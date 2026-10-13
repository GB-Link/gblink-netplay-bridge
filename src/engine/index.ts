import { EventEmitter } from 'node:events';
import {
  FwStatus,
  type AwStats,
  type AwTimingOverride,
  type BridgeCounters,
  type CableSelection,
  type CloseReason,
  type Console,
  type FirmwareVersion,
  type IGBLinkAdapter,
  type INetplayEndpoint,
  type LinkGame,
  type LinkPhase,
  type NetplayHostOptions,
  type NetplayJoinOptions,
  type NetplayPeer,
  type PumpTimings,
  type SwitchRoom,
} from './types';
import { GBLinkAdapter } from './usb/adapter';
import { NetplayClient } from './netplay/client';
import { NetplayHost } from './netplay/host';
import { LinkBridge } from './bridge/linkBridge';
import { AwLinkBridge } from './aw/awLinkBridge';
import { RfuLinkBridge } from './rfu/rfuLinkBridge';
import { GBLinkRfuDevice } from './rfu/gblinkRfuDevice';
import { EspRfuDevice } from './rfu/espRfuDevice';
import type { IRfuDevice, RfuDeviceInfo } from './rfu/rfuDevice';
import { SwitchCableAdapter } from './switch/switchCableAdapter';

export * from './types';
export * from './aw/maw1';
export * from './rfu/rfu1';
export type { IRfuDevice, RfuDeviceEvents, RfuDeviceInfo, RfuDeviceNotice } from './rfu/rfuDevice';
export { decodeAwStats, encodeAwStats, formatAwStats } from './aw/awStats';
export { NetplayClient } from './netplay/client';
export { NetplayHost } from './netplay/host';
export { LinkBridge } from './bridge/linkBridge';
export { AwLinkBridge } from './aw/awLinkBridge';
export { RfuLinkBridge } from './rfu/rfuLinkBridge';
export { GBLinkRfuDevice } from './rfu/gblinkRfuDevice';
export { EspRfuDevice } from './rfu/espRfuDevice';
export { SwitchCableAdapter } from './switch/switchCableAdapter';
export { GBLinkAdapter } from './usb/adapter';
export { DeviceWatcher } from './usb/watcher';
export { EspDevice, EspDeviceError, isEspPort } from './esp32/espDevice';
export type { EspInfo, EspKeyStatus } from './esp32/espDevice';
export { Esp32Watcher } from './esp32/watcher';

/** Remote players a hosted wireless session accepts: a GBA wireless room holds five. */
const RFU_MAX_PLAYERS = 4;

export type EngineStartOptions = {
  /** Defaults to Pokémon gen 3 by cable. */
  game?: LinkGame;
  /** Defaults to a GB-Link with a GBA. */
  console?: Console;
  /** Serial port of the ESP32 bridge; the first one found when absent. */
  espPort?: string;
  /** Switch cable link, joining: the group led for the Switch. */
  switchRoom?: SwitchRoom;
  /** Switch: show each side's game as the other's kind so the games link across versions. */
  nationalBypass?: boolean;
  /** Advance Wars master-mode round pacing; set only from the CLI. */
  awTiming?: AwTimingOverride;
} & (({ mode: 'join' } & NetplayJoinOptions) | ({ mode: 'host' } & NetplayHostOptions));

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
  /** The ESP32 bridge board of a Switch session. */
  esp32: [{ state: 'absent' | 'present' | 'error'; info?: RfuDeviceInfo; detail?: string }];
  'fw-status': [FwStatus];
  'cable-type': [number];
  'link-phase': [LinkPhase, number?];
  session: [{ phase: SessionPhase; localClientId?: number; closeReason?: CloseReason; detail?: string }];
  peers: [NetplayPeer[]];
  counters: [BridgeCounters];
  'aw-stats': [AwStats];
  /** Wireless: the room the device joined (host's nick), or null when it left. */
  room: [string | null];
  'host-ready': [{ extPort: number; relaySessionId?: string }];
  log: [string];
  warn: [string];
  error: [Error];
}

type Bridge = LinkBridge | AwLinkBridge | RfuLinkBridge;

/**
 * Top-level engine: owns one device (a GB-Link adapter, or an ESP32 bridge for a
 * Switch), one netplay endpoint and the bridge between them. Electron-agnostic;
 * the shell (or the CLI) maps these events onto its own surface.
 */
export class GBLinkEngine extends EventEmitter<EngineEvents> {
  private adapter: IGBLinkAdapter | null = null;
  private rfuDevice: IRfuDevice | null = null;
  private endpoint: INetplayEndpoint | null = null;
  private bridge: Bridge | null = null;
  private running = false;

