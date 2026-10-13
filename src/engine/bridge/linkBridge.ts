import { EventEmitter } from 'node:events';
import {
  FwStatus,
  Mpk1State,
  firmwareLabel,
  fwAtLeast,
  type AdapterRole,
  type IGBLinkAdapter,
  type INetplayEndpoint,
  type LinkPhase,
  type PumpTimings,
  type Round,
} from '../types';
import { buildMpk1, parseMpk1 } from '../mpk1';
import { identifyPacket, mismatchWarning } from '../netplay/protocolMagic';
import { PacedEmitter, RoundBatcher } from './pumps';

export type BridgeMode = 'join' | 'host';

/** Peer link-state older than this reads as PREINIT (gpsp's 240-frame wipe). */
const PEER_STALE_MS = 4000;
const GRACEFUL_CLOSE_TICK_MS = 100;
const GRACEFUL_CLOSE_MAX_MS = 3000;
export const REINIT_DELAY_MS = 750;
/** LinkClosed arriving this soon after our own Cancel is our own doing. */
export const SELF_CLOSE_GRACE_MS = 2000;
/** Consecutive failed link-mode starts before we stop retrying. */
export const MAX_REINIT_ATTEMPTS = 5;
/** Firmware with the persistent cable selection (0x4b) the bridge relies on. */
const GEN3_MIN_FW = { major: 2, minor: 2, patch: 3 };
/**
 * Minimum time between arming the adapter handshake and driving 0x8FFF.
 * The real child GBA needs actual B9A0 exchange rounds (~16 ms each) before
 * the connect word; the packet layer leaves handshake mode the moment IT
 * transmits 0x8FFF (packetLayer.cpp:16-19), acknowledged or not.
 */
const CONNECT_GRACE_MS = 150;

const CLOSE_ROUND_BUF = (() => {
  const buf = Buffer.alloc(64);
  for (let i = 0; i < 4; i++) buf.writeUInt16LE(0x5fff, i * 16);
  return buf;
})();

interface PeerLink {
  state: number;
  lastSeen: number;
}

export interface LinkBridgeEvents {
  'link-phase': [LinkPhase, number?];
  counters: [{ txPackets: number; rxPackets: number }];
  /** Cable type sampled by the firmware at mode entry (0 GBA, 1 GBC/none). */
  cable: [number];
  log: [string];
  warn: [string];
  error: [Error];
}

/**
 * Translates between the GB-Link firmware relay (statuses + 8-word rounds)
 * and the gpsp MPK1 protocol carried over a netplay endpoint.
 *
 * join: adapter is MASTER (real GBA = child), we mirror gpsp's client FSM
 *       against the host's broadcast state (serial_proto.c:246-370).
 * host: adapter is SLAVE (real GBA = parent), we mirror gpsp's master FSM
 *       (serial_proto.c:139-235); the real GBA decides the 0x8FFF timing.
 */
export class LinkBridge extends EventEmitter<LinkBridgeEvents> {
  private readonly emitter: PacedEmitter;
  private readonly batcher: RoundBatcher;

  private sessionLive = false;
  /** 0xFF03 seen for the currently-live firmware section. */
  private sectionLive = false;
  private handshakeSent = false;
  private connectSent = false;
  private relayActive = false;
  private writeGate = false;
  private closing = false;
  private stopped = false;
  private reinitializing = false;

  private readonly peers = new Map<number, PeerLink>();
  private localState: Mpk1State = Mpk1State.Preinit;
  private phase: LinkPhase = 'idle';

  private txPackets = 0;
  private rxPackets = 0;
  private droppedWhileClosed = 0;
  private mismatchWarned = false;
  /**
   * Peer data received after its re-handshake but before our write gate
   * opens. The remote relay can go live before ours, and some of these
   * words (e.g. trade-confirm exchanges) are sent only once, so they are
   * buffered and delivered at gate-open. Data from before the peer's
   * re-handshake belongs to the previous link section and is discarded.
   */
  private readonly pendingRounds: Round[] = [];
  private handshakeArmedAt = 0;
  /** When we last issued a Cancel (which provokes a LinkClosed of our own). */
  private selfCancelAt = 0;
  /** Consecutive link-mode starts that never reached HandshakeReceived. */
  private reinitAttempts = 0;
  /**
   * A state-1 packet has been seen in the current section. After a link
   * teardown the peer keeps broadcasting state-2 keepalives until its game
   * re-enters link init (battle/trade result screens can run for seconds),
   * so state 2 alone does not mean the peer is ready to re-link — only its
   * transition through state 1 does.
   */
  private peerReadySeen = false;
  private evalTimer: NodeJS.Timeout | null = null;

