import { EventEmitter } from 'node:events';
import type { BridgeCounters, INetplayEndpoint, LinkPhase, NetplayPeer } from '../types';
import { identifyPacket, mismatchWarning } from '../netplay/protocolMagic';
import type { IRfuDevice } from './rfuDevice';
import { RfuPacer } from './rfuPacer';
import {
  GBA_GROUP_AS_FIRE_RED,
  RFU1_NO_FREE_SLOT,
  RFU_ACTIVITY,
  RfuType,
  SWITCH_GROUP_AS_EMERALD,
  markNationally,
  parseGameData,
  parseRfu1,
  rfu1Command,
  rfu1GameData,
  rfu1TypeName,
  type Rfu1Frame,
} from './rfu1';

/** gpsp drops a peer's broadcast after 255 frames without a fresh one. */
const BROADCAST_TTL_MS = 4500;
/** Joins unanswered this long are refused; an ESP32 board answers only once the Switch accepts. */
const CONNECT_PENDING_MS = 10000;
/** gpsp and the GB-Link firmware drop a member silent for 240 frames. */
const MEMBER_TIMEOUT_MS = 4000;
/**
 * A member's join request is a retry that crossed the acceptance (the firmware asks every 300 ms)
 * while it is new or talking, and a fresh join once it has been quiet this long.
 */
const REJOIN_QUIET_MS = 1500;
/** An ESP32 board is offered another player's group once this one's beacons stop. */
const OFFER_TTL_MS = 1500;
/** The board's groups for one Switch room come back to back, every 500 ms. */
const BEACON_BURST_MS = 250;
/** A board group marked occupied this long with no member here holds an orphaned member. */
const ORPHAN_SEAT_MS = 1000;
/** RFU_SERIAL_GAME: the Gen 3 games' group beacons. */
const GEN3_SERIAL = 0x0002;
/** The groups an ESP32 board can lead for the Switch (pia_bridge.c kGroupActivity). */
const SWITCH_ACTIVITIES: ReadonlySet<number> = new Set([
  RFU_ACTIVITY.TRADE,
  RFU_ACTIVITY.BATTLE_SINGLE,
  RFU_ACTIVITY.BATTLE_DOUBLE,
]);
/** The device counts as leading a room until this long after its last broadcast. */
const HOSTING_TTL_MS = 2000;
const COUNTERS_INTERVAL_MS = 1000;
const REJECT_LOG_MAX = 10;

export interface RfuBridgeOptions {
  /**
   * National Dex bypass for a Switch: its groups show to the GBAs as Emerald and theirs to it as
   * FireRed or LeafGreen, all marked as able to link nationally.
   */
  nationalBypass?: boolean;
  now?: () => number;
}

export interface RfuLinkBridgeEvents {
  'link-phase': [LinkPhase, number?];
  counters: [BridgeCounters];
  /** The device joined a room: the host's nick, or null when it left. */
  room: [string | null];
  log: [string];
  warn: [string];
  error: [Error];
}

/** A player's broadcasts, kept the way gpsp keeps them: one per netplay client. */
interface PeerRoom {
  /** The player's latest device id. */
  devid: number;
  at: number;
  /** Device ids the player announced lately, for a join aimed at an older one. */
  seen: Map<number, number>;
  /** It announces several groups at once (an ESP32 board's): their ids pass unchanged. */
  several: boolean;
  /** The one device id a GB-Link is shown for this player, as a real adapter keeps its own. */
  shown: number;
}

interface ChildLink {
  clientId: number;
  devid: number;
  heardAt: number;
  heard: boolean;
}

interface ClientLink {
  hostClientId: number;
  /** The device id the device asked for. */
  hostDevid: number;
  /** The device id the request was relayed with. */
  targetDevid: number;
  /** slot << 16 | our devid, from the host's CONNECT_ACK; 0 until then. */
  seat: number;
  /** When the last request was relayed, or the acceptance came. */
  at: number;
  /** When the device last sent the host a frame. */
  heardAt: number;
}

interface MutableCounters {
  txPackets: number;
  rxPackets: number;
  txBytes: number;
  rxBytes: number;
  rejected: number;
  ignoredPeer: number;
  txNoPeer: number;
}

