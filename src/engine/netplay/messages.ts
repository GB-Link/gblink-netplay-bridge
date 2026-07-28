import { createHash } from 'node:crypto';

/** Command codes (RetroArch netplay_private.h). */
export enum NetplayCmd {
  NAK = 0x0001,
  DISCONNECT = 0x0002,
  NICK = 0x0020,
  PASSWORD = 0x0021,
  INFO = 0x0022,
  SYNC = 0x0023,
  PLAY = 0x0025,
  MODE = 0x0026,
  MODE_REFUSED = 0x0027,
  NETPACKET = 0x0048,
  PLAYER_CHAT = 0x1000,
  PING_REQUEST = 0x1100,
  PING_RESPONSE = 0x1101,
  SETTING_ALLOW_PAUSING = 0x2000,
  SETTING_INPUT_LATENCY_FRAMES = 0x2001,
}

export const NETPLAY_MAGIC = 0x52414e50; /* "RANP" */
export const FULL_MAGIC = 0x46554c4c; /* "FULL" */
export const BANNED_MAGIC = 0x44454e59; /* "DENY" */
export const POKE_MAGIC = 0x504f4b45; /* "POKE" */

export const MITM_SESSION_MAGIC = 0x52415453; /* "RATS" */
export const MITM_LINK_MAGIC = 0x5241544c; /* "RATL" */
export const MITM_ADDR_MAGIC = 0x52415441; /* "RATA" */
export const MITM_PING_MAGIC = 0x52415450; /* "RATP" */

export const HIGH_PROTOCOL = 7;
export const LOW_PROTOCOL = 5;

/**
 * (is_big_endian << 30) | (sizeof(size_t) << 15) | sizeof(long) for
 * little-endian linux x86-64 — what we impersonate on the wire.
 */
export const IMPERSONATED_PLATFORM_MAGIC = 0x00040008;

export const COMPRESSION_SUPPORTED = 1; /* NETPLAY_COMPRESSION_ZLIB */

export const NICK_LEN = 32;
export const PASS_HASH_LEN = 64;
export const MAX_INPUT_DEVICES = 16;

/** MODE_REFUSED payload values (netplay_private.h reason enum). */
export enum ModeRefusedReason {
  Other = 0,
  Unprivileged = 1,
  NoSlots = 2,
  TooFast = 3,
  NotAvailable = 4,
}

/** Port of netplay_impl_magic(): the protocol XOR uses i === version.length. */
export function implMagic(version: string, protocol: number): number {
  let res = 0;
  let i = 0;
  for (; i < version.length; i++) res ^= version.charCodeAt(i) << (i & 0xf);
  res ^= protocol << (i & 0xf);
  return res >>> 0;
}

export interface NetplayHeader {
  magic: number;
  platformMagic: number;
  compression: number;
  /** Server->client: password salt (0 = none). Client->server: high protocol. */
  saltOrHigh: number;
  protocol: number;
  implMagic: number;
}

export function buildClientHeader(f: {
  highProto: number;
  lowProto: number;
  implMagic: number;
}): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(NETPLAY_MAGIC, 0);
  b.writeUInt32BE(IMPERSONATED_PLATFORM_MAGIC, 4);
  b.writeUInt32BE(COMPRESSION_SUPPORTED, 8);
  /* High protocol rides in the otherwise-unused salt slot (compat hack). */
  b.writeUInt32BE(f.highProto >>> 0, 12);
  b.writeUInt32BE(f.lowProto >>> 0, 16);
  b.writeUInt32BE(f.implMagic >>> 0, 20);
  return b;
}

export function buildHostHeader(f: {
  salt: number;
  protocol: number;
  implMagic: number;
}): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(NETPLAY_MAGIC, 0);
  b.writeUInt32BE(IMPERSONATED_PLATFORM_MAGIC, 4);
  b.writeUInt32BE(COMPRESSION_SUPPORTED, 8);
  b.writeUInt32BE(f.salt >>> 0, 12);
  b.writeUInt32BE(f.protocol >>> 0, 16);
  b.writeUInt32BE(f.implMagic >>> 0, 20);
  return b;
}

