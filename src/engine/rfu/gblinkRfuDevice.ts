import { EventEmitter } from 'node:events';
import { FwStatus, firmwareLabel, fwAtLeast, type IGBLinkAdapter } from '../types';
import type { IRfuDevice, RfuDeviceEvents, RfuDeviceInfo } from './rfuDevice';
import { Rfu1StreamParser, rfu1Chunks } from './rfu1';

/** The first stable release of the wireless adapter mode. */
const RFU_MIN_FW = { major: 2, minor: 2, patch: 7 };
const REINIT_DELAY_MS = 750;
const SELF_CLOSE_GRACE_MS = 2000;
const MAX_REINIT_ATTEMPTS = 5;

/** Telemetry the firmware sends every 500 ms on the data endpoint. */
const TELEMETRY_DETECTION = 0x0e;
const TELEMETRY_EVENTS = 0x1d;
const DETECTION_LEN = 16;
const EVENTS_LEN = 25;
/** comstate at and past which the GBA has run the adapter's ID exchange. */
const COMSTATE_DETECTED = 2;
/** The game resets an adapter it cannot reach about 4 times a second. */
const RESET_LOOP_RISES = 30;
const RESET_LOOP_WINDOW_MS = 10000;
/** Reports with the GBA clocking but every word zero before "wrong cable" is raised. */
const SILENT_CLOCK_REPORTS = 4;

/**
 * The GB-Link firmware's wireless adapter mode (0x07) as an RFU1 device: a
 * real GBA's AGB-015 stand-in, streamed over the vendor USB data endpoint.
 */
export class GBLinkRfuDevice extends EventEmitter<RfuDeviceEvents> implements IRfuDevice {
  readonly kind = 'gblink' as const;
  readonly gpspChild = true;
  readonly maxChildren = 4;
  info: RfuDeviceInfo | null = null;

  private readonly parser = new Rfu1StreamParser((f) => this.emit('frame', f));
  private ready = false;
  private stopped = false;
  private reinitializing = false;
  private reinitAttempts = 0;
  private selfCancelAt = 0;
  private reinitTimer: NodeJS.Timeout | null = null;

  private detected = false;
  private lastTransfers = -1;
  private silentClockReports = 0;
  private wrongCableRaised = false;
  private readonly resets: { at: number; count: number }[] = [];
  private resetLoop = false;

