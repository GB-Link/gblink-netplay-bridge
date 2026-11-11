import type { PumpTimings, Round } from '../types';
import { DEFAULT_PUMP_TIMINGS } from '../types';

const TICK_MS = 5;
const QUEUE_DEPTH_WARN = 64;

/**
 * LINKCMD values a data round must never carry: they collide with firmware
 * status words (AwaitPlayerSettings/LinkReconnecting/LinkClosed) and the firmware
 * would coerce them to 0x5FFF. Real gpsp data cannot produce them.
 */
const RESERVED_CMD_WORDS = new Set([0xff02, 0xff06, 0xff07]);

export function isAllZero(round: Round): boolean {
  return round.every((w) => w === 0);
}

export function hasReservedCommand(round: Round): boolean {
  return RESERVED_CMD_WORDS.has(round[0] ?? 0);
}

/**
 * Paces firmware rounds toward the netplay peer: gpsp consumes at most one
 * data MPK1 per ~15 ms, and treats a >4 s silent peer as gone, so an idle
 * link must still heartbeat status-only packets.
 */
export class PacedEmitter {
  /** Fired after a push that leaves more than 64 rounds queued. */
  onDepth?: (depth: number) => void;

  private readonly timings: Required<PumpTimings>;
  private readonly queue: Round[] = [];
  private state = 0;
  private _enabled = false;
  private sinceData = Number.POSITIVE_INFINITY;
  private sinceAny = 0;
  private timer: NodeJS.Timeout | null;

  constructor(
    private readonly send: (state: number, words: Round | null) => void,
    timings?: PumpTimings,
  ) {
    this.timings = { ...DEFAULT_PUMP_TIMINGS, ...timings };
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  pushRounds(rounds: Round[]): void {
    for (const round of rounds) {
      if (!isAllZero(round)) this.queue.push(new Uint16Array(round));
    }
    if (this.queue.length > QUEUE_DEPTH_WARN) this.onDepth?.(this.queue.length);
  }

  setState(s: number): void {
    this.state = s;
  }

  /** Starts disabled: gpsp must hear nothing before PREINIT completes. */
  enable(): void {
    if (this._enabled) return;
    this._enabled = true;
    this.sinceAny = 0;
    this.sinceData = Number.POSITIVE_INFINITY;
  }

  disable(): void {
    this._enabled = false;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  clear(): void {
    this.queue.length = 0;
  }

  /**
   * Send every queued round immediately, ignoring pacing and the enable gate.
   * Used at link teardown: the tail (e.g. the GBA's 0x5FFF close-acks) must
   * still reach the peer — a burst is safe, gpsp queues 128 packets deep.
   */
  flushNow(): number {
    const n = this.queue.length;
    while (this.queue.length > 0) {
      this.send(this.state, this.queue.shift()!);
    }
    if (n > 0) {
      this.sinceData = 0;
      this.sinceAny = 0;
    }
    return n;
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._enabled = false;
    this.queue.length = 0;
  }

  private tick(): void {
    if (!this._enabled) return;
    // Tick-count timekeeping instead of Date.now(): a congested event loop can
    // only slow the cadence down, never burst faster than one data MPK1 per
    // dataEmitMs — and it stays deterministic under fake timers.
    this.sinceData += TICK_MS;
    this.sinceAny += TICK_MS;
    if (this.queue.length > 0 && this.sinceData >= this.timings.dataEmitMs) {
      const words = this.queue.shift()!;
      this.sinceData = 0;
      this.sinceAny = 0;
      this.send(this.state, words);
    } else if (this.sinceAny >= this.timings.statusCadenceMs) {
      this.sinceAny = 0;
      this.send(this.state, null);
    }
  }
}