/**
 * Relays one wireless adapter (a GBA on a GB-Link, or a Switch behind an ESP32 board) into a
 * netplay session of gpsp wireless peers. The device already speaks RFU1; the relay adds the
 * addressing gpsp gets from netplay: broadcasts to everyone, the rest to the client a room link
 * is with (gpsp keys peers by netplay client id, the device by device id).
 */
export class RfuLinkBridge extends EventEmitter<RfuLinkBridgeEvents> {
  private readonly now: () => number;
  private readonly nationalBypass: boolean;

  private phase: LinkPhase = 'idle';
  private sessionLive = false;
  private deviceReady = false;
  private stopped = false;

  /** The players' rooms, by netplay client id. */
  private readonly rooms = new Map<number, PeerRoom>();
  private clientLink: ClientLink | null = null;
  private readonly childLinks = new Map<number, ChildLink>();
  private readonly pendingRequests: { clientId: number; at: number }[] = [];
  /**
   * The member an ESP32 board admitted by itself after one left: it keeps the
   * Switch's side connected (pia_bridge.c), so the next joiner takes that seat.
   */
  private boardSeat: number | null = null;
  private boardSeatNoted = false;
  private orphanSince = 0;
  /** The player whose group an ESP32 board is offered. */
  private offered: { clientId: number; at: number } | null = null;
  private readonly burst = { start: 0, index: 0, size: 1, turn: 0 };
  private severalGroupsNoted = false;
  private lastOwnBroadcastAt = 0;
  private rejectsLogged = 0;
  private mismatchWarned = false;
  private countersTimer: NodeJS.Timeout | null = null;
  private readonly pacer = new RfuPacer((frame, dest) => this.send(frame, dest));

  private readonly counters: MutableCounters = {
    txPackets: 0,
    rxPackets: 0,
    txBytes: 0,
    rxBytes: 0,
    rejected: 0,
    ignoredPeer: 0,
    txNoPeer: 0,
  };

  constructor(
    private readonly device: IRfuDevice,
    private readonly net: INetplayEndpoint,
    opts: RfuBridgeOptions = {},
  ) {
    super();
    this.now = opts.now ?? Date.now;
    this.nationalBypass = opts.nationalBypass ?? false;
  }

  get linkPhase(): LinkPhase {
    return this.phase;
  }

  get bridgeCounters(): BridgeCounters {
    return { ...this.counters };
  }

  /** The device is leading a room (broadcasting lately). */
  get hosting(): boolean {
    return this.now() - this.lastOwnBroadcastAt < HOSTING_TTL_MS;
  }

  get joinedHost(): number | null {
    return this.clientLink && this.clientLink.seat !== 0 ? this.clientLink.hostClientId : null;
  }

  get childCount(): number {
    return this.childLinks.size;
  }

