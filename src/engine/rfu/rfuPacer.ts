import { frameClock } from '../frameClock';
import { RFU1_HEADER_LEN, RFU1_PAYLOAD_MAX, RfuType } from './rfu1';

const FRAME_MS = 1000 / 59.7275;
/** Superseded held-keys reports are shed beyond this many queued child frames (the firmware's hostShedAt). */
const SHED_AT = 3;
/**
 * Idle parent frames are dropped only once this many wait: the child sends one frame per new
 * parent frame (link_rfu_2.c MscCallback_Child), so collapsing each bunch would slow it down.
 */
const TRIM_AT = 8;
/** A link this far behind has lost its reader; the oldest frames go. */
const MAX_QUEUED = 256;
const CMD_SEND_HELD_KEYS = 0xbe;

interface Link {
  frames: Buffer[];
  /** Child frames: a report was shed, so command tags are renumbered. */
  restamp: boolean;
  outTag: number;
  lastCommand: Buffer | null;
}

function payloadOf(frame: Buffer): Buffer {
  const header = frame.readUInt32BE(8);
  const type = frame.readUInt32BE(4);
  const len = type === RfuType.HostSend ? header & 0x7f : header >>> 24;
  return frame.subarray(RFU1_HEADER_LEN, RFU1_HEADER_LEN + Math.min(len, RFU1_PAYLOAD_MAX));
}

function allZero(p: Buffer): boolean {
  for (const b of p) if (b) return false;
  return true;
}

/** A parent frame of the UNI stream: LLSF state (header bits 14-17) 4. */
function isParentUni(p: Buffer): boolean {
  if (p.length < 3) return false;
  return ((((p[0] ?? 0) | ((p[1] ?? 0) << 8) | ((p[2] ?? 0) << 16)) >> 14) & 0xf) === 4;
}

/** Any of a parent UNI frame's 14-byte slots carries a command word: the parent sends it once. */
function parentUniHasCommand(p: Buffer): boolean {
  for (let off = 3; off + 2 <= p.length; off += 14) if (p[off] || p[off + 1]) return true;
  return false;
}

/** Child frame: 2-byte LLSF header, then a slot whose byte 1 is the command's high byte. */
function childHasCommand(p: Buffer): boolean {
  return p.length >= 4 && p[3] !== 0;
}

/** A held-keys report of no key or a direction: a later one supersedes it. */
function childSuperseded(p: Buffer): boolean {
  if (p.length < 5 || p[3] !== CMD_SEND_HELD_KEYS) return false;
  const key = p[4] ?? 0;
  return key === 0 || (key >= 0x11 && key <= 0x15);
}

/**
 * Releases the device's data frames to each netplay client at one per GBA frame, queued like the
 * GB-Link firmware's own (rfuProtocol.hpp PktQueue).
 *
 * gpsp keeps four frames per link, drops what arrives while full, and its game reads one a frame,
 * but an ESP32 board delivers the Switch's frames in bunches. A lost frame hangs the games (a child
 * command tag gap, a missing block fragment), so only superseded frames are dropped, under a backlog.
 */
export class RfuPacer {
  private readonly links = new Map<number, Link>();
  private stopClock: (() => void) | null = null;

  constructor(private readonly deliver: (frame: Buffer, dest: number) => void) {}

  /** The pacer owns `frame` from here. */
  push(frame: Buffer, dest: number): void {
    let link = this.links.get(dest);
    if (!link) {
      link = { frames: [], restamp: false, outTag: 0, lastCommand: null };
      this.links.set(dest, link);
    }
    const type = frame.readUInt32BE(4);
    const p = payloadOf(frame);
    const queue = link.frames;
    if (type === RfuType.HostSend) {
      const backlog = queue.length >= TRIM_AT;
      // An idle frame only keeps the reader's pump turning, which the waiting ones already do.
      if (allZero(p) && backlog) return;
      const tail = queue.at(-1);
      if (tail && backlog && isParentUni(p)) {
        const tp = payloadOf(tail);
        if (isParentUni(tp) && !parentUniHasCommand(tp)) {
          queue[queue.length - 1] = frame;
          return;
        }
      }
      queue.push(frame);
    } else {
      // An empty child frame reads like no frame at all to the parent's game.
      if (allZero(p)) return;
      if (childHasCommand(p)) {
        // Once tags are renumbered, an unchanged resend would be acted on twice.
        if (link.restamp && link.lastCommand?.equals(p)) return;
        link.lastCommand = Buffer.from(p);
      }
      queue.push(frame);
      while (queue.length > SHED_AT) {
        const i = queue.findIndex((f, k) => k < queue.length - 1 && childSuperseded(payloadOf(f)));
        if (i < 0) break;
        queue.splice(i, 1);
        link.restamp = true;
      }
    }
    if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
    this.startClock();
  }

  drop(dest: number): void {
    this.links.delete(dest);
    if (this.links.size === 0) this.halt();
  }

  queued(dest: number): number {
    return this.links.get(dest)?.frames.length ?? 0;
  }

  stop(): void {
    this.links.clear();
    this.halt();
  }

  private startClock(): void {
    if (!this.stopClock) this.stopClock = frameClock(() => this.tick(), FRAME_MS);
  }

  private halt(): void {
    this.stopClock?.();
    this.stopClock = null;
  }

  private tick(): void {
    let waiting = false;
    for (const [dest, link] of this.links) {
      const frame = link.frames.shift();
      if (!frame) continue;
      if (frame.readUInt32BE(4) === RfuType.ClientSend) this.stamp(link, frame);
      this.deliver(frame, dest);
      if (link.frames.length > 0) waiting = true;
    }
    if (!waiting) this.halt();
  }

  /** The parent takes only the previous tag + 1: once a report was shed, tags are renumbered. */
  private stamp(link: Link, frame: Buffer): void {
    const p = payloadOf(frame);
    if (!childHasCommand(p)) return;
    if (link.restamp) p[2] = ((p[2] ?? 0) & 0x1f) | (link.outTag << 5);
    link.outTag = (((p[2] ?? 0) >> 5) + 1) & 7;
  }
}
