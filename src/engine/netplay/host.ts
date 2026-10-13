import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type {
  CloseReason,
  INetplayEndpoint,
  NetplayEvents,
  NetplayHostOptions,
  NetplayPeer,
} from '../types';
import { GPSP_NETPACKET_VERSION, NETPACKET_BROADCAST } from '../types';
import {
  HIGH_PROTOCOL,
  LOW_PROTOCOL,
  MITM_ADDR_MAGIC,
  MITM_LINK_MAGIC,
  MITM_PING_MAGIC,
  MITM_SESSION_MAGIC,
  ModeRefusedReason,
  NETPLAY_MAGIC,
  NICK_LEN,
  NetplayCmd,
  PASS_HASH_LEN,
  POKE_MAGIC,
  buildHostHeader,
  buildInfoPayload,
  buildMitmId,
  buildModePayload,
  buildNickPayload,
  buildSettingAllowPausing,
  buildSettingInputLatency,
  buildSyncPayload,
  implMagic,
  parseInfoPayload,
  parseMitmId,
  parseNickPayload,
  passwordHash,
} from './messages';
import { WireBuffer, writeFrame, writeNetpacketFrame, type WireFrame } from './wire';

const PENDING_LINK_TIMEOUT_MS = 15000;
/** Round trips kept per client: about 15 s at RetroArch's ping every 3 s. */
const RTT_SAMPLES = 5;
const MAX_PENDING_LINKS = 8;
const HEADER_LEN = 24;
const INFO_PAYLOAD_LEN = 68;

type ConnPhase = 'magic' | 'header' | 'nick' | 'password' | 'info' | 'ready';

interface Conn {
  sock: Socket;
  wire: WireBuffer;
  index: number;
  id: number;
  phase: ConnPhase;
  salt: number;
  protocol: number;
  nick: string;
  canPlay: boolean;
  playing: boolean;
  established: boolean;
  dead: boolean;
  /** Send time of the unanswered PING_REQUEST. */
  pingSentAt: number | null;
  rtts: number[];
}

function refusedPayload(reason: ModeRefusedReason): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(reason, 0);
  return b;
}

/** Longest prefix of s that fits maxBytes once UTF-8 encoded. */
function truncateUtf8(s: string, maxBytes: number): string {
  let out = s;
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}

interface PendingLink {
  readonly id: Buffer;
  readonly sock: Socket;
  connected: boolean;
  hasAddr: boolean;
  timer: NodeJS.Timeout | null;
  fail: (() => void) | null;
}

/**
 * Headless netplay host impersonating RetroArch 1.22.2 running gpsp in
 * netpacket mode: direct TCP hosting or a RATS/RATL/RATA relay (MITM)
 * session. The host core itself is netplay client 0; remote connections get
 * client id connIndex+1.
 */
export class NetplayHost extends EventEmitter<NetplayEvents> implements INetplayEndpoint {
  private server: Server | null = null;
  private session: Socket | null = null;
  private sessionBuf: Buffer = Buffer.alloc(0);
  private sessionReady = false;
  private readonly pending: PendingLink[] = [];
  private readonly conns = new Map<number, Conn>();
  private readonly peers = new Map<number, NetplayPeer>();
  private _localClientId: number | null = null;
  private torndown = false;
  private closing = false;
  private readonly hostImpl: number;
  private readonly coreName: string;
  private readonly coreVersion: string;

  constructor(private readonly opts: NetplayHostOptions) {
    super();
    this.hostImpl = implMagic(opts.retroarchVersion ?? '1.22.2', HIGH_PROTOCOL);
    this.coreName = opts.coreName ?? 'gpSP';
    this.coreVersion = opts.coreVersion ?? GPSP_NETPACKET_VERSION;
  }

  get localClientId(): number | null {
    return this._localClientId;
  }

  get playingPeers(): ReadonlyMap<number, NetplayPeer> {
    return this.peers;
  }

  peerRttMs(id: number): number | undefined {
    for (const conn of this.conns.values()) {
      if (conn.id !== id || conn.rtts.length === 0) continue;
      const sorted = [...conn.rtts].sort((a, b) => a - b);
      return sorted[sorted.length >> 1];
    }
    return undefined;
  }

