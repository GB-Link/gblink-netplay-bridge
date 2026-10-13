import { EventEmitter } from 'node:events';
import { FwStatus } from '../types';
import type {
  AdapterEvents,
  AdapterRole,
  AwStats,
  AwTimingOverride,
  CableSelection,
  FirmwareVersion,
  IGBLinkAdapter,
  LinkGame,
  Round,
  SwitchRoom,
} from '../types';
import type { IRfuDevice } from '../rfu/rfuDevice';
import { RfuType, rfu1ClientSend, rfu1Command, type Rfu1Frame } from '../rfu/rfu1';
import { CableTranslator } from './vendor/translator.js';
import { ReverseTranslator } from './vendor/reverse.js';
import { RfuLeader } from './vendor/leader.js';
import { frameClock } from '../frameClock';

const FRAME_MS = 1000 / 59.7275;
/**
 * One command per packet at a GB-Link master's pace (a checksum and eight words 1.378 ms apart,
 * then a 12.953 ms gap), the rate the translators' packet counts assume.
 */
const ROUND_MS = 26;
const READY_POLL_MS = 100;
/** The pause before a new section after a close, as the adapter's firmware takes. */
const REOPEN_MS = 400;
/** After the other player left, the Switch is given this long to leave the group on its own. */
const SWITCH_LEAVE_MS = 10000;
/** A group marked occupied this long while this side is out of it has kept the last visit's member. */
const HELD_GROUP_MS = 1500;
const CMD_WORDS = 8;
const CMD_SEND_HELD_KEYS = 0xcafe;
const CMD_READY_CLOSE_LINK = 0x5fff;
const KEY_EMPTY = 0x11;
const KEY_EXIT_ROOM = 0x17;

const ROOM_ACTIVITY: Record<SwitchRoom, number> = { trade: 4, single: 1, double: 2 };

export interface SwitchCableOptions {
  /** The group led for the Switch when this side is the cable child (joining). */
  room?: SwitchRoom;
  nationalBypass?: boolean;
}

/** The cable game behind the translators, as the Celio page drives it. */
interface CableGame {
  gameCommand(words: number[]): void;
  nextCommand(): number[] | null;
  reset(): void;
  ready(): boolean;
  boardFrame(frame: Rfu1Frame): void;
  /** The Switch is in this side's group, or this side in the Switch's. */
  inGroup(): boolean;
  /** Stops the game's clock; a Switch still in the group is told the link ended. */
  teardown(): void;
}

function safeTeardown(game: CableGame | null | undefined): void {
  try {
    game?.teardown();
  } catch {
    // the device may already be gone
  }
}

/**
 * A Switch's FireRed or LeafGreen on an ESP32 bridge, presented to the gen 3 cable bridge as a
 * GB-Link with a GBA in the Cable Club. The Switch page's translators join the Switch's room
 * when hosting (cable parent) and lead a group the Switch joins when joining (cable child).
 */
export class SwitchCableAdapter extends EventEmitter<AdapterEvents> implements IGBLinkAdapter {
  /** No physical cable: a section ends by restarting it, never by playing 0x5FFF at a GBA. */
  readonly emulated = true;
  private readonly room: SwitchRoom;
  private nationalBypass: boolean;

  private deviceStarted = false;
  private deviceReady = false;
  private role: AdapterRole = 'slave';
  /** The mode is entered: a game runs, or waits for the last one's group to empty. */
  private armed = false;
  private game: CableGame | null = null;
  /** The last visit's game, kept until the Switch has left its group. */
  private leaving: { game: CableGame; timer: NodeJS.Timeout } | null = null;
  /** Statuses queued for a section that has since ended are dropped. */
  private generation = 0;

  private waiting = false;
  private handshake = false;
  private connected = false;
  /** The other player left the link: the section is over until the mode is re-entered. */
  private ended = false;
  private readyAfter = 0;
  private sentClose = false;
  private gotClose = false;
  private exitSeen = false;
  private cafeStreak = 0;

  private readyTimer: NodeJS.Timeout | null = null;
  private stopRoundClock: (() => void) | null = null;

