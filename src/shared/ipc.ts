import type {
  BridgeCounters,
  CableSelection,
  CloseReason,
  Console,
  FirmwareVersion,
  LinkGame,
  LinkPhase,
  SwitchRoom,
} from '../engine/types';

export type RelayHandle = 'nyc' | 'madrid' | 'saopaulo' | 'singapore' | 'custom';

export interface SessionSetup {
  game?: LinkGame;
  console?: Console;
  /** Switch cable link, joining: the group the bridge leads for the Switch. */
  switchRoom?: SwitchRoom;
  /** Switch: let FireRed/LeafGreen and Emerald link before the National Dex. */
  nationalBypass?: boolean;
}

export interface JoinDirectRequest extends SessionSetup {
  host: string;
  port: number;
  nick: string;
  password?: string;
}

export interface JoinRelayRequest extends SessionSetup {
  addr: string;
  port: number;
  /** base64 12-byte mitm_session from the lobby entry. */
  session: string;
  nick: string;
  password?: string;
}

export interface HostRequest extends SessionSetup {
  port: number;
  nick: string;
  password?: string;
  spectatePassword?: string;
  announce: boolean;
  relay?: { handle: RelayHandle; customAddr?: string };
  gameName: string;
  /** 8-hex-digit CRC32 of the content, or empty for none. */
  gameCrc?: string;
}

/** One row of the lobby.libretro.com /list response, normalized. */
export interface LobbyRoom {
  username: string;
  gameName: string;
  gameCrc: number;
  coreName: string;
  coreVersion: string;
  ip: string;
  port: number;
  hasPassword: boolean;
  hasSpectatePassword: boolean;
  mitmIp: string;
  mitmPort: number;
  mitmSession: string;
  /** 0 unknown, 1 manual, 2 upnp, 3 mitm. */
  hostMethod: number;
  retroarchVersion: string;
  country: string;
  frontend: string;
  connectable: boolean;
  isRetroarch: boolean;
  playerCount: number;
  spectatorCount: number;
  /** Derived: passes the joinable-gpsp filter. */
  joinable: boolean;
  /** Derived from gameName. */
  game?: LinkGame | 'pokemon';
  /** Found via LAN discovery rather than the public lobby. */
  lan?: boolean;
}

export interface AppSettings {
  nick: string;
  defaultPort: number;
  /** Which link protocol the play card starts with. */
  game: LinkGame;
  /** Which console the play card starts with. */
  console: Console;
  switchRoom: SwitchRoom;
  nationalBypass: boolean;
  /** Last address typed into Join, restored on next launch. */
  lastAddress: string;
  /** Last port used for hosting. */
  hostPort: number;
  /** Whether hosting announces to the public lobby. */
  announce: boolean;
  gameName: string;
  gameCrc: string;
  relayDefault: RelayHandle | 'off';
  lanDiscovery: boolean;
  theme: 'light' | 'dark' | 'system';
  logLevel: 'info' | 'debug';
}

export type DeviceStateName =
  | 'absent'
  | 'present'
  | 'device-ready'
  | 'awaiting-gba'
  | 'handshake-received'
  | 'link-connected'
  | 'reconnecting'
  | 'closed'
  | 'access-denied';

export type SessionPhase =
  | 'idle'
  | 'connecting'
  | 'relay-connecting'
  | 'handshaking'
  | 'connected'
  | 'hosting'
  | 'closed';

/** The ESP32 bridge board in front of a Switch. */
export interface Esp32State {
  state: 'absent' | 'present' | 'error';
  path?: string;
  version?: string;
  chip?: string;
  /** The board holds the Switch keys FireRed rooms need; undefined until probed. */
  keys?: boolean;
  detail?: string;
}

export type BridgeEvent =
  | {
      type: 'device';
      /** Absent on pure attribute updates (e.g. cable type mid-session). */
      state?: DeviceStateName;
      firmware?: FirmwareVersion;
      cableType?: number;
      /** Watcher verdict: adapter present but not openable. */
      blocked?: boolean;
      raw?: number;
    }
  | ({ type: 'esp32' } & Esp32State)
  | {
      type: 'session';
      phase: SessionPhase;
      game?: LinkGame;
      console?: Console;
      localClientId?: number;
      peers: { id: number; nick: string }[];
      closeReason?: CloseReason;
      detail?: string;
    }
  | { type: 'link'; phase: LinkPhase; raw?: number }
  /** Wireless: the room the device joined (the host's nick), or null when it left. */
  | { type: 'room'; host: string | null }
  | ({ type: 'counters' } & BridgeCounters)
  | {
      type: 'announce';
      status: 'ok' | 'failed' | 'not-connectable' | 'off';
      roomId?: number;
      nextInSec?: number;
    }
  | { type: 'host-ready'; extPort: number; relaySessionId?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'debug'; msg: string; ts: number };

export interface BridgeApi {
  /** Host platform ('linux' | 'win32' | 'darwin'): drives troubleshooting copy. */
  readonly platform: string;
  joinDirect(req: JoinDirectRequest): Promise<void>;
  joinRelay(req: JoinRelayRequest): Promise<void>;
  host(req: HostRequest): Promise<void>;
  stop(): Promise<void>;
  getVersion(): Promise<string>;
  lobbyRefresh(): Promise<LobbyRoom[]>;
  lanScan(): Promise<LobbyRoom[]>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  resetSettings(): Promise<AppSettings>;
  installUdevRule(): Promise<{ ok: boolean; detail?: string }>;
  /** Persist the link-cable selection on the adapter (firmware 0x4b). */
  setCableSelection(selection: CableSelection): Promise<FirmwareVersion>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  onEvent(cb: (ev: BridgeEvent) => void): () => void;
}

export const IPC = {
  joinDirect: 'engine:joinDirect',
  joinRelay: 'engine:joinRelay',
  host: 'engine:host',
  stop: 'engine:stop',
  getVersion: 'app:version',
  lobbyRefresh: 'lobby:refresh',
  lanScan: 'lan:scan',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  resetSettings: 'settings:reset',
  installUdevRule: 'app:installUdevRule',
  setCableSelection: 'device:setCableSelection',
  openExternal: 'app:openExternal',
  copyText: 'app:copyText',
  event: 'bridge:event',
} as const;

declare global {
  interface Window {
    bridge: BridgeApi;
  }
}
