/**
 * RFU1 frames: gpsp's Wireless Adapter netpackets (rfu.c rfu_net_send_cmd / rfu_net_send_bcast /
 * rfu_net_send_data / rfu_net_receive), which the GB-Link and ESP32 firmware stream as well.
 *
 * Frame: "RFU1" | type u32 BE | header u32 BE | payload. Size is fixed by type:
 * BROADCAST 36, HOST_SEND / CLIENT_SEND 104, the other known types 16.
 */

export const RFU1_MAGIC = 0x52465531;
export const RFU1_MAGIC_BYTES = [0x52, 0x46, 0x55, 0x31] as const;
export const RFU1_HEADER_LEN = 12;

export enum RfuType {
  /** Host to everyone: header = host devid, body = 24-byte librfu game data. */
  Broadcast = 0,
  /** Client to a host: header = the host's devid. */
  ConnectReq = 1,
  /** Host to the client: header = child devid | slot << 16. */
  ConnectAck = 2,
  ConnectNack = 3,
  /** Either way: header = child devid | slot << 16. */
  Disconnect = 4,
  /** Host to a client: header = byte count (low 7 bits), 92-byte payload. */
  HostSend = 5,
  /** Client to the host: header = bytes << 24 | slot << 16 | child devid. */
  ClientSend = 6,
  /** Client to the host after each HostSend: header = child devid | slot << 16. */
  ClientAck = 7,
  /** GB-Link firmware only: inbound queue pressure report to the host side. */
  FlowCtl = 8,
}

export const RFU1_BROADCAST_LEN = 36;
export const RFU1_DATA_LEN = 104;
export const RFU1_CMD_LEN = 16;
export const RFU1_PAYLOAD_MAX = 92;
export const RFU1_GAME_DATA_LEN = 24;

/** 0 for a type no device or peer sends. */
export function rfu1FrameSize(type: number): number {
  if (type === RfuType.Broadcast) return RFU1_BROADCAST_LEN;
  if (type === RfuType.HostSend || type === RfuType.ClientSend) return RFU1_DATA_LEN;
  if (type >= RfuType.ConnectReq && type <= RfuType.FlowCtl) return RFU1_CMD_LEN;
  return 0;
}

export interface Rfu1Frame {
  type: number;
  header: number;
  /** The whole frame, exactly rfu1FrameSize(type) bytes. */
  raw: Buffer;
}

/** GB-Link BROADCAST header bits 16-23: the next free slot, 0xFF when the room is full or closed. */
export const RFU1_NO_FREE_SLOT = 0xff;

export function rfu1TypeName(type: number): string {
  return RfuType[type] ?? `type${type}`;
}

function hasMagic(buf: Uint8Array, at: number): boolean {
  return (
    buf.length - at >= 4 &&
    buf[at] === RFU1_MAGIC_BYTES[0] &&
    buf[at + 1] === RFU1_MAGIC_BYTES[1] &&
    buf[at + 2] === RFU1_MAGIC_BYTES[2] &&
    buf[at + 3] === RFU1_MAGIC_BYTES[3]
  );
}

function newFrame(type: number, header: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  out.writeUInt32BE(RFU1_MAGIC, 0);
  out.writeUInt32BE(type >>> 0, 4);
  out.writeUInt32BE(header >>> 0, 8);
  return out;
}

export function rfu1Command(type: number, header: number): Buffer {
  return newFrame(type, header, RFU1_CMD_LEN);
}

/**
 * The host's 24-byte librfu game data travels as six big-endian words of the
 * little-endian record: record byte r sits at 12 + (r & ~3) + (3 - (r & 3)).
 */