  async start(initDeviceNow = true): Promise<void> {
    this.net.on('session-start', this.onSessionStart);
    this.net.on('packet', this.onPacket);
    this.net.on('peer-playing', this.onPeerPlaying);
    this.net.on('peer-left', this.onPeerLeft);
    this.net.on('closed', this.onNetClosed);
    this.device.on('frame', this.onDeviceFrame);
    this.device.on('ready', this.onDeviceReady);
    this.device.on('down', this.onDeviceDown);
    this.device.on('detached', this.onDeviceDown);
    this.device.on('log', this.onDeviceLog);
    this.device.on('notice', this.onDeviceNotice);
    this.device.on('error', this.onDeviceError);
    this.countersTimer = setInterval(() => {
      this.emit('counters', this.bridgeCounters);
      this.expire();
    }, COUNTERS_INTERVAL_MS);
    this.countersTimer.unref?.();
    if (initDeviceNow) {
      await this.device.start().catch((e: Error) => this.emit('error', e));
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.leaveEverything('bridge stopping');
    this.pacer.stop();
    if (this.countersTimer) clearInterval(this.countersTimer);
    this.countersTimer = null;
    this.net.off('session-start', this.onSessionStart);
    this.net.off('packet', this.onPacket);
    this.net.off('peer-playing', this.onPeerPlaying);
    this.net.off('peer-left', this.onPeerLeft);
    this.net.off('closed', this.onNetClosed);
    this.device.off('frame', this.onDeviceFrame);
    this.device.off('ready', this.onDeviceReady);
    this.device.off('down', this.onDeviceDown);
    this.device.off('detached', this.onDeviceDown);
    this.device.off('log', this.onDeviceLog);
    this.device.off('notice', this.onDeviceNotice);
    this.device.off('error', this.onDeviceError);
    await this.device.stop().catch(() => undefined);
    this.setPhase('closed');
  }

  // ---- device side ----

  private readonly onDeviceReady = (): void => {
    this.deviceReady = true;
    this.resetLinks();
    this.emit('log', 'wireless adapter live');
    this.updatePhase();
  };

  private readonly onDeviceDown = (reason?: string): void => {
    if (!this.deviceReady) return;
    this.deviceReady = false;
    this.leaveEverything(reason ?? 'device down');
    this.updatePhase();
  };

  private readonly onDeviceLog = (msg: string): void => {
    this.emit('log', msg);
  };

  private readonly onDeviceNotice = (n: { text: string }): void => {
    this.emit('warn', n.text);
  };

  private readonly onDeviceError = (e: Error): void => {
    this.emit('error', e);
  };

  private readonly onDeviceFrame = (frame: Rfu1Frame): void => {
    if (this.stopped) return;
    const now = this.now();
    switch (frame.type) {
      case RfuType.Broadcast:
        this.lastOwnBroadcastAt = now;
        this.ownBroadcast(frame, now);
        this.updatePhase();
        break;
      case RfuType.ConnectReq:
        this.deviceJoins(frame, now);
        this.updatePhase();
        break;
      case RfuType.ConnectAck:
      case RfuType.ConnectNack:
        this.deviceAnswers(frame, now);
        this.updatePhase();
        break;
      case RfuType.Disconnect:
        this.deviceLeaves(frame);
        this.updatePhase();
        break;
      case RfuType.HostSend: {
        if (this.childLinks.size === 0) {
          this.counters.txNoPeer++;
          break;
        }
        for (const child of this.childLinks.values()) this.pace(Buffer.from(frame.raw), child.clientId);
        break;
      }
      case RfuType.ClientSend:
      case RfuType.ClientAck: {
        const link = this.clientLink;
        if (!link) {
          this.counters.txNoPeer++;
          break;
        }
        link.heardAt = now;
        if (frame.type === RfuType.ClientAck) {
          this.send(frame.raw, link.hostClientId);
          break;
        }
        if ((frame.header & 0xffff) === 0 && link.seat !== 0) {
          frame.raw.writeUInt32BE(((frame.header & 0xff000000) | link.seat) >>> 0, 8);
        }
        this.pace(frame.raw, link.hostClientId);
        break;
      }
      case RfuType.FlowCtl:
        // Inbound queue pressure: a GB-Link partner slows down on it; gpsp and the ESP32 board ignore it.
        for (const id of this.linkPartners()) this.send(frame.raw, id);
        break;
      default:
        this.counters.rejected++;
        this.logReject(`unknown frame type ${frame.type} from the device`);
        break;
    }
  };

  private ownBroadcast(frame: Rfu1Frame, now: number): void {
    const out = Buffer.from(frame.raw);
    if (this.device.kind === 'esp32') {
      // The board marks the group it serves as occupied (header bit 16).
      const occupied = ((frame.header >>> 16) & 1) !== 0;
      if (occupied && this.childLinks.size === 0 && this.pendingRequests.length === 0 && this.boardSeat === null) {
        // A member the board admitted before this relay saw a player leave: its slot 0 is
        // taken over as is, since the board checks no device id on its member's frames.
        if (this.orphanSince === 0) this.orphanSince = now;
        else if (now - this.orphanSince >= ORPHAN_SEAT_MS) this.takeBoardSeat(1 + Math.floor(Math.random() * 0xfffe));
      } else {
        this.orphanSince = 0;
      }
      if (!this.boardBeaconTurn(now)) return;
      // In the firmware's terms: the next free slot, or none.
      const full = this.childLinks.size + this.pendingRequests.length >= this.device.maxChildren;
      out[8] = 0;
      out[9] = full ? RFU1_NO_FREE_SLOT : 0;
      if (this.nationalBypass) markNationally(out, SWITCH_GROUP_AS_EMERALD);
    }
    this.send(out);
  }

  /**
   * A board that can't read the Switch's room beacons it as trade, single and double battle groups
   * back to back; gpsp keeps one broadcast per player, so each burst passes one, in turn.
   */
  private boardBeaconTurn(now: number): boolean {
    const b = this.burst;
    if (now - b.start > BEACON_BURST_MS) {
      if (b.start !== 0) b.size = Math.max(1, b.index);
      b.start = now;
      b.index = 0;
      b.turn++;
    }
    const index = b.index++;
    if (b.size <= 1) return true;
    if (!this.severalGroupsNoted) {
      this.severalGroupsNoted = true;
      this.emit(
        'warn',
        "The ESP32 board could not read which room the Switch is in, so the other players see its group as a trade, single-battle and double-battle group in turn.",
      );
    }
    return index === b.turn % b.size;
  }

  private deviceJoins(frame: Rfu1Frame, now: number): void {
    const devid = frame.header & 0xffff;
    const link = this.clientLink;
    if (link && link.hostDevid === devid) {
      if (link.seat === 0) {
        // The firmware asks every 300 ms until it hears an answer.
        link.at = now;
        this.send(rfu1Command(RfuType.ConnectReq, link.targetDevid), link.hostClientId);
        return;
      }
      if (now - link.at < REJOIN_QUIET_MS) return;
    }
    // Asking anew: whatever seat the device held, it has given up on its side.
    if (link) this.leaveHost(link, link.hostDevid === devid ? 'the device asked to join again' : 'the device asked for another room');
    const target = this.roomOf(devid);
    if (!target) {
      this.counters.txNoPeer++;
      this.emit('log', `the device asked to join room ${hex16(devid)}, which no player announces — refusing it`);
      this.toDevice(rfu1Command(RfuType.ConnectNack, 0));
      return;
    }
    this.clientLink = {
      hostClientId: target.clientId,
      hostDevid: devid,
      targetDevid: target.devid,
      seat: 0,
      at: now,
      heardAt: now,
    };
    this.send(rfu1Command(RfuType.ConnectReq, target.devid), target.clientId);
    this.emit('log', `joining ${this.nick(target.clientId)}'s room ${hex16(target.devid)}`);
  }

  private deviceAnswers(frame: Rfu1Frame, now: number): void {
    this.prunePending();
    const req = this.pendingRequests.shift();
    if (!req) {
      this.counters.rejected++;
      if (frame.type === RfuType.ConnectAck) this.unclaimedDeviceSeat(frame.header & 0x3ffff);
      else this.logReject('a refusal from the device with no join pending');
      return;
    }
    if (frame.type === RfuType.ConnectAck) {
      const slot = (frame.header >>> 16) & 0x3;
      this.childLinks.set(slot, { clientId: req.clientId, devid: frame.header & 0xffff, heardAt: now, heard: false });
      this.emit('log', `${this.nick(req.clientId)} joined the device's room (slot ${slot})`);
    } else {
      this.emit('log', `the device refused ${this.nick(req.clientId)}'s join`);
    }
    this.send(frame.raw, req.clientId);
  }

  /** The device let in a player nobody here waits for. */
  private unclaimedDeviceSeat(seat: number): void {
    if (this.device.kind === 'esp32') {
      // Answering with a DISCONNECT would have the board admit one again on its next frame.
      this.takeBoardSeat(seat);
      return;
    }
    this.toDevice(rfu1Command(RfuType.Disconnect, seat));
    this.logReject(`released a seat the device opened for nobody (${hex16(seat)})`);
  }

  private takeBoardSeat(seat: number): void {
    this.boardSeat = seat;
    if (this.boardSeatNoted) return;
    this.boardSeatNoted = true;
    this.emit(
      'warn',
      "A player left the Switch's group, but the Switch still counts them: the next player to join takes their place. If that player cannot link, leave the group on the Switch and lead it again.",
    );
  }

  private deviceLeaves(frame: Rfu1Frame): void {
    const slot = (frame.header >>> 16) & 0x3;
    const devid = frame.header & 0xffff;
    const child = this.childLinks.get(slot);
    if (child && child.devid === devid) {
      this.endChild(slot, child);
      this.send(frame.raw, child.clientId);
      this.emit('log', `the device dropped ${this.nick(child.clientId)} from its room`);
      return;
    }
    const link = this.clientLink;
    if (link && (link.seat === 0 || devid === 0 || devid === (link.seat & 0xffff))) {
      this.endClientLink(link);
      if (link.seat !== 0) {
        this.send(rfu1Command(RfuType.Disconnect, link.seat), link.hostClientId);
        this.emit('room', null);
      }
      this.emit('log', `the device left ${this.nick(link.hostClientId)}'s room`);
      return;
    }
    this.counters.txNoPeer++;
  }

  // ---- netplay side ----

  private readonly onSessionStart = (id: number): void => {
    this.sessionLive = true;
    this.emit('log', `netplay session live (client ${id})`);
    this.updatePhase();
  };

  private readonly onPeerPlaying = (peer: NetplayPeer): void => {
    this.emit('log', `${peer.nick} is playing (client ${peer.id})`);
  };

  private readonly onPeerLeft = (peer: NetplayPeer): void => {
    this.emit('log', `${peer.nick} left`);
    this.forgetPeer(peer.id);
    this.updatePhase();
  };

  private readonly onNetClosed = (): void => {
    this.sessionLive = false;
    this.leaveEverything('netplay session closed');
    this.updatePhase();
  };

  /** `buf` is shared with the netplay host's relay to the other players: never changed here. */
  private readonly onPacket = (buf: Buffer, src: number): void => {
    if (this.stopped) return;
    const frame = parseRfu1(buf);
    if (frame === null) {
      this.counters.rejected++;
      const seen = identifyPacket(buf);
      if (seen && seen !== 'rfu1' && !this.mismatchWarned) {
        this.mismatchWarned = true;
        this.emit('warn', mismatchWarning('rfu', seen));
      }
      this.logReject(`rejected a packet from client ${src}: not an RFU1 frame (${buf.length} bytes)`);
      return;
    }
    this.counters.rxPackets++;
    this.counters.rxBytes += buf.length;
    const now = this.now();
    switch (frame.type) {
      case RfuType.Broadcast:
        this.peerBroadcast(frame, src, now);
        break;
      case RfuType.ConnectReq:
        this.peerJoins(frame, src, now);
        this.updatePhase();
        break;
      case RfuType.ConnectAck: {
        const link = this.clientLink;
        const seat = frame.header & 0x3ffff;
        if (link && link.hostClientId === src && link.seat === seat) break;
        if (!link || link.hostClientId !== src || link.seat !== 0) {
          // Nobody here waits for it any more: free the slot the host opened.
          this.counters.ignoredPeer++;
          this.send(rfu1Command(RfuType.Disconnect, seat), src);
          this.logReject(`released a seat ${this.nick(src)} granted after the device stopped asking`);
          break;
        }
        link.seat = seat;
        link.at = now;
        link.heardAt = now;
        this.emit('log', `${this.nick(src)} let the device into room ${hex16(link.targetDevid)} (slot ${seat >>> 16})`);
        this.toDevice(frame.raw);
        this.emit('room', this.nick(src));
        this.updatePhase();
        break;
      }
      case RfuType.ConnectNack: {
        const link = this.clientLink;
        if (!link || link.hostClientId !== src || link.seat !== 0) {
          this.counters.ignoredPeer++;
          break;
        }
        this.toDevice(frame.raw);
        // The GB-Link firmware keeps asking after a refusal (a Union Room player may be between
        // scans), and an acceptance can still come for an earlier request: the link stays.
        if (this.device.kind === 'gblink') break;
        this.endClientLink(link);
        this.emit('log', `${this.nick(src)} refused the device's join`);
        this.updatePhase();
        break;
      }
      case RfuType.Disconnect: {
        const devid = frame.header & 0xffff;
        const link = this.clientLink;
        if (link && link.hostClientId === src && link.seat !== 0 && devid === (link.seat & 0xffff)) {
          this.endClientLink(link);
          this.emit('log', `${this.nick(src)} closed the room`);
          this.toDevice(frame.raw);
          this.emit('room', null);
          this.updatePhase();
          break;
        }
        const slot = (frame.header >>> 16) & 0x3;
        const child = this.childLinks.get(slot);
        if (child && child.clientId === src && child.devid === devid) {
          this.endChild(slot, child);
          this.emit('log', `${this.nick(src)} left the device's room`);
          this.toDevice(frame.raw);
          this.updatePhase();
          break;
        }
        // gpsp disconnects every slot in its game's mask, empty ones too (to client 0).
        this.counters.ignoredPeer++;
        break;
      }
      case RfuType.HostSend: {
        const link = this.clientLink;
        if (!link || link.hostClientId !== src) {
          this.counters.ignoredPeer++;
          break;
        }
        this.toDevice(frame.raw);
        // gpsp hosts drop a child silent for 4 s, so the relay acks for a device that doesn't.
        if (!this.device.gpspChild && link.seat !== 0) {
          this.send(rfu1Command(RfuType.ClientAck, link.seat), src);
        }
        break;
      }
      case RfuType.ClientSend:
      case RfuType.ClientAck: {
        const slot = (frame.header >>> 16) & 0x3;
        const child = this.childLinks.get(slot);
        if (!child || child.clientId !== src) {
          this.counters.ignoredPeer++;
          break;
        }
        child.heardAt = now;
        child.heard = true;
        // The ESP32 board keeps its children alive itself and ignores acks.
        if (frame.type === RfuType.ClientAck && this.device.kind === 'esp32') break;
        this.toDevice(frame.raw);
        break;
      }
      case RfuType.FlowCtl:
        if (this.device.kind === 'gblink' && this.linkPartners().includes(src)) this.toDevice(frame.raw);
        break;
      default:
        this.counters.rejected++;
        this.logReject(`unknown frame type ${frame.type} from ${this.nick(src)}`);
        break;
    }
  };

  private peerBroadcast(frame: Rfu1Frame, src: number, now: number): void {
    const devid = frame.header & 0xffff;
    let room = this.rooms.get(src);
    if (!room) {
      room = { devid, at: now, seen: new Map(), several: false, shown: this.unshownId(devid) };
      this.rooms.set(src, room);
      this.emit('log', `${this.nick(src)} announces room ${hex16(devid)}`);
    } else if (room.devid !== devid && room.seen.has(devid)) {
      // Back to an id it announced before: several groups at once, not
      // gpsp's new id each time a Union Room player starts hosting again.
      room.several = true;
    }
    for (const [d, at] of room.seen) if (now - at > BROADCAST_TTL_MS) room.seen.delete(d);
    room.seen.set(devid, now);
    room.devid = devid;
    room.at = now;

    const out = Buffer.from(frame.raw);
    if (this.device.kind === 'esp32') {
      if (!this.offerToBoard(frame, src, now)) return;
      if (this.nationalBypass) markNationally(out, GBA_GROUP_AS_FIRE_RED);
    } else if (!room.several) {
      // The firmware lists rooms by device id: one entry per player.
      out.writeUInt16BE(room.shown, 10);
    }
    this.toDevice(out);
  }

  /**
   * An ESP32 board leads a Switch room for the first group it is offered and keeps it while that
   * group beacons (pia_bridge.c), so it is offered one joinable group at a time. Once the Switch is
   * in or joining a group, only that group's beacons pass.
   */
  private offerToBoard(frame: Rfu1Frame, src: number, now: number): boolean {
    const link = this.clientLink;
    if (link) return link.hostClientId === src;
    const offered = this.offered;
    if (offered && offered.clientId !== src && now - offered.at < OFFER_TTL_MS) return false;
    if (!joinableBySwitch(frame)) {
      if (offered?.clientId === src) this.offered = null;
      return false;
    }
    this.offered = { clientId: src, at: now };
    return true;
  }

  private peerJoins(frame: Rfu1Frame, src: number, now: number): void {
    for (const [slot, child] of this.childLinks) {
      if (child.clientId !== src) continue;
      if (!child.heard || now - child.heardAt < REJOIN_QUIET_MS) return;
      // Its game started over: a gpsp reset says nothing to the room.
      this.dropChild(slot, child, 'it asked to join again');
    }
    if (this.pendingRequests.some((r) => r.clientId === src)) return;
    if (!this.hosting) {
      // As gpsp answers a request while it leads no room.
      this.send(rfu1Command(RfuType.ConnectNack, 0), src);
      return;
    }
    if (this.childLinks.size + this.pendingRequests.length >= this.device.maxChildren) {
      this.emit('log', `${this.nick(src)} asks to join the device's room, which is full`);
      this.send(rfu1Command(RfuType.ConnectNack, 0), src);
      return;
    }
    const seat = this.boardSeat;
    if (seat !== null) {
      this.boardSeat = null;
      const slot = (seat >>> 16) & 0x3;
      this.childLinks.set(slot, { clientId: src, devid: seat & 0xffff, heardAt: now, heard: false });
      // The board answers no request while it holds a member, but still
      // takes the group the player picked from it.
      this.toDevice(frame.raw);
      this.send(rfu1Command(RfuType.ConnectAck, seat), src);
      this.emit('log', `${this.nick(src)} takes the place the Switch's group kept (slot ${slot})`);
      return;
    }
    this.pendingRequests.push({ clientId: src, at: now });
    this.emit('log', `${this.nick(src)} asks to join the device's room`);
    this.toDevice(frame.raw);
  }

  // ---- helpers ----

  /**
   * RetroArch tells a client only about players who join after it, so the peer list is no gate:
   * like gpsp, frames go to the link's client id and the host drops them if nobody is there.
   */
  private send(frame: Buffer, dest?: number): void {
    if (!this.sessionLive) {
      this.counters.txNoPeer++;
      return;
    }
    this.net.sendPacket(frame, dest);
    this.counters.txPackets++;
    this.counters.txBytes += frame.length;
  }

  private pace(frame: Buffer, dest: number): void {
    if (!this.sessionLive) {
      this.counters.txNoPeer++;
      return;
    }
    this.pacer.push(frame, dest);
  }

  private toDevice(frame: Buffer): void {
    if (!this.deviceReady) return;
    this.device.writeFrame(frame);
  }

  private nick(clientId: number): string {
    return this.net.playingPeers.get(clientId)?.nick ?? `client ${clientId}`;
  }

  /**
   * The room a device id names, as shown to the device: one id per player on a GB-Link (the
   * player's latest real id goes on), else the players' own ids.
   */
  private roomOf(devid: number): { clientId: number; devid: number } | null {
    const oneIdEach = this.device.kind === 'gblink';
    for (const [clientId, room] of this.rooms) {
      if (oneIdEach && room.shown === devid) return { clientId, devid: room.several ? devid : room.devid };
    }
    for (const [clientId, room] of this.rooms) {
      if ((!oneIdEach || room.several) && room.seen.has(devid)) return { clientId, devid };
    }
    return null;
  }

  /** A player's first id, unless another player is shown it already. */
  private unshownId(devid: number): number {
    const taken = new Set([...this.rooms.values()].map((room) => room.shown));
    let id = devid;
    while (id === 0 || taken.has(id)) id = (id + 0x0101) & 0xffff;
    return id;
  }

  private linkPartners(): number[] {
    const ids = new Set<number>();
    if (this.clientLink && this.clientLink.seat !== 0) ids.add(this.clientLink.hostClientId);
    for (const child of this.childLinks.values()) ids.add(child.clientId);
    return [...ids];
  }

  /** Frames still paced to a client a link ended with are no use to it. */
  private endClientLink(link: ClientLink): void {
    if (this.clientLink === link) this.clientLink = null;
    this.pacer.drop(link.hostClientId);
  }

  private endChild(slot: number, child: ChildLink): void {
    this.childLinks.delete(slot);
    this.pacer.drop(child.clientId);
  }

  private leaveHost(link: ClientLink, why: string): void {
    this.endClientLink(link);
    if (link.seat !== 0) {
      this.send(rfu1Command(RfuType.Disconnect, link.seat), link.hostClientId);
      this.emit('room', null);
    }
    this.emit('log', `left ${this.nick(link.hostClientId)}'s room: ${why}`);
  }

  private dropChild(slot: number, child: ChildLink, why: string): void {
    this.endChild(slot, child);
    this.toDevice(rfu1Command(RfuType.Disconnect, (child.devid | (slot << 16)) >>> 0));
    this.emit('log', `${this.nick(child.clientId)} left the device's room: ${why}`);
  }

  private forgetPeer(clientId: number): void {
    this.rooms.delete(clientId);
    if (this.offered?.clientId === clientId) this.offered = null;
    this.pendingRequests.splice(0, this.pendingRequests.length, ...this.pendingRequests.filter((r) => r.clientId !== clientId));
    const link = this.clientLink;
    if (link && link.hostClientId === clientId) {
      this.endClientLink(link);
      if (link.seat !== 0) this.toDevice(rfu1Command(RfuType.Disconnect, link.seat));
      else this.toDevice(rfu1Command(RfuType.ConnectNack, 0));
      this.emit('room', null);
    }
    for (const [slot, child] of this.childLinks) {
      if (child.clientId === clientId) this.dropChild(slot, child, 'they left the session');
    }
  }

  /** Every room link ends on both sides. */
  private leaveEverything(reason: string): void {
    const link = this.clientLink;
    const hadLinks = link !== null || this.childLinks.size > 0;
    if (link) {
      if (link.seat !== 0) {
        this.send(rfu1Command(RfuType.Disconnect, link.seat), link.hostClientId);
        this.toDevice(rfu1Command(RfuType.Disconnect, link.seat));
      } else {
        this.toDevice(rfu1Command(RfuType.ConnectNack, 0));
      }
    }
    for (const [slot, child] of this.childLinks) {
      const header = (child.devid | (slot << 16)) >>> 0;
      this.send(rfu1Command(RfuType.Disconnect, header), child.clientId);
      this.toDevice(rfu1Command(RfuType.Disconnect, header));
    }
    for (const req of this.pendingRequests) this.send(rfu1Command(RfuType.ConnectNack, 0), req.clientId);
    this.resetLinks();
    if (hadLinks) {
      this.emit('log', `room links dropped: ${reason}`);
      this.emit('room', null);
    }
  }

  private resetLinks(): void {
    this.rooms.clear();
    this.clientLink = null;
    this.childLinks.clear();
    this.pacer.stop();
    this.pendingRequests.length = 0;
    this.boardSeat = null;
    this.boardSeatNoted = false;
    this.orphanSince = 0;
    this.offered = null;
    Object.assign(this.burst, { start: 0, index: 0, size: 1, turn: 0 });
    this.severalGroupsNoted = false;
    this.lastOwnBroadcastAt = 0;
  }

  /** Rooms, joins and members that went quiet, timed like gpsp's. */
  private expire(): void {
    const now = this.now();
    for (const [clientId, room] of this.rooms) if (now - room.at > BROADCAST_TTL_MS) this.rooms.delete(clientId);
    if (this.offered && now - this.offered.at >= OFFER_TTL_MS) this.offered = null;
    this.prunePending();
    for (const [slot, child] of this.childLinks) {
      if (now - child.heardAt >= MEMBER_TIMEOUT_MS) this.dropChild(slot, child, 'silent for 4 s');
    }
    const link = this.clientLink;
    if (link && link.seat === 0 && now - link.at >= CONNECT_PENDING_MS) {
      this.endClientLink(link);
      this.toDevice(rfu1Command(RfuType.ConnectNack, 0));
      this.emit('log', `${this.nick(link.hostClientId)} never answered the device's join`);
    } else if (link && link.seat !== 0 && now - link.heardAt >= MEMBER_TIMEOUT_MS) {
      this.endClientLink(link);
      this.send(rfu1Command(RfuType.Disconnect, link.seat), link.hostClientId);
      this.toDevice(rfu1Command(RfuType.Disconnect, link.seat));
      this.emit('room', null);
      this.emit('log', `the device went quiet in ${this.nick(link.hostClientId)}'s room: left it`);
    }
    this.updatePhase();
  }

  private prunePending(): void {
    const now = this.now();
    while (this.pendingRequests.length > 0 && now - this.pendingRequests[0]!.at >= CONNECT_PENDING_MS) {
      const stale = this.pendingRequests.shift()!;
      this.send(rfu1Command(RfuType.ConnectNack, 0), stale.clientId);
      this.emit('log', `the device never answered ${this.nick(stale.clientId)}'s join`);
    }
  }

  private logReject(msg: string): void {
    if (this.rejectsLogged >= REJECT_LOG_MAX) return;
    this.rejectsLogged++;
    this.emit('log', msg);
  }

  private updatePhase(): void {
    if (this.stopped) return;
    let phase: LinkPhase;
    if (!this.deviceReady) phase = 'idle';
    else if (this.joinedHost !== null || this.childLinks.size > 0) phase = 'connected';
    else if (this.clientLink) phase = 'handshake';
    else if (this.hosting) phase = 'room-open';
    else phase = 'searching';
    this.setPhase(phase);
  }

  private setPhase(phase: LinkPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('link-phase', phase);
  }
}

function hex16(v: number): string {
  return (v & 0xffff).toString(16).padStart(4, '0');
}

/** A Gen 3 trade or battle group still open to joiners: what the Switch can join through a board. */
function joinableBySwitch(frame: Rfu1Frame): boolean {
  if (((frame.header >>> 16) & 0xff) === RFU1_NO_FREE_SLOT) return false;
  const data = parseGameData(rfu1GameData(frame.raw));
  return data.serial === GEN3_SERIAL && !data.started && SWITCH_ACTIVITIES.has(data.activity);
}
