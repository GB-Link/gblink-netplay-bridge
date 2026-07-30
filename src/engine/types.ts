import type { EventEmitter } from 'node:events';

/** Status words the firmware emits on the status IN endpoint (2-byte LE). */
export enum FwStatus {
  GameboyConnected = 0xff00,
  GameboyDisconnected = 0xff01,
  AwaitMode = 0xff02,
  HandshakeReceived = 0xff03,
  HandshakeFinished = 0xff04,
  LinkConnected = 0xff05,
  LinkReconnecting = 0xff06,
  LinkClosed = 0xff07,
  DeviceReady = 0xff08,
}

/**
 * Adapter link role. 'master' = adapter drives SC, the real GBA becomes the
 * MULTI child (bridge joins netplay). 'slave' = the real GBA is the MULTI
 * parent and drives the clock (bridge hosts netplay).
 */
export type AdapterRole = 'master' | 'slave';

export interface FirmwareVersion {
  major: number;
  minor: number;
  patch: number;
}

/** One 8-word GBA MULTI command round (u16 values, index 0 = LINKCMD word). */
export type Round = Uint16Array;

export interface AdapterEvents {
  /** Firmware status word from the status endpoint. */
  status: [FwStatus];
  /** One 8-word round received from the real GBA (64 B data IN split in 4). */
  round: [Round];
  /** Non-64-byte data-endpoint payloads (firmware info, cable type replies). */
  'data-raw': [Buffer];
  attached: [];
  detached: [];
  error: [Error];
}

export interface IGBLinkAdapter extends EventEmitter<AdapterEvents> {
  /** Find the device, claim interface 0, start the IN transfer loops. */
  start(): Promise<void>;
  /** Cancel -> 500 ms -> SetMode(gbaLink) -> DeviceReady -> AwaitMode -> role. */
  initLinkMode(role: AdapterRole): Promise<void>;
  /** 0x12 — only legal after HandshakeReceived (0xFF03) for the live section. */
  startHandshake(): Promise<void>;
  /** 0x13 — master role only; makes the adapter transmit 0x8FFF. */
  connectLink(): Promise<void>;
  /** 0x01 — abort the running mode. */
  cancel(): Promise<void>;
  /** Write exactly 64 bytes (4 rounds x 8 u16 LE) to the data OUT endpoint. */
  writeRounds(buf: Buffer): Promise<void>;
  getFirmwareInfo(): Promise<FirmwareVersion>;
  getCableType(): Promise<number>;
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

export interface INetplayEndpoint extends EventEmitter<NetplayEvents> {
  /** Broadcast a core packet to every playing peer (reliable, ordered). */
  sendPacket(buf: Buffer): void;
  close(graceful?: boolean): void;
  readonly localClientId: number | null;
  readonly playingPeers: ReadonlyMap<number, NetplayPeer>;
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
  /** Partial-batch flush timer for netplay->firmware rounds. */
  batchFlushMs?: number;
}

export const DEFAULT_PUMP_TIMINGS: Required<PumpTimings> = {
  dataEmitMs: 15,
  statusCadenceMs: 17,
  batchFlushMs: 66,
};

/** User-facing link phase derived by the LinkBridge. */
export type LinkPhase =
  | 'idle'
  | 'searching'
  | 'cable-club'
  | 'handshake'
  | 'connected'
  | 'closing'
  | 'closed';
