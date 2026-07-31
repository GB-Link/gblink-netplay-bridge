import { BrowserWindow } from 'electron';
import { DeviceWatcher, GBLinkEngine, type SessionPhase as EngineSessionPhase } from '../engine/index';
import { FwStatus, GPSP_CORE_VERSION, type CloseReason, type NetplayPeer } from '../engine/types';
import {
  IPC,
  type AppSettings,
  type BridgeEvent,
  type DeviceStateName,
  type HostRequest,
  type JoinDirectRequest,
  type JoinRelayRequest,
  type SessionPhase,
} from '../shared/ipc';
import { LanResponder } from './lan-discovery';
import { announce, resolveTunnel } from './lobby';
import type { SettingsStore } from './settings';

const ANNOUNCE_FIRST_MS = 5000;
const ANNOUNCE_INTERVAL_MS = 20000;
const DEFAULT_RELAY_PORT = 55435;

const FW_DEVICE_STATE: Partial<Record<FwStatus, DeviceStateName>> = {
  [FwStatus.DeviceReady]: 'device-ready',
  [FwStatus.AwaitMode]: 'awaiting-gba',
  [FwStatus.HandshakeReceived]: 'handshake-received',
  [FwStatus.LinkConnected]: 'link-connected',
  [FwStatus.LinkReconnecting]: 'reconnecting',
  [FwStatus.LinkClosed]: 'closed',
};

export function parseHostPort(
  raw: string,
  defaultPort: number,
): { host: string; port: number } {
  const idx = raw.lastIndexOf(':');
  // Only 'host:port' (a single colon) — anything else is a bare host/IPv6.
  if (idx > 0 && idx === raw.indexOf(':')) {
    const port = Number(raw.slice(idx + 1));
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return { host: raw.slice(0, idx), port };
    }
  }
  return { host: raw, port: defaultPort };
}

function normalizeCrc(crc: string | undefined): string {
  const v = (crc ?? '').trim();
  if (v === '') return '00000000';
  return v.toUpperCase().padStart(8, '0').slice(-8);
}

export class EngineHost {
  private readonly engine: GBLinkEngine;
  private readonly lanResponder: LanResponder;
  private readonly watcher = new DeviceWatcher();