  /** Listens from the start, so an adapter plugged in after the session began is picked up. */
  constructor(private readonly adapter: IGBLinkAdapter) {
    super();
    this.adapter.on('status', this.onStatus);
    this.adapter.on('rfu-chunk', this.onChunk);
    this.adapter.on('data-raw', this.onRaw);
    this.adapter.on('detached', this.onDetached);
    this.adapter.on('attached', this.onAttached);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.enterMode();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reinitTimer) clearTimeout(this.reinitTimer);
    this.reinitTimer = null;
    this.adapter.off('status', this.onStatus);
    this.adapter.off('rfu-chunk', this.onChunk);
    this.adapter.off('data-raw', this.onRaw);
    this.adapter.off('detached', this.onDetached);
    this.adapter.off('attached', this.onAttached);
    this.ready = false;
    this.selfCancelAt = Date.now();
    await this.adapter.cancel().catch(() => undefined);
  }

  writeFrame(frame: Buffer): void {
    if (!this.ready) return;
    for (const chunk of rfu1Chunks(frame, 64)) {
      void this.adapter.writeRfuChunk(chunk).catch((e: Error) => this.emit('log', `fw write failed: ${e.message}`));
    }
  }

  private async enterMode(): Promise<void> {
    if (this.reinitializing || this.stopped) return;
    this.reinitializing = true;
    this.selfCancelAt = Date.now();
    try {
      const fw = await this.adapter.getFirmwareInfo();
      this.info = { kind: 'gblink', label: `GB-Link ${firmwareLabel(fw)}`, version: firmwareLabel(fw) };
      if (!fwAtLeast(fw, RFU_MIN_FW.major, RFU_MIN_FW.minor, RFU_MIN_FW.patch) || !(await this.adapter.probeWireless())) {
        throw new Error(
          `GB-Link firmware ${firmwareLabel(fw)} has no wireless adapter mode — install 2.2.7 or newer from the GBLink launcher`,
        );
      }
      this.emit('log', `firmware ${firmwareLabel(fw)}`);
      this.resetTelemetry();
      this.parser.reset();
      await this.adapter.initLinkMode('rfu');
      this.reinitAttempts = 0;
      this.ready = true;
      this.emit('ready');
    } catch (e) {
      this.emit('error', e as Error);
      if ((e as Error).name === 'AdapterTimeoutError') this.scheduleReinit();
    } finally {
      this.reinitializing = false;
    }
  }

  private scheduleReinit(): void {
    if (this.stopped || this.reinitializing || this.reinitTimer) return;
    if (Date.now() - this.selfCancelAt < SELF_CLOSE_GRACE_MS) return;
    if (this.reinitAttempts >= MAX_REINIT_ATTEMPTS) {
      this.emit('log', `wireless mode failed to start ${this.reinitAttempts} times — unplug and replug the adapter`);
      return;
    }
    this.reinitAttempts++;
    this.reinitTimer = setTimeout(() => {
      this.reinitTimer = null;
      void this.enterMode();
    }, REINIT_DELAY_MS);
    this.reinitTimer.unref?.();
  }

  private readonly onStatus = (status: FwStatus): void => {
    if (this.stopped) return;
    switch (status) {
      case FwStatus.LinkReconnecting:
        if (this.ready) this.emit('log', 'nothing has reached the adapter from the network for 4 s');
        break;
      case FwStatus.LinkClosed:
        if (!this.ready) break;
        this.ready = false;
        this.emit('down', 'the adapter left the wireless mode');
        this.scheduleReinit();
        break;
      default:
        break;
    }
  };

  private readonly onChunk = (buf: Buffer): void => {
    if (!this.ready) return;
    this.parser.push(buf);
  };

  private readonly onRaw = (buf: Buffer): void => {
    if (!this.ready || buf.length === 0) return;
    if (buf[0] === TELEMETRY_DETECTION && buf.length === DETECTION_LEN) this.onDetection(buf);
    else if (buf[0] === TELEMETRY_EVENTS && buf.length === EVENTS_LEN) this.noteResets(buf[14]!);
  };

  private onDetection(buf: Buffer): void {
    const anyRx = buf[1] !== 0;
    const comstate = buf[3]!;
    const transfers = buf.readUInt32LE(12);
    if (!this.detected && comstate >= COMSTATE_DETECTED) {
      this.detected = true;
      this.emit('log', 'the GBA found the wireless adapter');
    }
    // Clock arriving with every word zero: the GBA's data line is grounded
    // (a GBA cable) or open; only a GBC link cable carries it.
    const clocking = this.lastTransfers >= 0 && transfers > this.lastTransfers;
    this.lastTransfers = transfers;
    if (clocking && !anyRx) {
      if (++this.silentClockReports >= SILENT_CLOCK_REPORTS && !this.wrongCableRaised) {
        this.wrongCableRaised = true;
        this.emit('notice', {
          code: 'wrong-cable',
          text: 'The GBA clocks the adapter but no data arrives: the wireless adapter mode needs a Game Boy Color link cable',
        });
      }
    } else if (anyRx) {
      this.silentClockReports = 0;
    }
  }

  private noteResets(count: number): void {
    const now = Date.now();
    this.resets.push({ at: now, count });
    while (this.resets.length > 1 && now - this.resets[0]!.at > RESET_LOOP_WINDOW_MS) this.resets.shift();
    const risen = (count - this.resets[0]!.count) & 0xff;
    const looping = risen >= RESET_LOOP_RISES;
    if (looping === this.resetLoop) return;
    this.resetLoop = looping;
    if (looping) {
      this.emit('notice', {
        code: 'reset-loop',
        text: this.detected
          ? 'The game keeps restarting the adapter: try another Game Boy Color link cable'
          : 'The game cannot reach the adapter: use a Game Boy Color link cable and update the adapter firmware',
      });
    } else {
      this.emit('log', 'the adapter is answering the game again');
    }
  }

  private resetTelemetry(): void {
    this.detected = false;
    this.lastTransfers = -1;
    this.silentClockReports = 0;
    this.wrongCableRaised = false;
    this.resets.length = 0;
    this.resetLoop = false;
  }

  private readonly onDetached = (): void => {
    if (!this.ready) return;
    this.ready = false;
    this.emit('down', 'GB-Link unplugged');
    this.emit('detached');
  };

  private readonly onAttached = (): void => {
    if (this.stopped) return;
    this.emit('attached');
    void this.adapter
      .start()
      .then(() => this.enterMode())
      .catch((e: Error) => this.emit('error', e));
  };
}
