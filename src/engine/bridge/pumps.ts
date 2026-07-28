import type { PumpTimings, Round } from '../types';
import { DEFAULT_PUMP_TIMINGS } from '../types';

const TICK_MS = 5;
const QUEUE_DEPTH_WARN = 64;
const ROUND_WORDS = 8;
const ROUND_BYTES = ROUND_WORDS * 2;
const ROUNDS_PER_WRITE = 4;
const WRITE_BYTES = ROUNDS_PER_WRITE * ROUND_BYTES;

/**
 * LINKCMD values a data round must never carry: they collide with firmware
 * status words (AwaitMode/LinkReconnecting/LinkClosed) and the firmware
 * would coerce them to 0x5FFF. Real gpsp data cannot produce them.
 */
const RESERVED_CMD_WORDS = new Set([0xff02, 0xff06, 0xff07]);

function isAllZero(round: Round): boolean {
  return round.every((w) => w === 0);
}

/** Serialize up to 4 rounds as one 64-byte firmware write (u16 LE), zero-padded. */
export function roundsToBuffer(rounds: Round[]): Buffer {
  if (rounds.length > ROUNDS_PER_WRITE) {
    throw new RangeError(`expected at most ${ROUNDS_PER_WRITE} rounds, got ${rounds.length}`);
  }
  const buf = Buffer.alloc(WRITE_BYTES);
  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i]!;
    for (let j = 0; j < ROUND_WORDS; j++) {
      buf.writeUInt16LE(round[j] ?? 0, (i * ROUND_WORDS + j) * 2);
    }
  }
  return buf;
}

export function bufferToRounds(buf: Buffer): Round[] {
  if (buf.length % ROUND_BYTES !== 0) {
    throw new RangeError(`buffer length ${buf.length} is not a multiple of ${ROUND_BYTES}`);
  }
  const rounds: Round[] = [];
  for (let off = 0; off < buf.length; off += ROUND_BYTES) {
    const round = new Uint16Array(ROUND_WORDS);
    for (let j = 0; j < ROUND_WORDS; j++) {
      round[j] = buf.readUInt16LE(off + j * 2);
    }
    rounds.push(round);
  }
  return rounds;
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

/**
 * Batches netplay rounds into the exactly-64-byte (4 x 8-u16-LE) writes the
 * firmware data OUT endpoint requires, zero-padding stragglers on a timer.
 */
export class RoundBatcher {
  private readonly timings: Required<PumpTimings>;
  private pending: Round[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly write64: (buf: Buffer) => void,
    timings?: PumpTimings,
    private readonly onAnomaly?: (msg: string) => void,
  ) {
    this.timings = { ...DEFAULT_PUMP_TIMINGS, ...timings };
  }

  push(round: Round): void {
    const cmd = round[0] ?? 0;
    if (RESERVED_CMD_WORDS.has(cmd)) {
      this.onAnomaly?.(`dropped round with reserved status word 0x${cmd.toString(16)} in word 0`);
      return;
    }
    this.pending.push(new Uint16Array(round));
    if (this.pending.length >= ROUNDS_PER_WRITE) {
      this.flush();
    } else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), this.timings.batchFlushMs);
    }
  }

  clear(): void {
    this.pending = [];
    this.cancelTimer();
  }

  dispose(): void {
    this.clear();
  }

  private cancelTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flush(): void {
    this.cancelTimer();
    const rounds = this.pending;
    this.pending = [];
    // An all-zero write is indistinguishable from link noise to the GBA — skip.
    if (rounds.length === 0 || rounds.every(isAllZero)) return;
    this.write64(roundsToBuffer(rounds));
  }
}
