import { EventEmitter } from 'node:events';
import { UsbLink, fromBase64, toBase64 } from '../native';
import { getDeviceList, usb, type Device } from '../shims/usb';

/** The adapter's USB IDs: 1209:b011 from firmware 3.0.0, 2fe3:000a before. */
export const GBLINK_IDS: ReadonlyArray<{ vid: number; pid: number }> = [
  { vid: 0x1209, pid: 0xb011 },
  { vid: 0x2fe3, pid: 0x000a },
];

// Bulk endpoints on vendor interface 0, as on the desktop.
const EP_CMD_OUT = 0x01;
const EP_STATUS_IN = 0x81;
const EP_DATA_OUT = 0x02;
const EP_DATA_IN = 0x82;

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

/** Transport surface GBLinkAdapter depends on. */
export interface ILinkTransport extends EventEmitter<UsbTransportEvents> {
  open(): Promise<void>;
  sendCommand(bytes: Buffer | number[]): Promise<void>;
  sendData(buf: Buffer): Promise<void>;
  close(): Promise<void>;
  present?(): boolean;
}

const isGBLink = (device: Device): boolean =>
  GBLINK_IDS.some(
    (id) => device.deviceDescriptor.idVendor === id.vid && device.deviceDescriptor.idProduct === id.pid,
  );

const transports = new Map<number, UsbTransport>();
let routing: Promise<void> | null = null;

export function routeUsbReads(): Promise<void> {
  routing ??= (async () => {
    await UsbLink.addListener('data', (e) => transports.get(e.handle)?.received(e.endpoint, fromBase64(e.data)));
    await UsbLink.addListener('lost', (e) => transports.get(e.handle)?.lostHandle());
  })();
  return routing;
}

/** The GB-Link's vendor interface through Android's USB host API; the desktop's UsbTransport, for the phone. */
export class UsbTransport extends EventEmitter<UsbTransportEvents> implements ILinkTransport {
  private handle: number | null = null;
  private opening: Promise<unknown> | null = null;
  private closed = false;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onAttach = (device: Device): void => {
    if (isGBLink(device)) this.emit('attached');
  };

  private readonly onDetach = (device: Device): void => {
    if (!isGBLink(device)) return;
    this.dropHandle();
    this.emit('detached');
  };

  constructor() {
    super();
    usb.on('attach', this.onAttach);
    usb.on('detach', this.onDetach);
  }

  static list(): Device[] {
    return getDeviceList().filter(isGBLink);
  }

  present(): boolean {
    return UsbTransport.list().length > 0;
  }

  async open(): Promise<void> {
    if (this.handle !== null || this.opening) throw new Error('UsbTransport is already open');
    this.closed = false;
    const device = UsbTransport.list()[0];
    if (!device) throw new Error('GBLink device not found');
    const opening = routeUsbReads().then(() => UsbLink.open({ name: device.name }));
    this.opening = opening;
    let handle: number;
    try {
      ({ handle } = await opening);
    } catch (e) {
      throw new Error(`cannot open GB-Link: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.opening = null;
    }
    if (this.closed) {
      await UsbLink.close({ handle }).catch(() => undefined);
      throw new Error('UsbTransport was closed while opening');
    }
    this.handle = handle;
    transports.set(handle, this);
  }

  sendCommand(bytes: Buffer | number[]): Promise<void> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return this.write(EP_CMD_OUT, buf);
  }

  sendData(buf: Buffer): Promise<void> {
    if (buf.length === 0 || buf.length > 64) {
      return Promise.reject(new Error(`data OUT endpoint takes 1 to 64 bytes, got ${buf.length}`));
    }
    return this.write(EP_DATA_OUT, buf);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    usb.removeListener('attach', this.onAttach);
    usb.removeListener('detach', this.onDetach);
    if (this.opening) await this.opening.catch(() => undefined);
    const handle = this.handle;
    this.handle = null;
    if (handle === null) return;
    transports.delete(handle);
    await UsbLink.close({ handle }).catch(() => undefined);
  }

  received(endpoint: number, data: Buffer): void {
    if (data.length === 0) return;
    if (endpoint === EP_STATUS_IN) this.emit('status-bytes', data);
    else if (endpoint === EP_DATA_IN) this.emit('data-bytes', data);
  }

  /**
   * Reading broke without an unplug: no attach event follows, so 'attached' is emitted once the
   * adapter can be reopened.
   */
  lostHandle(): void {
    this.dropHandle();
    this.emit('detached');
    if (this.reopenTimer) return;
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      if (!this.closed && this.handle === null && this.present()) this.emit('attached');
    }, REOPEN_AFTER_MS);
  }

  /**
   * The firmware holds a write semaphore per endpoint, so writes to one endpoint must never overlap:
   * the plugin runs each endpoint's transfers one after another, in the order they were sent.
   */
  private write(endpoint: number, buf: Buffer): Promise<void> {
    const handle = this.handle;
    if (handle === null) return Promise.reject(new Error('UsbTransport is not open'));
    return UsbLink.write({ handle, endpoint, data: toBase64(buf) });
  }

  /** Forget the handle without waiting on transfers that can never finish. */
  private dropHandle(): void {
    const handle = this.handle;
    this.handle = null;
    if (handle === null) return;
    transports.delete(handle);
    void UsbLink.close({ handle }).catch(() => undefined);
  }
}