  listen(): Promise<void> {
    return this.opts.relay ? this.listenRelay() : this.listenDirect();
  }

  sendPacket(buf: Buffer, dest: number = NETPACKET_BROADCAST): void {
    if (this.torndown) return;
    const frame = writeNetpacketFrame(0, buf);
    for (const conn of this.conns.values()) {
      if (dest !== NETPACKET_BROADCAST && conn.id !== dest) continue;
      if (conn.playing && !conn.sock.destroyed) conn.sock.write(frame);
    }
  }

  close(graceful = true): void {
    if (this.torndown) return;
    this.closing = true;
    const bye = graceful ? writeFrame(NetplayCmd.DISCONNECT) : undefined;
    for (const conn of [...this.conns.values()]) {
      this.killConn(conn, conn.established ? bye : undefined);
    }
    this.teardown('graceful');
  }

  // ---- direct mode ----

  private listenDirect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((sock) => this.accept(sock));
      this.server = server;
      const onBindError = (e: Error) => reject(e);
      server.once('error', onBindError);
      server.listen(this.opts.port, () => {
        server.off('error', onBindError);
        server.on('error', (e) => this.emit('error', e));
        this._localClientId = 0;
        // Report the bound port: port 0 asks the OS for an ephemeral one.
        const addr = server.address();
        const extPort = addr !== null && typeof addr === 'object' ? addr.port : this.opts.port;
        this.emit('host-ready', { extPort });
        this.emit('session-start', 0);
        resolve();
      });
    });
  }

  // ---- per-connection FSM ----

  private accept(sock: Socket): void {
    if (this.torndown) {
      sock.destroy();
      return;
    }
    sock.setNoDelay(true);
    let index = 0;
    while (this.conns.has(index)) index++;
    const conn: Conn = {
      sock,
      wire: new WireBuffer(),
      index,
      id: index + 1,
      phase: 'magic',
      salt: 0,
      protocol: HIGH_PROTOCOL,
      nick: '',
      canPlay: true,
      playing: false,
      established: false,
      dead: false,
      pingSentAt: null,
      rtts: [],
    };
    this.conns.set(index, conn);
    sock.on('data', (chunk: Buffer) => {
      if (conn.dead) return;
      conn.wire.append(chunk);
      try {
        this.pump(conn);
      } catch {
        this.killConn(conn);
      }
    });
    sock.on('error', () => this.killConn(conn));
    sock.on('close', () => this.killConn(conn));
  }

  private pump(conn: Conn): void {
    while (!conn.dead) {
      if (conn.phase === 'magic') {
        const raw = conn.wire.tryReadBytes(4);
        if (!raw) return;
        this.handleMagic(conn, raw.readUInt32BE(0));
        continue;
      }
      if (conn.phase === 'header') {
        const raw = conn.wire.tryReadBytes(HEADER_LEN - 4);
        if (!raw) return;
        this.handleHeader(conn, raw);
        continue;
      }
      const frame = conn.wire.tryReadFrame();
      if (!frame) return;
      this.handleFrame(conn, frame);
    }
  }

  /** RA decides on the first 4 header bytes alone (netplay_frontend.c:1036, 1060-1063). */
  private handleMagic(conn: Conn, magic: number): void {
    conn.salt =
      this.opts.password !== undefined || this.opts.spectatePassword !== undefined
        ? randomInt(1, 0x1_0000_0000)
        : 0;
    if (magic === POKE_MAGIC) {
      // Lobby prober: send our full header and hang up without waiting for
      // the rest of its header (send_info_and_disconnect).
      this.killConn(
        conn,
        buildHostHeader({ salt: conn.salt, protocol: HIGH_PROTOCOL, implMagic: this.hostImpl }),
      );
      return;
    }
    if (magic !== NETPLAY_MAGIC) {
      this.killConn(conn);
      return;
    }
    conn.phase = 'header';
  }

  /** `rest` is the 20 header bytes that follow the RANP magic. */
  private handleHeader(conn: Conn, rest: Buffer): void {
    const saltOrHigh = rest.readUInt32BE(8);
    const protocol = rest.readUInt32BE(12);
    // Modern clients ride their high protocol in the salt slot; legacy ones
    // only fill the protocol field.
    const negotiated = saltOrHigh !== 0 ? Math.min(saltOrHigh, HIGH_PROTOCOL) : protocol;
    if (negotiated < LOW_PROTOCOL || negotiated > HIGH_PROTOCOL) {
      // Protocol 0 in our header tells the client no common protocol exists.
      this.killConn(
        conn,
        buildHostHeader({ salt: conn.salt, protocol: 0, implMagic: this.hostImpl }),
      );
      return;
    }
    conn.protocol = negotiated;
    conn.sock.write(
      buildHostHeader({ salt: conn.salt, protocol: negotiated, implMagic: this.hostImpl }),
    );
    conn.phase = 'nick';
  }

  private handleFrame(conn: Conn, frame: WireFrame): void {
    switch (conn.phase) {
      case 'nick':
        this.handleNickFrame(conn, frame);
        return;
      case 'password':
        this.handlePasswordFrame(conn, frame);
        return;
      case 'info':
        this.handleInfoFrame(conn, frame);
        return;
      case 'ready':
        this.handleCommand(conn, frame);
        return;
      default:
        this.killConn(conn);
    }
  }

  private handleNickFrame(conn: Conn, frame: WireFrame): void {
    if (frame.cmd !== NetplayCmd.NICK || frame.payload.length !== NICK_LEN) {
      this.killConn(conn);
      return;
    }
    conn.nick = this.assignNick(parseNickPayload(frame.payload));
    conn.sock.write(writeFrame(NetplayCmd.NICK, buildNickPayload(this.opts.nick)));
    if (conn.salt !== 0) {
      conn.phase = 'password';
      return;
    }
    this.beginInfo(conn);
  }

  private handlePasswordFrame(conn: Conn, frame: WireFrame): void {
    if (frame.cmd !== NetplayCmd.PASSWORD || frame.payload.length !== PASS_HASH_LEN) {
      this.killConn(conn);
      return;
    }
    const given = frame.payload.toString('latin1');
    if (
      this.opts.password !== undefined &&
      given === passwordHash(conn.salt, this.opts.password)
    ) {
      conn.canPlay = true;
    } else if (
      this.opts.spectatePassword !== undefined &&
      given === passwordHash(conn.salt, this.opts.spectatePassword)
    ) {
      conn.canPlay = false;
    } else {
      // RA drops wrong-password connections without a refusal message.
      this.killConn(conn);
      return;
    }
    this.beginInfo(conn);
  }

  private beginInfo(conn: Conn): void {
    this.sendInfo(conn);
    conn.phase = 'info';
  }

  private sendInfo(conn: Conn): void {
    conn.sock.write(
      writeFrame(
        NetplayCmd.INFO,
        buildInfoPayload({
          contentCrc: this.opts.contentCrc ?? 0,
          coreName: this.coreName,
          coreVersion: this.coreVersion,
        }),
      ),
    );
  }

  private handleInfoFrame(conn: Conn, frame: WireFrame): void {
    if (frame.cmd !== NetplayCmd.INFO) {
      this.killConn(conn);
      return;
    }
    if (frame.payload.length === 0) {
      // RA re-sends its INFO and stays in the info state until a real one
      // arrives (netplay_frontend.c:1694-1707).
      this.sendInfo(conn);
      return;
    }
    if (frame.payload.length !== INFO_PAYLOAD_LEN) {
      this.killConn(conn);
      return;
    }
    const info = parseInfoPayload(frame.payload);
    if (info.coreName.toLowerCase() !== this.coreName.toLowerCase()) {
      this.killConn(conn);
      return;
    }
    conn.sock.write(
      writeFrame(
        NetplayCmd.SYNC,
        buildSyncPayload({ frameCount: 0, clientNum: conn.id, paused: false, nick: conn.nick }),
      ),
    );
    if (conn.protocol >= 6) {
      conn.sock.write(writeFrame(NetplayCmd.SETTING_ALLOW_PAUSING, buildSettingAllowPausing(false)));
      conn.sock.write(
        writeFrame(NetplayCmd.SETTING_INPUT_LATENCY_FRAMES, buildSettingInputLatency(0, 0)),
      );
    }
    conn.established = true;
    conn.phase = 'ready';
  }

  private handleCommand(conn: Conn, frame: WireFrame): void {
    switch (frame.cmd) {
      case NetplayCmd.PLAY:
        this.handlePlay(conn, frame);
        return;
      case NetplayCmd.NETPACKET:
        this.handleNetpacket(conn, frame);
        return;
      case NetplayCmd.PING_REQUEST:
        // RA never pings on a timer: it answers, then immediately requests
        // its own ping back on protocol 6+ (netplay_frontend.c:6597-6604).
        conn.sock.write(writeFrame(NetplayCmd.PING_RESPONSE));
        if (conn.protocol >= 6) {
          conn.sock.write(writeFrame(NetplayCmd.PING_REQUEST));
          conn.pingSentAt = Date.now();
        }
        return;
      case NetplayCmd.PING_RESPONSE:
        if (conn.pingSentAt !== null) {
          conn.rtts.push(Date.now() - conn.pingSentAt);
          if (conn.rtts.length > RTT_SAMPLES) conn.rtts.shift();
          conn.pingSentAt = null;
        }
        return;
      case NetplayCmd.PLAYER_CHAT:
        this.handleChat(conn, frame);
        return;
      case NetplayCmd.NAK:
      case NetplayCmd.DISCONNECT:
        this.killConn(conn);
        return;
      default:
        return; /* PAUSE/RESUME/anything else: ignore */
    }
  }

  private handleChat(conn: Conn, frame: WireFrame): void {
    const msg = frame.payload.toString('utf8').replace(/\0+$/u, '');
    this.emit('chat', conn.nick, msg);
    if (!conn.playing || msg.length === 0) return;
    // RA relays a playing client's chat as 32-byte nick + message to every
    // playing protocol-6+ client, the sender included (netplay_relay_chat,
    // netplay_frontend.c:5166-5194).
    const relay = writeFrame(
      NetplayCmd.PLAYER_CHAT,
      Buffer.concat([buildNickPayload(conn.nick), Buffer.from(msg, 'utf8')]),
    );
    for (const other of this.conns.values()) {
      if (other.playing && other.protocol >= 6 && !other.sock.destroyed) other.sock.write(relay);
    }
  }

  private handlePlay(conn: Conn, frame: WireFrame): void {
    if (frame.payload.length !== 4) {
      // RA: bad PLAY payload size -> NAK + hangup (netplay_frontend.c:5691-5695).
      this.killConn(conn, writeFrame(NetplayCmd.NAK));
      return;
    }
    if (conn.playing) {
      // RA: PLAY while already playing -> NAK + hangup (netplay_frontend.c:5697-5703).
      this.killConn(conn, writeFrame(NetplayCmd.NAK));
      return;
    }
    if (!conn.canPlay) {
      // RA refuses Unprivileged but keeps the connection (netplay_frontend.c:5708-5716).
      conn.sock.write(writeFrame(NetplayCmd.MODE_REFUSED, refusedPayload(ModeRefusedReason.Unprivileged)));
      return;
    }
    // Real gpsp accepts 3 remote players (gpsp/libretro/libretro.c:523-540);
    // defaulting to 1 mirrors the 2-node physical link on purpose.
    if (this.peers.size >= (this.opts.maxPlayers ?? 1)) {
      this.refuse(conn, ModeRefusedReason.Other);
      return;
    }
    conn.playing = true;
    this.peers.set(conn.id, { id: conn.id, nick: conn.nick });
    conn.sock.write(
      writeFrame(
        NetplayCmd.MODE,
        buildModePayload({ frame: 1, you: true, playing: true, clientId: conn.id, nick: conn.nick }),
      ),
    );
    const announce = writeFrame(
      NetplayCmd.MODE,
      buildModePayload({ frame: 1, you: false, playing: true, clientId: conn.id, nick: conn.nick }),
    );
    for (const other of this.conns.values()) {
      if (other !== conn && other.established && !other.sock.destroyed) other.sock.write(announce);
    }
    this.emit('peer-playing', { id: conn.id, nick: conn.nick });
  }

  private refuse(conn: Conn, reason: ModeRefusedReason): void {
    this.killConn(conn, writeFrame(NetplayCmd.MODE_REFUSED, refusedPayload(reason)));
  }

  private handleNetpacket(conn: Conn, frame: WireFrame): void {
    // netpacketClientId is the DESTINATION on the client->host leg.
    const dest = frame.netpacketClientId ?? 0;
    const payload = Buffer.from(frame.payload);
    const toHost = dest === 0 || dest === NETPACKET_BROADCAST;
    if (toHost) this.emit('packet', payload, conn.id);
    // RA relays regardless of the SENDER's mode; only recipients are gated
    // on playing (netplay_frontend.c:6519-6544, netplay_send_cmd_netpacket).
    if (dest === NETPACKET_BROADCAST) {
      const relay = writeNetpacketFrame(conn.id, payload);
      for (const other of this.conns.values()) {
        if (other !== conn && other.playing && !other.sock.destroyed) other.sock.write(relay);
      }
    } else if (!toHost && dest !== conn.id) {
      const target = this.conns.get(dest - 1);
      if (target && target.id === dest && target.playing && !target.sock.destroyed) {
        target.sock.write(writeNetpacketFrame(conn.id, payload));
      }
    }
  }

  private assignNick(requested: string): string {
    const taken = new Set<string>([this.opts.nick]);
    for (const conn of this.conns.values()) {
      if (conn.nick !== '') taken.add(conn.nick);
    }
    if (!taken.has(requested)) return requested;
    for (let n = 2; ; n++) {
      // RA truncates the base so base + " (n)" fits the 32-byte wire field,
      // i.e. at most 31 content bytes (select_nickname, netplay_frontend.c:1330-1364).
      const suffix = ` (${n})`;
      const candidate = truncateUtf8(requested, NICK_LEN - 1 - suffix.length) + suffix;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private killConn(conn: Conn, farewell?: Buffer): void {
    if (conn.dead) return;
    conn.dead = true;
    if (this.conns.get(conn.index) === conn) this.conns.delete(conn.index);
    if (!conn.sock.destroyed) {
      if (farewell) {
        conn.sock.write(farewell);
        conn.sock.end();
      } else {
        conn.sock.destroy();
      }
    }
    if (conn.playing) {
      conn.playing = false;
      this.peers.delete(conn.id);
      if (!this.torndown && !this.closing) {
        const departure = writeFrame(
          NetplayCmd.MODE,
          buildModePayload({
            frame: 0,
            you: false,
            playing: false,
            clientId: conn.id,
            nick: conn.nick,
          }),
        );
        for (const other of this.conns.values()) {
          if (other.established && !other.sock.destroyed) other.sock.write(departure);
        }
        this.emit('peer-left', { id: conn.id, nick: conn.nick });
      }
    }
  }

  private teardown(reason: CloseReason, detail?: string): void {
    if (this.torndown) return;
    this.torndown = true;
    this.closing = true;
    for (const conn of [...this.conns.values()]) this.killConn(conn);
    for (const p of [...this.pending]) this.dropPending(p, true);
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.session) {
      this.session.destroy();
      this.session = null;
    }
    this.emit('closed', reason, detail);
  }

  // ---- relay (MITM) mode ----

  private listenRelay(): Promise<void> {
    const relay = this.opts.relay!;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      const sock = connect({ host: relay.addr, port: relay.port });
      this.session = sock;
      sock.setNoDelay(true);
      sock.on('connect', () => {
        // All-zero unique = new-session request.
        sock.write(buildMitmId(MITM_SESSION_MAGIC, Buffer.alloc(12)));
      });
      sock.on('data', (chunk: Buffer) => {
        this.sessionBuf = Buffer.concat([this.sessionBuf, chunk]);
        try {
          this.pumpSession(() => settle());
        } catch (e) {
          if (!settled) {
            settle(e as Error);
            sock.destroy();
            this.session = null;
          } else {
            this.relayFail();
          }
        }
      });
      sock.on('error', (e) => {
        if (!settled) settle(e);
        else this.relayFail();
      });
      sock.on('close', () => {
        if (!settled) settle(new Error('relay closed the session socket during setup'));
        else this.relayFail();
      });
    });
  }

  private relayFail(): void {
    if (this.torndown || this.closing) return;
    this.teardown('relay-error');
  }

  private pumpSession(onReady: () => void): void {
    for (;;) {
      if (this.torndown) return;
      if (!this.sessionReady) {
        if (this.sessionBuf.length < 16) return;
        const reply = parseMitmId(this.sessionBuf.subarray(0, 16));
        this.sessionBuf = this.sessionBuf.subarray(16);
        if (reply.magic !== MITM_SESSION_MAGIC || reply.unique.every((b) => b === 0)) {
          throw new Error('relay rejected the session request');
        }
        this.sessionReady = true;
        this._localClientId = 0;
        this.emit('host-ready', {
          extPort: this.opts.port,
          relaySessionId: reply.unique.toString('base64'),
        });
        this.emit('session-start', 0);
        onReady();
        continue;
      }
      if (this.sessionBuf.length < 4) return;
      const magic = this.sessionBuf.readUInt32BE(0);
      if (magic === MITM_PING_MAGIC) {
        this.sessionBuf = this.sessionBuf.subarray(4);
        const pong = Buffer.alloc(4);
        pong.writeUInt32BE(MITM_PING_MAGIC, 0);
        this.session?.write(pong);
        continue;
      }
      if (magic === MITM_LINK_MAGIC) {
        if (this.sessionBuf.length < 16) return;
        const id = Buffer.from(this.sessionBuf.subarray(4, 16));
        this.sessionBuf = this.sessionBuf.subarray(16);
        this.openPendingLink(id);
        continue;
      }
      if (magic === MITM_ADDR_MAGIC) {
        if (this.sessionBuf.length < 32) return;
        const id = this.sessionBuf.subarray(4, 16);
        const p = this.pending.find((x) => x.id.equals(id));
        this.sessionBuf = this.sessionBuf.subarray(32);
        if (p) {
          p.hasAddr = true;
          this.promoteIfReady(p);
        }
        continue;
      }
      throw new Error(`unknown relay session message 0x${magic.toString(16)}`);
    }
  }

  private openPendingLink(id: Buffer): void {
    if (this.pending.length >= MAX_PENDING_LINKS) return;
    const relay = this.opts.relay!;
    const sock = connect({ host: relay.addr, port: relay.port });
    sock.setNoDelay(true);
    const p: PendingLink = { id, sock, connected: false, hasAddr: false, timer: null, fail: null };
    p.fail = () => this.dropPending(p, true);
    sock.on('error', p.fail);
    sock.on('close', p.fail);
    sock.once('connect', () => {
      p.connected = true;
      this.promoteIfReady(p);
    });
    p.timer = setTimeout(p.fail, PENDING_LINK_TIMEOUT_MS);
    p.timer.unref();
    this.pending.push(p);
    this.session?.write(buildMitmId(MITM_ADDR_MAGIC, id));
  }

  private promoteIfReady(p: PendingLink): void {
    if (!p.connected || !p.hasAddr) return;
    this.dropPending(p, false);
    if (p.fail) {
      p.sock.off('error', p.fail);
      p.sock.off('close', p.fail);
    }
    // Claim the link, then the tunnel goes transparent: the joiner speaks
    // first, exactly like a direct connection.
    p.sock.write(buildMitmId(MITM_LINK_MAGIC, p.id));
    this.accept(p.sock);
  }

  private dropPending(p: PendingLink, destroy: boolean): void {
    const i = this.pending.indexOf(p);
    if (i === -1) return;
    this.pending.splice(i, 1);
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
    if (destroy) p.sock.destroy();
  }
}