export function rfu1Broadcast(devid: number, gameData: Uint8Array, flags = 0): Buffer {
  const out = newFrame(RfuType.Broadcast, ((devid & 0xffff) | (flags << 16)) >>> 0, RFU1_BROADCAST_LEN);
  for (let i = 0; i < 6; i++) {
    const word =
      ((gameData[i * 4] ?? 0) |
        ((gameData[i * 4 + 1] ?? 0) << 8) |
        ((gameData[i * 4 + 2] ?? 0) << 16) |
        ((gameData[i * 4 + 3] ?? 0) << 24)) >>>
      0;
    out.writeUInt32BE(word, RFU1_HEADER_LEN + i * 4);
  }
  return out;
}

/** The 24-byte game data record of a BROADCAST, in record byte order. */
export function rfu1GameData(frame: Buffer): Buffer {
  const out = Buffer.alloc(RFU1_GAME_DATA_LEN);
  for (let i = 0; i < 6; i++) {
    const word = frame.readUInt32BE(RFU1_HEADER_LEN + i * 4);
    out.writeUInt32LE(word, i * 4);
  }
  return out;
}

export function rfu1HostSend(payload: Uint8Array): Buffer {
  const len = Math.min(payload.length, RFU1_PAYLOAD_MAX);
  const out = newFrame(RfuType.HostSend, len, RFU1_DATA_LEN);
  out.set(payload.subarray(0, len), RFU1_HEADER_LEN);
  return out;
}

export function rfu1ClientSend(payload: Uint8Array, slot: number, devid: number): Buffer {
  const len = Math.min(payload.length, RFU1_PAYLOAD_MAX);
  const header = ((len << 24) | ((slot & 0x3) << 16) | (devid & 0xffff)) >>> 0;
  const out = newFrame(RfuType.ClientSend, header, RFU1_DATA_LEN);
  out.set(payload.subarray(0, len), RFU1_HEADER_LEN);
  return out;
}

/** Payload of a HOST_SEND or CLIENT_SEND, by the length its header declares. */
export function rfu1Payload(frame: Rfu1Frame): Buffer {
  const len =
    frame.type === RfuType.HostSend
      ? frame.header & 0x7f
      : frame.type === RfuType.ClientSend
        ? frame.header >>> 24
        : 0;
  return frame.raw.subarray(RFU1_HEADER_LEN, RFU1_HEADER_LEN + Math.min(len, RFU1_PAYLOAD_MAX));
}

/** `raw` is a view of `buf`: copy it before changing it. */
export function parseRfu1(buf: Buffer): Rfu1Frame | null {
  if (buf.length < RFU1_HEADER_LEN || !hasMagic(buf, 0)) return null;
  const type = buf.readUInt32BE(4);
  const size = rfu1FrameSize(type);
  if (size === 0 || buf.length < size) return null;
  return { type, header: buf.readUInt32BE(8), raw: buf.subarray(0, size) };
}

/**
 * Reassembles frames from a stream zero padded between frames (the devices write 64-byte chunks).
 * Resyncs on the magic, which padding can never match.
 */
export class Rfu1StreamParser {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (frame: Rfu1Frame) => void) {}

  push(bytes: Buffer): void {
    this.pending = this.pending.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.pending, bytes]);
    let at = 0;
    const buf = this.pending;
    while (buf.length - at >= RFU1_HEADER_LEN) {
      if (!hasMagic(buf, at)) {
        at++;
        continue;
      }
      const type = buf.readUInt32BE(at + 4);
      const size = rfu1FrameSize(type);
      if (size === 0) {
        // Unknown type: resync on the next magic, as the firmware does.
        at++;
        continue;
      }
      if (buf.length - at < size) break;
      this.onFrame({ type, header: buf.readUInt32BE(at + 8), raw: Buffer.from(buf.subarray(at, at + size)) });
      at += size;
    }
    // Keep a partial frame, or a tail that could start a magic.
    this.pending = Buffer.from(buf.subarray(at));
    if (this.pending.length > 4096) this.pending = this.pending.subarray(-256);
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
  }
}

