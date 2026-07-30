import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import type { CloseReason, FirmwareVersion, LinkPhase } from '../../../../engine/types';
import type {
  AppSettings,
  BridgeApi,
  BridgeEvent,
  DeviceStateName,
  HostRequest,
  JoinDirectRequest,
  JoinRelayRequest,
  LobbyRoom,
  SessionPhase,
} from '../../../../shared/ipc';

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
}

export interface TimelineEntry {
  ts: number;
  kind: 'device' | 'link';
  text: string;
}

export interface AnnounceState {
  status: 'ok' | 'failed' | 'not-connectable' | 'off';
  roomId?: number;
  nextInSec?: number;
  /** Local wall clock when this announce event arrived (for countdowns). */
  at: number;
}

const LOG_CAP = 500;
/** Log messages meaning the adapter is present but could not be opened. */
const USB_BLOCKED_RE =
  /LIBUSB_ERROR_ACCESS|LIBUSB_ERROR_BUSY|LIBUSB_ERROR_NOT_SUPPORTED|EACCES|access denied|permission denied|cannot open GB-Link|cannot claim GB-Link/i;

export const UDEV_RULE_PATH = '/etc/udev/rules.d/70-gblink.rules';
export const UDEV_RULE_TEXT =
  'SUBSYSTEM=="usb", ATTRS{idVendor}=="2fe3", ATTRS{idProduct}=="000a", MODE="0660", TAG+="uaccess", GROUP="plugdev"';

@Injectable({ providedIn: 'root' })
export class BridgeService {
  private readonly zone = inject(NgZone);
  private readonly api: BridgeApi;

  readonly isMock: boolean;
  /** Host platform, for platform-specific troubleshooting copy. */
  readonly platform: string;

  readonly deviceState = signal<DeviceStateName>('absent');
  readonly firmware = signal<FirmwareVersion | null>(null);
  readonly cableType = signal<number | null>(null);
  readonly linkPhase = signal<LinkPhase>('idle');
  readonly sessionPhase = signal<SessionPhase>('idle');
  readonly localClientId = signal<number | null>(null);
  readonly closeReason = signal<CloseReason | null>(null);
  readonly closeDetail = signal<string | null>(null);
  readonly peers = signal<{ id: number; nick: string }[]>([]);
  readonly counters = signal<{ txPackets: number; rxPackets: number }>({
    txPackets: 0,
    rxPackets: 0,
  });
  readonly announce = signal<AnnounceState>({ status: 'off', at: 0 });
  readonly hostReady = signal<{ extPort: number; relaySessionId?: string } | null>(null);
  /** Newest first, capped at LOG_CAP. */
  readonly log = signal<LogEntry[]>([]);
  /** Device + link state changes, newest first. */
  readonly timeline = signal<TimelineEntry[]>([]);
  /** Adapter enumerated but not openable (permissions, driver, or in use). */
  /** App version, shown in the footer. */
  readonly appVersion = signal('');
  /** Failure from the last connect/host attempt, shown until dismissed. */
  readonly actionError = signal<string | null>(null);
  readonly usbBlocked = signal(false);
  /** Raw error text behind usbBlocked, shown verbatim for diagnosis. */
  readonly usbBlockedDetail = signal<string | null>(null);

  readonly sessionActive = computed(() => {
    const p = this.sessionPhase();
    return p !== 'idle' && p !== 'closed';
  });

  constructor() {
    const real = (window as { bridge?: BridgeApi }).bridge;
    this.isMock = !real;
    this.api = real ?? new MockBridge();
    this.platform = this.api.platform;
    this.api.onEvent((ev) => this.zone.run(() => this.apply(ev)));
    void this.api.getVersion().then((v) => this.appVersion.set(v));
  }

