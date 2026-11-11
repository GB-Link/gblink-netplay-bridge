import { EventEmitter } from 'node:events';
import {
  FwStatus,
  firmwareLabel,
  fwAtLeast,
  type BridgeCounters,
  type FirmwareVersion,
  type IGBLinkAdapter,
  type INetplayEndpoint,
  type LinkPhase,
  type NetplayPeer,
  type PlayerSettings,
} from '../types';
import { MAX_REINIT_ATTEMPTS, REINIT_DELAY_MS, SELF_CLOSE_GRACE_MS, type BridgeMode } from '../bridge/linkBridge';
import { identifyPacket, mismatchWarning } from '../netplay/protocolMagic';
import { GPSP_SERIAL_OPTION } from '../../shared/games';
import {
  AW_SYNC_WORD,
  AwState,
  CMD_NONE,
  Maw1Chunker,
  Maw1StreamParser,
  isStateOnly,
  maw1Problem,
  otherVariant,
  parseMaw1,
  serializeFrame,
  serializeMaw1,
  type AwVariant,
  type Maw1Frame,
} from './maw1';
import { PeerKeys } from './peerKeys';
import { PhaseGate } from './phaseGate';

export type { BridgeMode } from '../bridge/linkBridge';

/** The first firmware with seats in the mode's commands and data packets. */
const AW_MIN_FW = { major: 3, minor: 0, patch: 0 };
/** Player settings sent but no 0xFF03: the firmware is stuck, re-enter the mode. */
const ARM_TIMEOUT_MS = 3000;
/** 0x12 sent but no 0xFF05. */
const START_TIMEOUT_MS = 3000;
const PENDING_INBOUND_MAX = 64;
const COUNTERS_INTERVAL_MS = 1000;
/** Our GBA in the link menu this long with nothing from the peer: a gpsp outside its Advance Wars modes stays silent. */
const SILENT_PEER_MS = 15000;
const REJECT_LOG_MAX = 5;

export interface AwBridgeOptions {
  /** Suppression window for repeated state-only frames toward the firmware. */
  dedupWindowMs?: number;
  now?: () => number;
}

export interface AwLinkBridgeEvents {
  'link-phase': [LinkPhase, number?];
  counters: [BridgeCounters];
  log: [string];
  warn: [string];
  error: [Error];
}

interface MutableCounters {
  txPackets: number;
  rxPackets: number;
  txBytes: number;
  rxBytes: number;
  dedupSuppressed: number;
  rejected: number;
  ignoredPeer: number;
  txNoPeer: number;
}

/**
 * Advance Wars bridge between firmware mode 0x04 (the link proxy) and MAW1 netpackets from gpsp peers.
 * The proxy's frames are gpsp's, apart from the key presses PeerKeys puts in gpsp's terms.
 *
 * The proxy is armed without waiting for a peer, so the GBA always sees an idle partner, as a gpsp game does.
 * One SetMode and StartHandshake serve every match of a session; the section restarts only when the peer
 * leaves, the session closes or the firmware closes the mode.
 */
export class AwLinkBridge extends EventEmitter<AwLinkBridgeEvents> {
  private readonly dedupWindowMs: number;
  private readonly now: () => number;

  private readonly parser = new Maw1StreamParser((f) => this.onFwFrame(f));
  private readonly chunker = new Maw1Chunker((chunk) => this.writeChunk(chunk));
  private readonly peerKeys = new PeerKeys();
  private readonly gate: PhaseGate;

  private phase: LinkPhase = 'idle';
  private firmware: FirmwareVersion | null = null;

  private sessionLive = false;
  /** 0xFF03 seen for this firmware section. */
  private sectionLive = false;
  private handshakeSent = false;
  /** 0xFF05 seen: the proxy answers the GBA and takes data both ways. */
  private relayActive = false;
  private closing = false;
  private stopped = false;
  private reinitializing = false;

  private selfCancelAt = 0;
  private reinitAttempts = 0;

  private readonly pendingInbound: Buffer[] = [];
  private lastInState: number | null = null;
  private lastInAt = 0;
  private variantWarned = { out: false, in: false };
  private mismatchWarned = false;
  private readonly ignoredPeers = new Set<number>();
  private peerHeard = false;
  private lobbySince = 0;
  private silentPeerWarned = false;
  private rejectsLogged = 0;

  private readonly counters: MutableCounters = {
    txPackets: 0,
    rxPackets: 0,
    txBytes: 0,
    rxBytes: 0,
    dedupSuppressed: 0,
    rejected: 0,
    ignoredPeer: 0,
    txNoPeer: 0,
  };

