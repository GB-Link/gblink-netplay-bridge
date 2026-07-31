import { EventEmitter } from 'node:events';
import { CABLE_OVERRIDE_VALUE, FwStatus } from '../types';
import type {
  AdapterEvents,
  AdapterRole,
  CableOverride,
  FirmwareVersion,
  IGBLinkAdapter,
} from '../types';
import { UsbTransport } from './device';
import type { ILinkTransport } from './device';

const CMD_SET_MODE = 0x00;
const CMD_CANCEL = 0x01;
const CMD_GET_FIRMWARE_INFO = 0x0f;
const CMD_SET_MODE_MASTER = 0x10;
const CMD_SET_MODE_SLAVE = 0x11;
const CMD_START_HANDSHAKE = 0x12;
const CMD_CONNECT_LINK = 0x13;
const CMD_SET_CABLE_OVERRIDE = 0x49;
const CMD_GET_CABLE_TYPE = 0x4a;

const MODE_GBA_LINK = 0x01;

const READY_TIMEOUT_MS = 2500;
const REPLY_TIMEOUT_MS = 1500;
// Firmware needs settle time after Cancel before it accepts SetMode.
const CANCEL_SETTLE_MS = 500;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AdapterTimeoutError extends Error {
  constructor(
    message: string,
    readonly status?: FwStatus,
  ) {
    super(message);
    this.name = 'AdapterTimeoutError';
  }
}

export class GBLinkAdapter extends EventEmitter<AdapterEvents> implements IGBLinkAdapter {
  private readonly transport: ILinkTransport;

  constructor(transport?: ILinkTransport) {
    super();
    this.transport = transport ?? new UsbTransport();
    this.transport.on('status-bytes', (buf) => this.onStatusBytes(buf));
    this.transport.on('data-bytes', (buf) => this.onDataBytes(buf));
    this.transport.on('attached', () => this.emit('attached'));
    this.transport.on('detached', () => this.emit('detached'));
  }

  async start(): Promise<void> {
    await this.transport.open();
  }

  async stop(): Promise<void> {
    await this.transport.close();
  }

  async initLinkMode(role: AdapterRole): Promise<void> {
    await this.cancel();
    await delay(CANCEL_SETTLE_MS);
    // DeviceReady and AwaitMode can arrive back-to-back right after SetMode —
    // both waits must be armed before the command goes out.
    const ready = this.awaitStatus(FwStatus.DeviceReady, READY_TIMEOUT_MS);
    const awaitMode = this.awaitStatus(FwStatus.AwaitMode, READY_TIMEOUT_MS);
    void ready.catch(() => undefined);
    void awaitMode.catch(() => undefined);
    await this.transport.sendCommand([CMD_SET_MODE, MODE_GBA_LINK]);
    await ready;
    await awaitMode;
    await this.transport.sendCommand([role === 'master' ? CMD_SET_MODE_MASTER : CMD_SET_MODE_SLAVE]);
  }

  async startHandshake(): Promise<void> {
    await this.transport.sendCommand([CMD_START_HANDSHAKE]);
  }

  async connectLink(): Promise<void> {
    await this.transport.sendCommand([CMD_CONNECT_LINK]);
  }

  async setCableOverride(mode: CableOverride): Promise<void> {
    await this.transport.sendCommand([CMD_SET_CABLE_OVERRIDE, CABLE_OVERRIDE_VALUE[mode]]);
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

  async getFirmwareInfo(): Promise<FirmwareVersion> {
    // Reply: [0x0F, major, minor, patch, flags] on the data endpoint.
    const reply = await this.commandReply([CMD_GET_FIRMWARE_INFO], CMD_GET_FIRMWARE_INFO);
    if (reply.length < 4) {
      throw new Error(`malformed GetFirmwareInfo reply (${reply.length} bytes)`);
    }
    return { major: reply.readUInt8(1), minor: reply.readUInt8(2), patch: reply.readUInt8(3) };
  }

  async getCableType(): Promise<number> {
    // Reply: [0x4A, type] on the data endpoint.
    const reply = await this.commandReply([CMD_GET_CABLE_TYPE], CMD_GET_CABLE_TYPE);
    if (reply.length < 2) {
      throw new Error(`malformed GetCableType reply (${reply.length} bytes)`);
    }
    return reply.readUInt8(1);
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
  private commandReply(cmd: number[], replyId: number): Promise<Buffer> {
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
            `no reply to command 0x${replyId.toString(16).padStart(2, '0')} within ${REPLY_TIMEOUT_MS} ms`,
          ),
        );
      }, REPLY_TIMEOUT_MS);
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
