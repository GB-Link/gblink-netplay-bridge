import type { BridgeMode } from '../bridge/linkBridge';
import { AwState, type AwVariant, type Maw1Frame } from './maw1';

/** VS packet types: the low byte of the first word after [size, checksum (two in AW2)]. */
interface VsPackets {
  headerWords: number;
  entry: number;
  start: number;
  /** Setup data, sent after START. */
  data: number;
  ready: number;
  /** False for AW2: a held READY lets the host's READY arrive first, and the host then never ends setup. */
  timeReadyJoining: boolean;
}
const VS_PACKETS: Record<AwVariant, VsPackets> = {
  aw1: { headerWords: 2, entry: 0x2c, start: 0x3f, data: 0x3b, ready: 0x3a, timeReadyJoining: true },
  aw2: { headerWords: 3, entry: 0xad, start: 0xaf, data: 0xab, ready: 0xaa, timeReadyJoining: false },
};
/** Shorter packets are lobby entries and replies; longer ones are setup data, sent back to back. */
const LONG_PACKET_CNT = 40;

/** A game in the VS lobby queues its entry every 17 frames. */
const ENTRY_FRAMES = 17;
const ANCHORS_KEPT = 12;
/** START goes this many frames after the peer's latest entry, less the round trip, to land mid-entry. */
const START_LEAD_FRAMES = 2.5;
/** Setup data and READY are aimed this far into the peer's next long packet, less hand-over and act time. */
const INTO_PACKET_FRAMES = 10;
const ACT_FRAMES = 1.5;
/**
 * Joining, the host resends START (~7 frames) then setup data (~28) at ~2.5 words a frame.
 * Our setup data takes ~28 frames to reach the game, so it is aimed at the middle of the host's: 49 frames after START.
 */
const HOST_WORDS_PER_FRAME = 2.5;
const JOIN_DATA_AIM_FRAMES = 49;
/** Longer than the host's START resend interval: past it, aim at its long packets instead. */
const START_RESEND_WAIT_MS = 1200;
/** gpsp hands its game one queued word per serial interrupt, just over 2 a frame. */
const PEER_WORDS_PER_FRAME = 2;
/** A held packet lands at least this long after gpsp's queue of our words should be empty. */
const QUEUE_MARGIN_FRAMES = 4;
/** gpsp drops what does not fit its 512-word queue (MAX_FPACK). */
const PEER_QUEUE_WORDS = 512;
const MAX_HOLD_MS = 4000;
/** Hosting: our setup data can come before the peer's first long packet to aim by. */
const ANCHOR_WAIT_MS = 2000;
/** Older anchors no longer predict the peer's packets. */
const ANCHOR_STALE_MS = 1500;
/** Games resend START, setup data and READY until answered; a START this long after the last begins a new phase. */
const NEW_PHASE_AFTER_MS = 4000;
const DEFAULT_FRAME_MS = 1000 / 59.7275;

export interface PhaseGateHooks {
  now: () => number;
  rtt: () => number | undefined;
  send: (packet: Buffer) => void;
  log: (msg: string) => void;
}

interface Plan {
  /** Arrival time of the peer packet the aim counts from. */
  anchor: number;
  lead: number;
  period: number;
}

function packetType(frame: Maw1Frame, header: number): number | null {
  if (frame.state !== AwState.PacketXg || frame.cnt <= header) return null;
  if (frame.cnt !== (frame.words[0] ?? 0) + header) return null;
  return (frame.words[header] ?? 0) & 0xff;
}

