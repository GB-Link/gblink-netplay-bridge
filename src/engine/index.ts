import { EventEmitter } from 'node:events';
import {
  FwStatus,
  type CableOverride,
  type CloseReason,
  type FirmwareVersion,
  type IGBLinkAdapter,
  type INetplayEndpoint,
  type LinkPhase,
  type NetplayHostOptions,
  type NetplayJoinOptions,
  type NetplayPeer,
  type PumpTimings,
} from './types';
import { GBLinkAdapter } from './usb/adapter';
import { NetplayClient } from './netplay/client';
import { NetplayHost } from './netplay/host';
import { LinkBridge } from './bridge/linkBridge';

export * from './types';
export { NetplayClient } from './netplay/client';
export { NetplayHost } from './netplay/host';
export { LinkBridge } from './bridge/linkBridge';
export { GBLinkAdapter } from './usb/adapter';
export { DeviceWatcher } from './usb/watcher';

export type EngineStartOptions = { cableOverride?: CableOverride } & (
  | ({ mode: 'join' } & NetplayJoinOptions)
  | ({ mode: 'host' } & NetplayHostOptions)
);

export type SessionPhase =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'hosting'
  | 'closed';

export interface EngineEvents {
  device: [
    {
      state: 'absent' | 'present' | 'error';
      firmware?: FirmwareVersion;
      detail?: string;
    },
  ];
  'fw-status': [FwStatus];
  'cable-type': [number];
  'link-phase': [LinkPhase, number?];
  session: [{ phase: SessionPhase; localClientId?: number; closeReason?: CloseReason; detail?: string }];
  peers: [NetplayPeer[]];
  counters: [{ txPackets: number; rxPackets: number }];
  'host-ready': [{ extPort: number; relaySessionId?: string }];
  log: [string];
  error: [Error];
}

/**
 * Top-level engine: owns one GB-Link adapter, one netplay endpoint and the
 * LinkBridge between them. Electron-agnostic; the shell (or the CLI) maps
 * these events onto its own surface.
 */
export class GBLinkEngine extends EventEmitter<EngineEvents> {
  private adapter: IGBLinkAdapter | null = null;
  private endpoint: INetplayEndpoint | null = null;
  private bridge: LinkBridge | null = null;
  private running = false;

  constructor(
    private readonly adapterFactory: () => IGBLinkAdapter = () => new GBLinkAdapter(),
    private readonly timings?: PumpTimings,
  ) {
    super();
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(opts: EngineStartOptions): Promise<void> {
    if (this.running) await this.stop();
    this.running = true;

    const adapter = this.adapterFactory();
    this.adapter = adapter;
    adapter.on('status', (s) => this.emit('fw-status', s));
    adapter.on('error', (e) => this.emit('error', e));

    const endpoint =
      opts.mode === 'join' ? new NetplayClient(opts) : new NetplayHost(opts);
    this.endpoint = endpoint;

    endpoint.on('session-start', (id) => {
      this.emit('session', { phase: opts.mode === 'host' ? 'hosting' : 'connected', localClientId: id });
      this.emitPeers();
    });
    endpoint.on('peer-playing', () => this.emitPeers());
    endpoint.on('peer-left', () => this.emitPeers());
    endpoint.on('host-ready', (info) => this.emit('host-ready', info));
    endpoint.on('closed', (reason, detail) => {
      this.emit('session', { phase: 'closed', closeReason: reason, detail });
    });
    endpoint.on('error', (e) => this.emit('error', e));

    const bridge = new LinkBridge(adapter, endpoint, opts.mode, this.timings, opts.cableOverride);
    this.bridge = bridge;
    bridge.on('link-phase', (phase, raw) => this.emit('link-phase', phase, raw));
    bridge.on('cable', (cable) => this.emit('cable-type', cable));
    bridge.on('counters', (c) => this.emit('counters', c));
    bridge.on('log', (msg) => this.emit('log', msg));
    bridge.on('error', (e) => this.emit('error', e));

    const deviceUp = await adapter
      .start()
      .then(() => true)
      .catch((e: Error) => {
        this.emit('device', { state: 'absent', detail: e.message });
        this.emit('log', `GB-Link not found: ${e.message} — waiting for hotplug`);
        return false;
      });
    if (deviceUp) this.emit('device', { state: 'present' });

    this.emit('session', { phase: 'connecting' });
    await bridge.start(deviceUp);
    if (opts.mode === 'join') {
      await (endpoint as NetplayClient).connect();
    } else {
      await (endpoint as NetplayHost).listen();
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.bridge?.stop().catch(() => undefined);
    this.endpoint?.close(true);
    await this.adapter?.stop().catch(() => undefined);
    this.bridge = null;
    this.endpoint = null;
    this.adapter = null;
    this.emit('session', { phase: 'closed', closeReason: 'graceful' });
  }

  private emitPeers(): void {
    const peers = this.endpoint ? [...this.endpoint.playingPeers.values()] : [];
    this.emit('peers', peers);
  }
}
