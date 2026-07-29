import type { CloseReason, FirmwareVersion, LinkPhase } from '../engine/types';

export type RelayHandle = 'nyc' | 'madrid' | 'saopaulo' | 'singapore' | 'custom';

export interface JoinDirectRequest {
  host: string;
  port: number;
  nick: string;
  password?: string;
}

export interface JoinRelayRequest {
  addr: string;
  port: number;
  /** base64 12-byte mitm_session from the lobby entry. */
  session: string;
  nick: string;
  password?: string;
}

export interface HostRequest {
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
  /** Found via LAN discovery rather than the public lobby. */
  lan?: boolean;
}

export interface AppSettings {
  nick: string;
  defaultPort: number;
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

export type BridgeEvent =
  | {
      type: 'device';
      /** Absent on pure attribute updates (e.g. cable type mid-session). */
      state?: DeviceStateName;
      firmware?: FirmwareVersion;
      cableType?: number;
      raw?: number;
    }
  | {
      type: 'session';
      phase: SessionPhase;
      localClientId?: number;
      peers: { id: number; nick: string }[];
      closeReason?: CloseReason;
      detail?: string;
    }
  | { type: 'link'; phase: LinkPhase; raw?: number }
  | { type: 'counters'; txPackets: number; rxPackets: number }
  | {
      type: 'announce';
      status: 'ok' | 'failed' | 'not-connectable' | 'off';
      roomId?: number;
      nextInSec?: number;
    }
  | { type: 'host-ready'; extPort: number; relaySessionId?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'debug'; msg: string; ts: number };

export interface BridgeApi {
  joinDirect(req: JoinDirectRequest): Promise<void>;
  joinRelay(req: JoinRelayRequest): Promise<void>;
  host(req: HostRequest): Promise<void>;
  stop(): Promise<void>;
  lobbyRefresh(): Promise<LobbyRoom[]>;
  lanScan(): Promise<LobbyRoom[]>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  installUdevRule(): Promise<{ ok: boolean; detail?: string }>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  onEvent(cb: (ev: BridgeEvent) => void): () => void;
}

export const IPC = {
  joinDirect: 'engine:joinDirect',
  joinRelay: 'engine:joinRelay',
  host: 'engine:host',
  stop: 'engine:stop',
  lobbyRefresh: 'lobby:refresh',
  lanScan: 'lan:scan',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  installUdevRule: 'app:installUdevRule',
  openExternal: 'app:openExternal',
  copyText: 'app:copyText',
  event: 'bridge:event',
} as const;

declare global {
  interface Window {
    bridge: BridgeApi;
  }
}
