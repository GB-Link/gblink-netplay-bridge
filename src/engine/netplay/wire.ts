import { NetplayCmd } from './messages';

export interface WireFrame {
  cmd: number;
  payload: Buffer;
  /** NETPACKET only: sender (toward clients) / recipient (toward host) id. */
  netpacketClientId?: number;
}

export const MAX_FRAME_PAYLOAD = 262144;

/**
 * Reassembles TCP chunks into netplay frames: u32 BE cmd + u32 BE size +
 * size payload bytes. NETPACKET (0x0048) carries an extra u32 client id
 * between size and data that is NOT counted in size.
 */
export class WireBuffer {
  private buf: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
  }

  get length(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf = Buffer.alloc(0);
  }

  tryReadBytes(n: number): Buffer | null {
    if (this.buf.length < n) return null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  tryReadFrame(): WireFrame | null {
    if (this.buf.length < 8) return null;
    const cmd = this.buf.readUInt32BE(0);
    const size = this.buf.readUInt32BE(4);
    if (size > MAX_FRAME_PAYLOAD)
      throw new Error(`netplay frame payload too large: ${size} (cmd 0x${cmd.toString(16)})`);
    if (cmd === NetplayCmd.NETPACKET) {
      if (this.buf.length < 12 + size) return null;
      const netpacketClientId = this.buf.readUInt32BE(8);
      const payload = this.buf.subarray(12, 12 + size);
      this.buf = this.buf.subarray(12 + size);
      return { cmd, payload, netpacketClientId };
    }
    if (this.buf.length < 8 + size) return null;
    const payload = this.buf.subarray(8, 8 + size);
    this.buf = this.buf.subarray(8 + size);
    return { cmd, payload };
  }
}

export function writeFrame(cmd: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_FRAME_PAYLOAD)
    throw new Error(`netplay frame payload too large: ${payload.length}`);
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(cmd >>> 0, 0);
  out.writeUInt32BE(payload.length, 4);
  payload.copy(out, 8);
  return out;
}

export function writeNetpacketFrame(clientId: number, payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_PAYLOAD)
    throw new Error(`netplay frame payload too large: ${payload.length}`);
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(NetplayCmd.NETPACKET, 0);
  out.writeUInt32BE(payload.length, 4);
  out.writeUInt32BE(clientId >>> 0, 8);
  payload.copy(out, 12);
  return out;
}
