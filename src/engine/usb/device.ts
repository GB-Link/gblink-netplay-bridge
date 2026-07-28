import { EventEmitter } from 'node:events';
import { usb, findByIds, getDeviceList, Device, Interface, InEndpoint, OutEndpoint } from 'usb';

export const GBLINK_VID = 0x2fe3;
export const GBLINK_PID = 0x000a;

// Bulk endpoints on vendor interface 0. Interfaces 1/2 are CDC — never claim them.
const EP_CMD_OUT = 0x01;
const EP_STATUS_IN = 0x81;
const EP_DATA_OUT = 0x02;
const EP_DATA_IN = 0x82;

const POLL_TRANSFERS = 2;
const POLL_SIZE = 64;

export interface UsbTransportEvents {
  /** Raw status endpoint (0x81) payload: consecutive 2-byte LE words. */
  'status-bytes': [Buffer];
  /** Raw data endpoint (0x82) payload: 64 B rounds or shorter command replies. */
  'data-bytes': [Buffer];
  attached: [];
  detached: [];
}

/** Transport surface GBLinkAdapter depends on — substitutable in tests. */
export interface ILinkTransport extends EventEmitter<UsbTransportEvents> {
  open(): Promise<void>;
  sendCommand(bytes: Buffer | number[]): Promise<void>;
  sendData(buf: Buffer): Promise<void>;
  close(): Promise<void>;
}

const hex = (value: number, digits: number): string => value.toString(16).padStart(digits, '0');

const isGBLink = (device: Device): boolean =>
  device.deviceDescriptor.idVendor === GBLINK_VID && device.deviceDescriptor.idProduct === GBLINK_PID;

export class UsbTransport extends EventEmitter<UsbTransportEvents> implements ILinkTransport {
  private device: Device | null = null;
  private iface: Interface | null = null;
  private cmdOut: OutEndpoint | null = null;
  private dataOut: OutEndpoint | null = null;
  private statusIn: InEndpoint | null = null;
  private dataIn: InEndpoint | null = null;

  // The firmware holds a 100 ms write semaphore per endpoint — writes to one
  // endpoint must never overlap, hence a promise chain per OUT endpoint.
  private cmdChain: Promise<void> = Promise.resolve();
  private dataChain: Promise<void> = Promise.resolve();

  /** IN endpoint addresses that already spent their single clearHalt retry. */
  private readonly retried = new Set<number>();

  private readonly onAttach = (device: Device): void => {
    if (isGBLink(device)) this.emit('attached');
  };

  private readonly onDetach = (device: Device): void => {
    if (isGBLink(device)) this.emit('detached');
  };

  constructor() {
    super();
    usb.on('attach', this.onAttach);
    usb.on('detach', this.onDetach);
    // Hotplug listeners alone must not keep the process alive.
    usb.unrefHotplugEvents();
  }

  static list(): Device[] {
    return getDeviceList().filter(isGBLink);
  }

  static find(): Device | undefined {
    return findByIds(GBLINK_VID, GBLINK_PID);
  }

  async open(device?: Device): Promise<void> {
    if (this.device) throw new Error('UsbTransport is already open');
    const dev = device ?? UsbTransport.find();
    if (!dev) {
      throw new Error(`GBLink device ${hex(GBLINK_VID, 4)}:${hex(GBLINK_PID, 4)} not found`);
    }
    dev.open();
    const iface = dev.interface(0);
    if (process.platform === 'linux' && iface.isKernelDriverActive()) {
      iface.detachKernelDriver();
    }
    iface.claim();

    this.cmdOut = this.requireOut(iface, EP_CMD_OUT);
    this.dataOut = this.requireOut(iface, EP_DATA_OUT);
    this.statusIn = this.requireIn(iface, EP_STATUS_IN);
    this.dataIn = this.requireIn(iface, EP_DATA_IN);
    this.device = dev;
    this.iface = iface;

    this.startPoll(this.statusIn, 'status-bytes');
    this.startPoll(this.dataIn, 'data-bytes');
  }

  sendCommand(bytes: Buffer | number[]): Promise<void> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return this.enqueue('cmd', buf);
  }

  sendData(buf: Buffer): Promise<void> {
    if (buf.length !== 64) {
      return Promise.reject(new Error(`data OUT endpoint takes exactly 64 bytes, got ${buf.length}`));
    }
    return this.enqueue('data', buf);
  }

  async close(): Promise<void> {
    usb.removeListener('attach', this.onAttach);
    usb.removeListener('detach', this.onDetach);
    const { device, iface, statusIn, dataIn } = this;
    this.device = null;
    this.iface = null;
    this.cmdOut = null;
    this.dataOut = null;
    this.statusIn = null;
    this.dataIn = null;
    if (!device) return;

    for (const ep of [statusIn, dataIn]) {
      if (!ep?.pollActive) continue;
      await new Promise<void>((resolve) => {
        try {
          ep.stopPoll(resolve);
        } catch {
          resolve();
        }
      });
    }
    if (iface) {
      await new Promise<void>((resolve) => {
        try {
          iface.release(true, () => resolve());
        } catch {
          resolve();
        }
      });
    }
    try {
      device.close();
    } catch {
      // device may already be unplugged
    }
  }

  private enqueue(lane: 'cmd' | 'data', buf: Buffer): Promise<void> {
    const run = (): Promise<void> => this.write(lane === 'cmd' ? this.cmdOut : this.dataOut, buf);
    const prev = lane === 'cmd' ? this.cmdChain : this.dataChain;
    const p = prev.then(run, run);
    const tail = p.catch(() => undefined);
    if (lane === 'cmd') this.cmdChain = tail;
    else this.dataChain = tail;
    return p;
  }

  private write(ep: OutEndpoint | null, buf: Buffer): Promise<void> {
    if (!ep) return Promise.reject(new Error('UsbTransport is not open'));
    return new Promise<void>((resolve, reject) => {
      ep.transfer(buf, (error) => (error ? reject(error) : resolve()));
    });
  }

  private startPoll(ep: InEndpoint, event: 'status-bytes' | 'data-bytes'): void {
    ep.on('data', (data: Buffer) => {
      if (data.length > 0) this.emit(event, data);
    });
    ep.on('error', () => this.recoverPoll(ep));
    ep.startPoll(POLL_TRANSFERS, POLL_SIZE);
  }

  private recoverPoll(ep: InEndpoint): void {
    if (!this.device) return;
    if (this.retried.has(ep.address)) {
      this.emit('detached');
      return;
    }
    this.retried.add(ep.address);
    // A poll error stops the endpoint's own polling; the restart must wait
    // until the remaining queued transfers have drained ('end').
    ep.once('end', () => {
      if (!this.device) return;
      ep.clearHalt((error) => {
        if (error || !this.device) {
          this.emit('detached');
          return;
        }
        try {
          ep.startPoll(POLL_TRANSFERS, POLL_SIZE);
        } catch {
          this.emit('detached');
        }
      });
    });
  }

  private requireOut(iface: Interface, address: number): OutEndpoint {
    const ep = iface.endpoint(address);
    if (!(ep instanceof OutEndpoint)) {
      throw new Error(`bulk OUT endpoint 0x${hex(address, 2)} missing on interface 0`);
    }
    return ep;
  }

  private requireIn(iface: Interface, address: number): InEndpoint {
    const ep = iface.endpoint(address);
    if (!(ep instanceof InEndpoint)) {
      throw new Error(`bulk IN endpoint 0x${hex(address, 2)} missing on interface 0`);
    }
    return ep;
  }
}
