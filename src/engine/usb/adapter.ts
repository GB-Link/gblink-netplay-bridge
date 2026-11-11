import { EventEmitter } from 'node:events';
import { FwStatus } from '../types';
import type { AdapterEvents, FirmwareVersion, IGBLinkAdapter, LinkGame, PlayerSettings, Round } from '../types';
import { AW_CHUNK_LEN, AW_MODE_VARIANT } from '../aw/maw1';
import { UsbTransport } from './device';
import type { ILinkTransport } from './device';

const CMD_SET_MODE = 0x00;
const CMD_CANCEL = 0x01;
const CMD_GET_FIRMWARE_INFO = 0x0f;
const CMD_SET_PLAYER_SETTINGS = 0x10;
const CMD_START_HANDSHAKE = 0x12;
const CMD_CONNECT_LINK = 0x13;

const MODE_GBA_LINK = 0x01;
const MODE_ADVANCE_WARS = 0x04;
const MODE_WIRELESS = 0x07;
const CMD_GET_RFU_ISR_STATS = 0x4c;
const RFU_STATS_REPLY_LEN = 21;
const PROBE_TIMEOUT_MS = 400;

const ROUND_WORDS = 8;
/** A round on the data endpoints: the seat it comes from, then its 8 words (u16 LE). */
const ROUND_PACKET_LEN = 1 + ROUND_WORDS * 2;
const ROUNDS_PER_TRANSFER = 3;
/** Data IN transfer of the cable modes: three rounds, or the adapter's seat and 50 bytes of MAW1 stream. */
const LINK_TRANSFER_LEN = ROUNDS_PER_TRANSFER * ROUND_PACKET_LEN;
const RFU_CHUNK_LEN = 64;

const READY_TIMEOUT_MS = 2500;
const REPLY_TIMEOUT_MS = 1500;
// Firmware needs settle time after Cancel before it accepts SetMode.
const CANCEL_SETTLE_MS = 500;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Open retries while the adapter is plugged in: it can't be opened for a moment after it
 * appears (udev rules, WinUSB binding) or after another handle lets go of it.
 */
const OPEN_RETRY_DELAYS_MS = [300, 800, 1500];

export class AdapterTimeoutError extends Error {
  constructor(
    message: string,
    readonly status?: FwStatus,
  ) {
    super(message);
    this.name = 'AdapterTimeoutError';
  }
}

/** SetMode payload for a game: [0x00, mode], and the variant for Advance Wars. */
export function setModeCommand(game: LinkGame): number[] {
  if (game === 'gen3') return [CMD_SET_MODE, MODE_GBA_LINK];
  if (game === 'rfu') return [CMD_SET_MODE, MODE_WIRELESS];
  return [CMD_SET_MODE, MODE_ADVANCE_WARS, AW_MODE_VARIANT[game]];
}

export class GBLinkAdapter extends EventEmitter<AdapterEvents> implements IGBLinkAdapter {
  private readonly transport: ILinkTransport;
  /** How data IN transfers are decoded for the current mode. */
  private dataMode: 'rounds' | 'aw' | 'rfu' = 'rounds';

  constructor(transport?: ILinkTransport) {
    super();
    this.transport = transport ?? new UsbTransport();
    this.transport.on('status-bytes', (buf) => this.onStatusBytes(buf));
    this.transport.on('data-bytes', (buf) => this.onDataBytes(buf));
    this.transport.on('attached', () => this.emit('attached'));
    this.transport.on('detached', () => this.emit('detached'));
  }

