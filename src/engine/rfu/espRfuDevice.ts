import { EventEmitter } from 'node:events';
import {
  EspDevice,
  EspDeviceError,
  isNativeUsbPort,
  type EspDeviceEvents,
  type EspInfo,
  type EspKeyStatus,
} from '../esp32/espDevice';
import { GB_CHANNEL, GbFrameParser, buildGbFrame } from '../esp32/wire';
import type { IRfuDevice, RfuDeviceEvents, RfuDeviceInfo } from './rfuDevice';
import { Rfu1StreamParser, rfu1Chunks } from './rfu1';

/**
 * To the board: 64-byte GB data frames, zero padded, as it reads a shorter one as adapter telemetry.
 * From the board: pieces of at most 64 bytes, unpadded.
 */
const RFU_CHUNK = 64;
/** The board treats a silent console as a missing adapter after 10 s. */
const STATUS_POLL_MS = 3000;
const HOST_PORT_RELEASE_MS = 150;
const OPEN_RETRY_MS = 3000;
/** First firmware with the host port, Celio-style group beacons, and only the room's own group offered. */
const ESP_MIN_VERSION = '2.1.5';

/** 0xFF02 AwaitMode as a GB status frame: stops the board re-sending SetMode. */
const AWAIT_MODE_STATUS = buildGbFrame(GB_CHANNEL.STATUS, Buffer.from([0x02, 0xff]));

/** The board's console: an EspDevice, or a fake in tests. */
export interface IEspConsole extends EventEmitter<EspDeviceEvents> {
  readonly info: EspInfo | null;
  readonly attached: boolean;
  open(): Promise<void>;
  keyStatus(): Promise<EspKeyStatus | null>;
  setAdapterPort(where: 'host' | 'uart'): Promise<boolean>;
  bridgeStatus(): Promise<Record<string, string> | null>;
  sendAdapter(bytes: Uint8Array): void;
  close(): Promise<void>;
}

export interface EspRfuDeviceOptions {
  /** Serial port path; the first ESP32 found when absent. */
  path?: string;
  /** Opens the console on a port; an EspDevice by default. */
  connect?: (path: string, vendorId?: string) => IEspConsole;
}

const STATE_TEXT: Record<string, string> = {
  scan: 'the board is looking for the Switch and listening for a room to lead',
  auth: "joining the Switch's room",
  member: "joining the Switch's room",
  net: "joining the Switch's room",
  run: "in the Switch's room",
  host: 'leading a room for the Switch',
  stopped: 'the board is not running its bridge',
  idle: 'the board is not running its bridge',
};

function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * The ESP32 bridge's host port as an RFU1 wireless adapter (GB-Link-Switch-LDN pia_bridge.c): the board
 * offers the Switch's room as a group, or leads a room the Switch joins when offered a group.
 */
export class EspRfuDevice extends EventEmitter<RfuDeviceEvents> implements IRfuDevice {
  readonly kind = 'esp32' as const;
  readonly gpspChild = true;
  readonly maxChildren = 1;
  info: RfuDeviceInfo | null = null;
  esp: IEspConsole | null = null;
  keys: boolean | null = null;

  private readonly gb = new GbFrameParser(512);
  private readonly rfu = new Rfu1StreamParser((f) => this.emit('frame', f));
  private statusTimer: NodeJS.Timeout | null = null;
  private lastState = '';
  private ready = false;
  private stopped = false;

  constructor(private readonly opts: EspRfuDeviceOptions = {}) {
    super();
  }

  private retryTimer: NodeJS.Timeout | null = null;
  private lastRetryReason = '';
  /** The port a board answered on, tried first on reopening. */
  private boardPath: string | null = null;
  /** USB-serial ports that did not answer as a board; never opened again. */
  private readonly notBoards = new Set<string>();