  constructor(
    readonly device: IRfuDevice,
    opts: SwitchCableOptions = {},
  ) {
    super();
    this.room = opts.room ?? 'trade';
    this.nationalBypass = opts.nationalBypass ?? false;
    device.on('frame', (f) => this.boardFrame(f));
    device.on('ready', () => {
      this.deviceReady = true;
      this.emit('attached');
    });
    device.on('down', (reason) => {
      if (!this.deviceReady) return;
      this.deviceReady = false;
      this.emit('log', `Switch link down: ${reason}`);
      this.disarm();
      this.emit('detached');
    });
    device.on('log', (m) => this.emit('log', m));
    device.on('notice', (n) => this.emit('warn', n.text));
    device.on('error', (e) => this.emit('error', e));
  }

  async start(): Promise<void> {
    if (this.deviceStarted) return;
    this.deviceStarted = true;
    try {
      await this.device.start();
    } catch (e) {
      this.deviceStarted = false;
      throw e;
    }
  }

  async stop(): Promise<void> {
    await this.cancel();
    this.deviceStarted = false;
    this.deviceReady = false;
    await this.device.stop();
  }

  async initLinkMode(role: AdapterRole, _game: LinkGame = 'gen3', _awTiming?: AwTimingOverride): Promise<void> {
    const last = this.game;
    const live = last !== null && !this.ended;
    const switchStays = last !== null && this.ended && last.inGroup();
    this.game = null;
    this.stopSection();
    if (last && switchStays) this.waitForSwitchToLeave(last);
    else safeTeardown(last);
    // Every mode entry opens with a Cancel, on which the firmware reports a live link closed.
    if (live) this.emit('status', FwStatus.LinkClosed);
    this.role = role;
    this.ended = false;
    this.readyAfter = 0;
    this.armed = true;
    if (!this.leaving) this.game = this.newGame();
    this.status(FwStatus.DeviceReady);
    this.status(FwStatus.AwaitMode);
    this.readyTimer = setInterval(() => this.pollReady(), READY_POLL_MS);
    this.readyTimer.unref?.();
  }

  async startHandshake(): Promise<void> {
    const game = this.game;
    if (!game || !this.waiting) return;
    this.waiting = false;
    game.reset();
    this.sentClose = this.gotClose = this.exitSeen = false;
    this.cafeStreak = 0;
    if (this.role === 'master') this.handshake = true;
    else this.up();
  }

  async connectLink(): Promise<void> {
    if (this.role !== 'master' || !this.handshake) return;
    this.handshake = false;
    this.up();
  }

  async cancel(): Promise<void> {
    const had = this.game !== null || this.leaving !== null;
    this.disarm();
    if (had) this.status(FwStatus.LinkClosed);
  }

  async writeRounds(buf: Buffer): Promise<void> {
    if (buf.length !== 64) throw new Error(`writeRounds requires exactly 64 bytes, got ${buf.length}`);
    const game = this.game;
    if (!game || (!this.connected && !this.handshake)) return;
    for (let r = 0; r < 4; r++) {
      const words: number[] = [];
      let any = false;
      for (let w = 0; w < CMD_WORDS; w++) {
        const word = buf.readUInt16LE(r * 16 + w * 2);
        words.push(word);
        if (word) any = true;
      }
      if (!any) continue;
      if (words[0] === CMD_READY_CLOSE_LINK) this.gotClose = true;
      if (words[0] === CMD_SEND_HELD_KEYS && (words[1]! & 0xff) === KEY_EXIT_ROOM) this.exitSeen = true;
      game.gameCommand(words);
    }
    this.checkClose();
  }

  async getFirmwareInfo(): Promise<FirmwareVersion> {
    const version = this.device.info?.version ?? '0.0.0';
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    return { major: Number(m?.[1] ?? 0), minor: Number(m?.[2] ?? 0), patch: Number(m?.[3] ?? 0), device: 'esp32' };
  }

  async getCableType(): Promise<number> {
    throw new Error('a Switch has no link cable');
  }

  async setCableSelection(_selection: CableSelection): Promise<void> {
    throw new Error('a Switch has no link cable');
  }

  async writeAwChunk(_buf: Buffer): Promise<void> {
    throw new Error('Advance Wars is not available on the Switch');
  }

