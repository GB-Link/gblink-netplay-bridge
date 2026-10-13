/**
 * MAW1 framing: gpsp's Advance Wars netpacket (serial_proto.c) and the firmware's byte stream of it (awProtocol.hpp).
 *
 * Frame: "MAW1" | cmd u16 BE | state u8 | cnt u8 | cnt x u16 BE.
 * gpsp accepts a netpacket only at exactly 8 + 2*cnt bytes, so each frame travels alone.
 */

export const MAW1_MAGIC_BYTES = [0x4d, 0x41, 0x57, 0x31] as const;
export const MAW1_HEADER_LEN = 8;
/** Data-endpoint transfer size: the firmware chunks its MAW1 stream into 64-byte pieces. */
export const AW_CHUNK_LEN = 64;
/** gpsp dequeues with a u8 cursor that must reach cnt+1 for a PACKETXG entry, so a 255-word one replays forever. */
export const MAW1_TX_MAX_CNT = 254;
/** The wire field is 8 bits; inbound frames up to 255 words are still well-formed. */
export const MAW1_RX_MAX_CNT = 255;

export const CMD_NONE = 0x7fff;
export const CMD_NOP = 0x5fff;

export enum AwState {
  PacketXg = 0,
  Sync = 1,
  Intersync = 2,
}

export type AwVariant = 'aw1' | 'aw2';

export const AW_SYNC_WORD: Record<AwVariant, number> = { aw1: 0x5678, aw2: 0x9abc };
export const AW_PACK_TAIL: Record<AwVariant, number> = { aw1: 1, aw2: 2 };
/** Third SetMode byte for firmware mode 0x04. */
export const AW_MODE_VARIANT: Record<AwVariant, number> = { aw1: 1, aw2: 2 };

export function otherVariant(v: AwVariant): AwVariant {
  return v === 'aw1' ? 'aw2' : 'aw1';
}

export interface Maw1Frame {
  cmd: number;
  state: number;
  cnt: number;
  words: Uint16Array;
}

export function serializeMaw1(cmd: number, state: number, words: ArrayLike<number>): Buffer {
  if (words.length > MAW1_RX_MAX_CNT) {
    throw new RangeError(`MAW1 frame cannot carry ${words.length} words (max ${MAW1_RX_MAX_CNT})`);
  }
  const out = Buffer.alloc(MAW1_HEADER_LEN + 2 * words.length);
  out[0] = MAW1_MAGIC_BYTES[0];
  out[1] = MAW1_MAGIC_BYTES[1];
  out[2] = MAW1_MAGIC_BYTES[2];
  out[3] = MAW1_MAGIC_BYTES[3];
  out.writeUInt16BE(cmd & 0xffff, 4);
  out[6] = state & 0xff;
  out[7] = words.length;
  for (let i = 0; i < words.length; i++) {
    out.writeUInt16BE((words[i] ?? 0) & 0xffff, MAW1_HEADER_LEN + 2 * i);
  }
  return out;
}

export function serializeFrame(frame: Maw1Frame): Buffer {
  return serializeMaw1(frame.cmd, frame.state, frame.words);
}

function hasMagic(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === MAW1_MAGIC_BYTES[0] &&
    buf[1] === MAW1_MAGIC_BYTES[1] &&
    buf[2] === MAW1_MAGIC_BYTES[2] &&
    buf[3] === MAW1_MAGIC_BYTES[3]
  );
}

export function maw1Problem(buf: Buffer): string | null {
  if (buf.length < MAW1_HEADER_LEN) return `short (${buf.length} bytes)`;
  if (!hasMagic(buf)) return 'bad magic';
  const cnt = buf[7] ?? 0;
  if (cnt > MAW1_RX_MAX_CNT) return `cnt ${cnt}`;
  const expected = MAW1_HEADER_LEN + 2 * cnt;
  if (buf.length !== expected) return `length ${buf.length} != 8+2*${cnt}`;
  return null;
}

