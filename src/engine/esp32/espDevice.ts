import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { EspFrameDecoder, EspKind, buildEspFrame, type EspFrame } from './wire';

export interface EspPortInfo {
  path: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
}

/** Espressif native USB Serial/JTAG, then the USB-UART chips of classic ESP32 dev boards. */
export const ESP_VENDOR_IDS = ['303a', '10c4', '1a86', '0403'] as const;
const NATIVE_VENDOR_ID = '303a';
export const FAST_BAUD = 921600;
const SLOW_BAUD = 115200;

const BOOT_BANNER = Buffer.from('LDN_READY');
const HANDSHAKE_ATTEMPTS = 4;
/** Output seen only while the chip boots. */
const BOOT_SIGNS = /LDN_READY|ldn_bridge|rst:0x|ESP-ROM:|I \(\d+\) boot:/;
const CRASH_LINES =
  /^(Guru Meditation Error.*|abort\(\).*|ESP_ERROR_CHECK failed.*|assert failed.*|Backtrace:.*|Stack smashing.*|Task watchdog.*|E \(\d+\) task_wdt.*|Core +\d+ register dump:.*|PC +: .*|.*Interrupt wdt timeout.*)$/gm;
const REATTACH_DELAY_MS = 1200;
const BINARY_SETTLE_MS = 200;

export type EspErrorCode = 'port-busy' | 'port-lost' | 'download-mode' | 'no-firmware' | 'crash-loop' | 'restarting' | 'not-connected';

export class EspDeviceError extends Error {
  constructor(
    message: string,
    readonly code: EspErrorCode,
    readonly detail?: string,
    readonly silent = false,
  ) {
    super(message);
    this.name = 'EspDeviceError';
  }
}

export interface EspInfo {
  name: string;
  version: string;
  chip: string;
  transport: string;
  reset?: string;
}

export interface EspKeyStatus {
  kek: boolean;
  gen: boolean;
  master00: boolean;
  master12: boolean;
  protocol1: boolean;
  protocol3: boolean;
  complete: boolean;
}

export interface EspDeviceEvents {
  attached: [EspInfo | null];
  /** The board rebooted (its boot banner was seen); a re-attach follows. */
  restarted: [];
  reattached: [];
  /** The port went away for good. */
  disconnected: [];
  failed: [Error];
  /** Board lines not tied to a request (LDN_BRIDGE …, LDN_HOST …). */
  event: [string];
  log: [string];
  /** Kind 6: one whole GB-Link frame for the adapter side. */
  'adapter-frame': [Buffer];
}

interface Pending {
  request: number;
  lines: string[];
  resolve: (lines: string[]) => void;
  timer: NodeJS.Timeout | null;
}

export function isEspPort(port: EspPortInfo): boolean {
  const vid = (port.vendorId ?? '').toLowerCase();
  return (ESP_VENDOR_IDS as readonly string[]).includes(vid);
}