  async writeRfuChunk(_buf: Buffer): Promise<void> {
    throw new Error('the Switch cable link carries no wireless stream');
  }

  async probeWireless(): Promise<boolean> {
    return false;
  }

  async getAwStats(): Promise<AwStats> {
    throw new Error('Advance Wars is not available on the Switch');
  }

  setNationalBypass(value: boolean): void {
    this.nationalBypass = value;
  }

  /** Status words reach the bridge asynchronously, as the firmware's do over USB. */
  private status(word: FwStatus): void {
    const generation = this.generation;
    setImmediate(() => {
      if (generation === this.generation) this.emit('status', word);
    });
  }

  /** The Switch's side is ready to link: its room is seen, or it waits in the group. */
  get switchReady(): boolean {
    return this.game?.ready() ?? false;
  }

  get linkOpen(): boolean {
    return this.connected;
  }

  // ---- the two games ----

  private newGame(): CableGame {
    return this.role === 'slave' ? this.parentGame() : this.childGame();
  }

  private boardFrame(frame: Rfu1Frame): void {
    const leaving = this.leaving;
    if (!leaving) {
      this.game?.boardFrame(frame);
      return;
    }
    leaving.game.boardFrame(frame);
    if (!leaving.game.inGroup()) this.switchLeft();
  }

  /** Hosting: this side is the cable parent and joins the Switch's room. */
  private parentGame(): CableGame {
    const translator = new CableTranslator({
      send: (payload) => this.device.writeFrame(rfu1ClientSend(payload, 0, 0)),
      connect: (devid) => this.device.writeFrame(rfu1Command(RfuType.ConnectReq, devid)),
      disconnect: () => this.device.writeFrame(rfu1Command(RfuType.Disconnect, 0)),
      log: (m) => this.emit('log', m),
      holdJoin: true,
    });
    translator.bypassNationally = this.nationalBypass;
    translator.onLinked = (linked) => this.emit('log', linked ? "linked with the Switch's room" : "the Switch's room link ended");
    const stopClock = frameClock(() => translator.frame(), FRAME_MS);
    let heldSince = 0;
    let heldNoted = false;
    return {
      gameCommand: (words) => translator.gameCommand(words),
      nextCommand: () => translator.nextCommand(),
      reset: () => translator.cableReset(),
      ready: () => translator.readyToLink,
      boardFrame: (f) => {
        if (f.type === RfuType.Broadcast) {
          // Header bit 16 marks the group the board's member is in; the board keeps that member after
          // a visit (pia_bridge.c), so a group marked while this side is out of it takes nobody new.
          const held = ((f.header >>> 16) & 1) !== 0 && !translator.joined;
          if (!held) heldSince = 0;
          else if (heldSince === 0) heldSince = Date.now();
          else if (!heldNoted && Date.now() - heldSince >= HELD_GROUP_MS) {
            heldNoted = true;
            this.emit('warn', "The Switch's group still counts the last visit. On the Switch, leave the group and lead it again.");
          }
        }
        translator.boardFrame({ type: f.type, header: f.header, frame: f.raw });
      },
      inGroup: () => translator.joined,
      teardown: () => {
        stopClock();
        if (translator.joined) this.device.writeFrame(rfu1Command(RfuType.Disconnect, 0));
      },
    };
  }

  /** Joining: this side is the cable child and leads a group the Switch joins. */
  private childGame(): CableGame {
    const log = (m: string): void => {
      this.emit('log', m);
    };
    const leader = new RfuLeader({ send: (f) => this.device.writeFrame(Buffer.from(f)), log });
    const reverse = new ReverseTranslator({ leader, activity: ROOM_ACTIVITY[this.room], log });
    reverse.bypassNationally = this.nationalBypass;
    reverse.onReady = () => log("the Switch's player is known");
    reverse.onOtherChoice = (type) => log(`the other player chose another room (link type 0x${type.toString(16)})`);
    reverse.onRefused = (reason) => {
      if (reason) log(`the other player's game refuses the Switch's: ${reason}`);
    };
    reverse.openGroup();
    const stopClock = frameClock(() => leader.tick(), FRAME_MS);
    return {
      gameCommand: (words) => reverse.gameCommand(words),
      nextCommand: () => reverse.nextCommand(),
      reset: () => reverse.cableReset(),
      ready: () => reverse.ready,
      boardFrame: (f) => leader.boardFrame({ type: f.type, header: f.header, frame: f.raw }),
      inGroup: () => leader.joined,
      teardown: () => {
        stopClock();
        leader.close();
      },
    };
  }