  private hostReq: HostRequest | null = null;
  private relayJoin = false;
  private relaySessionId: string | undefined;
  private peers: NetplayPeer[] = [];
  private sessionPhase: SessionPhase = 'idle';
  private localClientId: number | undefined;
  private announceFirstTimer: NodeJS.Timeout | null = null;
  private announceInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly settings: SettingsStore,
    engine: GBLinkEngine = new GBLinkEngine(),
  ) {
    this.engine = engine;
    this.lanResponder = new LanResponder((msg) => this.log('warn', msg));
    this.wireEngine();
    this.watcher.on('presence', (p) => {
      this.broadcast({
        type: 'device',
        state: p.present ? 'present' : 'absent',
        firmware: p.firmware,
      });
      if (p.detail) this.log('warn', `adapter present but not openable: ${p.detail}`);
    });
    this.engine.on('cable-type', (cableType) => {
      this.broadcast({ type: 'device', cableType });
    });
    this.watcher.start();
  }

  /** Re-broadcasts current device presence (e.g. for a freshly opened window). */
  refreshDevice(): void {
    void this.watcher.check();
  }

  private async startSession(start: () => Promise<void>, port?: number): Promise<void> {
    // The watcher's probe and a session cannot share the claimed interface.
    this.watcher.suspend();
    try {
      await start();
    } catch (e) {
      // A half-started engine would block the next attempt; tear it down and
      // put the UI back to idle before reporting a usable message.
      await this.engine.stop().catch(() => undefined);
      this.stopAnnounce();
      this.lanResponder.stop();
      this.watcher.resume();
      const detail = describeStartFailure(e as Error, port);
      this.log('error', detail);
      this.broadcastSession('socket-error', detail);
      throw new Error(detail);
    }
  }

  async joinDirect(req: JoinDirectRequest): Promise<void> {
    this.resetSessionState();
    await this.startSession(() =>
      this.engine.start({
        mode: 'join',
        cableOverride: this.settings.get().cableOverride,
        host: req.host,
        port: req.port,
        nick: req.nick,
        password: req.password,
      }),
      req.port,
    );
  }

  async joinRelay(req: JoinRelayRequest): Promise<void> {
    this.resetSessionState();
    this.relayJoin = true;
    await this.startSession(() =>
      this.engine.start({
        mode: 'join',
        cableOverride: this.settings.get().cableOverride,
        host: req.addr,
        port: req.port,
        relaySession: req.session,
        nick: req.nick,
        password: req.password,
      }),
      req.port,
    );
  }

  async host(req: HostRequest): Promise<void> {
    this.resetSessionState();
    this.hostReq = req;
    let relay: { addr: string; port: number } | undefined;
    if (req.relay) {
      if (req.relay.handle === 'custom') {
        const raw = (req.relay.customAddr ?? '').trim();
        if (raw === '') throw new Error('custom relay selected but no address given');
        const parsed = parseHostPort(raw, DEFAULT_RELAY_PORT);
        relay = { addr: parsed.host, port: parsed.port };
      } else {
        relay = await resolveTunnel(req.relay.handle);
      }
    }
    await this.startSession(() =>
      this.engine.start({
        mode: 'host',
        cableOverride: this.settings.get().cableOverride,
        port: req.port,
        nick: req.nick,
        password: req.password,
        spectatePassword: req.spectatePassword,
        relay,
        contentCrc: req.gameCrc ? parseInt(req.gameCrc, 16) : undefined,
      }),
      req.port,
    );
    if (!req.announce) this.broadcast({ type: 'announce', status: 'off' });
  }

  async stop(): Promise<void> {
    this.stopAnnounce();
    this.lanResponder.stop();
    this.hostReq = null;
    await this.engine.stop();
    this.watcher.resume();
  }

  private wireEngine(): void {
    this.engine.on('device', (d) => {
      const state: DeviceStateName = d.state === 'error' ? 'access-denied' : d.state;
      this.broadcast({ type: 'device', state, firmware: d.firmware });
      if (d.detail) this.log('warn', d.detail);
    });
    this.engine.on('fw-status', (status) => {
      const state = FW_DEVICE_STATE[status];
      if (state) this.broadcast({ type: 'device', state, raw: status });
    });
    this.engine.on('link-phase', (phase, raw) => {
      this.broadcast({ type: 'link', phase, raw });
    });
    this.engine.on('session', (s) => {
      this.sessionPhase = this.mapPhase(s.phase);
      if (s.localClientId !== undefined) this.localClientId = s.localClientId;
      if (s.phase === 'closed') {
        this.stopAnnounce();
        this.lanResponder.stop();
        this.relayJoin = false;
        this.peers = [];
        this.watcher.resume();
      }
      this.broadcastSession(s.closeReason, s.detail);
    });
    this.engine.on('peers', (peers) => {
      this.peers = peers;
      this.broadcastSession();
    });
    this.engine.on('counters', (c) => {
      this.broadcast({ type: 'counters', txPackets: c.txPackets, rxPackets: c.rxPackets });
    });
    this.engine.on('host-ready', (info) => this.onHostReady(info));
    this.engine.on('log', (msg) => this.log('info', msg));
    this.engine.on('error', (e) => this.log('error', e.message));
  }

  private mapPhase(phase: EngineSessionPhase): SessionPhase {
    if (phase === 'connecting' && this.relayJoin) return 'relay-connecting';
    return phase;
  }

  private onHostReady(info: { extPort: number; relaySessionId?: string }): void {
    this.relaySessionId = info.relaySessionId;
    this.broadcast({
      type: 'host-ready',
      extPort: info.extPort,
      relaySessionId: info.relaySessionId,
    });
    const req = this.hostReq;
    if (!req) return;
    if (req.announce) this.startAnnounce(req, info.extPort);
    if (!req.relay && this.settings.get().lanDiscovery) {
      this.lanResponder.start({
        port: info.extPort,
        nick: req.nick,
        gameName: req.gameName,
        gameCrc: req.gameCrc ?? '',
        hasPassword: !!req.password,
        hasSpectatePassword: !!req.spectatePassword,
        coreVersion: GPSP_CORE_VERSION,
      });
    }
  }

  private startAnnounce(req: HostRequest, extPort: number): void {
    this.stopAnnounce();
    this.announceFirstTimer = setTimeout(() => {
      this.announceFirstTimer = null;
      void this.announceOnce(req, extPort);
      this.announceInterval = setInterval(
        () => void this.announceOnce(req, extPort),
        ANNOUNCE_INTERVAL_MS,
      );
    }, ANNOUNCE_FIRST_MS);
  }

  private stopAnnounce(): void {
    if (this.announceFirstTimer !== null) {
      clearTimeout(this.announceFirstTimer);
      this.announceFirstTimer = null;
    }
    if (this.announceInterval !== null) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
  }

  private async announceOnce(req: HostRequest, extPort: number): Promise<void> {
    const custom =
      req.relay?.handle === 'custom'
        ? parseHostPort((req.relay.customAddr ?? '').trim(), DEFAULT_RELAY_PORT)
        : null;
    try {
      const res = await announce({
        username: req.nick,
        coreName: 'gpSP',
        coreVersion: GPSP_CORE_VERSION,
        gameName: req.gameName,
        gameCrc: normalizeCrc(req.gameCrc),
        port: extPort,
        mitmServer: req.relay?.handle ?? '',
        mitmSession: this.relaySessionId ?? '',
        mitmCustomAddr: custom?.host ?? '',
        mitmCustomPort: custom?.port ?? 0,
        hasPassword: !!req.password,
        hasSpectatePassword: !!req.spectatePassword,
        forceMitm: !!this.relaySessionId,
        retroarchVersion: '1.22.2',
        frontend: 'unix x86_64',
        subsystemName: 'N/A',
        playerCount: 1 + this.peers.length,
        spectatorCount: 0,
      });
      this.broadcast({
        type: 'announce',
        status: res.connectable === false ? 'not-connectable' : 'ok',
        roomId: res.id,
        nextInSec: ANNOUNCE_INTERVAL_MS / 1000,
      });
    } catch (e) {
      this.broadcast({
        type: 'announce',
        status: 'failed',
        nextInSec: ANNOUNCE_INTERVAL_MS / 1000,
      });
      this.log('warn', `lobby announce failed: ${(e as Error).message}`);
    }
  }

  private resetSessionState(): void {
    this.stopAnnounce();
    this.lanResponder.stop();
    this.hostReq = null;
    this.relayJoin = false;
    this.relaySessionId = undefined;
    this.peers = [];
    this.localClientId = undefined;
    this.sessionPhase = 'idle';
  }

  private broadcastSession(closeReason?: CloseReason, detail?: string): void {
    this.broadcast({
      type: 'session',
      phase: this.sessionPhase,
      localClientId: this.localClientId,
      peers: this.peers.map((p) => ({ id: p.id, nick: p.nick })),
      closeReason,
      detail,
    });
  }

  private log(level: 'info' | 'warn' | 'error' | 'debug', msg: string): void {
    this.broadcast({ type: 'log', level, msg, ts: Date.now() });
  }

  private broadcast(ev: BridgeEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.event, ev);
    }
  }
}

/** Turn socket/bind failures into something a player can act on. */
function describeStartFailure(e: Error, port?: number): string {
  const code = (e as NodeJS.ErrnoException).code;
  const where = port === undefined ? 'that port' : `port ${port}`;
  switch (code) {
    case 'EADDRINUSE':
      return `${capitalize(where)} is already in use on this computer — close the other program (or another copy of this app) or pick a different port.`;
    case 'EACCES':
      return `${capitalize(where)} needs administrator rights — choose a port above 1024.`;
    case 'ECONNREFUSED':
      return 'The host refused the connection — check the address and that they are still hosting.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'That address could not be found — check it for typos.';
    case 'ETIMEDOUT':
      return 'The connection timed out — check the address and port, or ask the host to use a relay.';
    case 'ECONNRESET':
      return 'The host closed the connection unexpectedly.';
    default:
      return e.message;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
