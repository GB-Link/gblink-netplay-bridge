/**
 * ESP32 bridge console framing (GB-Link-Switch-LDN ldn_wire.c): COBS frames ending in 0x00, carrying
 *   version:1 | kind:1 | request:4 LE | session:4 LE | length:2 LE | payload | crc32:4 LE
 * The adapter kinds carry GB-Link frames: 'G' 'B' | channel | length:2 LE | payload.
 */

export enum EspKind {
  /** host -> board, ASCII command (request id must be non-zero). */
  Command = 1,
  /** board -> host, ASCII, answers a request; the last line is LDN_DONE. */
  Response = 2,
  /** board -> host, ASCII, unsolicited. */
  Event = 3,
  /** board -> host, one whole GB-Link frame for the adapter side. */
  AdapterOut = 6,
  /** host -> board, a GB-Link frame byte stream from the adapter side. */
  AdapterIn = 7,
}

/** Raw frames above this are dropped by the board. */
export const ESP_MAX_RAW_FRAME = 3200;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function cobsEncode(data: Uint8Array): Buffer {
  const out: number[] = [0];
  let codeAt = 0;
  let code = 1;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) {
      out[codeAt] = code;
      codeAt = out.length;
      out.push(0);
      code = 1;
    } else {
      out.push(data[i]!);
      code++;
      if (code === 0xff) {
        out[codeAt] = code;
        codeAt = out.length;
        out.push(0);
        code = 1;
      }
    }
  }
  out[codeAt] = code;
  return Buffer.from(out);
}

export function cobsDecode(data: Uint8Array): Buffer | null {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const code = data[i++]!;
    if (code === 0 || i + code - 1 > data.length) return null;
    for (let k = 1; k < code; k++) out.push(data[i++]!);
    if (code !== 0xff && i < data.length) out.push(0);
  }
  return Buffer.from(out);
}

export interface EspFrame {
  kind: number;
  request: number;
  session: number;
  payload: Buffer;
}

/** One COBS-encoded frame plus its 0x00 terminator. */
export function buildEspFrame(kind: number, request: number, session: number, payload: Uint8Array): Buffer {
  const raw = Buffer.alloc(16 + payload.length);
  raw[0] = 1;
  raw[1] = kind;
  raw.writeUInt32LE(request >>> 0, 2);
  raw.writeUInt32LE(session >>> 0, 6);
  raw.writeUInt16LE(payload.length, 10);
  raw.set(payload, 12);
  raw.writeUInt32LE(crc32(raw.subarray(0, 12 + payload.length)), 12 + payload.length);
  const encoded = cobsEncode(raw);
  const framed = Buffer.alloc(encoded.length + 1);
  encoded.copy(framed, 0);
  return framed;
}

/** Splits a byte stream on 0x00 and yields the frames that pass every check. */
export class EspFrameDecoder {
  private pending: number[] = [];

  push(bytes: Uint8Array): EspFrame[] {
    const frames: EspFrame[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (b !== 0) {
        if (this.pending.length < 8192) this.pending.push(b);
        continue;
      }
      const chunk = this.pending;
      this.pending = [];
      if (chunk.length === 0) continue;
      const raw = cobsDecode(Uint8Array.from(chunk));
      if (!raw || raw.length < 16 || raw[0] !== 1) continue;
      const length = raw.readUInt16LE(10);
      if (raw.length !== length + 16) continue;
      if (raw.readUInt32LE(12 + length) !== crc32(raw.subarray(0, 12 + length))) continue;
      frames.push({
        kind: raw[1]!,
        request: raw.readUInt32LE(2),
        session: raw.readUInt32LE(6),
        payload: Buffer.from(raw.subarray(12, 12 + length)),
      });
    }
    return frames;
  }

  reset(): void {
    this.pending = [];
  }
}

// ---- GB-Link frames ----

export const GB_CHANNEL = { COMMAND: 0, DATA: 1, STATUS: 2 } as const;
/** The board drops GB frames with a longer payload. */
export const GB_MAX_PAYLOAD = 128;

export interface GbFrame {
  channel: number;
  payload: Buffer;
}

export function buildGbFrame(channel: number, payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0x47;
  frame[1] = 0x42;
  frame[2] = channel;
  frame.writeUInt16LE(payload.length, 3);
  frame.set(payload, 5);
  return frame;
}

/** Incremental GB frame parser; input need not be frame aligned. */
export class GbFrameParser {
  private state = 0;
  private channel = 0;
  private length = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private seen = 0;

  constructor(private readonly maxPayload = 512) {}

  /** Drops a frame in progress: the next bytes start a new one. */
  reset(): void {
    this.state = 0;
    this.length = 0;
    this.seen = 0;
    this.buffer = Buffer.alloc(0);
  }

  push(bytes: Uint8Array): GbFrame[] {
    const frames: GbFrame[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      switch (this.state) {
        case 0:
          if (b === 0x47) this.state = 1;
          break;
        case 1:
          this.state = b === 0x42 ? 2 : b === 0x47 ? 1 : 0;
          break;
        case 2:
          this.channel = b;
          this.state = 3;
          break;
        case 3:
          this.length = b;
          this.state = 4;
          break;
        case 4:
          this.length |= b << 8;
          if (this.length > this.maxPayload) {
            this.state = 0;
            break;
          }
          this.buffer = Buffer.alloc(this.length);
          this.seen = 0;
          if (this.length === 0) {
            frames.push({ channel: this.channel, payload: this.buffer });
            this.state = 0;
          } else {
            this.state = 5;
          }
          break;
        case 5:
          this.buffer[this.seen++] = b;
          if (this.seen >= this.length) {
            frames.push({ channel: this.channel, payload: this.buffer });
            this.state = 0;
          }
          break;
        default:
          this.state = 0;
      }
    }
    return frames;
  }
}