  /** The other player left: the Switch leaves the group at its own pace, then the next visit's group opens. */
  private waitForSwitchToLeave(game: CableGame): void {
    const timer = setTimeout(() => this.switchLeft(true), SWITCH_LEAVE_MS);
    timer.unref?.();
    this.leaving = { game, timer };
    this.emit('log', 'waiting for the Switch to leave the group');
  }

  private switchLeft(timedOut = false): void {
    const leaving = this.leaving;
    if (!leaving) return;
    this.leaving = null;
    clearTimeout(leaving.timer);
    if (timedOut) this.emit('log', 'the Switch stayed in the group: closing it');
    safeTeardown(leaving.game);
    if (this.armed && this.deviceReady && !this.game) this.game = this.newGame();
  }

  // ---- the firmware's lifecycle, as the page reports it to Celio ----

  private pollReady(): void {
    const game = this.game;
    if (!game || !this.deviceReady || this.ended || this.waiting || this.connected || this.handshake) return;
    if (Date.now() < this.readyAfter || !game.ready()) return;
    this.waiting = true;
    this.status(FwStatus.HandshakeReceived);
  }

  private up(): void {
    this.connected = true;
    this.status(FwStatus.LinkConnected);
    this.stopRounds();
    this.stopRoundClock = frameClock(() => this.round(), ROUND_MS);
  }

  /** One cable packet: the next command for the other player, if any. */
  private round(): void {
    const game = this.game;
    if (!game || !this.connected) return;
    const next = game.nextCommand();
    if (!next) return;
    let words = next.map((w) => w & 0xffff);
    if (!words.some((w) => w)) return;
    if (words[0] === CMD_READY_CLOSE_LINK) this.sentClose = true;
    if (words[0] === CMD_SEND_HELD_KEYS && (words[1]! & 0xff) === KEY_EXIT_ROOM) this.exitSeen = true;
    // Like the adapter: a run of "no key" reports travels as its first one.
    if (words[0] === CMD_SEND_HELD_KEYS && words[1] === KEY_EMPTY) {
      if (this.cafeStreak++ > 0) words = [];
    } else {
      this.cafeStreak = 0;
    }
    if (words.length === 0) {
      this.checkClose();
      return;
    }
    const round: Round = new Uint16Array(CMD_WORDS);
    for (let i = 0; i < CMD_WORDS; i++) round[i] = words[i] ?? 0;
    this.emit('round', round);
    this.checkClose();
  }

  /** A 0x5FFF sent and received ends the section, as the adapter's does. */
  private checkClose(): void {
    if (!this.connected || !this.sentClose || !this.gotClose) return;
    this.connected = false;
    this.stopRounds();
    if (this.exitSeen) {
      // The translators still have goodbyes to send, so the game ends on the next mode entry
      // or once the Switch has left the group.
      this.ended = true;
      this.emit('log', 'the other player left the link');
      this.status(FwStatus.LinkClosed);
    } else {
      this.status(FwStatus.LinkReconnecting);
      this.readyAfter = Date.now() + REOPEN_MS;
    }
  }

  private stopRounds(): void {
    this.stopRoundClock?.();
    this.stopRoundClock = null;
  }

  /** Statuses still queued for the section are dropped. */
  private stopSection(): void {
    this.generation++;
    if (this.readyTimer) clearInterval(this.readyTimer);
    this.readyTimer = null;
    this.stopRounds();
    this.waiting = false;
    this.handshake = false;
    this.connected = false;
  }

  /** Leaves the mode: every game ends now, and a Switch still linked is told so. */
  private disarm(): void {
    this.armed = false;
    this.stopSection();
    const game = this.game;
    this.game = null;
    const leaving = this.leaving;
    this.leaving = null;
    if (leaving) clearTimeout(leaving.timer);
    safeTeardown(leaving?.game);
    safeTeardown(game);
  }
}
