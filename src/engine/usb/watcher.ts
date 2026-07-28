import { EventEmitter } from 'node:events';
import { usb, type Device } from 'usb';
import { GBLINK_PID, GBLINK_VID, UsbTransport } from './device';
import { GBLinkAdapter } from './adapter';
import type { FirmwareVersion } from '../types';

export interface DeviceWatcherEvents {
  presence: [{ present: boolean; firmware?: FirmwareVersion; detail?: string }];
}

const isGBLink = (d: Device): boolean =>
  d.deviceDescriptor.idVendor === GBLINK_VID && d.deviceDescriptor.idProduct === GBLINK_PID;

const ATTACH_SETTLE_MS = 750;
const PROBE_RETRY_MS = 800;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Idle-time adapter presence tracker. A probe opens the device just long
 * enough to read the firmware version, then fully releases it so a session
 * (or another client, e.g. the Celio web client) can claim the interface.
 */
export class DeviceWatcher extends EventEmitter<DeviceWatcherEvents> {
  private suspended = false;
  private probing = false;
  private started = false;

  private readonly onAttach = (d: Device): void => {
    if (!isGBLink(d)) return;
    // Report presence at once, but give udev time to apply ACLs to the fresh
    // device node before opening it — an immediate open races the rules and
    // fails with EACCES even on correctly configured systems.
    this.emit('presence', { present: true });
    setTimeout(() => void this.check(), ATTACH_SETTLE_MS).unref?.();
  };
  private readonly onDetach = (d: Device): void => {
    if (isGBLink(d)) this.emit('presence', { present: false });
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    usb.on('attach', this.onAttach);
    usb.on('detach', this.onDetach);
    usb.unrefHotplugEvents();
    void this.check();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    usb.removeListener('attach', this.onAttach);
    usb.removeListener('detach', this.onDetach);
  }

  /** A running session owns the device; the watcher must not open it. */
  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
    void this.check();
  }

  async check(): Promise<void> {
    const present = UsbTransport.list().length > 0;
    if (!present) {
      this.emit('presence', { present: false });
      return;
    }
    if (this.suspended || this.probing) {
      this.emit('presence', { present: true });
      return;
    }
    this.probing = true;
    try {
      let firstError: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const info = await this.probe();
          this.emit('presence', { present: true, ...info });
          return;
        } catch (e) {
          firstError ??= e as Error;
          if (attempt === 0) await delay(PROBE_RETRY_MS);
        }
      }
      // Enumerated but not openable (permissions, or claimed by another
      // program such as a WebUSB session) — still present.
      this.emit('presence', { present: true, detail: firstError?.message });
    } finally {
      this.probing = false;
    }
  }

  // Cable type is deliberately NOT queried here: the firmware only samples it
  // at link-mode entry, so an idle GetCableType returns the boot default.
  private async probe(): Promise<{ firmware: FirmwareVersion }> {
    const adapter = new GBLinkAdapter();
    try {
      await adapter.start();
      const firmware = await adapter.getFirmwareInfo();
      return { firmware };
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  }
}
