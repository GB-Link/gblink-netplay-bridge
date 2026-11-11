import { EventEmitter } from 'node:events';
import { usb, type Device } from 'usb';
import { isGBLink, UsbTransport } from './device';
import { GBLinkAdapter } from './adapter';
import type { FirmwareVersion } from '../types';

export interface DeviceWatcherEvents {
  presence: [{ present: boolean; firmware?: FirmwareVersion; detail?: string }];
  /** Per-attempt diagnostics while trying to open a freshly seen adapter. */
  log: [string];
}

/**
 * Delays before each probe attempt after the device appears. A freshly
 * plugged adapter is not openable the instant it enumerates (udev applies
 * ACLs asynchronously; Windows attaches WinUSB), but that settles in well
 * under a second, so ~4 s is enough before reporting a real failure.
 */
const PROBE_DELAYS_MS = [250, 750, 1500, 1500];
/**
 * Background re-check after a failure, so the adapter recovers on its own
 * once whatever held it lets go (e.g. a browser tab closing).
 */
const SLOW_RETRY_MS = 10000;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Idle-time adapter presence tracker. A probe opens the device just long
 * enough to read the firmware version, then fully releases it so a session
 * (or another client, e.g. the Celio web client) can claim the interface.
 */
export class DeviceWatcher extends EventEmitter<DeviceWatcherEvents> {
  private suspended = false;
  private probing = false;
  /** The probe holding the device right now, if any. */
  private probeRun: Promise<unknown> | null = null;
  private started = false;
  private slowRetry: ReturnType<typeof setTimeout> | null = null;
  /** True once a failure has been reported; silences repeat retry logging. */
  private blockedNotified = false;

  private readonly onAttach = (d: Device): void => {
    if (!isGBLink(d)) return;
    // Report presence at once; opening has to wait for the OS to finish
    // setting the device up (see PROBE_DELAYS_MS).
    this.emit('presence', { present: true });
    void this.check();
  };
  private readonly onDetach = (d: Device): void => {
    if (!isGBLink(d)) return;
    this.clearSlowRetry();
    this.blockedNotified = false;
    this.emit('presence', { present: false });
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
    this.clearSlowRetry();
    usb.removeListener('attach', this.onAttach);
    usb.removeListener('detach', this.onDetach);
  }

  /**
   * Leaves the device to a session; resolves once a running probe has let go. Two handles on
   * the adapter take each other's replies, and the probe's release breaks the session's transfers.
   */
  async suspend(): Promise<void> {
    this.suspended = true;
    this.clearSlowRetry();
    if (this.probeRun) await this.probeRun.catch(() => undefined);
  }

  resume(): void {
    this.suspended = false;
    void this.check();
  }

  async check(): Promise<void> {
    const present = UsbTransport.list().length > 0;
    if (!present) {
      this.clearSlowRetry();
      this.emit('presence', { present: false });
      return;
    }
    if (this.suspended || this.probing) {
      this.emit('presence', { present: true });
      return;
    }
    this.probing = true;
    this.clearSlowRetry();
    try {
      let lastError: Error | null = null;
      let attempt = 0;
      for (const wait of PROBE_DELAYS_MS) {
        await delay(wait);
        // The device may have been unplugged or claimed mid-wait.
        if (!this.started || this.suspended) return;
        if (UsbTransport.list().length === 0) {
          this.emit('presence', { present: false });
          return;
        }
        attempt++;
        try {
          const run = this.probe();
          this.probeRun = run;
          const info = await run.finally(() => {
            this.probeRun = null;
          });
          if (this.blockedNotified) this.emit('log', 'adapter opened after earlier failures');
          else if (attempt > 1) this.emit('log', `adapter opened on attempt ${attempt}`);
          this.blockedNotified = false;
          this.emit('presence', { present: true, ...info });
          return;
        } catch (e) {
          lastError = e as Error;
          // Only the first failing sequence is logged in detail; background
          // retries stay silent so they cannot flood the event log.
          if (!this.blockedNotified) {
            this.emit('log', `adapter open attempt ${attempt} failed: ${lastError.message}`);
          }
        }
      }
      // Enumerated but not openable (permissions, driver still attaching, or
      // another program holds it). Keep checking quietly in the background so
      // a late driver bind recovers without the user restarting the app.
      this.emit('presence', { present: true, detail: lastError?.message ?? 'unknown error' });
      this.blockedNotified = true;
      this.scheduleSlowRetry();
    } finally {
      this.probing = false;
    }
  }

  private scheduleSlowRetry(): void {
    if (!this.started || this.suspended || this.slowRetry) return;
    this.slowRetry = setTimeout(() => {
      this.slowRetry = null;
      void this.check();
    }, SLOW_RETRY_MS);
    this.slowRetry.unref?.();
  }

  private clearSlowRetry(): void {
    if (!this.slowRetry) return;
    clearTimeout(this.slowRetry);
    this.slowRetry = null;
  }

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