  private armTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private reinitTimer: NodeJS.Timeout | null = null;
  private countersTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly adapter: IGBLinkAdapter,
    private readonly net: INetplayEndpoint,
    private readonly mode: BridgeMode,
    private readonly variant: AwVariant,
    opts: AwBridgeOptions = {},
  ) {
    super();
    this.dedupWindowMs = opts.dedupWindowMs ?? 100;
    this.now = opts.now ?? Date.now;
    this.gate = new PhaseGate(mode, variant, {
      now: () => this.now(),
      rtt: () => this.net.peerRttMs?.(this.expectedPeerId),
      send: (packet) => this.transmit(packet),
      log: (msg) => this.emit('log', msg),
    });
  }

  get players(): PlayerSettings {
    // gpsp makes netplay client 0 the MULTI parent, so client ids are seats: hosting, the GBA is the parent; joining, child 1.
    return { playerCount: 2, seat: this.mode === 'join' ? 1 : 0 };
  }

  get expectedPeerId(): number {
    return this.mode === 'join' ? 0 : 1;
  }

  get linkPhase(): LinkPhase {
    return this.phase;
  }

  get bridgeCounters(): BridgeCounters {
    return { ...this.counters };
  }

  async start(initFirmwareNow = true): Promise<void> {
    this.net.on('session-start', this.onSessionStart);
    this.net.on('packet', this.onPacket);
    this.net.on('peer-playing', this.onPeerPlaying);
    this.net.on('peer-left', this.onPeerLeft);
    this.net.on('closed', this.onNetClosed);
    this.adapter.on('status', this.onFwStatus);
    this.adapter.on('aw-chunk', this.onFwChunk);
    this.adapter.on('detached', this.onDetached);
    this.adapter.on('attached', this.onAttached);

    this.countersTimer = setInterval(() => {
      this.emit('counters', this.bridgeCounters);
      this.logStatusLine();
    }, COUNTERS_INTERVAL_MS);
    this.countersTimer.unref?.();

    if (initFirmwareNow) {
      await this.initFirmware();
    } else {
      this.setPhase('idle');
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.sendFarewell();
    this.resetSection();
    this.clearReinitTimer();
    if (this.countersTimer) clearInterval(this.countersTimer);
    this.countersTimer = null;
    this.net.off('session-start', this.onSessionStart);
    this.net.off('packet', this.onPacket);
    this.net.off('peer-playing', this.onPeerPlaying);
    this.net.off('peer-left', this.onPeerLeft);
    this.net.off('closed', this.onNetClosed);
    this.adapter.off('status', this.onFwStatus);
    this.adapter.off('aw-chunk', this.onFwChunk);
    this.adapter.off('detached', this.onDetached);
    this.adapter.off('attached', this.onAttached);
    this.selfCancelAt = this.now();
    await this.adapter.cancel().catch(() => undefined);
    this.setPhase('closed');
  }

  // ---- firmware section lifecycle ----

  private async initFirmware(): Promise<void> {
    if (this.reinitializing || this.stopped) return;
    this.reinitializing = true;
    // initLinkMode opens with Cancel, which itself provokes a LinkClosed.
    this.selfCancelAt = this.now();
    this.resetSection();
    this.setPhase('init');
    try {
      const fw = await this.adapter.getFirmwareInfo();
      this.firmware = fw;
      if (!fwAtLeast(fw, AW_MIN_FW.major, AW_MIN_FW.minor, AW_MIN_FW.patch)) {
        throw new Error(
          `GB-Link firmware ${firmwareLabel(fw)} is too old — Advance Wars needs 3.0.0 or newer (update the adapter from the GBLink launcher)`,
        );
      }
      this.emit('log', `firmware ${firmwareLabel(fw)}`);
      await this.adapter.initLinkMode(this.variant, this.players);
      // 0xFF03 can arrive before the player settings write resolves.
      if (!this.sectionLive && !this.stopped) {
        this.armTimer = setTimeout(() => {
          this.armTimer = null;
          if (this.sectionLive || this.stopped) return;
          this.emit('log', 'firmware never reported HandshakeReceived — re-entering link mode');
          this.scheduleReinit();
        }, ARM_TIMEOUT_MS);
        this.armTimer.unref?.();
      }
    } catch (e) {
      this.emit('error', e as Error);
      if ((e as Error).name === 'AdapterTimeoutError') this.scheduleReinit();
      else this.setPhase('idle');
    } finally {
      this.reinitializing = false;
    }
  }

  /** Ignores closes we caused: every init begins with a Cancel, and reacting to those would loop forever. */
  private scheduleReinit(): void {
    if (this.stopped || this.closing || this.reinitializing || this.reinitTimer) return;
    if (this.now() - this.selfCancelAt < SELF_CLOSE_GRACE_MS) {
      this.emit('log', 'link closed by our own cancel — not re-initializing');
      return;
    }
    if (this.reinitAttempts >= MAX_REINIT_ATTEMPTS) {
      this.emit(
        'log',
        `link mode failed to start ${this.reinitAttempts} times — unplug and replug the adapter`,
      );
      return;
    }
    this.reinitAttempts++;
    this.reinitTimer = setTimeout(() => {
      this.reinitTimer = null;
      void this.initFirmware();
    }, REINIT_DELAY_MS);
    this.reinitTimer.unref?.();
  }

  /** Re-enters the mode so the proxy is fresh for the next peer; the GBA sees a ~1 s cable pull, netplay is untouched. */
  private async restartSection(reason: string): Promise<void> {
    if (this.closing || this.stopped) return;
    this.closing = true;
    this.emit('log', `restarting link section: ${reason}`);
    this.sendFarewell();
    this.selfCancelAt = this.now();
    this.resetSection();
    this.setPhase('closing');
    await this.adapter.cancel().catch(() => undefined);
    this.closing = false;
    if (this.stopped) return;
    this.reinitTimer ??= setTimeout(() => {
      this.reinitTimer = null;
      void this.initFirmware();
    }, REINIT_DELAY_MS);
    this.reinitTimer.unref?.();
  }

  private resetSection(): void {
    this.sectionLive = false;
    this.handshakeSent = false;
    this.relayActive = false;
    this.pendingInbound.length = 0;
    this.lastInState = null;
    this.variantWarned = { out: false, in: false };
    this.parser.reset();
    this.chunker.clear();
    this.peerKeys.reset();
    this.clearTimer('armTimer');
    this.clearTimer('startTimer');
    this.gate.reset();
  }

  private clearTimer(name: 'armTimer' | 'startTimer'): void {
    const t = this[name];
    if (t) clearTimeout(t);
    this[name] = null;
  }

  private clearReinitTimer(): void {
    if (this.reinitTimer) clearTimeout(this.reinitTimer);
    this.reinitTimer = null;
  }

  // ---- firmware side ----

  private readonly onFwStatus = (status: FwStatus): void => {
    if (this.stopped) return;
    this.emit('log', `fw status 0x${status.toString(16)}`);
    switch (status) {
      case FwStatus.HandshakeReceived:
        if (this.sectionLive) break;
        this.sectionLive = true;
        this.reinitAttempts = 0;
        this.clearTimer('armTimer');
        this.armProxy();
        break;
      case FwStatus.LinkConnected:
        if (!this.sectionLive) break;
        if (!this.relayActive) {
          this.relayActive = true;
          this.clearTimer('startTimer');
          // Reset gpsp's stale view of us before anything else it hears.
          this.sendAnnouncement();
          const buffered = this.pendingInbound.splice(0);
          for (const frame of buffered) this.chunker.push(frame);
          if (buffered.length > 0) {
            this.emit('log', `delivered ${buffered.length} buffered peer frame(s) to the proxy`);
          }
        }
        this.setPhase('linked', status);
        break;
      case FwStatus.LinkReconnecting:
        // Status only: the proxy keeps answering the GBA, and a gpsp host is silent until its game links.
        if (this.relayActive) this.setPhase('partner-quiet', status);
        break;
      case FwStatus.LinkClosed:
        this.resetSection();
        // The Cancel opening every init causes one too; the phase stays at init.
        if (this.now() - this.selfCancelAt >= SELF_CLOSE_GRACE_MS) this.setPhase('closing', status);
        this.scheduleReinit();
        break;
      default:
        break;
    }
  };

  private armProxy(): void {
    if (this.handshakeSent || !this.sectionLive) return;
    this.handshakeSent = true;
    this.emit('log', 'arming the link proxy (StartHandshake)');
    void this.adapter.startHandshake().catch((e: Error) => this.emit('error', e));
    this.setPhase('starting');
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.relayActive || this.stopped) return;
      void this.restartSection('no LinkConnected after StartHandshake');
    }, START_TIMEOUT_MS);
    this.startTimer.unref?.();
  }

  private readonly onFwChunk = (buf: Buffer): void => {
    if (this.stopped) return;
    this.parser.push(buf);
  };

  private onFwFrame(frame: Maw1Frame): void {
    this.sniffVariant(frame, 'out');
    if (!this.sessionLive || !this.net.playingPeers.has(this.expectedPeerId)) {
      // Dropped, as a gpsp with no connections would.
      this.counters.txNoPeer++;
      return;
    }
    if (frame.state === AwState.PacketXg && frame.cnt >= 2) this.noteLobbyPacket();
    for (const out of this.peerKeys.toPeer(frame)) {
      const packet = serializeFrame(out);
      if (this.gate.pass(out, packet)) this.transmit(packet);
    }
  }

  private transmit(packet: Buffer): void {
    if (!this.sessionLive || !this.net.playingPeers.has(this.expectedPeerId)) {
      this.counters.txNoPeer++;
      return;
    }
    this.net.sendPacket(packet);
    this.counters.txPackets++;
    this.counters.txBytes += packet.length;
  }

  private noteLobbyPacket(): void {
    if (this.peerHeard || this.silentPeerWarned) return;
    const now = this.now();
    if (this.lobbySince === 0) {
      this.lobbySince = now;
      return;
    }
    if (now - this.lobbySince < SILENT_PEER_MS) return;
    this.silentPeerWarned = true;
    const nick = this.net.playingPeers.get(this.expectedPeerId)?.nick ?? 'the other player';
    // A joined gpsp sends from the moment its game runs; a hosting one only once its game is in the link menu.
    const lead =
      this.mode === 'host'
        ? `nothing has arrived from ${nick}: their gpsp is not running the Advance Wars link.`
        : `nothing has arrived from ${nick} yet. Once they are in the link menu, check their gpsp.`;
    // The core options menu shows the new value at once, but the running game keeps the mode it loaded with.
    this.emit(
      'warn',
      `${lead} gpsp applies Link Cable Connectivity only when a game loads, so with it on ` +
        `${GPSP_SERIAL_OPTION[this.variant]} or Automatic they close the content and load the game again; ` +
        `Restart is not enough. Playing alone, their Link screen shows a 1P icon only when the link is running`,
    );
  }

  /** A new peer or session: whether the peer's gpsp speaks MAW1 is unknown again. */
  private resetPeerWatch(): void {
    this.peerHeard = false;
    this.lobbySince = 0;
    this.silentPeerWarned = false;
  }

  private writeChunk(chunk: Buffer): void {
    void this.adapter
      .writeAwChunk(this.expectedPeerId, chunk)
      .catch((e: Error) => this.emit('log', `fw write failed: ${e.message}`));
  }

  // ---- netplay side ----

  private readonly onSessionStart = (id: number): void => {
    this.sessionLive = true;
    this.resetPeerWatch();
    this.emit('log', `netplay session live (client ${id})`);
    if (this.relayActive) this.sendAnnouncement();
  };

  private readonly onPeerPlaying = (peer: NetplayPeer): void => {
    if (peer.id !== this.expectedPeerId) {
      if (!this.ignoredPeers.has(peer.id)) {
        this.ignoredPeers.add(peer.id);
        this.emit(
          'warn',
          `player ${peer.id} (${peer.nick}) joined — the bridge's Advance Wars link is 2-player only; ignoring them`,
        );
      }
      return;
    }
    this.emit('log', `peer ${peer.nick} is playing`);
    this.resetPeerWatch();
    if (this.relayActive) this.sendAnnouncement();
  };

  private readonly onPeerLeft = (peer: NetplayPeer): void => {
    if (peer.id !== this.expectedPeerId) {
      this.ignoredPeers.delete(peer.id);
      this.emit('log', `player ${peer.id} (${peer.nick}) left`);
      return;
    }
    this.emit('log', `peer ${peer.nick} left`);
    this.resetPeerWatch();
    if (this.handshakeSent) void this.restartSection('peer left');
  };

  private readonly onNetClosed = (): void => {
    this.sessionLive = false;
    if (this.handshakeSent && !this.stopped) void this.restartSection('netplay session closed');
  };

  private readonly onPacket = (buf: Buffer, src: number): void => {
    if (this.stopped) return;
    if (src !== this.expectedPeerId) {
      this.counters.ignoredPeer++;
      if (!this.ignoredPeers.has(src)) {
        this.ignoredPeers.add(src);
        this.emit('warn', `ignoring frames from player ${src} — 2-player only`);
      }
      return;
    }
    this.peerHeard = true;
    const frame = parseMaw1(buf);
    if (frame === null) {
      this.counters.rejected++;
      const seen = identifyPacket(buf);
      if (seen && seen !== 'maw1' && !this.mismatchWarned) {
        this.mismatchWarned = true;
        this.emit('warn', mismatchWarning(this.variant, seen));
      }
      this.logReject(`rejected peer packet: ${maw1Problem(buf) ?? 'unknown'}`);
      return;
    }
    this.sniffVariant(frame, 'in');
    this.gate.observe(frame);
    if (isStateOnly(frame)) {
      const now = this.now();
      if (this.lastInState === frame.state && now - this.lastInAt < this.dedupWindowMs) {
        this.counters.dedupSuppressed++;
        return;
      }
    }
    this.lastInState = frame.state;
    this.lastInAt = this.now();
    this.counters.rxPackets++;
    this.counters.rxBytes += buf.length;
    if (this.relayActive) {
      this.chunker.push(buf);
    } else {
      // Not linked yet: keep the newest frames so a hello sent during a ~1 s re-init is not lost.
      this.pendingInbound.push(Buffer.from(buf));
      if (this.pendingInbound.length > PENDING_INBOUND_MAX) this.pendingInbound.shift();
    }
  };

  // ---- helpers ----

  /** `(0x7FFF, PACKETXG, cnt 0)`: tells gpsp we are back at protocol start. */
  private sendAnnouncement(): void {
    if (!this.sessionLive || !this.net.playingPeers.has(this.expectedPeerId)) return;
    const packet = serializeMaw1(CMD_NONE, AwState.PacketXg, []);
    this.net.sendPacket(packet);
    this.counters.txPackets++;
    this.counters.txBytes += packet.length;
  }

  /** gpsp never times an AW peer out: without a PACKETXG farewell, our last state would stick. */
  private sendFarewell(): void {
    if (!this.sessionLive || !this.relayActive) return;
    if (!this.net.playingPeers.has(this.expectedPeerId)) return;
    this.net.sendPacket(serializeMaw1(CMD_NONE, AwState.PacketXg, []));
  }

  private sniffVariant(frame: Maw1Frame, dir: 'out' | 'in'): void {
    // The variant isn't negotiated; a game polling the other variant's sync word in PACKETXG is the one sure tell.
    if (frame.state !== AwState.PacketXg || frame.cnt !== 0) return;
    if (frame.cmd !== AW_SYNC_WORD[otherVariant(this.variant)]) return;
    if (this.variantWarned[dir]) return;
    this.variantWarned[dir] = true;
    const games: Record<AwVariant, string> = { aw1: 'Advance Wars', aw2: 'Advance Wars 2' };
    const other = games[otherVariant(this.variant)];
    if (dir === 'out') {
      this.emit(
        'error',
        new Error(
          `your GBA is running ${other} but ${games[this.variant]} is selected — stop and pick the other game`,
        ),
      );
    } else {
      this.emit(
        'warn',
        `the other player seems to be running ${other} (or their gpsp_serial core option is set to the wrong mode)`,
      );
    }
  }

  private logReject(msg: string): void {
    if (this.rejectsLogged >= REJECT_LOG_MAX) return;
    this.rejectsLogged++;
    this.emit('log', msg);
  }

  /** Once a second while a session or section is up, to tell a silent peer from unsent or misaddressed frames. */
  private logStatusLine(): void {
    if (this.stopped || (!this.sessionLive && !this.sectionLive)) return;
    const c = this.counters;
    const peers = [...this.net.playingPeers.keys()].join(',') || 'none';
    this.emit(
      'log',
      `aw-bridge phase=${this.phase} relay=${this.relayActive} expect=${this.expectedPeerId} ` +
        `peers=[${peers}] tx=${c.txPackets} txNoPeer=${c.txNoPeer} rx=${c.rxPackets} ` +
        `ignored=${c.ignoredPeer} rejected=${c.rejected} dedup=${c.dedupSuppressed}`,
    );
  }

  private readonly onDetached = (): void => {
    this.resetSection();
    this.setPhase('idle');
    this.emit('log', 'GB-Link unplugged — waiting for it to return');
  };

  private readonly onAttached = (): void => {
    if (this.stopped) return;
    this.emit('log', 'GB-Link reattached');
    void this.adapter
      .start()
      .then(() => this.initFirmware())
      .catch((e: Error) => this.emit('error', e));
  };

  private setPhase(phase: LinkPhase, raw?: number): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('link-phase', phase, raw);
  }
}