  joinDirect(req: JoinDirectRequest): Promise<void> {
    return this.api.joinDirect(req);
  }
  joinRelay(req: JoinRelayRequest): Promise<void> {
    return this.api.joinRelay(req);
  }
  host(req: HostRequest): Promise<void> {
    return this.api.host(req);
  }
  stop(): Promise<void> {
    return this.api.stop();
  }
  lobbyRefresh(): Promise<LobbyRoom[]> {
    return this.api.lobbyRefresh();
  }
  lanScan(): Promise<LobbyRoom[]> {
    return this.api.lanScan();
  }
  getSettings(): Promise<AppSettings> {
    return this.api.getSettings();
  }
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.api.setSettings(patch);
  }
  installUdevRule(): Promise<{ ok: boolean; detail?: string }> {
    return this.api.installUdevRule();
  }
  openExternal(url: string): Promise<void> {
    return this.api.openExternal(url);
  }
  copyText(text: string): Promise<void> {
    return this.api.copyText(text);
  }

  /** Record a failed command; strips Electron's IPC wrapper from the text. */
  reportActionError(e: unknown): void {
    const raw = e instanceof Error ? e.message : String(e);
    const cleaned = raw
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error:\s*/, '');
    this.actionError.set(cleaned);
  }

  private apply(ev: BridgeEvent): void {
    switch (ev.type) {
      case 'device': {
        if (ev.firmware) this.firmware.set(ev.firmware);
        if (ev.cableType !== undefined) this.cableType.set(ev.cableType);
        if (ev.state !== undefined) {
          this.deviceState.set(ev.state);
          if (ev.state === 'access-denied') this.usbBlocked.set(true);
          else if (ev.state === 'device-ready') {
            this.usbBlocked.set(false);
            this.usbBlockedDetail.set(null);
          }
          this.pushTimeline('device', `Adapter: ${ev.state}`);
          if (ev.state === 'absent') this.cableType.set(null);
        }
        break;
      }
      case 'link': {
        this.linkPhase.set(ev.phase);
        this.pushTimeline('link', `Link: ${ev.phase}`);
        break;
      }
      case 'session': {
        this.sessionPhase.set(ev.phase);
        this.peers.set(ev.peers);
        this.localClientId.set(ev.localClientId ?? null);
        if (ev.phase === 'closed') {
          this.closeReason.set(ev.closeReason ?? null);
          this.closeDetail.set(ev.detail ?? null);
          this.hostReady.set(null);
          this.announce.set({ status: 'off', at: Date.now() });
        } else {
          this.closeReason.set(null);
          this.closeDetail.set(null);
          if (ev.phase !== 'connecting') this.actionError.set(null);
        }
        break;
      }
      case 'counters':
        this.counters.set({ txPackets: ev.txPackets, rxPackets: ev.rxPackets });
        break;
      case 'announce':
        this.announce.set({
          status: ev.status,
          roomId: ev.roomId,
          nextInSec: ev.nextInSec,
          at: Date.now(),
        });
        break;
      case 'host-ready':
        this.hostReady.set({ extPort: ev.extPort, relaySessionId: ev.relaySessionId });
        break;
      case 'log': {
        if (USB_BLOCKED_RE.test(ev.msg)) {
          this.usbBlocked.set(true);
          this.usbBlockedDetail.set(ev.msg);
        }
        this.log.update((entries) =>
          [{ ts: ev.ts, level: ev.level, msg: ev.msg }, ...entries].slice(0, LOG_CAP),
        );
        break;
      }
    }
  }

  private pushTimeline(kind: 'device' | 'link', text: string): void {
    this.timeline.update((entries) => [{ ts: Date.now(), kind, text }, ...entries].slice(0, LOG_CAP));
  }
}

/** Plain-browser stand-in so every screen is developable with `ng serve`. */
class MockBridge implements BridgeApi {
  readonly platform = 'linux';

  async getVersion(): Promise<string> {
    return '0.0.0-dev';
  }
  private readonly listeners = new Set<(ev: BridgeEvent) => void>();
  private countersTimer: ReturnType<typeof setInterval> | null = null;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private tx = 0;
  private rx = 0;
  private settings: AppSettings = {
    nick: 'Anonymous',
    defaultPort: 55435,
    gameName: 'Pokemon - Emerald Version (USA)',
    gameCrc: '1F1C08FB',
    relayDefault: 'off',
    lanDiscovery: false,
    theme: 'system',
    logLevel: 'info',
  };

  constructor() {
    this.script();
  }

