import dgram from 'node:dgram';
import { readFixedString, writeFixedString } from '../engine/netplay/messages';
import type { LobbyRoom } from '../shared/ipc';

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

/**
 * Broadcast a discovery query and collect replies from RetroArch hosts on
 * the local network, shaped as lobby rows (route "LAN", direct join).
 */
export function scanLan(timeoutMs = 1200): Promise<LobbyRoom[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map<string, LobbyRoom>();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      if (msg.length !== REPLY_SIZE || msg.readUInt32BE(0) !== RANS_MAGIC) return;
      if (!isPrivateIPv4(rinfo.address)) return;
      const coreName = readFixedString(msg, 80, 32);
      const flags = msg.readUInt32BE(12);
      const room: LobbyRoom = {
        username: readFixedString(msg, 16, 32),
        gameName: readFixedString(msg, 176, 256),
        gameCrc: msg.readInt32BE(4) >>> 0,
        coreName,
        coreVersion: readFixedString(msg, 112, 32),
        ip: rinfo.address,
        port: msg.readInt32BE(8),
        hasPassword: (flags & 1) !== 0,
        hasSpectatePassword: (flags & 2) !== 0,
        mitmIp: '',
        mitmPort: 0,
        mitmSession: '',
        hostMethod: 0,
        retroarchVersion: readFixedString(msg, 144, 32),
        country: '',
        frontend: readFixedString(msg, 48, 32),
        connectable: true,
        isRetroarch: true,
        playerCount: 0,
        spectatorCount: 0,
        joinable: coreName.toLowerCase() === 'gpsp',
        lan: true,
      };
      found.set(`${room.ip}:${room.port}`, room);
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        const query = Buffer.alloc(4);
        query.writeUInt32BE(RANQ_MAGIC, 0);
        socket.send(query, DISCOVERY_PORT, '255.255.255.255');
      } catch {
        finish();
      }
    });
  });
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
