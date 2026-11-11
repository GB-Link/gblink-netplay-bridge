import type { EventEmitter } from 'node:events';

/** Status words the firmware emits on the status IN endpoint (2-byte LE). */
export enum FwStatus {
  GameboyConnected = 0xff00,
  GameboyDisconnected = 0xff01,
  AwaitPlayerSettings = 0xff02,
  HandshakeReceived = 0xff03,
  HandshakeFinished = 0xff04,
  LinkConnected = 0xff05,
  LinkReconnecting = 0xff06,
  LinkClosed = 0xff07,
  DeviceReady = 0xff08,
}

/**
 * SetPlayerSettings for the cable modes: how many players the link has (2 to 4) and the
 * GBA's seat among them. Seat 0 is the MULTI parent, which drives the clock (bridge hosts
 * netplay); in any other seat the adapter drives it and the GBA is a child (bridge joins).
 */
export interface PlayerSettings {
  playerCount: number;
  seat: number;
}

/** Link protocol: Pokémon gen 3 by cable (gpsp MPK1), the Wireless Adapter (RFU1), Advance Wars 1/2 (MAW1). */
export type LinkGame = 'gen3' | 'rfu' | 'aw1' | 'aw2';

/** A real GBA on a GB-Link, or a Switch behind an ESP32 bridge. */
export type Console = 'gba' | 'switch';

/** The group a bridge leads for the Switch when it joins a cable session as the child. */
export type SwitchRoom = 'trade' | 'single' | 'double';

export interface FirmwareVersion {
  major: number;
  minor: number;
  patch: number;
  /** A GB-Link when absent. */
  device?: 'gblink' | 'esp32';
  /** GetFirmwareInfo byte 4 (firmware 2.2.1+). */
  landingPage?: boolean;
}

export function fwAtLeast(fw: FirmwareVersion, major: number, minor: number, patch: number): boolean {
  if (fw.major !== major) return fw.major > major;
  if (fw.minor !== minor) return fw.minor > minor;
  return fw.patch >= patch;
}

export function firmwareLabel(fw: FirmwareVersion): string {
  return `${fw.major}.${fw.minor}.${fw.patch}`;
}

export function parseFirmwareVersion(text: string, device?: 'gblink' | 'esp32'): FirmwareVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!m) return null;
  const fw: FirmwareVersion = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  if (device) fw.device = device;
  return fw;
}

/** One 8-word GBA MULTI command round (u16 values, index 0 = LINKCMD word). */
export type Round = Uint16Array;

export interface BridgeCounters {
  txPackets: number;
  rxPackets: number;
  txBytes?: number;
  rxBytes?: number;
  dedupSuppressed?: number;
  rejected?: number;
  ignoredPeer?: number;
}

export interface AdapterEvents {
  /** Firmware status word from the status endpoint. */
  status: [FwStatus];
  /** One 8-word round received from the real GBA (a data IN packet carries three). */
  round: [Round];
  /** The 50 bytes of the firmware's MAW1 byte stream in one data IN packet (Advance Wars mode). */
  'aw-chunk': [Buffer];
  /** One 64-byte chunk of the firmware's RFU1 byte stream (wireless adapter mode). */
  'rfu-chunk': [Buffer];
  log: [string];
  /** A condition the player can act on (raised by the Switch's stand-in adapter). */
  warn: [string];
  /** Data-endpoint payloads that are not the mode's link data (firmware info and other command replies). */
  'data-raw': [Buffer];
  attached: [];
  detached: [];
  error: [Error];
}

export interface IGBLinkAdapter extends EventEmitter<AdapterEvents> {
  /**
   * A firmware stand-in with no GBA behind it (the Switch's translators): a link section
   * is restarted, never closed by playing READY_CLOSE_LINK at a game.
   */
  readonly emulated?: boolean;
  /** Find the device, claim interface 0, start the IN transfer loops. */
  start(): Promise<void>;
  /**
   * Cancel -> 500 ms -> SetMode(game) -> DeviceReady -> AwaitPlayerSettings -> SetPlayerSettings.
   * The wireless mode takes no player settings; the cable modes need them.
   */
  initLinkMode(game: LinkGame, players?: PlayerSettings): Promise<void>;
  /** 0x12 — only legal after HandshakeReceived (0xFF03) for the live section. */
  startHandshake(): Promise<void>;
  /** 0x13 — gen3, a child GBA only; makes the adapter transmit 0x8FFF. */
  connectLink(): Promise<void>;
  /** 0x01 — abort the running mode. */
  cancel(): Promise<void>;
  /** Write up to 3 rounds of the player in `seat` to the data OUT endpoint. */
  writeRounds(seat: number, rounds: Round[]): Promise<void>;
  /** Write exactly 50 bytes of the MAW1 stream of the player in `seat` to the data OUT endpoint. */
  writeAwChunk(seat: number, stream: Buffer): Promise<void>;
  /** Write exactly 64 bytes of RFU1 stream to the data OUT endpoint. */
  writeRfuChunk(buf: Buffer): Promise<void>;
  /** 0x4C answered: the firmware carries the wireless adapter mode. */
  probeWireless(): Promise<boolean>;
  getFirmwareInfo(): Promise<FirmwareVersion>;
  stop(): Promise<void>;
}

