import type { Mpk1Packet, Round } from './types';

/** "MPK1" — gpsp serial_proto.c NET_SERPOKE_HEADER. */
export const MPK1_MAGIC = 0x4d504b31;
export const MPK1_LENGTH = 24;

/** Bit 31 of the flags word: an 8-word round payload follows. */
const HAS_DATA_FLAG = 0x80000000;

export function parseMpk1(buf: Buffer): Mpk1Packet | null {
  // gpsp receiver requires len == 24 exactly, not >= 24.
  if (buf.length !== MPK1_LENGTH || buf.readUInt32BE(0) !== MPK1_MAGIC)
    return null;

  const flags = buf.readUInt32BE(4);
  const state = flags & 0xffff;
  if ((flags & HAS_DATA_FLAG) === 0) return { state, words: null };

  const words: Round = new Uint16Array(8);
  for (let i = 0; i < 4; i++) {
    // pack16 puts the even-indexed word in the high half of each BE u32.
    const u32 = buf.readUInt32BE(8 + i * 4);
    words[i * 2] = u32 >>> 16;
    words[i * 2 + 1] = u32 & 0xffff;
  }
  return { state, words };
}

export function buildMpk1(state: number, words: Round | null): Buffer {
  const buf = Buffer.alloc(MPK1_LENGTH);
  buf.writeUInt32BE(MPK1_MAGIC, 0);
  buf.writeUInt32BE(((state & 0xffff) | (words ? HAS_DATA_FLAG : 0)) >>> 0, 4);
  if (words) {
    for (let i = 0; i < 4; i++) {
      const hi = words[i * 2]! & 0xffff;
      const lo = words[i * 2 + 1]! & 0xffff;
      buf.writeUInt32BE(((hi << 16) | lo) >>> 0, 8 + i * 4);
    }
  }
  return buf;
}

export function isZeroRound(r: Round): boolean {
  for (let i = 0; i < r.length; i++) {
    if (r[i] !== 0) return false;
  }
  return true;
}