/** gpsp's acceptance rules: magic, and length exactly 8 + 2*cnt. */
export function parseMaw1(buf: Buffer): Maw1Frame | null {
  if (maw1Problem(buf) !== null) return null;
  const cnt = buf[7] ?? 0;
  const words = new Uint16Array(cnt);
  for (let i = 0; i < cnt; i++) words[i] = buf.readUInt16BE(MAW1_HEADER_LEN + 2 * i);
  return { cmd: buf.readUInt16BE(4), state: buf[6] ?? 0, cnt, words };
}

export function isStateOnly(frame: Maw1Frame): boolean {
  return frame.cnt === 0;
}

/**
 * Port of the firmware's Maw1StreamParser: frames span 64-byte chunks with zero-padded tails,
 * and it resyncs on the magic, which zero padding can't match.
 */
export class Maw1StreamParser {
  private magicIdx = 0;
  private hdrIdx = 0;
  private readonly hdr = [0, 0, 0, 0];
  private cmd = 0;
  private state = 0;
  private cnt = 0;
  private payloadIdx = 0;
  private words = new Uint16Array(MAW1_RX_MAX_CNT);

  constructor(private readonly onFrame: (frame: Maw1Frame) => void) {}

  push(data: Buffer): void {
    for (let i = 0; i < data.length; i++) this.pushByte(data[i]!);
  }

  reset(): void {
    this.magicIdx = 0;
    this.hdrIdx = 0;
    this.payloadIdx = 0;
  }

  private pushByte(b: number): void {
    if (this.magicIdx < 4) {
      if (b === MAW1_MAGIC_BYTES[this.magicIdx]) this.magicIdx++;
      else this.magicIdx = b === MAW1_MAGIC_BYTES[0] ? 1 : 0;
      return;
    }
    if (this.hdrIdx < 4) {
      this.hdr[this.hdrIdx++] = b;
      if (this.hdrIdx === 4) {
        this.cmd = ((this.hdr[0]! << 8) | this.hdr[1]!) & 0xffff;
        this.state = this.hdr[2]!;
        this.cnt = this.hdr[3]!;
        this.payloadIdx = 0;
        if (this.cnt === 0) this.finishFrame();
      }
      return;
    }
    const w = this.payloadIdx >> 1;
    if ((this.payloadIdx & 1) === 0) this.words[w] = b << 8;
    else this.words[w] = (this.words[w]! | b) & 0xffff;
    this.payloadIdx++;
    if (this.payloadIdx === 2 * this.cnt) this.finishFrame();
  }

  private finishFrame(): void {
    const frame: Maw1Frame = {
      cmd: this.cmd,
      state: this.state,
      cnt: this.cnt,
      words: this.words.slice(0, this.cnt),
    };
    this.magicIdx = 0;
    this.hdrIdx = 0;
    this.onFrame(frame);
  }
}

/**
 * Packs frames into the 64-byte writes the firmware's data OUT endpoint takes. Frames queued in one
 * tick share chunks; the last is zero-padded, which the firmware skips while seeking the magic.
 */
export class Maw1Chunker {
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private scheduled = false;

  constructor(
    private readonly write64: (chunk: Buffer) => void,
    private readonly schedule: (fn: () => void) => void = queueMicrotask,
  ) {}

  get pendingBytes(): number {
    return this.pendingLen;
  }

  push(frame: Buffer): void {
    this.pending.push(frame);
    this.pendingLen += frame.length;
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  flush(): void {
    if (this.pendingLen === 0) return;
    const all = Buffer.concat(this.pending, this.pendingLen);
    this.clear();
    for (let off = 0; off < all.length; off += AW_CHUNK_LEN) {
      const chunk = Buffer.alloc(AW_CHUNK_LEN);
      all.copy(chunk, 0, off, Math.min(off + AW_CHUNK_LEN, all.length));
      this.write64(chunk);
    }
  }

  clear(): void {
    this.pending = [];
    this.pendingLen = 0;
  }
}
