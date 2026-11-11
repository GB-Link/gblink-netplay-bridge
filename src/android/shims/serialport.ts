import { EventEmitter } from 'node:events';
import { SerialLink, fromBase64, toBase64 } from '../native';

/** What node-serialport's list() gives for a port, as the engine reads it. */
export interface PortInfo {
  path: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
}

type Callback = (error: Error | null) => void;

const hex4 = (n: number): string => n.toString(16).padStart(4, '0');
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

const open = new Map<number, SerialPort>();
let routing: Promise<void> | null = null;

export function routeSerialEvents(): Promise<void> {
  routing ??= (async () => {
    await SerialLink.addListener('data', (e) => open.get(e.handle)?.emit('data', fromBase64(e.data)));
    await SerialLink.addListener('closed', (e) => open.get(e.handle)?.portClosed(e.error));
  })();
  return routing;
}

/** The node-serialport calls the ESP32 board code makes, over Android's USB serial drivers. */
export class SerialPort extends EventEmitter {
  static async list(): Promise<PortInfo[]> {
    const { ports } = await SerialLink.list();
    return ports.map((p) => ({
      path: p.path,
      vendorId: hex4(p.vendorId),
      productId: hex4(p.productId),
      manufacturer: p.manufacturer,
    }));
  }

  readonly path: string;
  readonly baudRate: number;
  private handle: number | null = null;
  private closeCallback: Callback | null = null;

  constructor(options: { path: string; baudRate: number; autoOpen?: boolean; highWaterMark?: number }) {
    super();
    this.path = options.path;
    this.baudRate = options.baudRate;
    if (options.autoOpen !== false) this.open();
  }

  get isOpen(): boolean {
    return this.handle !== null;
  }

  open(callback?: Callback): void {
    routeSerialEvents()
      .then(() => SerialLink.open({ path: this.path, baudRate: this.baudRate }))
      .then(
        ({ handle }) => {
          this.handle = handle;
          open.set(handle, this);
          this.emit('open');
          callback?.(null);
        },
        (e: unknown) => this.fail(asError(e), callback),
      );
  }

  /** Unset lines default to asserted, as in node-serialport. */
  set(signals: { dtr?: boolean; rts?: boolean }, callback?: Callback): void {
    const handle = this.handle;
    if (handle === null) return this.fail(new Error('Port is not open'), callback);
    SerialLink.setSignals({ handle, dtr: signals.dtr ?? true, rts: signals.rts ?? true }).then(
      () => callback?.(null),
      (e: unknown) => this.fail(asError(e), callback),
    );
  }

  write(data: Uint8Array, callback?: Callback): boolean {
    const handle = this.handle;
    if (handle === null) {
      this.fail(new Error('Port is not open'), callback);
      return false;
    }
    SerialLink.write({ handle, data: toBase64(data) }).then(
      () => callback?.(null),
      (e: unknown) => this.fail(asError(e), callback),
    );
    return true;
  }

  close(callback?: Callback): void {
    const handle = this.handle;
    if (handle === null) return this.fail(new Error('Port is not open'), callback);
    this.closeCallback = callback ?? null;
    SerialLink.close({ handle }).catch(() => this.portClosed());
  }

  /** The port is gone, closed by us or lost; `close` carries the reason when it was lost. */
  portClosed(error?: string): void {
    const handle = this.handle;
    if (handle === null) return;
    this.handle = null;
    open.delete(handle);
    const reason = error === undefined ? null : new Error(error);
    const callback = this.closeCallback;
    this.closeCallback = null;
    this.emit('close', reason);
    callback?.(reason);
  }

  private fail(error: Error, callback?: Callback): void {
    if (callback) queueMicrotask(() => callback(error));
    else this.emit('error', error);
  }
}
