import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import type {
  CloseReason,
  INetplayEndpoint,
  NetplayEvents,
  NetplayJoinOptions,
  NetplayPeer,
} from '../types';
import { GPSP_NETPACKET_VERSION, NETPACKET_BROADCAST } from '../types';
import {
  BANNED_MAGIC,
  FULL_MAGIC,
  HIGH_PROTOCOL,
  LOW_PROTOCOL,
  MITM_SESSION_MAGIC,
  NETPLAY_MAGIC,
  NICK_LEN,
  NetplayCmd,
  buildClientHeader,
  buildInfoPayload,
  buildMitmId,
  buildNickPayload,
  buildPasswordPayload,
  buildPlayPayload,
  implMagic,
  parseHeader,
  parseInfoPayload,
  parseModePayload,
  parseNickPayload,
  parseSyncPayload,
  passwordHash,
  readFixedString,
} from './messages';
import { WireBuffer, type WireFrame, writeFrame, writeNetpacketFrame } from './wire';

const PING_INTERVAL_MS = 3000;
/** Round trips kept: about 15 s at one ping every 3 s. */
const RTT_SAMPLES = 5;
/** RetroArch answers at once, but drops a wrong password silently, and a relay may hide the drop. */
const ANSWER_TIMEOUT_MS = 15000;

/**
 * Headless RetroArch netplay client (netpacket mode), wire-compatible with
 * RetroArch 1.22.2 running gpsp. Joins as the single remote player.
 */
export class NetplayClient extends EventEmitter<NetplayEvents> implements INetplayEndpoint {
  private socket: Socket | null = null;
  private readonly wire = new WireBuffer();
  private phase: 'header' | 'framed' = 'header';
  private sentPassword = false;
  private gotInfo = false;
  private sessionStarted = false;
  private closedEmitted = false;
  private hostNick = '';
  /** Our nick as the host assigned it (may differ on collision rename). */
  assignedNick = '';
  private _localClientId: number | null = null;
  private readonly peers = new Map<number, NetplayPeer>();
  /** Protocol negotiated in the host header; gates PING (netplay_frontend.c:5385). */
  private hostProtocol = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  /** From connect until the host's INFO accepts us. */
  private answerTimer: NodeJS.Timeout | null = null;
  /** Send time of the unanswered PING_REQUEST. */
  private pingSentAt: number | null = null;
  private readonly rtts: number[] = [];

  constructor(private readonly opts: NetplayJoinOptions) {
    super();
  }

  get localClientId(): number | null {
    return this._localClientId;
  }

  get playingPeers(): ReadonlyMap<number, NetplayPeer> {
    return this.peers;
  }

