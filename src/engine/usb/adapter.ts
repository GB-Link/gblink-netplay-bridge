import { EventEmitter } from 'node:events';
import { CABLE_SELECTION_VALUE, FwStatus, cableSelectionFromValue } from '../types';
import type {
  AdapterEvents,
  AdapterRole,
  AwStats,
  AwTimingOverride,
  CableSelection,
  FirmwareVersion,
  IGBLinkAdapter,
  LinkGame,
} from '../types';
import { AW_MODE_VARIANT } from '../aw/maw1';
import { CMD_GET_AW_STATS, decodeAwStats } from '../aw/awStats';
import { UsbTransport } from './device';
import type { ILinkTransport } from './device';

const CMD_SET_MODE = 0x00;
const CMD_CANCEL = 0x01;
const CMD_GET_FIRMWARE_INFO = 0x0f;
const CMD_SET_MODE_MASTER = 0x10;
const CMD_SET_MODE_SLAVE = 0x11;
const CMD_START_HANDSHAKE = 0x12;
const CMD_CONNECT_LINK = 0x13;
const CMD_GET_CABLE_TYPE = 0x4a;
const CMD_SET_CABLE_SELECTION = 0x4b;

const MODE_GBA_LINK = 0x01;
const MODE_ADVANCE_WARS = 0x04;
const MODE_WIRELESS = 0x07;
const CMD_GET_RFU_ISR_STATS = 0x4c;
const RFU_STATS_REPLY_LEN = 21;
const PROBE_TIMEOUT_MS = 400;

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

/** SetMode payload for a game: [0x00, mode, variant, pxgUs u16 LE, syncUs u16 LE]. */
export function setModeCommand(game: LinkGame, awTiming?: AwTimingOverride): number[] {
  if (game === 'gen3') return [CMD_SET_MODE, MODE_GBA_LINK];
  if (game === 'rfu') return [CMD_SET_MODE, MODE_WIRELESS];
  const cmd = [CMD_SET_MODE, MODE_ADVANCE_WARS, AW_MODE_VARIANT[game]];
  const pxg = awTiming?.pxgUs ?? 0;
  const sync = awTiming?.syncUs ?? 0;
  if (pxg !== 0 || sync !== 0) {
    cmd.push(pxg & 0xff, (pxg >> 8) & 0xff, sync & 0xff, (sync >> 8) & 0xff);
  }
  return cmd;
}

export class GBLinkAdapter extends EventEmitter<AdapterEvents> implements IGBLinkAdapter {
  private readonly transport: ILinkTransport;
  /** How 64-byte data IN transfers are decoded for the current mode. */
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

  async initLinkMode(role: AdapterRole, game: LinkGame = 'gen3', awTiming?: AwTimingOverride): Promise<void> {
    await this.cancel();
    await delay(CANCEL_SETTLE_MS);
    this.dataMode = game === 'gen3' ? 'rounds' : game === 'rfu' ? 'rfu' : 'aw';
    // DeviceReady and AwaitMode can arrive back-to-back right after SetMode —
    // both waits must be armed before the command goes out.
    const ready = this.awaitStatus(FwStatus.DeviceReady, READY_TIMEOUT_MS);
    const awaitMode = this.awaitStatus(FwStatus.AwaitMode, READY_TIMEOUT_MS);
    void ready.catch(() => undefined);
    void awaitMode.catch(() => undefined);
    await this.transport.sendCommand(setModeCommand(game, awTiming));
    await ready;
    await awaitMode;
    // The wireless adapter is symmetric: the game decides who leads a room,
    // and the role commands only echo status words there.
    if (game === 'rfu') return;
    await this.transport.sendCommand([role === 'master' ? CMD_SET_MODE_MASTER : CMD_SET_MODE_SLAVE]);
  }

  async startHandshake(): Promise<void> {
    await this.transport.sendCommand([CMD_START_HANDSHAKE]);
  }

  async connectLink(): Promise<void> {
    await this.transport.sendCommand([CMD_CONNECT_LINK]);
  }

  async setCableSelection(selection: CableSelection): Promise<void> {
    await this.transport.sendCommand([CMD_SET_CABLE_SELECTION, CABLE_SELECTION_VALUE[selection]]);
  }

  async cancel(): Promise<void> {
    await this.transport.sendCommand([CMD_CANCEL]);
  }

  async writeRounds(buf: Buffer): Promise<void> {
    if (buf.length !== 64) {
      throw new Error(`writeRounds requires exactly 64 bytes (4 rounds x 8 u16 LE), got ${buf.length}`);
    }
    await this.transport.sendData(buf);
  }

  async writeAwChunk(buf: Buffer): Promise<void> {
    if (buf.length !== 64) {
      throw new Error(`writeAwChunk requires exactly 64 bytes of MAW1 stream, got ${buf.length}`);
    }
    await this.transport.sendData(buf);
  }

  async writeRfuChunk(buf: Buffer): Promise<void> {
    if (buf.length !== 64) {
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
    // Reply: [0x0F, major, minor, patch, landingPage, cableSelection] on the data endpoint.
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
    if (reply.length >= 6) {
      const sel = cableSelectionFromValue(reply.readUInt8(5));
      if (sel !== undefined) fw.cableSelection = sel;
    }
    return fw;
  }

  async getCableType(): Promise<number> {
    // Reply: [0x4A, type] on the data endpoint.
    const reply = await this.commandReply([CMD_GET_CABLE_TYPE], CMD_GET_CABLE_TYPE);
    if (reply.length < 2) {
      throw new Error(`malformed GetCableType reply (${reply.length} bytes)`);
    }
    return reply.readUInt8(1);
  }

  async getAwStats(): Promise<AwStats> {
    return decodeAwStats(await this.commandReply([CMD_GET_AW_STATS], CMD_GET_AW_STATS, PROBE_TIMEOUT_MS));
  }

  private onStatusBytes(buf: Buffer): void {
    for (let i = 0; i + 2 <= buf.length; i += 2) {
      this.emit('status', buf.readUInt16LE(i) as FwStatus);
    }
  }

  private onDataBytes(buf: Buffer): void {
    if (buf.length !== 64) {
      this.emit('data-raw', buf);
      return;
    }
    if (this.dataMode === 'aw') {
      this.emit('aw-chunk', buf);
      return;
    }
    if (this.dataMode === 'rfu') {
      this.emit('rfu-chunk', buf);
      return;
    }
    for (let r = 0; r < 4; r++) {
      const round = new Uint16Array(8);
      for (let w = 0; w < 8; w++) {
        round[w] = buf.readUInt16LE(r * 16 + w * 2);
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