export function parseHeader(buf: Buffer): NetplayHeader {
  return {
    magic: buf.readUInt32BE(0),
    platformMagic: buf.readUInt32BE(4),
    compression: buf.readUInt32BE(8),
    saltOrHigh: buf.readUInt32BE(12),
    protocol: buf.readUInt32BE(16),
    implMagic: buf.readUInt32BE(20),
  };
}

/** sha256 hex of "%08lX"-formatted salt (uppercase) + password, lowercase digest. */
export function passwordHash(salt: number, password: string): string {
  const prefix = (salt >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return createHash('sha256').update(prefix + password, 'utf8').digest('hex');
}

/** strlcpy semantics: at most len-1 content bytes so the field stays NUL-terminated. */
export function writeFixedString(
  buf: Buffer,
  offset: number,
  str: string,
  len: number
): void {
  buf.fill(0, offset, offset + len);
  buf.write(str, offset, len - 1, 'utf8');
}

export function readFixedString(buf: Buffer, offset: number, len: number): string {
  const field = buf.subarray(offset, offset + len);
  const nul = field.indexOf(0);
  return field.toString('utf8', 0, nul === -1 ? len : nul);
}

export function buildNickPayload(nick: string): Buffer {
  const b = Buffer.alloc(NICK_LEN);
  writeFixedString(b, 0, nick, NICK_LEN);
  return b;
}

export function parseNickPayload(buf: Buffer): string {
  return readFixedString(buf, 0, NICK_LEN);
}

/** char[64], no NUL terminator on the wire (memcpy of the 64 hex chars). */
export function buildPasswordPayload(hash: string): Buffer {
  const b = Buffer.alloc(PASS_HASH_LEN);
  b.write(hash, 0, PASS_HASH_LEN, 'latin1');
  return b;
}

export interface InfoFields {
  contentCrc: number;
  coreName: string;
  coreVersion: string;
}

export function buildInfoPayload(f: InfoFields): Buffer {
  const b = Buffer.alloc(4 + NICK_LEN + NICK_LEN);
  b.writeUInt32BE(f.contentCrc >>> 0, 0);
  writeFixedString(b, 4, f.coreName, NICK_LEN);
  writeFixedString(b, 4 + NICK_LEN, f.coreVersion, NICK_LEN);
  return b;
}

export function parseInfoPayload(buf: Buffer): InfoFields {
  return {
    contentCrc: buf.readUInt32BE(0),
    coreName: readFixedString(buf, 4, NICK_LEN),
    coreVersion: readFixedString(buf, 4 + NICK_LEN, NICK_LEN),
  };
}

export interface SyncFields {
  frameCount: number;
  clientNum: number;
  paused?: boolean;
  /** u32[16]; defaults to all 1 (RETRO_DEVICE_JOYPAD on every slot). */
  devices?: readonly number[];
  shareModes?: readonly number[];
  deviceClients?: readonly number[];
  nick: string;
}

const SYNC_PAYLOAD_LEN =
  4 + 4 + MAX_INPUT_DEVICES * 4 + MAX_INPUT_DEVICES + MAX_INPUT_DEVICES * 4 + NICK_LEN;

export const SYNC_BIT_PAUSED = 0x80000000;

export function buildSyncPayload(f: SyncFields): Buffer {
  const b = Buffer.alloc(SYNC_PAYLOAD_LEN);
  b.writeUInt32BE(f.frameCount >>> 0, 0);
  b.writeUInt32BE(((f.clientNum >>> 0) | (f.paused ? SYNC_BIT_PAUSED : 0)) >>> 0, 4);
  for (let i = 0; i < MAX_INPUT_DEVICES; i++)
    b.writeUInt32BE((f.devices?.[i] ?? 1) >>> 0, 8 + i * 4);
  for (let i = 0; i < MAX_INPUT_DEVICES; i++)
    b.writeUInt8((f.shareModes?.[i] ?? 0) & 0xff, 72 + i);
  for (let i = 0; i < MAX_INPUT_DEVICES; i++)
    b.writeUInt32BE((f.deviceClients?.[i] ?? 0) >>> 0, 88 + i * 4);
  writeFixedString(b, 152, f.nick, NICK_LEN);
  return b;
}

export interface SyncParsed {
  frameCount: number;
  clientNum: number;
  paused: boolean;
  devices: number[];
  shareModes: number[];
  deviceClients: number[];
  nick: string;
}

export function parseSyncPayload(buf: Buffer): SyncParsed {
  const rawClient = buf.readUInt32BE(4);
  const devices: number[] = [];
  const shareModes: number[] = [];
  const deviceClients: number[] = [];
  for (let i = 0; i < MAX_INPUT_DEVICES; i++) {
    devices.push(buf.readUInt32BE(8 + i * 4));
    shareModes.push(buf.readUInt8(72 + i));
    deviceClients.push(buf.readUInt32BE(88 + i * 4));
  }
  return {
    frameCount: buf.readUInt32BE(0),
    clientNum: rawClient & 0x7fffffff,
    paused: (rawClient & SYNC_BIT_PAUSED) !== 0,
    devices,
    shareModes,
    deviceClients,
    nick: readFixedString(buf, 152, NICK_LEN),
  };
}

export const MODE_BIT_YOU = 0x80000000;
export const MODE_BIT_PLAYING = 0x40000000;

export interface ModeFields {
  frame: number;
  you: boolean;
  playing: boolean;
  clientId: number;
  nick: string;
}

const MODE_PAYLOAD_LEN = 4 + 4 + 4 + MAX_INPUT_DEVICES + NICK_LEN;

export function buildModePayload(f: ModeFields): Buffer {
  const b = Buffer.alloc(MODE_PAYLOAD_LEN);
  b.writeUInt32BE(f.frame >>> 0, 0);
  const mode =
    ((f.you ? MODE_BIT_YOU : 0) | (f.playing ? MODE_BIT_PLAYING : 0) | (f.clientId & 0xffff)) >>>
    0;
  b.writeUInt32BE(mode, 4);
  b.writeUInt32BE(0, 8); /* devices */
  /* share_modes[16] stay zero */
  writeFixedString(b, 12 + MAX_INPUT_DEVICES, f.nick, NICK_LEN);
  return b;
}

export interface ModeParsed {
  frame: number;
  you: boolean;
  playing: boolean;
  clientId: number;
  devices: number;
  nick: string;
}

export function parseModePayload(buf: Buffer): ModeParsed {
  const mode = buf.readUInt32BE(4);
  return {
    frame: buf.readUInt32BE(0),
    you: (mode & MODE_BIT_YOU) !== 0,
    playing: (mode & MODE_BIT_PLAYING) !== 0,
    clientId: mode & 0xffff,
    devices: buf.readUInt32BE(8),
    nick: readFixedString(buf, 12 + MAX_INPUT_DEVICES, NICK_LEN),
  };
}

/** u32 = 0: no slave bit, no share-mode preference. */
export function buildPlayPayload(): Buffer {
  return Buffer.alloc(4);
}

export function buildSettingAllowPausing(allow: boolean): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(allow ? 1 : 0, 0);
  return b;
}

export function buildSettingInputLatency(min: number, max: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeInt32BE(min, 0);
  b.writeInt32BE(max, 4);
  return b;
}

/** mitm_id_t: u32 magic + uint8_t unique[12]. */
export function buildMitmId(magic: number, unique: Buffer): Buffer {
  if (unique.length !== 12)
    throw new Error(`mitm unique id must be 12 bytes, got ${unique.length}`);
  const b = Buffer.alloc(16);
  b.writeUInt32BE(magic >>> 0, 0);
  unique.copy(b, 4);
  return b;
}

export function parseMitmId(buf: Buffer): { magic: number; unique: Buffer } {
  return {
    magic: buf.readUInt32BE(0),
    unique: Buffer.from(buf.subarray(4, 16)),
  };
}