  /** Every netpacket goes through the host, so each peer is one host round trip away. */
  peerRttMs(): number | undefined {
    if (this.rtts.length === 0) return undefined;
    const sorted = [...this.rtts].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  connect(): Promise<void> {
    let prelude: Buffer | null = null;
    if (this.opts.relaySession !== undefined) {
      const unique = Buffer.from(this.opts.relaySession, 'base64');
      if (unique.length !== 12) {
        this.finish('relay-error', `relay session decodes to ${unique.length} bytes, expected 12`);
        return Promise.resolve();
      }
      prelude = buildMitmId(MITM_SESSION_MAGIC, unique);
    }
    return new Promise<void>((resolve, reject) => {
      const sock = new Socket();
      this.socket = sock;
      sock.setNoDelay(true);
      let connected = false;
      sock.on('connect', () => {
        connected = true;
        this.answerTimer = setTimeout(() => this.onNoAnswer(), ANSWER_TIMEOUT_MS);
        this.answerTimer.unref?.();
        // The relay routes on the session id, so it must precede the header.
        if (prelude) sock.write(prelude);
        sock.write(
          buildClientHeader({
            highProto: HIGH_PROTOCOL,
            lowProto: LOW_PROTOCOL,
            implMagic: implMagic(this.opts.retroarchVersion ?? '1.22.2', HIGH_PROTOCOL),
          }),
        );
        resolve();
      });
      sock.on('data', (chunk: Buffer) => this.onData(chunk));
      sock.on('error', (err: Error) => {
        this.finish('socket-error', err.message);
        if (!connected) reject(err);
      });
      sock.on('close', () => this.onSocketClose());
      sock.connect(this.opts.port, this.opts.host);
    });
  }

  sendPacket(buf: Buffer, dest: number = NETPACKET_BROADCAST): void {
    if (!this.sessionStarted) return;
    const sock = this.socket;
    if (!sock || sock.destroyed || !sock.writable) return;
    sock.write(writeNetpacketFrame(dest, buf));
  }

  close(graceful = true): void {
    this.stopTimers();
    const sock = this.socket;
    if (graceful) {
      if (sock && !sock.destroyed && sock.writable) {
        sock.write(writeFrame(NetplayCmd.DISCONNECT));
        sock.end();
      }
      this.finish('graceful');
    } else {
      sock?.destroy();
    }
  }

  private onData(chunk: Buffer): void {
    this.wire.append(chunk);
    try {
      this.drain();
    } catch (e) {
      this.fail('socket-error', (e as Error).message);
    }
  }

  private drain(): void {
    if (this.phase === 'header') {
      const raw = this.wire.tryReadBytes(24);
      if (!raw) return;
      this.onHostHeader(raw);
      if (this.closedEmitted) return;
    }
    let frame: WireFrame | null;
    while (!this.closedEmitted && (frame = this.wire.tryReadFrame()) !== null) {
      this.handleFrame(frame);
    }
  }

  private onHostHeader(raw: Buffer): void {
    const h = parseHeader(raw);
    if (h.magic === FULL_MAGIC) return this.fail('full');
    if (h.magic === BANNED_MAGIC) return this.fail('banned');
    if (h.magic !== NETPLAY_MAGIC) return this.fail('protocol-version', 'bad magic');
    if (h.protocol < LOW_PROTOCOL || h.protocol > HIGH_PROTOCOL)
      return this.fail('protocol-version', `host protocol ${h.protocol}`);
    this.hostProtocol = h.protocol;
    this.send(writeFrame(NetplayCmd.NICK, buildNickPayload(this.opts.nick)));
    if (h.saltOrHigh !== 0) {
      this.send(
        writeFrame(
          NetplayCmd.PASSWORD,
          buildPasswordPayload(passwordHash(h.saltOrHigh, this.opts.password ?? '')),
        ),
      );
      this.sentPassword = true;
    }
    this.phase = 'framed';
  }

  private handleFrame(frame: WireFrame): void {
    switch (frame.cmd) {
      case NetplayCmd.NICK:
        this.hostNick = parseNickPayload(frame.payload);
        break;
      case NetplayCmd.INFO:
        this.onInfo(frame.payload);
        break;
      case NetplayCmd.SYNC:
        this.onSync(frame.payload);
        break;
      case NetplayCmd.SETTING_ALLOW_PAUSING:
      case NetplayCmd.SETTING_INPUT_LATENCY_FRAMES:
        break;
      case NetplayCmd.MODE:
        this.onMode(frame.payload);
        break;
      case NetplayCmd.MODE_REFUSED: {
        const reason = frame.payload.length >= 4 ? frame.payload.readUInt32BE(0) : 0;
        this.fail('refused', `mode refused (reason ${reason})`);
        break;
      }
      case NetplayCmd.NETPACKET:
        this.emit('packet', Buffer.from(frame.payload), frame.netpacketClientId ?? 0);
        break;
      case NetplayCmd.PING_REQUEST:
        this.send(writeFrame(NetplayCmd.PING_RESPONSE));
        break;
      case NetplayCmd.PING_RESPONSE:
        if (this.pingSentAt !== null) {
          this.rtts.push(Date.now() - this.pingSentAt);
          if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
          this.pingSentAt = null;
        }
        break;
      case NetplayCmd.PLAYER_CHAT: {
        const body = frame.payload.subarray(NICK_LEN);
        const nul = body.indexOf(0);
        this.emit(
          'chat',
          readFixedString(frame.payload, 0, NICK_LEN),
          body.toString('utf8', 0, nul === -1 ? body.length : nul),
        );
        break;
      }
      case NetplayCmd.NAK:
        this.fail('nak');
        break;
      case NetplayCmd.DISCONNECT:
        this.fail('socket-closed');
        break;
      default:
        // Payload already consumed by the framer — tolerate unknown commands.
        break;
    }
  }

  private onInfo(payload: Buffer): void {
    // Any INFO (even empty) means the host accepted our password.
    this.gotInfo = true;
    this.clearAnswerTimer();
    const coreName = this.opts.coreName ?? 'gpSP';
    const coreVersion = this.opts.coreVersion ?? GPSP_NETPACKET_VERSION;
    if (payload.length === 0) {
      // Host has no content loaded yet: answer with crc 0 and keep waiting.
      this.send(writeFrame(NetplayCmd.INFO, buildInfoPayload({ contentCrc: 0, coreName, coreVersion })));
      return;
    }
    const info = parseInfoPayload(payload);
    if (info.coreName.toLowerCase() !== coreName.toLowerCase()) {
      this.fail('core-mismatch', `host runs ${info.coreName}`);
      return;
    }
    // Echo the host CRC — a real client with matching content reports the
    // same value, and the host refuses a mismatch.
    this.send(
      writeFrame(NetplayCmd.INFO, buildInfoPayload({ contentCrc: info.contentCrc, coreName, coreVersion })),
    );
  }

  private onSync(payload: Buffer): void {
    const sync = parseSyncPayload(payload);
    this._localClientId = sync.clientNum;
    const expected = this.opts.expectClientId;
    if (expected !== undefined && sync.clientNum !== expected) {
      this.fail('bad-client-id', `host assigned client ${sync.clientNum}`);
      return;
    }
    // SYNC's nick field is the nick the host ASSIGNED US (possibly renamed on
    // collision) — the host's own name arrived in its NICK frame.
    if (sync.nick) this.assignedNick = sync.nick;
    this.peers.set(0, { id: 0, nick: this.hostNick || 'Host' });
    this.send(writeFrame(NetplayCmd.PLAY, buildPlayPayload()));
    this.startPing();
  }

  private onMode(payload: Buffer): void {
    const m = parseModePayload(payload);
    if (m.you) {
      if (m.playing && !this.sessionStarted) {
        this.sessionStarted = true;
        this.emit('session-start', this._localClientId ?? m.clientId);
      }
      return;
    }
    if (m.playing) {
      const peer: NetplayPeer = { id: m.clientId, nick: m.nick };
      this.peers.set(m.clientId, peer);
      this.emit('peer-playing', peer);
      return;
    }
    const existing = this.peers.get(m.clientId);
    this.peers.delete(m.clientId);
    this.emit('peer-left', existing ?? { id: m.clientId, nick: m.nick });
  }

  private startPing(): void {
    if (this.pingTimer !== null) return;
    // Only protocol 6+ speaks PING (netplay_frontend.c:5385). RA arms its first request
    // NETPLAY_PING_AFTER (3 s) after SYNC, then every 3 s (netplay_frontend.c:2047, 9097).
    if (this.hostProtocol < 6) return;
    this.pingTimer = setInterval(() => {
      this.send(writeFrame(NetplayCmd.PING_REQUEST));
      this.pingSentAt = Date.now();
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private stopTimers(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearAnswerTimer();
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer !== null) clearTimeout(this.answerTimer);
    this.answerTimer = null;
  }

  private onNoAnswer(): void {
    this.answerTimer = null;
    if (this.gotInfo || this.closedEmitted) return;
    if (this.sentPassword) this.fail('wrong-password');
    else this.fail('socket-error', 'the host did not answer');
  }

  private send(buf: Buffer): void {
    const sock = this.socket;
    if (sock && !sock.destroyed && sock.writable) sock.write(buf);
  }

  private finish(reason: CloseReason, detail?: string): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.stopTimers();
    this.emit('closed', reason, detail);
  }

  private fail(reason: CloseReason, detail?: string): void {
    this.finish(reason, detail);
    this.socket?.destroy();
  }

  private onSocketClose(): void {
    this.stopTimers();
    if (this.closedEmitted) return;
    // RetroArch drops a bad password silently: a close after we sent
    // PASSWORD but before any INFO is a failed authentication.
    if (this.sentPassword && !this.gotInfo) this.finish('wrong-password');
    else this.finish('socket-closed');
  }
}