export function isNativeUsbPort(vendorId: string | undefined): boolean {
  return (vendorId ?? '').toLowerCase() === NATIVE_VENDOR_ID;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const PORT_LOST_ADVICE =
  'The port was lost the moment it opened. On Linux this happens after another serial program used it: unplug the board, plug it back in and try again.';

/**
 * The ESP32 bridge firmware's console: binary mode, requests, host-port adapter frames, and the
 * re-attach after the restart that ends every Switch session. Ported from GB-Link-Switch-LDN web/js/esp.js.
 */
export class EspDevice extends EventEmitter<EspDeviceEvents> {
  private port: SerialPort | null = null;
  private decoder = new EspFrameDecoder();
  private session = 0;
  private request = 0;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  info: EspInfo | null = null;
  hello: string | null = null;
  attached = false;
  private attaching = false;
  private bannerTail = Buffer.alloc(0);
  private recentText = '';
  private bannerSeen = false;
  private readEnded = false;
  private bootText = '';
  private bootSignAt = 0;
  private closedByUs = false;
  baudRate = 0;

  constructor(
    readonly path: string,
    readonly vendorId?: string,
  ) {
    super();
  }

  static async listPorts(): Promise<EspPortInfo[]> {
    const ports = await SerialPort.list();
    return ports
      .map((p) => ({ path: p.path, vendorId: p.vendorId, productId: p.productId, manufacturer: p.manufacturer }))
      .filter(isEspPort);
  }

  get isNativeUsb(): boolean {
    return isNativeUsbPort(this.vendorId);
  }

  private ratesToTry(): number[] {
    return this.isNativeUsb ? [SLOW_BAUD] : [FAST_BAUD, SLOW_BAUD];
  }

  async open(): Promise<void> {
    const rates = this.ratesToTry();
    let failure: EspDeviceError | null = null;
    for (let i = 0; i < rates.length; i++) {
      try {
        await this.openPort(rates[i]!);
      } catch (error) {
        throw portOpenError(this.path, error as Error);
      }
      try {
        await this.attach(i === rates.length - 1);
        return;
      } catch (error) {
        failure = moreTelling(failure, error as EspDeviceError);
      }
      // The OS moving DTR and RTS on open can leave a dev board in ROM download mode; only a reset tells.
      if (rates[i] === FAST_BAUD && !this.readEnded && failure.code !== 'crash-loop') {
        try {
          await this.resetChip();
          await this.attach(true);
          return;
        } catch (error) {
          failure = moreTelling(failure, error as EspDeviceError);
        }
      }
      await this.close();
      if (failure.code === 'port-lost' || failure.code === 'crash-loop') break;
    }
    throw failure ?? new EspDeviceError('No bridge firmware answered on this port.', 'no-firmware');
  }

  /**
   * RTS without DTR holds EN low through the auto-reset circuit; DTR stays released, so IO0 is high
   * as EN rises and the firmware boots rather than download mode.
   */
  async resetChip(): Promise<void> {
    this.bootText = '';
    this.bootSignAt = 0;
    try {
      await this.setSignals(false, false);
      await this.setSignals(false, true);
      await sleep(100);
      await this.setSignals(false, false);
    } catch {
      // the port may not support control lines
    }
  }

  private setSignals(dtr: boolean, rts: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.port;
      if (!port) return reject(new EspDeviceError('Not connected', 'not-connected'));
      port.set({ dtr, rts }, (error) => (error ? reject(error) : resolve()));
    });
  }

  private openPort(baudRate: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const port = new SerialPort({ path: this.path, baudRate, autoOpen: false, highWaterMark: 65536 });
      port.open((error) => {
        if (error) return reject(error);
        this.port = port;
        this.baudRate = baudRate;
        this.readEnded = false;
        this.closedByUs = false;
        this.bootText = '';
        port.on('data', (chunk: Buffer) => this.onData(chunk));
        port.on('error', (e: Error) => this.emit('log', `serial error: ${e.message}`));
        port.on('close', () => this.onPortClosed());
        // The OS asserts DTR and RTS on open; releasing both leaves the chip running. USB-UARTs move one
        // line at a time and EN pulses while RTS is held with DTR released, so RTS is released first.
        void (async () => {
          try {
            if (this.isNativeUsb) await this.setSignals(false, false);
            else {
              await this.setSignals(true, false);
              await this.setSignals(false, false);
            }
          } catch {
            // best effort
          }
          resolve();
        })();
      });
    });
  }

  /** Binary mode, session id, device info; retried until the firmware has booted. */
  private async attach(lastChance = true): Promise<void> {
    this.attached = false;
    this.attaching = true;
    try {
      let hello: string | null = null;
      for (let attempt = 0; attempt < HANDSHAKE_ATTEMPTS && !hello; attempt++) {
        this.decoder = new EspFrameDecoder();
        const justBooted = this.bannerSeen;
        this.bannerSeen = false;
        await sleep(attempt === 0 || justBooted ? 150 : 600);
        // Lost before any output: an OS problem. Lost after output: the chip.
        if (this.readEnded) {
          throw this.bootText ? this.silenceExplained() : new EspDeviceError(PORT_LOST_ADVICE, 'port-lost');
        }
        await this.writeRaw(Buffer.concat([Buffer.from('\nLDN_BINARY\n'), Buffer.from([0])]));
        await sleep(BINARY_SETTLE_MS);
        const lines = await this.command('LDN_HELLO', 700, true);
        hello = lines.find((line) => line.startsWith('LDN_HELLO')) ?? null;
        if (this.bannerSeen) hello = null;
        if (!hello && !this.worthAnotherTry(attempt, lastChance)) break;
      }
      if (!hello) throw this.silenceExplained();
      this.hello = hello;
      this.session = ((Date.now() & 0x7fffffff) | 1) >>> 0;
      await this.command(`LDN_BEGIN ${this.session.toString(16).padStart(8, '0')}`, 2000, true);
      const info = await this.command('LDN_INFO', 2000, true);
      this.info = parseInfo(info.find((line) => line.startsWith('LDN_INFO')) ?? '');
      const boot = info.map((line) => /^LDN_BOOT reset=(\S+)/.exec(line)).find(Boolean);
      if (this.info && boot) this.info.reset = boot[1];
      this.attached = true;
    } finally {
      this.attaching = false;
    }
    this.emit('attached', this.info);
  }

  private worthAnotherTry(attempt: number, lastChance: boolean): boolean {
    const text = this.bootText;
    if (/waiting for download|invalid header|No bootable app|ESP_ERROR_CHECK failed|abort\(\) was called|Guru Meditation/i.test(text)) {
      return false;
    }
    const project = /Project name:\s+(\S+)/.exec(text)?.[1];
    if (project && !project.startsWith('ldn_bridge')) return false;
    if (BOOT_SIGNS.test(text)) return Date.now() - this.bootSignAt < 3000;
    return lastChance && attempt === 0 && text.length === 0;
  }

  private silenceExplained(): EspDeviceError {
    const text = this.bootText;
    if (/waiting for download/i.test(text)) {
      return new EspDeviceError('The ESP32 is sitting in its bootloader.', 'download-mode');
    }
    if (/invalid header|No bootable app/i.test(text)) {
      return new EspDeviceError('No bridge firmware answered on this port.', 'no-firmware');
    }
    const crash = /ESP_ERROR_CHECK failed[^\r\n]*|abort\(\) was called[^\r\n]*|Guru Meditation Error[^\r\n]*|Brownout detector was triggered/.exec(text);
    const restarts = (text.match(/rst:0x/g) ?? []).length;
    if (crash || restarts >= 2) {
      const detail = ['file:', 'func:', 'expression:']
        .map((label) => new RegExp(`${label}[^\\r\\n]*`).exec(text)?.[0])
        .filter(Boolean)
        .join(' ');
      return new EspDeviceError(
        'The firmware on this board crashes as it starts, and restarts.',
        'crash-loop',
        [crash?.[0], detail].filter(Boolean).join(' '),
      );
    }
    const project = /Project name:\s+(\S+)/.exec(text)?.[1];
    if (project && !project.startsWith('ldn_bridge')) {
      return new EspDeviceError(`This board is running other firmware (${project}).`, 'no-firmware');
    }
    return new EspDeviceError('No bridge firmware answered on this port.', 'no-firmware', undefined, true);
  }

  private onData(chunk: Buffer): void {
    if (!this.attached) {
      const text = chunk.toString('latin1');
      this.bootText = (this.bootText + text).slice(-16384);
      if (BOOT_SIGNS.test(this.bootText.slice(-(text.length + 32)))) this.bootSignAt = Date.now();
    }
    this.watchForReboot(chunk);
    for (const frame of this.decoder.push(chunk)) {
      try {
        this.handleFrame(frame);
      } catch (error) {
        this.emit('log', `frame handling failed: ${(error as Error).message}`);
      }
    }
  }

  private onPortClosed(): void {
    this.readEnded = true;
    const port = this.port;
    this.port = null;
    this.finishPending();
    const wasAttached = this.attached;
    this.attached = false;
    if (port && !this.closedByUs && wasAttached) this.emit('disconnected');
  }

  /** A software restart keeps the USB port open; only the boot banner shows the chip is back in text mode. */
  private watchForReboot(chunk: Buffer): void {
    this.recentText = (this.recentText + chunk.toString('latin1')).slice(-6144);
    const joined = Buffer.concat([this.bannerTail, chunk]);
    this.bannerTail = Buffer.from(joined.subarray(Math.max(0, joined.length - (BOOT_BANNER.length - 1))));
    if (joined.indexOf(BOOT_BANNER) < 0) return;
    this.bannerSeen = true;
    if (this.attaching) this.finishPending();
    if (!this.attached || this.attaching) return;
    this.attached = false;
    const report = this.recentText.match(CRASH_LINES);
    this.recentText = '';
    if (report) this.emit('log', `the board crashed: ${report.map((l) => l.trim()).join(' | ')}`);
    this.emit('restarted');
    void sleep(REATTACH_DELAY_MS)
      .then(() => this.attach())
      .then(() => this.emit('reattached'))
      .catch((error: Error) => this.emit('failed', error));
  }

  private handleFrame(frame: EspFrame): void {
    if (frame.kind === EspKind.AdapterOut) {
      this.emit('adapter-frame', frame.payload);
      return;
    }
    if (frame.kind !== EspKind.Response && frame.kind !== EspKind.Event) return;
    const text = frame.payload.toString('utf8').trim();
    const pending = this.pending;
    if (pending && frame.request === pending.request) {
      if (text === 'LDN_DONE') {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending = null;
        pending.resolve(pending.lines);
      } else {
        pending.lines.push(text);
      }
      return;
    }
    if (text && text !== 'LDN_DONE') this.emit('event', text);
  }

  /** One request at a time; resolves with the reply lines, or what arrived before the timeout. */
  command(text: string, timeoutMs = 2000, handshake = false): Promise<string[]> {
    const run = (): Promise<string[]> =>
      new Promise((resolve, reject) => {
        if (!this.port) return reject(new EspDeviceError('Not connected', 'not-connected'));
        if (!this.attached && !handshake) return reject(new EspDeviceError('The ESP32 is restarting', 'restarting'));
        const request = (this.request = (this.request % 0x7fffffff) + 1);
        const entry: Pending = { request, lines: [], resolve, timer: null };
        entry.timer = setTimeout(() => {
          if (this.pending === entry) this.pending = null;
          resolve(entry.lines);
        }, timeoutMs);
        this.pending = entry;
        this.writeRaw(buildEspFrame(EspKind.Command, request, this.session, Buffer.from(text, 'utf8'))).catch((error: Error) => {
          if (entry.timer) clearTimeout(entry.timer);
          if (this.pending === entry) this.pending = null;
          reject(error);
        });
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private finishPending(): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(pending.lines);
  }

  /** Adapter bytes to the board's bridge (kind 7). */
  sendAdapter(bytes: Uint8Array): void {
    if (!this.attached) return;
    this.writeRaw(buildEspFrame(EspKind.AdapterIn, 0, this.session, bytes)).catch(() => undefined);
  }

  private writeRaw(bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.port;
      if (!port) return reject(new EspDeviceError('Not connected', 'not-connected'));
      port.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
  }

  async keyStatus(): Promise<EspKeyStatus | null> {
    const lines = await this.command('LDN_KEYS');
    const line = lines.find((l) => l.startsWith('LDN_KEYS '));
    return line ? parseKeyStatus(line) : null;
  }

  async startBridge(): Promise<void> {
    await this.command('LDN_BRIDGE_START');
  }

  async bridgeStatus(): Promise<Record<string, string> | null> {
    const lines = await this.command('LDN_BRIDGE_STATUS', 1500);
    const line = lines.find((l) => l.startsWith('LDN_BRIDGE_STATUS '));
    if (!line) return null;
    const fields: Record<string, string> = {};
    for (const part of line.split(/\s+/).slice(1)) {
      const at = part.indexOf('=');
      if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1);
    }
    return fields;
  }

  async adapterPort(): Promise<string | null> {
    const lines = await this.command('LDN_ADAPTER');
    return lines.find((l) => l.startsWith('LDN_ADAPTER '))?.slice(12) ?? null;
  }

  async setAdapterPort(where: 'host' | 'uart'): Promise<boolean> {
    const lines = await this.command(`LDN_ADAPTER ${where}`, 3000);
    return lines.includes(`LDN_ADAPTER ${where}`);
  }

  async close(): Promise<void> {
    const port = this.port;
    this.closedByUs = true;
    this.port = null;
    this.attached = false;
    this.finishPending();
    if (!port) return;
    await new Promise<void>((resolve) => {
      if (!port.isOpen) return resolve();
      port.close(() => resolve());
    });
  }
}