  onEvent(cb: (ev: BridgeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(ev: BridgeEvent): void {
    for (const cb of [...this.listeners]) cb(ev);
  }

  private log(level: 'info' | 'warn' | 'error' | 'debug', msg: string): void {
    this.emit({ type: 'log', level, msg, ts: Date.now() });
  }

  private at(ms: number, fn: () => void): void {
    setTimeout(fn, ms);
  }

  private script(): void {
    this.at(400, () => {
      this.emit({
        type: 'device',
        state: 'present',
        firmware: { major: 2, minor: 3, patch: 1 },
        cableType: 0,
      });
      this.log('info', 'mock: GB-Link adapter attached');
    });
    this.at(900, () => this.emit({ type: 'device', state: 'device-ready' }));
    this.at(1400, () => {
      this.emit({ type: 'device', state: 'awaiting-gba' });
      this.emit({ type: 'link', phase: 'searching' });
    });
    this.at(2600, () => {
      this.emit({ type: 'device', state: 'handshake-received' });
      this.emit({ type: 'link', phase: 'cable-club' });
      this.log('info', 'mock: GBA entered the Cable Club');
    });
    this.at(3600, () => this.emit({ type: 'link', phase: 'handshake' }));
    this.at(4600, () => {
      this.emit({ type: 'device', state: 'link-connected' });
      this.emit({ type: 'link', phase: 'connected' });
      this.emit({ type: 'announce', status: 'ok', roomId: 421337, nextInSec: 600 });
      this.startCounters();
    });
  }

  private startCounters(): void {
    if (this.countersTimer) return;
    this.countersTimer = setInterval(() => {
      this.tx += 55 + Math.floor(Math.random() * 10);
      this.rx += 55 + Math.floor(Math.random() * 10);
      this.emit({ type: 'counters', txPackets: this.tx, rxPackets: this.rx });
    }, 1000);
  }

  private stopTimers(): void {
    if (this.countersTimer) clearInterval(this.countersTimer);
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.countersTimer = null;
    this.announceTimer = null;
  }

  async joinDirect(req: JoinDirectRequest): Promise<void> {
    this.log('info', `mock: joining ${req.host}:${req.port} as ${req.nick}`);
    this.emit({ type: 'session', phase: 'connecting', peers: [] });
    this.at(600, () => this.emit({ type: 'session', phase: 'handshaking', peers: [] }));
    this.at(1400, () => {
      this.emit({
        type: 'session',
        phase: 'connected',
        localClientId: 1,
        peers: [{ id: 0, nick: 'MockHost' }],
      });
      this.startCounters();
    });
  }

  async joinRelay(req: JoinRelayRequest): Promise<void> {
    this.log('info', `mock: joining via relay ${req.addr}:${req.port}`);
    this.emit({ type: 'session', phase: 'relay-connecting', peers: [] });
    this.at(600, () => this.emit({ type: 'session', phase: 'handshaking', peers: [] }));
    this.at(1400, () => {
      this.emit({
        type: 'session',
        phase: 'connected',
        localClientId: 1,
        peers: [{ id: 0, nick: 'MockRelayHost' }],
      });
      this.startCounters();
    });
  }

  async host(req: HostRequest): Promise<void> {
    this.log('info', `mock: hosting on port ${req.port}`);
    this.emit({ type: 'session', phase: 'hosting', localClientId: 0, peers: [] });
    this.at(400, () => {
      this.emit({
        type: 'host-ready',
        extPort: req.port,
        relaySessionId: req.relay ? 'bW9jay1zZXNzaW9u' : undefined,
      });
    });
    if (req.announce) {
      const tick = () =>
        this.emit({ type: 'announce', status: 'ok', roomId: 421337, nextInSec: 30 });
      this.at(700, tick);
      this.announceTimer = setInterval(tick, 30_000);
    } else {
      this.emit({ type: 'announce', status: 'off' });
    }
    this.at(2500, () => {
      this.emit({
        type: 'session',
        phase: 'hosting',
        localClientId: 0,
        peers: [{ id: 1, nick: 'MockJoiner' }],
      });
      this.startCounters();
    });
  }

  async stop(): Promise<void> {
    this.stopTimers();
    this.emit({ type: 'link', phase: 'closing' });
    this.at(300, () => {
      this.emit({ type: 'link', phase: 'closed' });
      this.emit({ type: 'session', phase: 'closed', closeReason: 'graceful', peers: [] });
    });
  }

  async lobbyRefresh(): Promise<LobbyRoom[]> {
    const base = {
      coreName: 'gpSP',
      coreVersion: 'v1.1.0',
      hasSpectatePassword: false,
      retroarchVersion: '1.22.2',
      frontend: 'retroarch',
      isRetroarch: true,
      spectatorCount: 0,
    };
    return [
      {
        ...base,
        username: 'BrendanRuby',
        gameName: 'Pokemon - Ruby Version (USA)',
        gameCrc: 0x84ee4776,
        ip: '203.0.113.10',
        port: 55435,
        hasPassword: false,
        mitmIp: '',
        mitmPort: 0,
        mitmSession: '',
        hostMethod: 2,
        country: 'US',
        connectable: true,
        playerCount: 1,
        joinable: true,
      },
      {
        ...base,
        username: 'MayEmerald',
        gameName: 'Pokemon - Emerald Version (USA)',
        gameCrc: 0x1f1c08fb,
        ip: '198.51.100.7',
        port: 55435,
        hasPassword: false,
        mitmIp: 'nyc.libretro.com',
        mitmPort: 55435,
        mitmSession: 'AAECAwQFBgcICQoL',
        hostMethod: 3,
        country: 'ES',
        connectable: true,
        playerCount: 1,
        joinable: true,
      },
      {
        ...base,
        username: 'WallyGreen',
        gameName: 'Pokemon - Sapphire Version (USA)',
        gameCrc: 0x8f88ec3a,
        ip: '192.0.2.44',
        port: 55436,
        hasPassword: true,
        mitmIp: '',
        mitmPort: 0,
        mitmSession: '',
        hostMethod: 1,
        country: 'JP',
        connectable: true,
        playerCount: 1,
        joinable: true,
      },
      {
        ...base,
        username: 'SnesFan99',
        gameName: 'Super Metroid (USA)',
        gameCrc: 0xd63ed5f8,
        coreName: 'Snes9x',
        coreVersion: '1.62.3',
        ip: '203.0.113.99',
        port: 55435,
        hasPassword: false,
        mitmIp: '',
        mitmPort: 0,
        mitmSession: '',
        hostMethod: 2,
        country: 'DE',
        connectable: true,
        playerCount: 1,
        joinable: false,
      },
      {
        ...base,
        username: 'FirewalledFred',
        gameName: 'Pokemon - Ruby Version (USA)',
        gameCrc: 0x84ee4776,
        ip: '203.0.113.201',
        port: 55435,
        hasPassword: false,
        mitmIp: '',
        mitmPort: 0,
        mitmSession: '',
        hostMethod: 0,
        country: 'FR',
        connectable: false,
        playerCount: 1,
        joinable: false,
      },
    ];
  }

  async lanScan(): Promise<LobbyRoom[]> {
    await new Promise((r) => setTimeout(r, 400));
    return [
      {
        username: 'CouchCoop',
        gameName: 'Pokemon - Emerald Version (USA)',
        gameCrc: 0x1f1c08fb,
        coreName: 'gpSP',
        coreVersion: 'v1.1.0',
        ip: '192.168.1.42',
        port: 55435,
        hasPassword: false,
        hasSpectatePassword: false,
        mitmIp: '',
        mitmPort: 0,
        mitmSession: '',
        hostMethod: 0,
        retroarchVersion: '1.22.2',
        country: '',
        frontend: 'retroarch',
        connectable: true,
        isRetroarch: true,
        playerCount: 0,
        spectatorCount: 0,
        joinable: true,
        lan: true,
      },
    ];
  }

  async getSettings(): Promise<AppSettings> {
    return { ...this.settings };
  }

  async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }

  async installUdevRule(): Promise<{ ok: boolean; detail?: string }> {
    this.log('info', 'mock: udev rule installed');
    return { ok: true };
  }

  async openExternal(url: string): Promise<void> {
    window.open(url, '_blank');
  }

  async copyText(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
  }
}