/** Serial interrupts gpsp needs to hand a frame to its game: command, words, trailing idle word. */
function peerWords(frame: Maw1Frame): number {
  if (frame.cnt < 2) return 0;
  return frame.state === AwState.PacketXg ? frame.cnt + 2 : frame.cnt;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

function remember(list: number[], at: number): void {
  list.push(at);
  if (list.length > ANCHORS_KEPT) list.shift();
}

/**
 * Holds the packets after which a gpsp peer's game empties its send queue (START when hosting,
 * setup data, READY) so they land mid-packet, where a cut packet only fails its checksum.
 *
 * Emptied just after a packet's first word, the idle word reads as a 255-word length and gpsp
 * overruns serialaw_senddata's u32 pkt[130], closing RetroArch. The RetroArch player's own START
 * can't be covered: their game empties its queue the frame they press it.
 */
export class PhaseGate {
  private held: Array<{ frame: Maw1Frame; packet: Buffer }> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Aims the held packet when the peer's next long packet arrives. */
  private aimOnNextLong: ((now: number) => number) | null = null;
  /** Joining: frames after the host's next START at which the held packet goes, less the round trip. */
  private afterPeerStart: number | null = null;
  /** Joining: the held packet's length, to aim at the host's long packets once START resends stop. */
  private joinHeldWords: number | null = null;
  private readonly entries: number[] = [];
  private lastLong: { at: number; cnt: number } | null = null;
  /** Our GBA's latest START (hosting) or the peer's (joining). */
  private lastStart = -Infinity;
  /** The phase's first setup data and READY are still to come. */
  private dataArmed = false;
  private readyArmed = false;
  /** When gpsp will have handed its game everything we sent. */
  private busyUntil = 0;
  private readonly vs: VsPackets;

  constructor(
    private readonly mode: BridgeMode,
    variant: AwVariant,
    private readonly hooks: PhaseGateHooks,
  ) {
    this.vs = VS_PACKETS[variant];
  }

  /** A frame from the gpsp peer. */
  observe(frame: Maw1Frame): void {
    const type = packetType(frame, this.vs.headerWords);
    if (type === null) return;
    const now = this.hooks.now();
    if (type === this.vs.entry) remember(this.entries, now);
    else if (type === this.vs.start && this.mode === 'join') {
      this.startSeen(now);
      const after = this.afterPeerStart;
      const rtt = this.hooks.rtt() ?? 0;
      // Not while gpsp still queues earlier frames: the held packet would land late by as much.
      if (after !== null && this.held !== null && now + rtt / 2 >= this.busyUntil) {
        this.afterPeerStart = null;
        this.joinHeldWords = null;
        this.schedule(Math.max(0, after * this.frameMs() - rtt));
      }
    }
    if (frame.cnt >= LONG_PACKET_CNT) {
      this.lastLong = { at: now, cnt: frame.cnt };
      const aim = this.aimOnNextLong;
      this.aimOnNextLong = null;
      if (aim !== null && this.held !== null) this.schedule(Math.max(0, aim(now) - now));
    }
  }

  /** Our GBA's frame to the peer; false when held. */
  pass(frame: Maw1Frame, packet: Buffer): boolean {
    if (this.held !== null) {
      this.held.push({ frame, packet });
      return false;
    }
    const words = peerWords(frame);
    const type = packetType(frame, this.vs.headerWords);
    const now = this.hooks.now();
    let at = now;
    if (type === this.vs.start && this.mode === 'host') {
      if (this.startSeen(now)) at = this.releaseAt(now, this.startPlan(now));
    } else if ((type === this.vs.data && this.dataArmed) || (type === this.vs.ready && this.readyArmed)) {
      const isData = type === this.vs.data;
      if (isData) this.dataArmed = false;
      else this.readyArmed = false;
      if (this.mode === 'join') {
        // READY reaches the game within a few frames, so it goes as the next START arrives.
        this.afterPeerStart = isData ? JOIN_DATA_AIM_FRAMES - words / HOST_WORDS_PER_FRAME - ACT_FRAMES : 0;
        this.joinHeldWords = words;
        this.hold(frame, packet, START_RESEND_WAIT_MS, isData ? 'setup data' : 'ready');
        return false;
      } else {
        const plan = this.longPacketPlan(now, words, PEER_WORDS_PER_FRAME);
        if (plan !== null) {
          at = this.releaseAt(now, plan);
        } else {
          this.hold(frame, packet, ANCHOR_WAIT_MS, isData ? 'setup data' : 'ready');
          this.aimOnNextLong = (t) => {
            const next = this.longPacketPlan(t, words, PEER_WORDS_PER_FRAME);
            return next === null ? t : this.releaseAt(t, next);
          };
          return false;
        }
      }
    }
    if (at > now) {
      const what = type === this.vs.start ? 'START' : type === this.vs.data ? 'setup data' : 'ready';
      this.hold(frame, packet, at - now, what);
      return false;
    }
    this.noteSent(words);
    return true;
  }

  /** The link section ended; anything held is stale. */
  reset(): void {
    this.clearTimer();
    this.held = null;
    this.aimOnNextLong = null;
    this.afterPeerStart = null;
    this.joinHeldWords = null;
    this.entries.length = 0;
    this.lastLong = null;
    this.lastStart = -Infinity;
    this.dataArmed = false;
    this.readyArmed = false;
    this.busyUntil = 0;
  }

  /** True when this START begins a phase rather than resending. */
  private startSeen(now: number): boolean {
    const first = now - this.lastStart > NEW_PHASE_AFTER_MS;
    this.lastStart = now;
    if (first) {
      this.dataArmed = true;
      this.readyArmed = this.mode === 'host' || this.vs.timeReadyJoining;
    }
    return first;
  }

  /** Hosting: aims at the peer's lobby entries, jitter smoothed onto the latest cycle. */
  private startPlan(now: number): Plan | null {
    const latest = this.entries.at(-1);
    if (latest === undefined || this.entries.length < 2 || now - latest > ANCHOR_STALE_MS) return null;
    const period = ENTRY_FRAMES * this.frameMs();
    const anchor = median(this.entries.map((t) => t + Math.round((latest - t) / period) * period));
    return { anchor, lead: START_LEAD_FRAMES, period };
  }

  /** Aims at the peer's next long packet, sent back to back at `rate` words a frame. */
  private longPacketPlan(now: number, words: number, rate: number): Plan | null {
    const long = this.lastLong;
    if (long === null || now - long.at > ANCHOR_STALE_MS) return null;
    const lead = INTO_PACKET_FRAMES - words / rate - ACT_FRAMES;
    const period = ((long.cnt + 1) / rate) * this.frameMs();
    return { anchor: long.at, lead, period };
  }

  /** On the aim, and after gpsp has drained what we sent before. */
  private releaseAt(now: number, plan: Plan | null): number {
    const rtt = this.hooks.rtt();
    if (plan === null || rtt === undefined || plan.period <= 0) return now;
    const frameMs = this.frameMs();
    let at = plan.anchor + plan.lead * frameMs - rtt;
    while (at < now) at += plan.period;
    while (at + rtt / 2 < this.busyUntil + QUEUE_MARGIN_FRAMES * frameMs) at += plan.period;
    return at - now <= MAX_HOLD_MS ? at : now;
  }

  private hold(frame: Maw1Frame, packet: Buffer, ms: number, what: string): void {
    this.held = [{ frame, packet }];
    this.hooks.log(`holding our ${what} up to ${Math.round(ms)} ms so the other gpsp is mid-packet when it lands`);
    this.schedule(ms);
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onHoldTimer();
    }, ms);
    this.timer.unref?.();
  }

  private onHoldTimer(): void {
    const words = this.joinHeldWords;
    this.joinHeldWords = null;
    if (words === null || this.held === null) {
      this.release();
      return;
    }
    // No START resend came: the host has moved on to its long packets.
    this.afterPeerStart = null;
    const now = this.hooks.now();
    const at = this.releaseAt(now, this.longPacketPlan(now, words, HOST_WORDS_PER_FRAME));
    if (at > now) this.schedule(at - now);
    else this.release();
  }

  /** Frames queued behind the held packet go through the gate again, as they may start a later phase. */
  private release(): void {
    const held = this.held;
    if (held === null) return;
    this.clearTimer();
    this.held = null;
    this.aimOnNextLong = null;
    this.afterPeerStart = null;
    this.joinHeldWords = null;
    const [first, ...rest] = held;
    if (first === undefined) return;
    this.hooks.send(first.packet);
    this.noteSent(peerWords(first.frame));
    for (const { frame, packet } of rest) {
      if (this.pass(frame, packet)) this.hooks.send(packet);
    }
  }

  private noteSent(words: number): void {
    if (words === 0) return;
    const arrival = this.hooks.now() + (this.hooks.rtt() ?? 0) / 2;
    const perWord = this.frameMs() / PEER_WORDS_PER_FRAME;
    this.busyUntil = Math.min(
      Math.max(this.busyUntil, arrival) + words * perWord,
      arrival + PEER_QUEUE_WORDS * perWord,
    );
  }

  /** The peer's frame time, measured across all kept entries to divide out arrival jitter. */
  private frameMs(): number {
    const first = this.entries[0];
    const last = this.entries.at(-1);
    if (first === undefined || last === undefined || this.entries.length < 3) return DEFAULT_FRAME_MS;
    const cycles = Math.round((last - first) / (ENTRY_FRAMES * DEFAULT_FRAME_MS));
    if (cycles < 2) return DEFAULT_FRAME_MS;
    const ms = (last - first) / (cycles * ENTRY_FRAMES);
    return ms > 15 && ms < 19 ? ms : DEFAULT_FRAME_MS;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