/** Why a serial port would not open, in words a player can act on. */
export function portOpenError(path: string, error: Error): EspDeviceError {
  const text = error.message;
  if (/permission denied|EACCES/i.test(text)) {
    return new EspDeviceError(
      `No permission to open the ESP32 board's port (${path}). On Linux, add yourself to the dialout group (uucp on Arch) and log in again.`,
      'port-busy',
    );
  }
  if (/no such file|ENOENT|cannot find/i.test(text)) {
    return new EspDeviceError(`The ESP32 board's port (${path}) is gone.`, 'port-lost');
  }
  if (/busy|lock|temporarily unavailable|access is denied/i.test(text)) {
    return new EspDeviceError(
      `The ESP32 board's port (${path}) is in use by another program. Close switch.gblink.io and any serial monitor.`,
      'port-busy',
    );
  }
  return new EspDeviceError(`The ESP32 board's port (${path}) would not open: ${text}`, 'port-busy');
}

function moreTelling(earlier: EspDeviceError | null, later: EspDeviceError): EspDeviceError {
  return earlier && later.silent && !earlier.silent ? earlier : later;
}

export function parseInfo(line: string): EspInfo | null {
  const match = /^LDN_INFO (\S+) (\S+) chip=(\S+) transport=(.+)$/.exec(line);
  return match ? { name: match[1]!, version: match[2]!, chip: match[3]!, transport: match[4]! } : null;
}

export function parseKeyStatus(line: string): EspKeyStatus {
  const has = (name: string): boolean => new RegExp(`\\b${name}=1\\b`).test(line);
  const status = {
    kek: has('kek'),
    gen: has('gen'),
    master00: has('master00'),
    master12: has('master12'),
    protocol1: has('protocol1'),
    protocol3: has('protocol3'),
  };
  return { ...status, complete: Object.values(status).every(Boolean) };
}