  /**
   * Opens the board and takes its adapter port, retrying until stopped while the port is busy (a browser
   * tab or probe on it) or absent, or the board is lost; `ready` fires when the stream is live.
   */
  async start(): Promise<void> {
    this.stopped = false;
    try {
      await this.open();
    } catch (e) {
      if (!retryable(e)) throw e;
      this.noteRetry(e as Error);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open().catch((e: Error) => {
        if (!retryable(e)) {
          this.emit('error', e);
          return;
        }
        this.noteRetry(e);
        this.scheduleRetry();
      });
    }, OPEN_RETRY_MS);
    this.retryTimer.unref?.();
  }

  private noteRetry(e: Error): void {
    if (e.message === this.lastRetryReason) return;
    this.lastRetryReason = e.message;
    this.emit('log', `${e.message} Trying again every ${OPEN_RETRY_MS / 1000} s.`);
  }

  /**
   * The configured port, else the last board's, else a native-USB board, else an untried USB-serial
   * port: opening one resets whatever is behind it, so each is probed once at most.
   */
  private async pickPort(): Promise<{ path: string; vendorId?: string; probe: boolean } | null> {
    if (this.opts.connect && this.opts.path) return { path: this.opts.path, probe: false };
    const ports = await EspDevice.listPorts();
    const known = ports.find((p) => p.path === (this.opts.path ?? this.boardPath));
    if (known) return { path: known.path, vendorId: known.vendorId, probe: false };
    const native = ports.find((p) => isNativeUsbPort(p.vendorId));
    if (native) return { path: native.path, vendorId: native.vendorId, probe: false };
    const untried = ports.find((p) => !this.notBoards.has(p.path));
    return untried ? { path: untried.path, vendorId: untried.vendorId, probe: true } : null;
  }

  private async open(): Promise<void> {
    const port = await this.pickPort();
    if (!port) throw new EspDeviceError('No ESP32 bridge board found on a serial port.', 'port-lost');
    const { path, vendorId } = port;
    const esp = this.opts.connect ? this.opts.connect(path, vendorId) : new EspDevice(path, vendorId);
    esp.on('log', (m) => this.emit('log', m));
    esp.on('event', (line) => this.onEvent(line));
    esp.on('adapter-frame', (frame) => this.onAdapterFrame(frame));
    esp.on('restarted', () => this.onRestarted());
    esp.on('reattached', () => void this.claim().catch((e: Error) => this.lost(esp, e)));
    esp.on('disconnected', () => this.onDisconnected(esp));
    esp.on('failed', (e) => this.lost(esp, e));
    try {
      await esp.open();
    } catch (e) {
      esp.removeAllListeners();
      const code = (e as EspDeviceError).code;
      if (port.probe && code !== 'port-busy' && code !== 'port-lost') this.notBoards.add(path);
      throw e;
    }
    if (this.stopped) {
      esp.removeAllListeners();
      await esp.close();
      return;
    }
    this.esp = esp;
    this.boardPath = path;
    this.lastRetryReason = '';
    const info = esp.info;
    this.info = info ? describe(info) : { kind: 'esp32', label: 'ESP32 bridge', version: '0.0.0' };
    this.emit('log', `${this.info.label} on ${path}`);
    if (info && !versionAtLeast(info.version, ESP_MIN_VERSION)) {
      this.emit('notice', {
        code: 'firmware-too-old',
        text: `The ESP32 bridge firmware ${info.version} is too old: install ${ESP_MIN_VERSION} or newer from switch.gblink.io`,
      });
    }
    const keys = await esp.keyStatus().catch(() => null);
    this.keys = keys?.protocol3 ?? null;
    if (keys && !keys.protocol3) {
      this.emit('notice', {
        code: 'no-keys',
        text: 'The ESP32 board has no Switch keys: drop your prod.keys on switch.gblink.io first',
      });
    }
    try {
      await this.claim();
    } catch (e) {
      this.esp = null;
      esp.removeAllListeners();
      await esp.close();
      throw e;
    }
    this.emit('attached');
  }

  /** The board did not come back after a restart, or would not hand over its port: start over. */
  private lost(esp: IEspConsole, e: Error): void {
    if (this.esp !== esp) return;
    this.emit('log', `${e.message} Reopening the board.`);
    this.esp = null;
    this.stopStatusPoll();
    if (this.ready) {
      this.ready = false;
      this.emit('down', 'the ESP32 board stopped answering');
    }
    esp.removeAllListeners();
    void esp.close().finally(() => this.scheduleRetry());
  }

  /** The host-port setting is lost on the restart after every session. */
  private async claim(): Promise<void> {
    const esp = this.esp;
    if (!esp || this.stopped) return;
    if (!(await esp.setAdapterPort('host'))) {
      throw new EspDeviceError('The ESP32 board did not hand over its adapter port.', 'no-firmware');
    }
    esp.sendAdapter(AWAIT_MODE_STATUS);
    this.gb.reset();
    this.rfu.reset();
    this.lastState = '';
    this.startStatusPoll();
    this.ready = true;
    this.emit('ready');
  }

  private stopStatusPoll(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  private startStatusPoll(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = setInterval(() => void this.pollStatus(), STATUS_POLL_MS);
    this.statusTimer.unref?.();
    void this.pollStatus();
  }

  private async pollStatus(): Promise<void> {
    const esp = this.esp;
    if (!esp || !esp.attached) return;
    const status = await esp.bridgeStatus().catch(() => null);
    if (!status) return;
    const state = status['state'] ?? '';
    if (state !== this.lastState) {
      this.lastState = state;
      const text = STATE_TEXT[state];
      if (text) this.emit('log', text);
    }
  }

  private onEvent(line: string): void {
    if (line.startsWith('LDN_BRIDGE ') || line.startsWith('LDN_HOST')) this.emit('log', line.replace(/^LDN_(BRIDGE|HOST) /, 'board: '));
    if (/^LDN_BRIDGE no keys/.test(line)) {
      this.keys = false;
      this.emit('notice', { code: 'no-keys', text: 'The ESP32 board has no Switch keys: drop your prod.keys on switch.gblink.io first' });
    }
  }

  private onAdapterFrame(frame: Buffer): void {
    for (const gb of this.gb.push(frame)) {
      if (gb.channel !== GB_CHANNEL.DATA) continue;
      this.rfu.push(gb.payload);
    }
  }

  private onRestarted(): void {
    this.stopStatusPoll();
    if (!this.ready) return;
    this.ready = false;
    this.emit('down', 'the board restarted after the session ended');
    this.emit('notice', { code: 'restarting', text: 'The ESP32 board is restarting; it is ready again in a few seconds' });
  }

  private onDisconnected(esp: IEspConsole): void {
    if (this.esp !== esp) return;
    this.stopStatusPoll();
    this.esp = null;
    esp.removeAllListeners();
    const wasReady = this.ready;
    this.ready = false;
    if (wasReady) this.emit('down', 'the ESP32 board was unplugged');
    this.emit('detached');
    this.scheduleRetry();
  }

  writeFrame(frame: Buffer): void {
    const esp = this.esp;
    if (!esp || !this.ready) return;
    const pieces = rfu1Chunks(frame, RFU_CHUNK).map((c) => buildGbFrame(GB_CHANNEL.DATA, c));
    esp.sendAdapter(Buffer.concat(pieces));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopStatusPoll();
    const esp = this.esp;
    this.esp = null;
    this.ready = false;
    if (!esp) return;
    await new Promise((resolve) => setTimeout(resolve, HOST_PORT_RELEASE_MS));
    if (esp.attached) await esp.setAdapterPort('uart').catch(() => false);
    esp.removeAllListeners();
    await esp.close();
  }
}

function retryable(e: unknown): boolean {
  const code = (e as EspDeviceError).code;
  return code === 'port-busy' || code === 'port-lost' || code === 'no-firmware' || code === 'not-connected' || code === 'restarting';
}

export function describe(info: EspInfo): RfuDeviceInfo {
  return { kind: 'esp32', label: `ESP32 bridge ${info.version} (${info.chip})`, version: info.version };
}
