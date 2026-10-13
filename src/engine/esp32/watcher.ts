import { EventEmitter } from 'node:events';
import { EspDevice, isNativeUsbPort, type EspInfo } from './espDevice';

export interface Esp32Presence {
  present: boolean;
  path?: string;
  info?: EspInfo;
  /** The board holds the Switch keys FireRed rooms use. */
  keys?: boolean;
  detail?: string;
}

export interface Esp32WatcherEvents {
  presence: [Esp32Presence];
  log: [string];
}

const SCAN_INTERVAL_MS = 3000;

/**
 * Polls for an ESP32 board while idle (serial ports have no hotplug events) and probes a new one once
 * for its firmware and keys. Only native-USB boards (S3, C3, C6) are probed: opening a USB-serial port
 * resets whatever is behind it, so a classic ESP32 is found when a session opens it.
 */
export class Esp32Watcher extends EventEmitter<Esp32WatcherEvents> {
  private timer: NodeJS.Timeout | null = null;
  private suspended = false;
  private probing = false;
  private probe: Promise<void> | null = null;
  private knownPath: string | null = null;
  private lastPresence: Esp32Presence = { present: false };

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), SCAN_INTERVAL_MS);
    this.timer.unref?.();
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A running session owns the port; the watcher must not open it. Resolves once no probe holds it. */
  async suspend(): Promise<void> {
    this.suspended = true;
    if (this.probe) await this.probe.catch(() => undefined);
  }

  resume(): void {
    this.suspended = false;
    this.knownPath = null;
    void this.check();
  }

  get presence(): Esp32Presence {
    return this.lastPresence;
  }

  async check(): Promise<void> {
    if (this.probing) return;
    const ports = await EspDevice.listPorts().catch(() => []);
    const port = ports.find((p) => isNativeUsbPort(p.vendorId));
    if (!port) {
      if (this.knownPath !== null || this.lastPresence.present) {
        this.knownPath = null;
        this.report({ present: false });
      }
      return;
    }
    if (this.suspended) {
      if (this.knownPath !== port.path) {
        this.knownPath = port.path;
        this.report({ present: true, path: port.path });
      }
      return;
    }
    if (this.knownPath === port.path) return;
    this.knownPath = port.path;
    this.probing = true;
    this.probe = (async () => {
      const device = new EspDevice(port.path, port.vendorId);
      try {
        await device.open();
        const keys = await device.keyStatus().catch(() => null);
        this.report({ present: true, path: port.path, info: device.info ?? undefined, keys: keys?.protocol3 });
      } catch (e) {
        this.emit('log', `ESP32 on ${port.path}: ${(e as Error).message}`);
        this.report({ present: true, path: port.path, detail: (e as Error).message });
      } finally {
        await device.close().catch(() => undefined);
      }
    })();
    try {
      await this.probe;
    } finally {
      this.probe = null;
      this.probing = false;
    }
  }

  private report(p: Esp32Presence): void {
    this.lastPresence = p;
    this.emit('presence', p);
  }
}