/** Splits a frame into exactly-`chunk`-byte pieces, the last zero padded. */
export function rfu1Chunks(frame: Buffer, chunk = 64): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < frame.length; at += chunk) {
    const piece = Buffer.alloc(chunk);
    frame.copy(piece, 0, at, Math.min(at + chunk, frame.length));
    out.push(piece);
  }
  return out;
}

// ---- librfu game data (RfuGameData, the 24 bytes a leader broadcasts) ----

/** Game versions in the compatibility word's bits 10-13. */
export const GAME_VERSION = { SAPPHIRE: 1, RUBY: 2, EMERALD: 3, FIRE_RED: 4, LEAF_GREEN: 5 } as const;

export const COMPAT_CAN_LINK_NATIONALLY = 1 << 7;

/** Union-room activity ids (low 7 bits of record byte 12). */
export const RFU_ACTIVITY = { BATTLE_SINGLE: 1, BATTLE_DOUBLE: 2, TRADE: 4 } as const;

export interface RfuGameDataFields {
  /** Serial number 0x0002 for the Gen 3 games. */
  serial: number;
  compatibility: number;
  version: number;
  canLinkNationally: boolean;
  trainerId: number;
  /** Activity id without the "started" bit 7. */
  activity: number;
  /** Bit 7 of the activity byte: the group has started (no longer joinable). */
  started: boolean;
  /** 8-byte trainer name in the game's charset. */
  name: Buffer;
}

export function parseGameData(record: Uint8Array): RfuGameDataFields {
  const compatibility = (record[2] ?? 0) | ((record[3] ?? 0) << 8);
  return {
    serial: (record[0] ?? 0) | ((record[1] ?? 0) << 8),
    compatibility,
    version: (compatibility >> 10) & 0xf,
    canLinkNationally: (compatibility & COMPAT_CAN_LINK_NATIONALLY) !== 0,
    trainerId: (record[4] ?? 0) | ((record[5] ?? 0) << 8),
    activity: (record[12] ?? 0) & 0x7f,
    started: ((record[12] ?? 0) & 0x80) !== 0,
    name: Buffer.from(record.subarray(16, 24)),
  };
}

/** Record byte r's position inside a BROADCAST frame (see rfu1Broadcast). */
const recordAt = (r: number): number => RFU1_HEADER_LEN + (r & ~3) + (3 - (r & 3));

/**
 * National Dex bypass, as on the Switch page (national.js): a game joining another kind of game's
 * group checks that its leader can link nationally, so relayed broadcasts are marked as able to and
 * shown as the version `asVersion` picks (null keeps it). Record byte 15 checksums bytes 2-9 and 16-23.
 */
export function markNationally(
  frame: Buffer,
  asVersion: ((version: number) => number | null) | null = null,
): void {
  if (frame.length < RFU1_BROADCAST_LEN) return;
  frame[recordAt(2)] = (frame[recordAt(2)] ?? 0) | COMPAT_CAN_LINK_NATIONALLY;
  const version = ((frame[recordAt(3)] ?? 0) >> 2) & 0xf;
  const shown = asVersion ? asVersion(version) : null;
  if (shown !== null && shown !== undefined) {
    frame[recordAt(3)] = ((frame[recordAt(3)] ?? 0) & ~0x3c) | (shown << 2);
  }
  let sum = 0;
  for (let r = 2; r < 10; r++) sum += frame[recordAt(r)] ?? 0;
  for (let r = 16; r < 24; r++) sum += frame[recordAt(r)] ?? 0;
  frame[recordAt(15)] = ~sum & 0xff;
}

/** Version shown to a GBA for a Switch's (FireRed/LeafGreen) group: Emerald. */
export const SWITCH_GROUP_AS_EMERALD = (): number => GAME_VERSION.EMERALD;
/** Version shown to the Switch for a GBA's group: FireRed, unless it already is FR/LG. */
export const GBA_GROUP_AS_FIRE_RED = (v: number): number | null =>
  v === GAME_VERSION.FIRE_RED || v === GAME_VERSION.LEAF_GREEN ? null : GAME_VERSION.FIRE_RED;
