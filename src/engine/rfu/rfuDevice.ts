import type { EventEmitter } from 'node:events';
import type { Rfu1Frame } from './rfu1';

export type RfuDeviceKind = 'gblink' | 'esp32';

export interface RfuDeviceInfo {
  kind: RfuDeviceKind;
  /** "GB-Link 2.2.7", "ESP32 bridge 2.1.5 (esp32s3)". */
  label: string;
  version: string;
}

/** A condition the player can act on, raised by the device. */
export interface RfuDeviceNotice {
  code: 'wrong-cable' | 'reset-loop' | 'no-keys' | 'restarting' | 'firmware-too-old';
  text: string;
}

export interface RfuDeviceEvents {
  /** One whole RFU1 frame from the device's wireless adapter side. */
  frame: [Rfu1Frame];
  /** The adapter stream is live: frames can be written and will arrive. */
  ready: [];
  /** The stream went down (mode left, board restarting); `ready` follows when it is back. */
  down: [string];
  attached: [];
  detached: [];
  notice: [RfuDeviceNotice];
  log: [string];
  error: [Error];
}

/**
 * One wireless adapter speaking RFU1: GB-Link's wireless mode (a real GBA) or the ESP32 bridge's host
 * port (a Switch). Its game either leads (broadcasts, accepts children) or picks a room to join.
 */
export interface IRfuDevice extends EventEmitter<RfuDeviceEvents> {
  readonly kind: RfuDeviceKind;
  readonly info: RfuDeviceInfo | null;
  /**
   * As a child, stamps CLIENT_SEND with its CONNECT_ACK slot and devid and acks every HOST_SEND, as
   * gpsp's client does; when false, the relay supplies both.
   */
  readonly gpspChild: boolean;
  /** Children the device's room takes: four on a GB-Link, one Switch on an ESP32 board. */
  readonly maxChildren: number;
  /** Open the device and bring the adapter stream up; `ready` fires when it is. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Write one whole RFU1 frame toward the device's adapter side. */
  writeFrame(frame: Buffer): void;
}
