import dgram from 'node:dgram';
import { writeFixedString } from '../engine/netplay/messages';

/** RetroArch LAN discovery: 4-byte "RANQ" query, 688-byte "RANS" reply. */
const DISCOVERY_PORT = 55435;
const RANQ_MAGIC = 0x52414e51;
const RANS_MAGIC = 0x52414e53;
const REPLY_SIZE = 688;

export interface LanHostInfo {
  port: number;
  nick: string;
  gameName: string;
  /** Hex CRC32 string ('' for none). */
  gameCrc: string;
  hasPassword: boolean;
  hasSpectatePassword: boolean;
  coreVersion: string;
}

function isPrivateIPv4(addr: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function buildReply(info: LanHostInfo): Buffer {
  const buf = Buffer.alloc(REPLY_SIZE);
  buf.writeUInt32BE(RANS_MAGIC, 0);
  buf.writeInt32BE((parseInt(info.gameCrc, 16) || 0) | 0, 4);
  buf.writeInt32BE(info.port | 0, 8);
  buf.writeUInt32BE(
    (info.hasPassword ? 1 : 0) | (info.hasSpectatePassword ? 2 : 0),
    12,
  );
  writeFixedString(buf, 16, info.nick, 32);
  writeFixedString(buf, 48, 'unix x86_64', 32);
  writeFixedString(buf, 80, 'gpSP', 32);
  writeFixedString(buf, 112, info.coreVersion, 32);
  writeFixedString(buf, 144, '1.22.2', 32);
  writeFixedString(buf, 176, info.gameName, 256);
  writeFixedString(buf, 432, 'N/A', 256);
  return buf;
}

export class LanResponder {
  private socket: dgram.Socket | null = null;

  constructor(private readonly log: (msg: string) => void = () => undefined) {}

  start(info: LanHostInfo): void {
    this.stop();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', (e) => {
      this.log(`LAN discovery unavailable: ${e.message}`);
      if (this.socket === socket) this.socket = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    });
    socket.on('message', (msg, rinfo) => {
      if (msg.length !== 4 || msg.readUInt32BE(0) !== RANQ_MAGIC) return;
      if (!isPrivateIPv4(rinfo.address)) return;
      socket.send(buildReply(info), rinfo.port, rinfo.address);
    });
    socket.bind(DISCOVERY_PORT);
  }

  stop(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}