/** MPK1 link states (gpsp serial_proto.c). */
export enum Mpk1State {
  Preinit = 0,
  Handshake = 1,
  Connected = 2,
}

export interface Mpk1Packet {
  state: number;
  /** Present iff the HAS_DATA flag (bit 31) was set: 8 u16 words. */
  words: Round | null;
}

export type CloseReason =
  | 'graceful'
  | 'socket-closed'
  | 'socket-error'
  | 'full'
  | 'banned'
  | 'nak'
  | 'wrong-password'
  | 'protocol-version'
  | 'core-mismatch'
  | 'refused'
  | 'bad-client-id'
  | 'relay-error';

export interface NetplayPeer {
  id: number;
  nick: string;
}

export interface NetplayEvents {
  /** Netpacket path is live; payload = local client id (0 when hosting). */
  'session-start': [number];
  /** A NETPACKET arrived: payload bytes, source client id. */
  packet: [Buffer, number];
  'peer-playing': [NetplayPeer];
  'peer-left': [NetplayPeer];
  chat: [string, string];
  /** Hosting only: listening/relay session established. */
  'host-ready': [{ extPort: number; relaySessionId?: string }];
  closed: [CloseReason, string?];
  error: [Error];
}

/** NETPACKET recipient meaning every playing client (RetroArch's broadcast id). */
export const NETPACKET_BROADCAST = 0xffff;

export interface INetplayEndpoint extends EventEmitter<NetplayEvents> {
  /** Send a core packet (reliable, ordered) to every playing peer or to client `dest`; hosts relay between clients. */
  sendPacket(buf: Buffer, dest?: number): void;
  close(graceful?: boolean): void;
  readonly localClientId: number | null;
  readonly playingPeers: ReadonlyMap<number, NetplayPeer>;
  /** Median recent ping round trip to a client; undefined until one completes. */
  peerRttMs?(id: number): number | undefined;
}

/** gpsp's library_version (GPSP_VERSION): what RetroArch announces publicly. */
export const GPSP_CORE_VERSION = 'v1.1.0';

/**
 * gpsp's netpacket protocol_version (GPSP_NETPACKET_VERSION). RetroArch puts
 * this in the handshake INFO frame instead of library_version whenever a core
 * registers a netpacket interface, and peers compare the two strings — so it
 * must track gpsp's value, not the core's release number.
 */
export const GPSP_NETPACKET_VERSION = 'gpSP v1.0';

export interface NetplayIdentity {
  nick: string;
  /** Defaults: coreName "gpSP", coreVersion GPSP_NETPACKET_VERSION (the INFO
   *  frame carries the netpacket protocol string), retroarchVersion "1.22.2". */
  coreName?: string;
  coreVersion?: string;
  retroarchVersion?: string;
  /** Content CRC32. Join mode ignores this and echoes the host's CRC. */
  contentCrc?: number;
}

export interface NetplayJoinOptions extends NetplayIdentity {
  host: string;
  port: number;
  password?: string;
  /** base64 of the 12-byte lobby mitm_session — sends the RATS prelude. */
  relaySession?: string;
  /**
   * Refuse any other client number from the host's SYNC. The cable protocols
   * map it onto the GBA MULTI id, so they need 1; the wireless relay takes any.
   */
  expectClientId?: number;
}

export interface NetplayHostOptions extends NetplayIdentity {
  port: number;
  password?: string;
  spectatePassword?: string;
  /** Host through a relay tunnel instead of listening locally. */
  relay?: { addr: string; port: number };
  /** Remote playing clients accepted before refusing PLAY. Default 1. */
  maxPlayers?: number;
}

export interface PumpTimings {
  /** Min interval between outgoing data MPK1s (gpsp block cadence). */
  dataEmitMs?: number;
  /** Idle interval after which a status-only MPK1 is sent. */
  statusCadenceMs?: number;
}

export const DEFAULT_PUMP_TIMINGS: Required<PumpTimings> = {
  dataEmitMs: 15,
  statusCadenceMs: 17,
};

/**
 * User-facing link phase derived by the bridges, in groups: gen3 LinkBridge, AwLinkBridge,
 * then RfuLinkBridge (which also uses searching/handshake/connected).
 */
export type LinkPhase =
  | 'idle'
  | 'searching'
  | 'cable-club'
  | 'handshake'
  | 'connected'
  | 'closing'
  | 'closed'
  | 'init'
  | 'starting'
  | 'linked'
  | 'partner-quiet'
  | 'room-open';