  async start(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.transport.open();
        return;
      } catch (e) {
        const wait = OPEN_RETRY_DELAYS_MS[attempt];
        if (wait === undefined || !this.transport.present?.()) throw e;
        await delay(wait);
      }
    }
  }

  async stop(): Promise<void> {
    await this.transport.close();
  }

  async initLinkMode(game: LinkGame, players?: PlayerSettings): Promise<void> {
    // The wireless adapter is symmetric: the game decides who leads a room.
    const settings = game === 'rfu' ? null : players;
    if (settings === undefined) throw new Error(`the ${game} link mode needs player settings`);
    await this.cancel();
    await delay(CANCEL_SETTLE_MS);
    this.dataMode = game === 'gen3' ? 'rounds' : game === 'rfu' ? 'rfu' : 'aw';
    // DeviceReady and AwaitPlayerSettings can arrive back-to-back right after SetMode —
    // both waits must be armed before the command goes out.
    const ready = this.awaitStatus(FwStatus.DeviceReady, READY_TIMEOUT_MS);
    const awaitSettings = this.awaitStatus(FwStatus.AwaitPlayerSettings, READY_TIMEOUT_MS);
    void ready.catch(() => undefined);
    void awaitSettings.catch(() => undefined);
    await this.transport.sendCommand(setModeCommand(game));
    await ready;
    await awaitSettings;
    if (settings === null) return;
    await this.transport.sendCommand([CMD_SET_PLAYER_SETTINGS, settings.playerCount, settings.seat]);
  }

  async startHandshake(): Promise<void> {
    await this.transport.sendCommand([CMD_START_HANDSHAKE]);
  }

  async connectLink(): Promise<void> {
    await this.transport.sendCommand([CMD_CONNECT_LINK]);
  }

  async cancel(): Promise<void> {
    await this.transport.sendCommand([CMD_CANCEL]);
  }

  async writeRounds(seat: number, rounds: Round[]): Promise<void> {
    if (rounds.length === 0 || rounds.length > ROUNDS_PER_TRANSFER) {
      throw new Error(`writeRounds takes 1 to ${ROUNDS_PER_TRANSFER} rounds, got ${rounds.length}`);
    }
    const buf = Buffer.alloc(rounds.length * ROUND_PACKET_LEN);
    rounds.forEach((round, i) => {
      const at = i * ROUND_PACKET_LEN;
      buf.writeUInt8(seat, at);
      for (let w = 0; w < ROUND_WORDS; w++) buf.writeUInt16LE(round[w] ?? 0, at + 1 + w * 2);
    });
    await this.transport.sendData(buf);
  }

  async writeAwChunk(seat: number, stream: Buffer): Promise<void> {
    if (stream.length !== AW_CHUNK_LEN) {
      throw new Error(`writeAwChunk requires exactly ${AW_CHUNK_LEN} bytes of MAW1 stream, got ${stream.length}`);
    }
    await this.transport.sendData(Buffer.concat([Buffer.from([seat]), stream]));
  }

  async writeRfuChunk(buf: Buffer): Promise<void> {
    if (buf.length !== RFU_CHUNK_LEN) {
      throw new Error(`writeRfuChunk requires exactly 64 bytes of RFU1 stream, got ${buf.length}`);
    }
    await this.transport.sendData(buf);
  }

  async probeWireless(): Promise<boolean> {
    try {
      const reply = await this.commandReply([CMD_GET_RFU_ISR_STATS], CMD_GET_RFU_ISR_STATS, PROBE_TIMEOUT_MS);
      return reply.length >= RFU_STATS_REPLY_LEN;
    } catch (e) {
      if ((e as Error).name === 'AdapterTimeoutError') return false;
      throw e;
    }
  }

  async getFirmwareInfo(): Promise<FirmwareVersion> {
    // Reply: [0x0F, major, minor, patch, landingPage] on the data endpoint.
    const reply = await this.commandReply([CMD_GET_FIRMWARE_INFO], CMD_GET_FIRMWARE_INFO);
    if (reply.length < 4) {
      throw new Error(`malformed GetFirmwareInfo reply (${reply.length} bytes)`);
    }
    const fw: FirmwareVersion = {
      major: reply.readUInt8(1),
      minor: reply.readUInt8(2),
      patch: reply.readUInt8(3),
    };
    if (reply.length >= 5) fw.landingPage = reply.readUInt8(4) !== 0;
    return fw;
  }

  private onStatusBytes(buf: Buffer): void {
    for (let i = 0; i + 2 <= buf.length; i += 2) {
      this.emit('status', buf.readUInt16LE(i) as FwStatus);
    }
  }

  private onDataBytes(buf: Buffer): void {
    if (this.dataMode === 'rfu') {
      this.emit(buf.length === RFU_CHUNK_LEN ? 'rfu-chunk' : 'data-raw', buf);
      return;
    }
    if (buf.length !== LINK_TRANSFER_LEN) {
      this.emit('data-raw', buf);
      return;
    }
    if (this.dataMode === 'aw') {
      this.emit('aw-chunk', buf.subarray(1));
      return;
    }
    for (let at = 0; at < LINK_TRANSFER_LEN; at += ROUND_PACKET_LEN) {
      const round = new Uint16Array(ROUND_WORDS);
      for (let w = 0; w < ROUND_WORDS; w++) {
        round[w] = buf.readUInt16LE(at + 1 + w * 2);
      }
      this.emit('round', round);
    }
  }

  /** Query replies arrive on the DATA endpoint echoing the command id as byte
   *  0 — the listener must be armed before the command is sent. */
  private commandReply(cmd: number[], replyId: number, timeoutMs = REPLY_TIMEOUT_MS): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const onRaw = (buf: Buffer): void => {
        if (buf.length === 0 || buf.readUInt8(0) !== replyId) return;
        cleanup();
        resolve(buf);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new AdapterTimeoutError(
            `no reply to command 0x${replyId.toString(16).padStart(2, '0')} within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('data-raw', onRaw);
      };
      this.on('data-raw', onRaw);
      this.transport.sendCommand(cmd).catch((err: Error) => {
        cleanup();
        reject(err);
      });
    });
  }

  private awaitStatus(status: FwStatus, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onStatus = (s: FwStatus): void => {
        if (s !== status) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new AdapterTimeoutError(
            `firmware did not report ${FwStatus[status]} (0x${status.toString(16)}) within ${timeoutMs} ms`,
            status,
          ),
        );
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('status', onStatus);
      };
      this.on('status', onStatus);
    });
  }
}
