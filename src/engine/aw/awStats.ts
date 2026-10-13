import type { AwStats } from '../types';

export const CMD_GET_AW_STATS = 0x14;
/** GetAwStats v1 reply length; never 64, as 64-byte reads on the data endpoint are stream data. */
export const AW_STATS_REPLY_LEN = 63;
export const AW_STATS_FORMAT_V1 = 1;

/**
 * Decode the firmware's GetAwStats (0x14) reply:
 *   0 u8 0x14 | 1 u8 fmt | 2.. 12 x u32 LE counters | 50 u16 rqHighWater |
 *   52 u16 rqCount | 54 u8 state | 55 u8 pstate | 56 u8 remoteState |
 *   57 u8 role | 58 u8 variant | 59 u16 pxgPeriodUs | 61 u16 syncPeriodUs.
 */
export function decodeAwStats(buf: Buffer): AwStats {
  if (buf.length < AW_STATS_REPLY_LEN) {
    throw new Error(`malformed GetAwStats reply (${buf.length} bytes)`);
  }
  if (buf.readUInt8(0) !== CMD_GET_AW_STATS) {
    throw new Error(`GetAwStats reply id 0x${buf.readUInt8(0).toString(16)}`);
  }
  const fmt = buf.readUInt8(1);
  if (fmt !== AW_STATS_FORMAT_V1) throw new Error(`GetAwStats format ${fmt} not supported`);
  const u32 = (off: number): number => buf.readUInt32LE(off);
  return {
    rounds: u32(2),
    txFrames: u32(6),
    txSuppressed: u32(10),
    txDropOversize: u32(14),
    txDropRingFull: u32(18),
    rxFrames: u32(22),
    rxDropQueueFull: u32(26),
    fallbackEcho: u32(30),
    resets: u32(34),
    txChunkRetries: u32(38),
    usbDataStalls: u32(42),
    maxRoundGapMs: u32(46),
    rqHighWater: buf.readUInt16LE(50),
    rqCount: buf.readUInt16LE(52),
    state: buf.readUInt8(54),
    pstate: buf.readUInt8(55),
    remoteState: buf.readUInt8(56),
    role: buf.readUInt8(57),
    variant: buf.readUInt8(58),
    pxgPeriodUs: buf.readUInt16LE(59),
    syncPeriodUs: buf.readUInt16LE(61),
  };
}

/** Inverse of decodeAwStats, for tests. */
export function encodeAwStats(s: AwStats): Buffer {
  const buf = Buffer.alloc(AW_STATS_REPLY_LEN);
  buf.writeUInt8(CMD_GET_AW_STATS, 0);
  buf.writeUInt8(AW_STATS_FORMAT_V1, 1);
  const counters = [
    s.rounds,
    s.txFrames,
    s.txSuppressed,
    s.txDropOversize,
    s.txDropRingFull,
    s.rxFrames,
    s.rxDropQueueFull,
    s.fallbackEcho,
    s.resets,
    s.txChunkRetries,
    s.usbDataStalls,
    s.maxRoundGapMs,
  ];
  counters.forEach((v, i) => buf.writeUInt32LE(v >>> 0, 2 + 4 * i));
  buf.writeUInt16LE(s.rqHighWater, 50);
  buf.writeUInt16LE(s.rqCount, 52);
  buf.writeUInt8(s.state, 54);
  buf.writeUInt8(s.pstate, 55);
  buf.writeUInt8(s.remoteState, 56);
  buf.writeUInt8(s.role, 57);
  buf.writeUInt8(s.variant, 58);
  buf.writeUInt16LE(s.pxgPeriodUs, 59);
  buf.writeUInt16LE(s.syncPeriodUs, 61);
  return buf;
}

export function formatAwStats(s: AwStats): string {
  const stateName = ['PACKETXG', 'SYNC', 'INTERSYNC'][s.state] ?? `state${s.state}`;
  return (
    `aw-stats rounds=${s.rounds} tx=${s.txFrames}(+${s.txSuppressed} dedup) rx=${s.rxFrames} ` +
    `state=${stateName}/${s.pstate} remote=${s.remoteState} rq=${s.rqCount}/${s.rqHighWater} ` +
    `echo=${s.fallbackEcho} resets=${s.resets} drops=${s.txDropOversize}/${s.txDropRingFull}/${s.rxDropQueueFull} ` +
    `usb=${s.txChunkRetries}/${s.usbDataStalls} gap=${s.maxRoundGapMs}ms ` +
    `period=${s.pxgPeriodUs}/${s.syncPeriodUs}us`
  );
}
