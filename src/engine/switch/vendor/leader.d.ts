/**
 * Types for GB-Link-Switch-LDN web/js/cable/leader.js (vendored unchanged): a FireRed leading
 * a group the Switch joins, as the ESP32 board's host port sees its adapter.
 */

import type { BoardFrame } from './translator.js';

export const FRAG_BYTES: 12;

export interface LeaderBeaconFields {
  activity: number;
  /** 8-byte trainer name in the game's charset. */
  name: Uint8Array;
  trainerId?: number;
  compatibility: number;
}

/** 24-byte librfu game data broadcast. */
export function leaderBeacon(fields: LeaderBeaconFields): Uint8Array;

export interface RfuLeaderOptions {
  /** A whole RFU1 frame for the board. */
  send: (frame: Uint8Array) => void;
  log?: (message: string) => void;
}

export class RfuLeader {
  constructor(options: RfuLeaderOptions);
  devid: number;
  state: 'idle' | 'open' | 'naming' | 'answering' | 'linked' | 'closed';
  childDevid: number;
  ticks: number;
  recv: { count: number; flags: number; data: Uint8Array; done: boolean } | null;
  keySource: (() => number | null | undefined) | null;
  onCommand: ((words: number[]) => void) | null;
  onBlock: ((count: number, data: Uint8Array) => void) | null;
  onJoined: ((childGameData: Uint8Array) => void) | null;
  onClosed: (() => void) | null;
  onTick: (() => void) | null;
  readonly linked: boolean;
  readonly childQuiet: boolean;
  readonly joined: boolean;
  readonly queued: number;
  playerIds(): void;
  request(type: number): void;
  standby(count: number): void;
  closeLink(count: number): void;
  echoCloseLink(count: number): void;
  sendBlock(data: Uint8Array, repeat?: number): number;
  open(beacon: Uint8Array): void;
  broadcast(): void;
  close(): void;
  command(words: number[]): void;
  boardFrame(frame: BoardFrame): void;
  /** Once per GBA frame (59.727 Hz). */
  tick(): void;
}