  constructor(
    private readonly adapterFactory: () => IGBLinkAdapter = () => new GBLinkAdapter(),
    private readonly timings?: PumpTimings,
    private readonly espDeviceFactory: (path?: string) => IRfuDevice = (path) => new EspRfuDevice({ path }),
  ) {
    super();
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(opts: EngineStartOptions): Promise<void> {
    if (this.running) await this.stop();
    this.running = true;

    const game = opts.game ?? 'gen3';
    const console = opts.console ?? 'gba';
    if (console === 'switch' && (game === 'aw1' || game === 'aw2')) {
      this.running = false;
      throw new Error('Advance Wars is not available on the Switch');
    }
    // A relay's delay is more than the Wireless Adapter games can take, on either console.
    if (game === 'rfu' && (opts.mode === 'join' ? opts.relaySession : opts.relay)) {
      this.running = false;
      throw new Error(
        "Wireless Adapter games can't use a relay: it adds more delay than they can take. Play on the same network or connect directly by address.",
      );
    }

    const endpoint =
      opts.mode === 'join'
        ? new NetplayClient({ ...opts, expectClientId: game === 'rfu' ? undefined : 1 })
        : new NetplayHost({ ...opts, maxPlayers: opts.maxPlayers ?? (game === 'rfu' ? RFU_MAX_PLAYERS : 1) });
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

    let deviceUp: boolean;
    if (console === 'gba') {
      const adapter = this.adapterFactory();
      this.adapter = adapter;
      adapter.on('status', (s) => this.emit('fw-status', s));
      adapter.on('error', (e) => this.emit('error', e));
      adapter.on('log', (msg) => this.emit('log', msg));
      let bridge: Bridge;
      if (game === 'gen3') bridge = new LinkBridge(adapter, endpoint, opts.mode, this.timings);
      else if (game === 'rfu') {
        const device = new GBLinkRfuDevice(adapter);
        this.rfuDevice = device;
        bridge = new RfuLinkBridge(device, endpoint);
      } else bridge = new AwLinkBridge(adapter, endpoint, opts.mode, game, { awTiming: opts.awTiming });
      this.wireBridge(bridge);
      deviceUp = await adapter
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
    } else {
      const device = this.espDeviceFactory(opts.espPort);
      this.rfuDevice = device;
      device.on('attached', () => this.emit('esp32', { state: 'present', info: device.info ?? undefined }));
      device.on('detached', () => this.emit('esp32', { state: 'absent' }));
      let bridge: Bridge;
      if (game === 'rfu') {
        bridge = new RfuLinkBridge(device, endpoint, { nationalBypass: opts.nationalBypass });
        this.wireBridge(bridge);
        this.emit('session', { phase: 'connecting' });
        // The relay opens the board itself and keeps running while it restarts.
        await bridge.start(true);
      } else {
        const adapter = new SwitchCableAdapter(device, { room: opts.switchRoom, nationalBypass: opts.nationalBypass });
        this.adapter = adapter;
        adapter.on('status', (s) => this.emit('fw-status', s));
        adapter.on('error', (e) => this.emit('error', e));
        adapter.on('log', (msg) => this.emit('log', msg));
        adapter.on('warn', (msg) => this.emit('warn', msg));
        bridge = new LinkBridge(adapter, endpoint, opts.mode, this.timings);
        this.wireBridge(bridge);
        deviceUp = await adapter
          .start()
          .then(() => true)
          .catch((e: Error) => {
            this.emit('esp32', { state: 'absent', detail: e.message });
            this.emit('log', `ESP32 bridge not ready: ${e.message}`);
            return false;
          });
        this.emit('session', { phase: 'connecting' });
        await bridge.start(deviceUp);
      }
    }

    if (opts.mode === 'join') {
      await (endpoint as NetplayClient).connect();
    } else {
      await (endpoint as NetplayHost).listen();
    }
  }

  private wireBridge(bridge: Bridge): void {
    this.bridge = bridge;
    bridge.on('link-phase', (phase, raw) => this.emit('link-phase', phase, raw));
    bridge.on('counters', (c) => this.emit('counters', c));
    bridge.on('log', (msg) => this.emit('log', msg));
    bridge.on('error', (e) => this.emit('error', e));
    if (bridge instanceof LinkBridge) {
      bridge.on('cable', (cable) => this.emit('cable-type', cable));
      bridge.on('warn', (msg) => this.emit('warn', msg));
    } else if (bridge instanceof AwLinkBridge) {
      bridge.on('cable', (cable) => this.emit('cable-type', cable));
      bridge.on('warn', (msg) => this.emit('warn', msg));
      bridge.on('aw-stats', (s) => this.emit('aw-stats', s));
    } else {
      bridge.on('warn', (msg) => this.emit('warn', msg));
      bridge.on('room', (nick) => this.emit('room', nick));
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.bridge?.stop().catch(() => undefined);
    this.endpoint?.close(true);
    await this.adapter?.stop().catch(() => undefined);
    if (!this.adapter) await this.rfuDevice?.stop().catch(() => undefined);
    this.bridge = null;
    this.endpoint = null;
    this.adapter = null;
    this.rfuDevice = null;
    this.emit('session', { phase: 'closed', closeReason: 'graceful' });
  }

  /**
   * Persist the link-cable selection on the adapter (0x4b) and report the
   * refreshed firmware info. Refused while a session holds the device.
   */
  async setCableSelection(selection: CableSelection): Promise<FirmwareVersion> {
    if (this.running) throw new Error('stop the session before changing the link cable selection');
    const adapter = this.adapterFactory();
    try {
      await adapter.start();
      await adapter.setCableSelection(selection);
      const firmware = await adapter.getFirmwareInfo();
      this.emit('device', { state: 'present', firmware });
      return firmware;
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  }

  private emitPeers(): void {
    const peers = this.endpoint ? [...this.endpoint.playingPeers.values()] : [];
    this.emit('peers', peers);
  }
}
