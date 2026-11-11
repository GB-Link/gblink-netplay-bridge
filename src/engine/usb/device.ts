import { EventEmitter } from 'node:events';
import { usb, getDeviceList, Device, Interface, InEndpoint, OutEndpoint } from 'usb';

/** The adapter's USB IDs: 1209:b011 from firmware 3.0.0, 2fe3:000a before. */
export const GBLINK_IDS: ReadonlyArray<{ vid: number; pid: number }> = [
  { vid: 0x1209, pid: 0xb011 },
  { vid: 0x2fe3, pid: 0x000a },
];

// Bulk endpoints on vendor interface 0. Interfaces 1/2 are CDC — never claim them.
const EP_CMD_OUT = 0x01;
const EP_STATUS_IN = 0x81;
const EP_DATA_OUT = 0x02;
const EP_DATA_IN = 0x82;

const POLL_TRANSFERS = 2;
const POLL_SIZE = 64;
/** A handle that broke with the adapter still plugged in is offered back this long after. */
const REOPEN_AFTER_MS = 1000;

export interface UsbTransportEvents {
  /** Raw status endpoint (0x81) payload: consecutive 2-byte LE words. */
  'status-bytes': [Buffer];
  /** Raw data endpoint (0x82) payload: the mode's link data or a command reply. */
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
  /** Whether the device is plugged in, so a failed open is worth retrying. */
  present?(): boolean;
}

const hex = (value: number, digits: number): string => value.toString(16).padStart(digits, '0');

export const isGBLink = (device: Device): boolean =>
  GBLINK_IDS.some(
    (id) => device.deviceDescriptor.idVendor === id.vid && device.deviceDescriptor.idProduct === id.pid,
  );

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
  /** The owner closed this transport: nothing is offered back any more. */
  private closed = false;
  private reopenTimer: NodeJS.Timeout | null = null;

  private readonly onAttach = (device: Device): void => {
    if (isGBLink(device)) this.emit('attached');
  };

  private readonly onDetach = (device: Device): void => {
    if (!isGBLink(device)) return;
    // The handle is dead with the device; drop it so a later open() works.
    this.dropHandle();
    this.emit('detached');
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

  present(): boolean {
    return UsbTransport.list().length > 0;
  }

  static find(): Device | undefined {
    return UsbTransport.list()[0];
  }

  async open(device?: Device): Promise<void> {
    if (this.device) throw new Error('UsbTransport is already open');
    this.closed = false;
    const dev = device ?? UsbTransport.find();
    if (!dev) {
      throw new Error('GBLink device not found');
    }
    // Annotate which step failed: opening fails when no usable driver is
    // bound (Windows without WinUSB), claiming fails when another program
    // holds the interface or permissions are missing.
    try {
      dev.open();
    } catch (e) {
      throw new Error(`cannot open GB-Link: ${describeUsbError(e)}`);
    }
    const iface = dev.interface(0);
    try {
      if (process.platform === 'linux' && iface.isKernelDriverActive()) {
        iface.detachKernelDriver();
      }
      iface.claim();
    } catch (e) {
      try {
        dev.close();
      } catch {
        /* ignore */
      }
      throw new Error(`cannot claim GB-Link interface: ${describeUsbError(e)}`);
    }

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
    if (buf.length === 0 || buf.length > 64) {
      return Promise.reject(new Error(`data OUT endpoint takes 1 to 64 bytes, got ${buf.length}`));
    }
    return this.enqueue('data', buf);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    usb.removeListener('attach', this.onAttach);
    usb.removeListener('detach', this.onDetach);
    const { device, iface, statusIn, dataIn } = this;
    this.device = null;
    this.iface = null;
    this.cmdOut = null;
    this.dataOut = null;
    this.statusIn = null;
    this.dataIn = null;
    this.retried.clear();
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

  /** Forget an unplugged device without waiting on transfers that can never finish. */
  private dropHandle(): void {
    const { device } = this;
    this.device = null;
    this.iface = null;
    this.cmdOut = null;
    this.dataOut = null;
    this.statusIn = null;
    this.dataIn = null;
    this.retried.clear();
    if (!device) return;
    try {
      device.close();
    } catch {
      // already gone
    }
  }

  private recoverPoll(ep: InEndpoint): void {
    if (!this.device) return;
    if (this.retried.has(ep.address)) {
      this.lostHandle();
      return;
    }
    this.retried.add(ep.address);
    // A poll error stops the endpoint's own polling; the restart must wait
    // until the remaining queued transfers have drained ('end').
    ep.once('end', () => {
      if (!this.device) return;
      ep.clearHalt((error) => {
        if (error || !this.device) {
          this.lostHandle();
          return;
        }
        try {
          ep.startPoll(POLL_TRANSFERS, POLL_SIZE);
        } catch {
          this.lostHandle();
        }
      });
    });
  }

  /**
   * The handle broke without an unplug (transfer errors, another handle letting go): no
   * hotplug event follows, so 'attached' is emitted once the adapter can be reopened.
   */
  private lostHandle(): void {
    this.dropHandle();
    this.emit('detached');
    if (this.reopenTimer) return;
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      if (!this.closed && !this.device && this.present()) this.emit('attached');
    }, REOPEN_AFTER_MS);
    this.reopenTimer.unref?.();
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

/** libusb errors carry a numeric errno; surface the symbolic name with it. */
function describeUsbError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const errno = (e as { errno?: number }).errno;
  return errno === undefined ? msg : `${msg} (errno ${errno})`;
}