  private staleTimer: NodeJS.Timeout | null = null;
  private countersTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly adapter: IGBLinkAdapter,
    private readonly net: INetplayEndpoint,
    private readonly mode: BridgeMode,
    private readonly timings?: PumpTimings,
  ) {
    super();
    this.emitter = new PacedEmitter((state, words) => this.sendMpk1(state, words), timings);
    this.batcher = new RoundBatcher(
      (buf) => void this.adapter.writeRounds(buf).catch((e: Error) => this.emit('log', `fw write failed: ${e.message}`)),
      timings,
      (msg) => this.emit('log', `batcher anomaly: ${msg}`),
    );
  }

  get role(): AdapterRole {
    return this.mode === 'join' ? 'master' : 'slave';
  }

  async start(initFirmwareNow = true): Promise<void> {
    this.net.on('session-start', this.onSessionStart);
    this.net.on('packet', this.onPacket);
    this.net.on('peer-left', this.onPeerLeft);
    this.net.on('closed', this.onNetClosed);
    this.adapter.on('status', this.onFwStatus);
    this.adapter.on('round', this.onFwRound);
    this.adapter.on('detached', this.onDetached);
    this.adapter.on('attached', this.onAttached);

    this.staleTimer = setInterval(() => this.expireStalePeers(), 500);
    this.staleTimer.unref?.();
    this.countersTimer = setInterval(() => {
      this.emit('counters', { txPackets: this.txPackets, rxPackets: this.rxPackets });
    }, 1000);
    this.countersTimer.unref?.();

    if (initFirmwareNow) {
      this.setPhase('searching');
      await this.initFirmware();
    } else {
      this.setPhase('idle');
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.relayActive && !this.adapter.emulated) await this.gracefulClose();
    this.teardownPumps();
    this.emitter.dispose();
    this.batcher.dispose();
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.countersTimer) clearInterval(this.countersTimer);
    if (this.evalTimer) clearTimeout(this.evalTimer);
    this.selfCancelAt = Date.now();
    await this.adapter.cancel().catch(() => undefined);
    this.setPhase('closed');
  }

  /**
   * Re-enter link mode after the firmware reported LinkClosed — but never in
   * response to a close we caused ourselves. Cancel makes the firmware exit
   * its mode and emit LinkClosed, and every init begins with a Cancel, so
   * reacting to those would cycle Cancel -> SetMode forever (visible on the
   * adapter as continuous mode switching).
   */
  private scheduleReinit(): void {
    if (this.stopped || this.closing || this.reinitializing) return;
    if (Date.now() - this.selfCancelAt < SELF_CLOSE_GRACE_MS) {
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
    setTimeout(() => void this.initFirmware(), REINIT_DELAY_MS).unref?.();
  }

  private async initFirmware(): Promise<void> {
    if (this.reinitializing || this.stopped) return;
    this.reinitializing = true;
    // initLinkMode opens with Cancel, which itself provokes a LinkClosed.
    this.selfCancelAt = Date.now();
    try {
      const fw = await this.adapter.getFirmwareInfo();
      if (fw.device === 'esp32') {
        if (fw.major || fw.minor || fw.patch) this.emit('log', `ESP32 bridge firmware ${firmwareLabel(fw)}`);
      } else {
        if (!fwAtLeast(fw, GEN3_MIN_FW.major, GEN3_MIN_FW.minor, GEN3_MIN_FW.patch)) {
          throw new Error(
            `GB-Link firmware ${firmwareLabel(fw)} is too old — Pokémon link needs 2.2.3 or newer (update the adapter from the GBLink launcher)`,
          );
        }
        this.emit('log', `firmware ${firmwareLabel(fw)}`);
      }
      if (fw.cableSelection && fw.cableSelection !== 'auto') {
        this.emit('log', `link cable pinned on the adapter: ${fw.cableSelection.toUpperCase()}`);
      }
      await this.adapter.initLinkMode(this.role);
      const cable = await this.adapter.getCableType().catch(() => -1);
      if (cable >= 0) {
        this.emit('cable', cable);
        this.emit('log', `cable type ${cable}`);
      }
      this.setPhase('searching');
    } catch (e) {
      this.emit('error', e as Error);
    } finally {
      this.reinitializing = false;
    }
  }

  // ---- netplay side ----

  private onSessionStart = (_id: number) => {
    this.sessionLive = true;
    this.evaluate();
  };

  private onPacket = (buf: Buffer, src: number) => {
    const pkt = parseMpk1(buf);
    if (!pkt) {
      const seen = identifyPacket(buf);
      if (seen && seen !== 'mpk1' && !this.mismatchWarned) {
        this.mismatchWarned = true;
        this.emit('warn', mismatchWarning('gen3', seen));
      }
      return;
    }
    this.rxPackets++;
    const prev = this.peers.get(src)?.state;
    if (prev !== pkt.state) {
      this.emit('log', `peer ${src} link state ${prev ?? '-'} -> ${pkt.state}`);
    }
    this.peers.set(src, { state: pkt.state, lastSeen: Date.now() });
    if (pkt.state === Mpk1State.Handshake && (this.mode === 'host' || src === 0)) {
      this.peerReadySeen = true;
    }
    this.evaluate();
    if (pkt.words) {
      if (this.writeGate) this.batcher.push(pkt.words);
      else if (this.peerReadySeen) this.pendingRounds.push(new Uint16Array(pkt.words));
      else this.droppedWhileClosed++;
    }
  };

  private onPeerLeft = ({ id }: { id: number }) => {
    this.peers.delete(id);
    this.batcher.clear();
    this.pendingRounds.length = 0;
    if (this.mode === 'host' && this.relayActive) {
      void this.gracefulClose().then(() => this.evaluate());
      return;
    }
    this.evaluate();
  };

  private onNetClosed = () => {
    this.sessionLive = false;
    this.peers.clear();
    if (this.relayActive && !this.stopped) void this.gracefulClose();
    this.evaluate();
  };

  // ---- firmware side ----

  private onFwStatus = (status: FwStatus) => {
    if (this.stopped) return;
    this.emit('log', `fw status 0x${status.toString(16)}`);
    switch (status) {
      case FwStatus.HandshakeReceived:
        // Link mode is alive and the GBA is talking: retries earned back.
        this.reinitAttempts = 0;
        this.sectionLive = true;
        this.setPhase('cable-club', status);
        this.evaluate();
        break;
      case FwStatus.LinkConnected:
        this.relayActive = true;
        if (this.mode === 'host') {
          // The real parent GBA sent 0x8FFF: gpsp masters drop every queued
          // peer packet at this transition (serial_proto.c:164-170).
          this.batcher.clear();
          this.pendingRounds.length = 0;
          if (this.hostShouldRefuseLoneConnect()) {
            void this.gracefulClose();
            return;
          }
        }
        this.openWriteGate();
        this.setPhase('connected', status);
        this.evaluate();
        break;
      case FwStatus.LinkReconnecting:
        this.resetSection();
        this.setPhase('handshake', status);
        break;
      case FwStatus.LinkClosed:
        this.resetSection();
        this.emitter.disable();
        this.localState = Mpk1State.Preinit;
        this.setPhase('closing', status);
        this.scheduleReinit();
        break;
      default:
        break;
    }
  };

  private onFwRound = (round: Round) => {
    if (this.stopped) return;
    this.emitter.pushRounds([round]);
    // The firmware's final data flush and its LinkReconnecting status arrive
    // on different USB endpoints, so the status can be processed first.
    // Rounds trailing the teardown carry the GBA's close acknowledgements
    // and must go out immediately.
    if (!this.relayActive) {
      const flushed = this.emitter.flushNow();
      if (flushed > 0) this.emit('log', `late fw round(s) after teardown: flushed ${flushed}`);
    }
  };

  private onDetached = () => {
    this.resetSection();
    this.emitter.disable();
    this.setPhase('idle');
    this.emit(
      'log',
      this.adapter.emulated ? 'the ESP32 bridge is away (restarting or unplugged) — waiting for it' : 'GB-Link unplugged — waiting for it to return',
    );
  };

  private onAttached = () => {
    if (this.stopped) return;
    this.emit('log', this.adapter.emulated ? 'the ESP32 bridge is back' : 'GB-Link reattached');
    void this.adapter
      .start()
      .then(() => this.initFirmware())
      .catch((e: Error) => this.emit('error', e));
  };

  // ---- core translation ----

  /**
   * Central transition function; safe to call on every input change.
   * Mirrors gpsp's serialpoke client (join) / master (host) rules.
   */
  private evaluate(): void {
    if (this.closing || this.stopped) return;
    if (this.mode === 'join') this.evaluateJoin();
    else this.evaluateHost();
  }

  private evaluateJoin(): void {
    const hostState = this.peerState(0);

    if (!this.sessionLive || !this.sectionLive || hostState === Mpk1State.Preinit) {
      // gpsp clients are completely silent while the master reports PREINIT
      // (serial_proto.c:263-264) — and we additionally have nothing to say
      // until the real GBA sits in the cable club (0xFF03).
      if (this.emitter.enabled) this.emit('log', 'link idle (silent)');
      this.emitter.disable();
      this.writeGate = false;
      return;
    }

    if (hostState === Mpk1State.Handshake) {
      this.localState = Mpk1State.Handshake;
      this.emitter.setState(this.localState);
      this.emitter.enable();
      this.ensureHandshakeStarted();
      // While the physical relay is live this is only the peer's transient
      // state flap — never downgrade the user-visible phase for it.
      if (!this.relayActive) this.setPhase('handshake');
      return;
    }

    // hostState CONNECTED. A gpsp client self-connects instantly
    // (serial_proto.c:286-301), but the physical child GBA needs a real
    // B9A0 exchange first, so state 1 is held until the adapter has been
    // armed long enough for actual handshake rounds to have happened.
    if (!this.peerReadySeen) {
      // The host has not begun its own re-handshake yet (its keepalives
      // still say CONNECTED). Connecting now would let the GBA run ahead
      // of the emulated game; wait for the host's state-1 transition.
      this.localState = Mpk1State.Handshake;
      this.emitter.setState(this.localState);
      this.emitter.enable();
      if (!this.relayActive) this.setPhase('handshake');
      return;
    }
    this.ensureHandshakeStarted();
    const armedFor = Date.now() - this.handshakeArmedAt;
    if (armedFor < CONNECT_GRACE_MS) {
      this.localState = Mpk1State.Handshake;
      this.emitter.setState(this.localState);
      this.emitter.enable();
      this.scheduleEvaluate(CONNECT_GRACE_MS - armedFor + 10);
      if (!this.relayActive) this.setPhase('handshake');
      return;
    }
    this.localState = Mpk1State.Connected;
    this.emitter.setState(this.localState);
    this.emitter.enable();
    this.ensureLinkConnected();
    this.openWriteGate();
    if (this.relayActive) this.setPhase('connected');
  }

  private evaluateHost(): void {
    if (!this.sectionLive) {
      this.emitter.disable();
      this.writeGate = false;
      return;
    }

    if (!this.relayActive) {
      // Real GBA is emitting 0xB9A0: we are a gpsp master in HANDSHAKE.
      this.localState = Mpk1State.Handshake;
      this.emitter.setState(this.localState);
      this.emitter.enable();
      // Only arm the adapter's handshake once a playing peer has shown a
      // fresh state-1 this section; until then the adapter answers 0xD15E
      // and the GBA keeps searching — exactly like a missing second player.
      if (this.peerReadySeen) this.ensureHandshakeStarted();
      this.setPhase('handshake');
      return;
    }

    this.localState = Mpk1State.Connected;
    this.emitter.setState(this.localState);
    this.emitter.enable();
    this.openWriteGate();
    this.setPhase('connected');
  }

  private hostShouldRefuseLoneConnect(): boolean {
    // 0xFF05 with no playing peer at handshake or beyond: the peer vanished
    // after StartHandshake (which is irrevocable within a firmware section).
    return !this.anyPeerAtLeast(Mpk1State.Handshake);
  }

  private ensureHandshakeStarted(): void {
    if (this.handshakeSent || !this.sectionLive) return;
    this.handshakeSent = true;
    this.handshakeArmedAt = Date.now();
    this.emit('log', 'arming adapter handshake (StartHandshake)');
    void this.adapter.startHandshake().catch((e: Error) => this.emit('error', e));
  }

  private ensureLinkConnected(): void {
    if (this.connectSent || !this.handshakeSent || this.mode !== 'join') return;
    this.connectSent = true;
    this.emit('log', 'driving link connect (ConnectLink)');
    void this.adapter.connectLink().catch((e: Error) => this.emit('error', e));
  }

  private sendMpk1(state: number, words: Round | null): void {
    this.net.sendPacket(buildMpk1(state, words));
    this.txPackets++;
  }

  private peerState(id: number): number {
    const p = this.peers.get(id);
    if (!p || Date.now() - p.lastSeen > PEER_STALE_MS) return Mpk1State.Preinit;
    return p.state;
  }

  private anyPeerAtLeast(state: Mpk1State): boolean {
    for (const [id] of this.peers) {
      if (this.peerState(id) >= state) return true;
    }
    return false;
  }

  private expireStalePeers(): void {
    let changed = false;
    for (const [id, p] of this.peers) {
      if (Date.now() - p.lastSeen > PEER_STALE_MS && p.state !== Mpk1State.Preinit) {
        p.state = Mpk1State.Preinit;
        changed = true;
      }
    }
    if (changed) this.evaluate();
  }

  private openWriteGate(): void {
    if (this.writeGate) return;
    this.writeGate = true;
    const buffered = this.pendingRounds.length;
    for (const round of this.pendingRounds) this.batcher.push(round);
    this.pendingRounds.length = 0;
    if (buffered > 0 || this.droppedWhileClosed > 0) {
      this.emit(
        'log',
        `write gate opened (delivered ${buffered} buffered round(s), dropped ${this.droppedWhileClosed} stale)`,
      );
      this.droppedWhileClosed = 0;
    }
  }

  /** Re-run evaluate() after a delay (single pending timer, latest wins). */
  private scheduleEvaluate(ms: number): void {
    if (this.evalTimer) clearTimeout(this.evalTimer);
    this.evalTimer = setTimeout(() => {
      this.evalTimer = null;
      this.evaluate();
    }, ms);
    this.evalTimer.unref?.();
  }

  private resetSection(): void {
    this.sectionLive = false;
    this.handshakeSent = false;
    this.connectSent = false;
    this.relayActive = false;
    this.writeGate = false;
    // Recorded peer state never carries across sections: the peer's own
    // teardown transition may still be in flight, and each section's
    // handshake commands must act on fresh evidence only.
    this.peers.clear();
    this.peerReadySeen = false;
    this.pendingRounds.length = 0;
    // Deliver the undrained fw->net tail before going quiet: the firmware's
    // final flush (carrying the GBA's 0x5FFF close-acks) lands just before
    // 0xFF06, and the peer's game hangs on the close until it sees them.
    const flushed = this.emitter.flushNow();
    if (flushed > 0) this.emit('log', `section reset: flushed ${flushed} tail round(s) to peer`);
    this.batcher.clear();
    this.pendingRounds.length = 0;
  }

  private teardownPumps(): void {
    this.emitter.disable();
    this.emitter.clear();
    this.batcher.clear();
    this.pendingRounds.length = 0;
    this.writeGate = false;
  }

  /**
   * Drive READY_CLOSE_LINK (0x5FFF) rounds at the GBA until the firmware
   * reports the section closed — the sanctioned equivalent of ending the
   * cable-club activity; mid-battle it looks like a cable pull.
   */
  private async gracefulClose(): Promise<void> {
    if (this.closing) return;
    if (this.adapter.emulated) {
      await this.restartSection('the link ended on the netplay side');
      return;
    }
    this.closing = true;
    this.writeGate = false;
    this.batcher.clear();
    this.pendingRounds.length = 0;
    this.emitter.clear();
    this.setPhase('closing');
    const deadline = Date.now() + GRACEFUL_CLOSE_MAX_MS;
    let timedOut = false;
    try {
      while (Date.now() < deadline && this.relayActive && !this.stopped) {
        await this.adapter.writeRounds(CLOSE_ROUND_BUF).catch(() => undefined);
        await delay(GRACEFUL_CLOSE_TICK_MS);
      }
      timedOut = this.relayActive;
    } finally {
      this.closing = false;
    }
    if (timedOut && !this.stopped) {
      // The game never answered the close: force the mode down and enter it
      // again, or the bridge would sit without a link mode.
      await this.restartSection('the GBA did not answer the link close');
      return;
    }
    // A 0xFF06 during the loop already reset the section, and a fresh
    // 0xFF03 may have started the next one. Section state is owned by
    // onFwStatus; re-evaluating here lets a live new section re-arm.
    this.evaluate();
  }

  /** Cancel the mode (our own LinkClosed is ignored) and enter it again shortly after. */
  private async restartSection(reason: string): Promise<void> {
    if (this.closing || this.stopped) return;
    this.closing = true;
    this.emit('log', `restarting the link section: ${reason}`);
    this.selfCancelAt = Date.now();
    this.resetSection();
    this.emitter.disable();
    this.localState = Mpk1State.Preinit;
    this.setPhase('closing');
    try {
      await this.adapter.cancel().catch(() => undefined);
    } finally {
      this.closing = false;
    }
    if (this.stopped) return;
    setTimeout(() => void this.initFirmware(), REINIT_DELAY_MS).unref?.();
  }

  private setPhase(phase: LinkPhase, raw?: number): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('link-phase', phase, raw);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
