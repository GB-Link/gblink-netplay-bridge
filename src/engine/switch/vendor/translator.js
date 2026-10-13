// Ruby/Sapphire cable link <-> FireRed/LeafGreen wireless link. The cable side plays player 0
// (the master) to a game that only knows the cable; the wireless side joins the Switch's trade
// room as an FRLG child. Each side sees a partner of its own kind.
//
// Cable side: gameCommand() takes each command the game sends (eight words), nextCommand()
// gives the next one for it, cableReset() marks a fresh cable link.
// Wireless side: boardFrame() takes RFU1 frames from the board; frame() runs once per GBA frame.

const RFUCMD = {
    MASK: 0xff00, READY_CLOSE_LINK: 0x5f00, READY_EXIT_STANDBY: 0x6600, SEND_PLAYER_IDS: 0x7700,
    SEND_BLOCK_INIT: 0x8800, SEND_BLOCK: 0x8900, SEND_BLOCK_REQ: 0xa100, SEND_HELD_KEYS: 0xbe00, DISCONNECT: 0xed00,
};

export const LINKCMD = {
    SEND_LINK_TYPE: 0x2222, READY_EXIT_STANDBY: 0x2ffe, READY_CLOSE_LINK: 0x5fff, CONT_BLOCK: 0x8888,
    INIT_BLOCK: 0xbbbb, SEND_HELD_KEYS: 0xcafe, SEND_BLOCK_REQ: 0xcccc,
};

const LCOM = { NULL: 0, NI_START: 1, NI: 2, NI_END: 3, UNI: 4 };

const RFU1 = { BROADCAST: 0, CONNECT_ACK: 2, DISCONNECT: 4, HOST_SEND: 5 };

const SLOT_BYTES = 14;
const FRAG_BYTES = 12;
const HOST_FRAME_BYTES = 3 + 5 * SLOT_BYTES;
const MAX_FRAGS = 24;
const MAX_BLOCK_BYTES = MAX_FRAGS * FRAG_BYTES;
export const CMD_WORDS = 8;

const LINK_PLAYER_BLOCK_SIZE = 60;
const LP_VERSION_OFFSET = 16;
const LP_TRAINER_ID_OFFSET = 16 + 4;
const LP_NAME_OFFSET = 16 + 8;
const LP_PROGRESS_OFFSET = 16 + 0x10;   // FRLG: progressFlags, neverRead, progressFlagsCopy
const PROGRESS_CLEARED = 0x11;          // National Dex (0x0F) and a cleared game (0xF0)
// Emerald: its player is Champion. FireRed/LeafGreen: the Sevii Islands story is done.
const PROGRESS_LINK_HOENN = 0x10;
const VERSION_EMERALD = 3;
// RfuGameData compatibility: can link nationally (bit 7), National Dex, game clear, version.
const COMPAT_CAN_LINK_NATIONALLY = 1 << 7;
const LP_LINK_TYPE_OFFSET = 16 + 0x14;
const LP_BUFFER_SIZE = 200;
const CARD_SIZE = 100;
const CARD_VERSION_OFFSET = 0x38;

const OWNER_FLAG = 0x80;
const CABLE_QUEUE = 96;
const CHILD_QUEUE = 8;
const HELD_BLOCKS = 8;
const ANNOUNCE_PACKETS = 30;
// After the LinkPlayer exchange the game still has to leave its link setup. A block that
// arrives earlier is wiped by its ResetBlockReceivedFlags and the game stays one exchange behind.
const SESSION_SETTLE_PACKETS = 150;
const BARRIER_EMITS = 6;
const INITIATE_TIMEOUT = 600;
const IDLE_TIMEOUT = 90;
const HOST_SILENT_FRAMES = 600;
// The Switch reports held keys once per frame, the cable carries one per packet (about 40 a
// second), so each packet stands for the Switch frames that passed meanwhile. Measured over
// this many packets; the backlog is held under HOST_KEY_LAG frames.
const KEY_RATE_WINDOW = 40;
const HOST_KEY_LAG = 12;

const AIR = { SEARCH: 0, CONNECTING: 1, NI: 2, UNI: 3 };
// Union-room activities, from the link type the game opens its Cable Club link with.
const ACTIVITY = { TRADE: 4, BATTLE_SINGLE: 1, BATTLE_DOUBLE: 2 };
const LINKTYPE = { SINGLE_BATTLE: 0x2233, DOUBLE_BATTLE: 0x2244, BATTLE: 0x2211, TRADE_SETUP: 0x1133 };
// holdJoin: the cable packets the other GBA's LinkPlayer has before the Switch's goes first.
// Another page sends its own only once it has this one; a GBA sends at once.
const LP_EARLY_PACKETS = 20;
const LP_ID_OFFSET = 16 + 0x18;
const LINK_PLAYER_SIZE = 28;         // struct LinkPlayer, as the Switch sends it at a battle's start
// Colosseum: in the room, the game closing its link for the battle, in the battle, and the
// game closing it again after the battle.
const BATTLE = { ROOM: 0, STARTING: 1, FIGHTING: 2, RETURNING: 3 };
const EXPECT = { NONE: 0, LINK_PLAYER: 1, PULL: 2, CARD: 3 };
const BAR = { IDLE: 0, STANDBY: 1, CLOSE: 2 };
const PURPOSE = { NONE: 0, ROUND0: 1, GAME_STANDBY: 2, GAME_CLOSE: 3, EXIT_CLOSE: 4, BATTLE: 5 };
const SEND = { INIT: 0, STREAM: 1, HOLD: 2, DONE: 3 };

const KEY_EMPTY = 0x11;
const KEY_EXIT_ROOM = 0x17;
const KEY_QUEUE = 48;

const le16 = (b, at) => b[at] | (b[at + 1] << 8);
const put16 = (b, at, v) => { b[at] = v & 0xff; b[at + 1] = (v >> 8) & 0xff; };
const MAGIC = Array.from('GameFreak inc.', (c) => c.charCodeAt(0));

function fragCount(bytes) { return Math.max(1, Math.ceil(bytes / FRAG_BYTES)); }

// Block sizes by fragment count; the counts the cable club and trade menu use are unique.
export function sizeFromCount(count) {
    switch (count) {
        case 17: return 200;
        case 9: return 100;
        case 19: return 220;
        case 4: return 40;
        case 2: return 20;
    }
    return count * FRAG_BYTES;
}

export function sizeFromRequest(type) {
    switch (type) {
        case 2: return 100;
        case 3: return 220;
        case 4: return 40;
    }
    return 200;
}

// The Switch's key reports as runs of one code, played back by time: each cable packet takes
// `step` frames' worth. Every run is played at least once, so a single-frame press is never lost.
export class KeyRuns {
    constructor() { this.runs = []; }
    push(code) {
        const last = this.runs.at(-1);
        if (last && last.code === code) last.count++;
        else this.runs.push({ code, count: 1 });
        if (this.runs.length > KEY_QUEUE) this.runs.shift();
    }
    get frames() { return this.runs.reduce((sum, run) => sum + run.count, 0); }
    pop(step) {
        const head = this.runs[0];
        if (!head) return KEY_EMPTY;
        const backlog = this.frames;
        if (backlog > HOST_KEY_LAG) step += (backlog - HOST_KEY_LAG) / 4;
        head.count -= step;
        if (head.count <= 0) {
            this.runs.shift();
            // The overshoot shortens the next run, which still plays at least once.
            if (this.runs.length) this.runs[0].count = Math.max(this.runs[0].count + head.count, 0.01);
        }
        return head.code;
    }
    clear() { this.runs = []; }
}

export class KeyQueue {
    constructor() { this.codes = []; }
    push(code) {
        if (this.codes.length >= KEY_QUEUE) this.codes.shift();
        this.codes.push(code);
    }
    pop() { return this.codes.length ? this.codes.shift() : KEY_EMPTY; }
    get count() { return this.codes.length; }
    clear() { this.codes = []; }
}

const REPAIR_QUIET_FRAMES = 30;
const REPAIRS = 3;
const REQUEST_FRAGMENTS = [17, 17, 9, 19, 4];
// Frames a repair's repeat may still come after the block came whole.
const REPEAT_FRAMES = 120;
// A request's type by its block's fragments (17 is the LinkPlayer's or a party part's,
// told apart by the pull), and the frames between a request and the leader's own block.
const REQUEST_TYPES = { 17: 1, 9: 2, 19: 3, 4: 4 };
const PULL_WITH_BLOCK_FRAMES = 8;
const repairType = (count) => [4, 2, 1, 3].find((type) => REQUEST_FRAGMENTS[type] >= count) ?? null;

function newRecv() {
    return { count: 0, flags: 0, receiving: false, done: false, lastIndex: -1, buf: new Uint8Array(MAX_BLOCK_BYTES), heardAt: 0, repairs: 0, need: 0 };
}

function recvInit(r, count) {
    if (count === 0 || count > MAX_FRAGS) return;
    // The repeat a repair asked for keeps the fragments already here.
    if (r.receiving && !r.done && r.repairs && count === REQUEST_FRAGMENTS[repairType(r.need)]) { r.count = count; return; }
    // A repeated INIT of the block being received keeps its fragments; the game repeats one
    // only before the fragments, so an INIT after some is the next block, of the same size.
    if (!r.receiving || r.done || count !== r.count || r.flags) {
        Object.assign(r, newRecv());
        r.count = count;
        r.receiving = true;
    }
}

function recvBlock(r, index, slot) {
    if (!r.receiving || index >= r.count) return false;
    const need = r.need || r.count;
    if (r.repairs && index >= need) return false;
    // A repeat that differs from a fragment already here is another block: start it over.
    if (r.repairs && r.flags & (1 << index) && slot.subarray(2, 2 + FRAG_BYTES).some((b, i) => b !== r.buf[index * FRAG_BYTES + i])) r.flags = 0;
    const wasDone = r.done;
    r.lastIndex = index;
    r.flags = (r.flags | (1 << index)) >>> 0;
    r.buf.set(slot.subarray(2, 2 + FRAG_BYTES), index * FRAG_BYTES);
    if (r.flags === ((1 << need) - 1) >>> 0) r.done = true;
    return r.done && !wasDone;
}

// True when the fragment completed the block.
function feedRecv(r, words, slot) {
    const op = words[0] & RFUCMD.MASK;
    if (op === RFUCMD.SEND_BLOCK_INIT) recvInit(r, words[1]);
    else if (op === RFUCMD.SEND_BLOCK) return recvBlock(r, words[0] & 0x1f, slot);
    return false;
}

function newSend() {
    return { active: false, state: SEND.INIT, count: 0, index: 0, initSends: 0, holdSends: 0, rr: 0, data: new Uint8Array(MAX_BLOCK_BYTES), isLinkPlayer: false, isCard: false };
}

function sendStart(s, data, size, isLinkPlayer) {
    Object.assign(s, newSend());
    s.active = true;
    s.count = fragCount(size);
    s.data.set(data.subarray(0, size));
    s.isLinkPlayer = isLinkPlayer;
}

function blockWords(s, index, words) {
    words[0] = RFUCMD.SEND_BLOCK | (index & 0x1f);
    for (let i = 0; i < 6; i++) words[1 + i] = le16(s.data, index * FRAG_BYTES + i * 2);
}

// One frame of the child's block sender, paced by the leader's reflection of our fragments.
// `hold` keeps the last fragment back: the leader moves on once it has our block.
function sendTick(s, ack, words, hold = false) {
    words.fill(0);
    if (!s.active) return;
    if (s.state === SEND.INIT) {
        s.initSends++;
        // INIT repeats until the reflection shows the leader armed its receive side.
        if (ack.receiving && ack.count === s.count) {
            s.state = SEND.STREAM;
            s.index = 0;
        } else {
            words[0] = RFUCMD.SEND_BLOCK_INIT;
            words[1] = s.count;
            words[2] = 1 | OWNER_FLAG;
            return;
        }
    }
    if (s.state === SEND.STREAM) {
        const index = s.index;
        if (hold && index >= s.count - 1) return;
        blockWords(s, index, words);
        if (index >= s.count - 1) { s.state = SEND.HOLD; s.holdSends = 0; }
        else s.index++;
        return;
    }
    if (s.state === SEND.HOLD) {
        s.holdSends++;
        const last = s.count - 1;
        const full = ((1 << s.count) - 1) >>> 0;
        if (ack.lastIndex === last && ack.count === s.count) {
            if (ack.flags === full) { s.state = SEND.DONE; s.active = false; return; }
            const missing = [];
            for (let i = 0; i < s.count; i++) if (!((ack.flags >>> i) & 1)) missing.push(i);
            if (missing.length) {
                s.rr = (s.rr + 1) % missing.length;
                blockWords(s, missing[s.rr], words);
                return;
            }
        }
        blockWords(s, last, words);
    }
}

function newBarrier() {
    return { mode: BAR.IDLE, initiated: false, hostCount: -1, localCount: 0, sinceHost: 0, sinceInitiate: 0, burstFor: -1, burstN: 0, rounds: 0 };
}

function barrierInitiate(b, kind) {
    if (b.mode === kind) return;
    b.mode = kind;
    b.initiated = true;
    b.hostCount = -1;
    b.sinceHost = 0;
    b.sinceInitiate = 0;
    b.burstFor = -1;
}

function barrierWant(b, words) {
    if (b.mode === BAR.IDLE) return false;
    if (b.burstFor !== b.localCount) { b.burstFor = b.localCount; b.burstN = 0; }
    if (b.burstN >= BARRIER_EMITS) return false;
    b.burstN++;
    words.fill(0);
    words[0] = b.mode === BAR.STANDBY ? RFUCMD.READY_EXIT_STANDBY : RFUCMD.READY_CLOSE_LINK;
    words[1] = b.localCount;
    return true;
}

function childLLSF(state, n, phase, ack, size) {
    return ((state & 0xf) << 10) | ((ack & 1) << 9) | ((n & 3) << 7) | ((phase & 3) << 5) | (size & 0x1f);
}

function newNI(src) {
    // NI_START header: data type 1 (game data), payload size 12, data size 26.
    const header = new Uint8Array(7);
    header[0] = 1;
    put16(header, 1, 12);
    header[3] = 26;
    return { state: 0, phase: 0, n: [0, 0, 0, 0], now: [0, 0, 0, 0], remain: 7, src: src ?? new Uint8Array(26), header };
}

const cloneNI = (ni) => ({ ...ni, n: [...ni.n], now: [...ni.now] });

// One child NI sub-frame (single pass: the board's link neither loses nor reorders frames).
// Null once the transfer is finished.
function niNext(ni) {
    const payload = 12;
    if (ni.state === 0) {
        const size = Math.min(ni.remain, payload);
        const out = new Uint8Array(2 + size);
        put16(out, 0, childLLSF(LCOM.NI_START, 1, 0, 0, size));
        out.set(ni.header.subarray(0, size), 2);
        ni.state = 1;
        ni.phase = 0;
        for (let i = 0; i < 4; i++) { ni.n[i] = 1; ni.now[i] = payload * i; }
        ni.remain = 26;
        return out;
    }
    if (ni.state === 1) {
        while (ni.now[ni.phase] >= 26) ni.phase = (ni.phase + 1) % 4;
        const off = ni.now[ni.phase];
        const size = Math.min(26 - off, payload);
        const out = new Uint8Array(2 + size);
        put16(out, 0, childLLSF(LCOM.NI, ni.n[ni.phase], ni.phase, 0, size));
        out.set(ni.src.subarray(off, off + size), 2);
        ni.remain -= size;
        ni.now[ni.phase] += payload << 2;
        ni.phase = (ni.phase + 1) % 4;
        if (ni.remain <= 0) { ni.state = 2; ni.phase = 0; }
        return out;
    }
    if (ni.state === 2) {
        const out = new Uint8Array(2);
        put16(out, 0, childLLSF(LCOM.NI_END, 0, 0, 0, 0));
        ni.state = 3;
        return out;
    }
    if (ni.state === 3) {
        const out = new Uint8Array(2);
        put16(out, 0, childLLSF(LCOM.NULL, 1, 0, 0, 0));
        ni.state = 4;
        return out;
    }
    return null;
}

const slotIdle = (slot) => slot.every((b) => b === 0);
// "CELIO" in the game's charset: the name joined with before the other player is known.
const PLACEHOLDER_NAME = [0xbd, 0xbf, 0xc6, 0xc3, 0xc9, 0xff];
const VERSION_FIRE_RED = 4;
const slotWords = (slot) => Array.from({ length: 7 }, (_, i) => le16(slot, i * 2));

export class CableTranslator {
    // send(payload): one child frame for the board (LLSF header and data).
    // connect(devid) / disconnect(): the board's join and leave.
    // holdJoin (over Celio): the Switch's group is found at once but joined only once the
    // cable opens (cableReset), as "CELIO", in whichever room the Switch opened; the other
    // player is known only after that.
    constructor({ send, connect, disconnect, log = () => {}, holdJoin = false }) {
        this.sendFrame = send;
        this.holdJoin = holdJoin;
        this.joinAllowed = !holdJoin;
        this.groupSeen = false;      // the Switch's group is open (holdJoin: this side is ready)
        this.roomsSeen = new Set();  // the rooms the board offers the Switch's room as
        this.severalRooms = false;
        this.lpPullWaiting = false;  // the leader pulled the other player's LinkPlayer before it came
        this.connectRoom = connect;
        this.disconnectRoom = disconnect;
        this.log = log;

        this.link = -1;
        this.hostId = 0;
        this.linkFrames = 0;
        this.silentFrames = 0;
        this.connectFrames = 0;

        this.bar = newBarrier();
        this.rx0 = newRecv();    // the leader's own blocks
        this.repairType = null;  // a block request to send for a block that stopped short
        this.repeatDue = null;   // { count, data, until }: the repeat of a repaired block, still to come
        this.pullAt = -Infinity; // host frame of the leader's last block request
        this.rx1 = newRecv();    // the leader's reflection of ours
        this.send = newSend();
        this.ni = newNI();
        this.childQueue = [];
        this.lastHostOp = 0;
        this.hostFrames = 0;
        this.childFrames = 0;
        this.tag = 0;
        this.keyCount = 0;

        this.haveRubyLP = false;
        this.haveHostLP = false;
        this.rubyLP = new Uint8Array(LINK_PLAYER_BLOCK_SIZE);
        this.hostLP = new Uint8Array(LINK_PLAYER_BLOCK_SIZE);
        this.lpSentToHost = false;
        this.lpSendDone = false;
        this.round0Started = false;
        this.keysActive = false;
        // Held-key codes are one-frame events, so they travel through queues.
        this.rubyKeys = new KeyQueue();   // game -> leader
        this.hostKeys = new KeyRuns();    // leader -> game
        this.keyStep = 1.5;               // Switch frames per cable packet
        this.keyPushes = 0;
        this.keyPops = 0;
        this.lastHostKeyCount = -1;
        this.purpose = PURPOSE.NONE;
        this.closeRoundsLeft = 0;
        this.closeCount = 0;       // closes asked for: the first leaves the room, later ones end the trade menu
        this.cancelPending = false;
        this.cancelClose = false;
        this.cancelReturn = false;
        this.cardArmed = false;
        this.cardAt = 0;
        this.cardRequested = false;
        this.haveRubyCard = false;
        this.cardQueued = false;
        this.cardPullWaiting = false;
        this.cardSendDone = false;
        this.pendingGameStandby = false;
        this.rubyCard = new Uint8Array(CARD_SIZE);
        this.exitKeySeen = false;
        this.hostClosedSeen = false;
        this.roomClosed = false;

        // What the leader sent while the game's cable link was not ready, held until it is.
        this.held = [];
        this.pendingPull = -1;

        this.cablePackets = 0;
        this.readyAt = 0;
        this.refusing = false;
        this.announced = false;
        this.expect = EXPECT.NONE;
        this.pullType = 0;
        this.sessionRubyLP = false;
        this.linkClosing = false;        // this side has closed the cable link: blocks wait
        this.p0LPDelivered = false;
        this.rxSize = 0;
        this.rxPos = 0;
        this.rxBuf = new Uint8Array(MAX_BLOCK_BYTES);
        this.cq = [];
        this.sessions = 0;

        this.hostNotReady = false;   // the Switch's trade group is not open to Ruby yet
        this.refusing = false;       // the game was told the link-up failed and is closing
        this.bypassNationally = false;   // join even if the Switch's game cannot link nationally
        this.activity = ACTIVITY.TRADE;  // the Switch group to join, from the game's choice
        this.battleState = BATTLE.ROOM;
        this.battleRound = false;        // a standby round for the Switch is due once our blocks are out
        this.onLinked = null;     // (linked) wireless link up or down, or hostNotReady changed
    }

    get linked() { return this.link === AIR.UNI; }
    // holdJoin: ready once the Switch's group is open; with a board that offers several, as
    // before (joined once the other player's room is known).
    get readyToLink() { return this.groupSeen || this.severalRooms; }
    // The cable game's version (Ruby 2, Sapphire 1, Emerald 3, FireRed 4, LeafGreen 5).
    get gameVersion() { return this.rubyLP[LP_VERSION_OFFSET]; }
    // Ruby and Sapphire have no wireless and are shown to the Switch as an Emerald; the
    // other games as themselves.
    get dressed() { return this.gameVersion === 1 || this.gameVersion === 2; }
    get battle() { return this.activity !== ACTIVITY.TRADE; }
    // Battle blocks are self-describing and padded to 4 bytes: pass whole fragments.
    get battleBlocks() { return this.battle && this.battleState !== BATTLE.ROOM; }
    get joined() { return this.link >= AIR.CONNECTING; }

    // ---- cable queue

    cablePush(cmd) {
        if (this.cq.length >= CABLE_QUEUE) { this.log(`cable queue full, command ${hex(cmd[0])} dropped`); return; }
        this.cq.push(cmd);
    }

    cablePushCmd(c0, c1, c2) {
        // Once this side has closed the link, blocks wait for the next one.
        if (c0 === LINKCMD.READY_CLOSE_LINK) this.linkClosing = true;
        this.cablePush([c0, c1, c2, 0, 0, 0, 0, 0]);
    }

    // A block for the game as player 0: INIT_BLOCK, then CONT_BLOCK chunks of seven words.
    cablePushBlock(data, size) {
        this.cablePushCmd(LINKCMD.INIT_BLOCK, size, 0 + 128);
        for (let pos = 0; pos < size; pos += (CMD_WORDS - 1) * 2) {
            const cmd = [LINKCMD.CONT_BLOCK, 0, 0, 0, 0, 0, 0, 0];
            for (let i = 0; i < CMD_WORDS - 1; i++) {
                const at = pos + i * 2;
                const lo = at < size ? data[at] : 0;
                const hi = at + 1 < size ? data[at + 1] : 0;
                cmd[1 + i] = lo | (hi << 8);
            }
            this.cablePush(cmd);
        }
    }

    // ---- translator

    childQueuePush(data, size, isLinkPlayer, isCard = false) {
        if (this.childQueue.length >= CHILD_QUEUE || size > MAX_BLOCK_BYTES) { this.log(`child block queue full, ${size} bytes dropped`); return; }
        const block = new Uint8Array(MAX_BLOCK_BYTES);
        block.set(data.subarray(0, size));
        this.childQueue.push({ data: block, size, isLinkPlayer, isCard });
    }

    // The game's LinkPlayer as an Emerald with link type 0, what a wireless link uses. FRLG
    // reads progress flags where Ruby's longer name field ends (Ruby fills those bytes with its
    // gender and trainer id): they claim the National Dex and a cleared game, so the Switch
    // lets any Pokémon go to Ruby, as it does for a real Ruby.
    buildLinkPlayerForHost() {
        const out = new Uint8Array(LP_BUFFER_SIZE);
        out.set(this.rubyLP);
        if (this.dressed) {
            put16(out, LP_VERSION_OFFSET, 0x4000 | VERSION_EMERALD);
            out[LP_PROGRESS_OFFSET] = PROGRESS_CLEARED;
            out[LP_PROGRESS_OFFSET + 1] = 0;
            out[LP_PROGRESS_OFFSET + 2] = PROGRESS_CLEARED;
        }
        out.fill(0, LP_LINK_TYPE_OFFSET, LP_LINK_TYPE_OFFSET + 4);
        return out;
    }

    // The leader's LinkPlayer with the game's own link type: the cable club accepts the
    // exchange only when every player reports the same one.
    // early: before the other GBA's, with the link type of the Switch's room and the first spot.
    deliverLinkPlayerToGame(early = false) {
        if (!this.haveHostLP || this.p0LPDelivered || (!this.sessionRubyLP && !early)) return;
        const block = this.hostLP.slice();
        if (early) {
            const type = this.activity === ACTIVITY.BATTLE_SINGLE ? LINKTYPE.SINGLE_BATTLE
                : this.activity === ACTIVITY.BATTLE_DOUBLE ? LINKTYPE.DOUBLE_BATTLE : LINKTYPE.TRADE_SETUP;
            put16(block, LP_LINK_TYPE_OFFSET, type);
            put16(block, LP_LINK_TYPE_OFFSET + 2, 0);
            if (this.battle) block[LP_ID_OFFSET] = 0;
            this.log('the Switch\'s LinkPlayer goes to the other GBA first');
        } else {
            block.set(this.rubyLP.subarray(LP_LINK_TYPE_OFFSET, LP_LINK_TYPE_OFFSET + 4), LP_LINK_TYPE_OFFSET);
        }
        // Emerald's cable club trades with a FireRed/LeafGreen player only when its own is
        // Champion and the other has finished the Sevii Islands story. With the bypass on, a
        // Champion's game gets the Switch player with that progress; any other gets the Switch
        // player as another Emerald, which it does not check (and draws as one).
        if (!early && this.bypassNationally && this.gameVersion === VERSION_EMERALD) {
            if (this.rubyLP[LP_PROGRESS_OFFSET] & PROGRESS_LINK_HOENN) {
                block[LP_PROGRESS_OFFSET] = PROGRESS_CLEARED;
                block[LP_PROGRESS_OFFSET + 2] = PROGRESS_CLEARED;
            } else {
                put16(block, LP_VERSION_OFFSET, 0x4000 | VERSION_EMERALD);
            }
        }
        // In the Colosseum the id is the spot each player stands on; there are two.
        if (this.battle && !early) block[LP_ID_OFFSET] = this.rubyLP[LP_ID_OFFSET] ^ 1;
        this.cablePushBlock(block, block.length);
        this.p0LPDelivered = true;
        this.readyAt = this.cablePackets + SESSION_SETTLE_PACKETS;
        if (!this.cardRequested && !this.roomClosed && this.closeCount === 0 && !this.cancelReturn) {
            this.cardArmed = true;
            this.cardAt = this.cablePackets + 15;
        }
        if (this.battleState === BATTLE.RETURNING) {
            // Back in the Colosseum after a battle: keys without a standby from the game; the
            // Switch has one of its own before its keys resume.
            this.battleState = BATTLE.ROOM;
            this.exitKeySeen = false;
            this.hostKeys.clear();
            this.keysActive = true;
            this.dueRound('back in the Colosseum');
            this.log('back in the Colosseum after the battle: keys resume');
        }
        if (this.cancelReturn) {
            // Back in the room after a cancelled trade: the game sends keys without a standby.
            this.cancelReturn = false;
            this.roomClosed = false;
            this.exitKeySeen = false;
            this.keysActive = true;
            this.log('room re-entered after the cancelled trade: keys resume');
        }
        this.log(`leader's LinkPlayer delivered to the game (link type ${hex(le16(block, LP_LINK_TYPE_OFFSET))})`);
    }

    maybeStartRound0() {
        if (this.round0Started || !this.lpSendDone || !this.p0LPDelivered) return;
        this.round0Started = true;
        this.purpose = PURPOSE.ROUND0;
        barrierInitiate(this.bar, BAR.STANDBY);
        this.log(`LinkPlayers exchanged both ways: standby round ${this.bar.localCount}`);
    }

    // Blocks for the game wait while its link is between sessions: from a battle's start until
    // the battle's link is up, and from its end until the room's is.
    sessionReady() {
        if (this.battle && (this.battleState === BATTLE.STARTING || this.battleState === BATTLE.RETURNING)) return false;
        return !this.linkClosing && this.sessionRubyLP && this.p0LPDelivered && this.cablePackets >= this.readyAt;
    }

    requestFromGame(type) {
        this.expect = EXPECT.PULL;
        this.pullType = type;
        this.cablePushCmd(LINKCMD.SEND_BLOCK_REQ, type, 0);
    }

    releaseHeld() {
        if (!this.sessionReady()) return;
        if (this.pendingPull >= 0 && this.expect !== EXPECT.PULL) {
            this.log(`cable link ready: forwarding the leader's pull of type ${this.pendingPull}`);
            this.requestFromGame(this.pendingPull);
            this.pendingPull = -1;
        }
        for (const h of this.held) {
            this.log(`cable link ready: delivering a held block of ${h.size} bytes`);
            this.cablePushBlock(h.data, h.size);
        }
        this.held = [];
    }

    // The game's card is asked for right after the LinkPlayers, ready for the leader's pull.
    // The game leaves its "awaiting link-up" screen once the leader's own card follows, which
    // the leader sends only after walking into its room.
    requestEarlyCard() {
        if (this.expect !== EXPECT.NONE) {
            this.cardArmed = true;
            this.cardAt = this.cablePackets + 10;
            return;
        }
        this.cardRequested = true;
        this.expect = EXPECT.CARD;
        this.cablePushCmd(LINKCMD.SEND_BLOCK_REQ, 2, 0);
        this.log('the game\'s trainer card asked for; the leader\'s goes to it when it arrives');
    }

    queueCard() {
        this.childQueuePush(this.rubyCard, CARD_SIZE, false, true);
        this.cardQueued = true;
    }

    // The leader pulled a block. The first pull is the LinkPlayer, already held; any other is
    // forwarded to the game as the cable's request for that block type.
    hostPull(type) {
        this.pullAt = this.hostFrames;
        this.log(`leader pulls block type ${type}`);
        if (type === 2 && this.cardRequested) {
            if (this.cardQueued) return;
            if (this.haveRubyCard) this.queueCard();
            else this.cardPullWaiting = true;
            return;
        }
        if (!this.lpSentToHost && type <= 1) {
            if (!this.haveRubyLP) {
                if (!this.lpPullWaiting) this.log('the other GBA\'s LinkPlayer goes to the leader when it arrives');
                this.lpPullWaiting = true;
                return;
            }
            this.childQueuePush(this.buildLinkPlayerForHost(), LP_BUFFER_SIZE, true);
            this.lpSentToHost = true;
            return;
        }
        if (this.expect === EXPECT.PULL || this.pendingPull >= 0) return;
        // The Switch repeats a pull until its block arrives: one answered but not yet streamed
        // is a repeat.
        if (this.childQueue.length || (this.send.active && this.send.state !== SEND.HOLD)) return;
        if (!this.sessionReady()) {
            this.pendingPull = type;
            this.log(`cable link not ready: pull of type ${type} held`);
            return;
        }
        this.requestFromGame(type);
    }

    // A block the leader finished sending.
    hostBlock(count, data) {
        if (this.battle && count === fragCount(LINK_PLAYER_SIZE) && data[1] === 0x40 && data[0] >= 1 && data[0] <= 5) {
            this.hostBattleLinkPlayer(data);
            return;
        }
        const size = this.battleBlocks ? count * FRAG_BYTES : sizeFromCount(count);
        if (count === 17 && !this.haveHostLP && MAGIC.every((c, i) => data[i] === c)) {
            this.hostLP.set(data.subarray(0, LINK_PLAYER_BLOCK_SIZE));
            this.haveHostLP = true;
            this.log(`leader's LinkPlayer received (version ${hex(le16(data, LP_VERSION_OFFSET))})`);
            this.deliverLinkPlayerToGame();
            this.maybeStartRound0();
            return;
        }
        if (this.battleBlocks) {
            this.log(`leader's battle block of ${size} bytes received`);
        } else if (count === 9) {
            // Trainer card: the first 0x38 bytes are the same in every Gen 3 game.
            this.log('leader\'s trainer card received');
        } else if (count === 2) {
            const command = le16(data, 0);
            this.log(`leader's trade-menu block ${hex(command)} received`);
            if (command === 0xeebb) this.cancelPending = true;
        } else {
            this.log(`leader's block of ${size} bytes received`);
        }
        if (!this.sessionReady()) {
            if (this.held.length < HELD_BLOCKS && size <= MAX_BLOCK_BYTES) {
                this.held.push({ data: data.slice(0, size), size });
                this.log(`cable link not ready: block of ${size} bytes held`);
            }
            return;
        }
        this.cablePushBlock(data, size);
    }

    // A block the game finished sending on the cable.
    gameBlock(size, data) {
        if (this.expect === EXPECT.LINK_PLAYER && size >= LINK_PLAYER_BLOCK_SIZE) {
            const first = !this.haveRubyLP;
            this.rubyLP.set(data.subarray(0, LINK_PLAYER_BLOCK_SIZE));
            this.haveRubyLP = true;
            const type = le16(data, LP_LINK_TYPE_OFFSET);
            const chosen = type === LINKTYPE.SINGLE_BATTLE ? ACTIVITY.BATTLE_SINGLE
                : type === LINKTYPE.DOUBLE_BATTLE ? ACTIVITY.BATTLE_DOUBLE : ACTIVITY.TRADE;
            if (!this.joined) {
                this.hostNotReady = false;   // decided again from the room's next beacon
                this.activity = chosen;
                this.battleState = BATTLE.ROOM;
            } else if (this.holdJoin && first) {
                // Joined first: the room is the Switch's, the other player's choice should match.
                this.battleState = BATTLE.ROOM;
                if (chosen !== this.activity) this.log(`the other GBA chose link type ${hex(type)} for another room than the Switch's`);
            }
            if (this.battleState === BATTLE.STARTING && le16(data, LP_LINK_TYPE_OFFSET) === LINKTYPE.BATTLE) {
                this.battleState = BATTLE.FIGHTING;
                this.log('the game opened its link for the battle');
            }
            this.sessionRubyLP = true;
            this.expect = EXPECT.NONE;
            this.log(`game's LinkPlayer received (version ${hex(le16(data, LP_VERSION_OFFSET))}, link type ${hex(le16(data, LP_LINK_TYPE_OFFSET))})`);
            this.deliverLinkPlayerToGame();
            if (this.lpPullWaiting && !this.lpSentToHost && this.joined) {
                this.lpPullWaiting = false;
                this.childQueuePush(this.buildLinkPlayerForHost(), LP_BUFFER_SIZE, true);
                this.lpSentToHost = true;
            }
            this.maybeStartRound0();
            return;
        }
        if (this.expect === EXPECT.CARD && size >= CARD_SIZE) {
            this.rubyCard.fill(0);
            if (this.dressed) {
                this.rubyCard.set(data.subarray(0, CARD_VERSION_OFFSET));
                this.rubyCard[CARD_VERSION_OFFSET] = VERSION_EMERALD;
            } else {
                this.rubyCard.set(data.subarray(0, CARD_SIZE));
            }
            this.haveRubyCard = true;
            this.expect = EXPECT.NONE;
            this.log('game\'s trainer card received');
            if (this.cardPullWaiting) { this.cardPullWaiting = false; this.queueCard(); }
            return;
        }
        const block = new Uint8Array(MAX_BLOCK_BYTES);
        let use = size;
        let card = false;
        if (this.expect === EXPECT.PULL) {
            card = this.pullType === 2;
            use = sizeFromRequest(this.pullType);
            this.expect = EXPECT.NONE;
            this.log(`game answered pull ${this.pullType} with ${size} bytes`);
        }
        block.set(data.subarray(0, Math.min(size, MAX_BLOCK_BYTES)));
        if (card && this.dressed) {
            // Ruby's card is the 0x38-byte RSE layout; the fields after it stay empty.
            block.fill(0, CARD_VERSION_OFFSET);
            block[CARD_VERSION_OFFSET] = VERSION_EMERALD;
        }
        this.childQueuePush(block, use, false);
    }

    gameStandby() {
        if (this.cancelReturn) {
            // The game's standby on returning to the room; the leader's round was part of the exit.
            this.cancelReturn = false;
            this.roomClosed = false;
            this.exitKeySeen = false;
            this.keysActive = true;
            this.log('game standby on re-entering the room: answered here, keys resume');
            this.cablePushCmd(LINKCMD.READY_EXIT_STANDBY, 0, 0);
            return;
        }
        if (this.cardRequested && !this.cardSendDone && !this.roomClosed) {
            // A standby and a block never share the wire: wait until the leader has our card.
            this.pendingGameStandby = true;
            this.log('game standby is early: waiting for the leader\'s card pull');
            return;
        }
        this.log(`game standby -> wireless standby round ${this.bar.localCount}`);
        this.purpose = PURPOSE.GAME_STANDBY;
        barrierInitiate(this.bar, BAR.STANDBY);
    }

    flushPendingStandby() {
        if (this.pendingGameStandby && this.cardSendDone && this.bar.mode === BAR.IDLE) {
            this.pendingGameStandby = false;
            this.gameStandby();
        }
    }

    // The Switch's game cannot link with Ruby yet. Ruby has no message for that; a LinkPlayer
    // with another link type makes it say "The link partners appear to have made different
    // selections." and close the link.
    refuse() {
        const block = this.rubyLP.slice();
        put16(block, LP_LINK_TYPE_OFFSET, le16(this.rubyLP, LP_LINK_TYPE_OFFSET) ^ 0xffff);
        block[16 + 0x18] = 0;
        this.cablePushBlock(block, block.length);
        this.p0LPDelivered = true;
        this.refusing = true;
        this.haveRubyLP = false;
        this.log('the Switch\'s game cannot link with Ruby or Sapphire yet: ending the game\'s link-up');
    }

    gameClose() {
        if (this.refusing) {
            this.refusing = false;
            this.cablePushCmd(LINKCMD.READY_CLOSE_LINK, 0, 0);
            return;
        }
        if (this.battle && !(this.exitKeySeen && this.battleState === BATTLE.ROOM)) {
            this.battleClose();
            return;
        }
        if (this.exitKeySeen && !this.cancelPending && !this.roomClosed) {
            // Leaving the room: the leader closes rather than standing by.
            this.log('game close after EXIT_ROOM: closing the wireless link');
            this.keysActive = false;
            this.purpose = PURPOSE.EXIT_CLOSE;
            if (this.hostClosedSeen) this.exitClosePassed();
            else barrierInitiate(this.bar, BAR.CLOSE);
            return;
        }
        this.log(`game close #${this.closeCount + 1}: wireless standby rounds, then the cable link is answered`);
        this.keysActive = false;
        this.roomClosed = true;
        this.purpose = PURPOSE.GAME_CLOSE;
        this.cancelClose = this.cancelPending;
        this.cancelPending = false;
        // The leader's standby rounds around the game's closes alternate: leaving the room two,
        // ending the trade menu for the trade scene one, ending the trade two, and so on.
        this.closeRoundsLeft = this.closeCount % 2 === 0 ? 2 : 1;
        if (this.cancelClose) {
            // Cancelling the trade: exit standby, back to the room, another standby before keys.
            this.closeRoundsLeft = 2;
            this.closeCount = 0;
        } else {
            this.closeCount++;
        }
        barrierInitiate(this.bar, BAR.STANDBY);
    }

    // The Colosseum. Ruby closes its cable link to start a battle and again after it, and opens
    // a new one each time. The Switch keeps its wireless link: at the start it exchanges
    // LinkPlayers as blocks and runs a standby round, after the battle it runs one standby
    // round, and another once back in the room. Over wireless the child speaks first in a
    // standby round, so those rounds are started here.
    battleClose() {
        this.cablePushCmd(LINKCMD.READY_CLOSE_LINK, 0, 0);
        this.keysActive = false;
        if (this.battleState === BATTLE.ROOM || this.battleState === BATTLE.STARTING) {
            this.battleState = BATTLE.STARTING;
            this.log('the game closed its link to start the battle');
        } else {
            this.battleState = BATTLE.RETURNING;
            this.dueRound('the battle ended');
            this.log('the game closed its link after the battle');
        }
    }

    // A standby round for the Switch, started once our queued blocks are out: a round and a
    // block never share the link.
    dueRound(why) {
        this.battleRound = true;
        this.battleRoundWhy = why;
    }

    startDueRound() {
        if (!this.battleRound || this.bar.mode !== BAR.IDLE || this.send.active || this.childQueue.length) return;
        this.battleRound = false;
        this.purpose = PURPOSE.BATTLE;
        barrierInitiate(this.bar, BAR.STANDBY);
        this.log(`standby round ${this.bar.localCount} for the Switch: ${this.battleRoundWhy}`);
    }

    // The Switch's LinkPlayer at a battle's start: answered with the game's, as an Emerald on
    // the other spot. A standby round follows once it is out.
    hostBattleLinkPlayer(data) {
        const out = new Uint8Array(LINK_PLAYER_SIZE);
        out.set(this.rubyLP.subarray(16, 16 + LINK_PLAYER_SIZE));
        if (this.dressed) {
            put16(out, 0, 0x4000 | VERSION_EMERALD);
            out[0x10] = PROGRESS_CLEARED;
            out[0x11] = 0;
            out[0x12] = PROGRESS_CLEARED;
        }
        put16(out, 0x14, LINKTYPE.BATTLE);
        out[0x16] = 0; out[0x17] = 0;
        out[0x18] = data[0x18] ^ 1;
        out[0x19] = 0;
        this.childQueuePush(out, LINK_PLAYER_SIZE, false);
        this.childQueue.at(-1).isBattleLP = true;
        if (this.battleState === BATTLE.ROOM) this.battleState = BATTLE.STARTING;
        this.keysActive = false;
        this.log(`the Switch started the battle from spot ${data[0x18]}`);
    }

    exitClosePassed() {
        this.log('room exit complete: answering the game, ending the wireless link');
        this.cablePushCmd(LINKCMD.READY_CLOSE_LINK, 0, 0);
        this.disconnectRoom();
        this.resetLink();
        this.setLink(-1);
        this.haveRubyLP = false;   // the next cable club visit starts a new search
        this.groupSeen = false;
        this.roomsSeen.clear();
        this.severalRooms = false;
        this.joinAllowed = !this.holdJoin;
        this.closeCount = 0;
        this.roomClosed = false;
        this.cancelPending = false;
        this.cancelClose = false;
        this.cancelReturn = false;
        this.exitKeySeen = false;
        this.hostClosedSeen = false;
        this.purpose = PURPOSE.NONE;
    }

    roundPassed() {
        this.log(`standby round passed (count now ${this.bar.localCount})`);
        switch (this.purpose) {
            case PURPOSE.EXIT_CLOSE:
                this.exitClosePassed();
                break;
            case PURPOSE.GAME_STANDBY:
                if (!this.roomClosed) this.keysActive = true;
                this.purpose = PURPOSE.NONE;
                this.cablePushCmd(LINKCMD.READY_EXIT_STANDBY, 0, 0);
                break;
            case PURPOSE.GAME_CLOSE:
                if (this.closeRoundsLeft > 1) {
                    this.closeRoundsLeft--;
                    barrierInitiate(this.bar, BAR.STANDBY);
                } else {
                    this.closeRoundsLeft = 0;
                    this.purpose = PURPOSE.NONE;
                    this.cablePushCmd(LINKCMD.READY_CLOSE_LINK, 0, 0);
                    if (this.cancelClose) {
                        this.cancelClose = false;
                        this.cancelReturn = true;
                        this.log('trade cancelled: waiting for the game to re-enter the room');
                    }
                }
                break;
            case PURPOSE.BATTLE:
                this.purpose = PURPOSE.NONE;
                // The Switch reaches its standby when its own screens are done: keep asking.
                if (this.bar.timedOut) this.dueRound('the Switch had not reached it yet');
                break;
            default:
                this.purpose = PURPOSE.NONE;
                break;
        }
        this.bar.timedOut = false;
        this.flushPendingStandby();
    }

    // ---- barriers against the leader's words

    // The leader's standby word. True when a round we started has passed.
    barrierHostStandby(count) {
        const b = this.bar;
        b.sinceHost = 0;
        const prev = b.hostCount;
        b.hostCount = count;
        if (b.initiated && b.mode === BAR.STANDBY) {
            if (count === b.localCount) {
                b.localCount++;
                b.rounds++;
                b.mode = BAR.IDLE;
                b.initiated = false;
                return true;
            }
            return false;
        }
        if (count < b.localCount) return false;
        if (b.mode !== BAR.STANDBY) {
            b.mode = BAR.STANDBY;
            b.initiated = false;
            this.log(`barrier: leader standby count=${count}, mirroring`);
        } else if (prev >= 0 && count !== prev) {
            b.rounds++;
        }
        b.localCount = count;
        b.sinceInitiate = 0;
        return false;
    }

    barrierHostClose(count) {
        const b = this.bar;
        b.sinceHost = 0;
        b.hostCount = count;
        b.localCount = count;
        if (b.mode !== BAR.CLOSE) {
            b.mode = BAR.CLOSE;
            b.initiated = false;
            this.log(`barrier: leader close count=${count}, mirroring`);
        }
    }

    // Once per host frame. True when a round ended without the leader's echo.
    barrierObserve(sawBarrier) {
        const b = this.bar;
        if (b.mode === BAR.CLOSE && b.initiated) {
            // Our own close: repeat every 60 frames, give up after 5 seconds.
            if (b.sinceInitiate && b.sinceInitiate % 60 === 0) b.burstN = 0;
            if (++b.sinceInitiate > 300) {
                b.mode = BAR.IDLE;
                b.initiated = false;
                this.log('barrier: close unanswered, ending the link anyway');
                return true;
            }
            return false;
        }
        if (b.mode !== BAR.STANDBY) return false;
        if (sawBarrier) { b.sinceHost = 0; b.sinceInitiate = 0; return false; }
        b.sinceHost++;
        if (b.initiated) {
            // Repeat every 60 frames: the leader listens only once its game reaches the standby.
            if (b.sinceInitiate && b.sinceInitiate % 60 === 0) b.burstN = 0;
            // The Switch can take long to reach it (a trade evolution, the player reading its
            // messages, a slow network between the pages): the round is not passed until it does.
            if (++b.sinceInitiate === INITIATE_TIMEOUT) this.log(`barrier: standby unanswered for ${INITIATE_TIMEOUT} frames, still asking`);
        } else if (b.sinceHost > IDLE_TIMEOUT) {
            b.localCount++;
            b.rounds++;
            b.mode = BAR.IDLE;
            this.log(`barrier: leader stopped its standby, round passed (count now ${b.localCount})`);
            return true;
        }
        return false;
    }

    // ---- wireless side

    // RfuGameData for the NI exchange: the game's trainer as an English Emerald that has
    // finished the game, trading.
    buildGameData() {
        const lp = this.rubyLP;
        const out = new Uint8Array(26);
        put16(out, 0, 2);
        out[12] = this.activity | 0x80;
        if (!this.haveRubyLP) {
            // Shown as FireRed so the Switch takes it without its checks for other versions.
            put16(out, 2, 2 | COMPAT_CAN_LINK_NATIONALLY | (1 << 8) | (1 << 9) | (VERSION_FIRE_RED << 10));
            out.set(PLACEHOLDER_NAME, 17);
            return out;
        }
        const version = this.dressed ? VERSION_EMERALD : this.gameVersion;
        put16(out, 2, 2 | COMPAT_CAN_LINK_NATIONALLY | (1 << 8) | (1 << 9) | (version << 10));
        put16(out, 4, le16(lp, LP_TRAINER_ID_OFFSET));
        let i = 0;
        for (; i < 7 && lp[LP_NAME_OFFSET + i] !== 0xff; i++) out[17 + i] = lp[LP_NAME_OFFSET + i];
        out[17 + i] = 0xff;
        return out;
    }

    airSend(payload) {
        this.sendFrame(payload);
        this.childFrames++;
    }

    setLink(link) {
        const was = this.linked;
        this.link = link;
        if (was !== this.linked) this.onLinked?.(this.linked);
    }

    // Everything that belongs to one wireless link: the Switch player's LinkPlayer and blocks
    // held for the game are never carried into the next.
    resetLink() {
        this.haveHostLP = false;
        this.hostLP.fill(0);
        this.held = [];
        this.pendingPull = -1;
        this.tag = 0;
        this.keyCount = 0;
        this.rx0 = newRecv();
        this.rx1 = newRecv();
        this.repairType = null;
        this.repeatDue = null;
        this.send = newSend();
        this.childQueue = [];
        this.bar = newBarrier();
        this.lpSentToHost = false;
        this.lpSendDone = false;
        this.lpPullWaiting = false;
        this.cardArmed = false;
        this.cardRequested = false;
        this.haveRubyCard = false;
        this.cardQueued = false;
        this.cardPullWaiting = false;
        this.cardSendDone = false;
        this.pendingGameStandby = false;
        this.round0Started = false;
        this.keysActive = false;
        this.battleRound = false;
        this.battleState = BATTLE.ROOM;
        this.rubyKeys.clear();
        this.hostKeys.clear();
        this.lastHostKeyCount = -1;
        this.purpose = PURPOSE.NONE;
        this.hostFrames = 0;
        this.childFrames = 0;
        this.silentFrames = 0;
    }

    startSearch() {
        this.setLink(AIR.SEARCH);
        this.linkFrames = 0;
        this.log(`looking for the Switch's ${['', 'single-battle', 'double-battle', '', 'trade'][this.activity]} group`);
    }

    // Frames from the board: room beacons, the join's answer, the Switch's frames.
    boardFrame({ type, header, frame }) {
        if (type === RFU1.BROADCAST) {
            if (this.link !== AIR.SEARCH) return;
            const occupied = (header >> 16) & 1;
            // RfuGameData: word 3's low byte is the activity (trade = 4).
            const word3 = ((frame[24] << 24) | (frame[25] << 16) | (frame[26] << 8) | frame[27]) >>> 0;
            const room = word3 & 0x7f;
            if (occupied) return;
            if (this.holdJoin && !this.haveRubyLP) {
                if (room !== ACTIVITY.TRADE && room !== ACTIVITY.BATTLE_SINGLE && room !== ACTIVITY.BATTLE_DOUBLE) return;
                // A board that cannot tell the Switch's room offers a group for each: the room
                // is then the other player's choice, known once its LinkPlayer comes.
                this.roomsSeen.add(room);
                if (this.roomsSeen.size > 1) {
                    if (!this.severalRooms) {
                        this.severalRooms = true;
                        this.groupSeen = false;
                        this.log('the board shows the Switch\'s room as several groups: waiting for the other player\'s choice (update the board\'s firmware)');
                        this.onLinked?.(this.linked);
                    }
                    return;
                }
                this.activity = room;
            } else if (room !== this.activity) return;
            // Emerald joins a FireRed or LeafGreen trade group only once that game can link
            // nationally (its Sevii Islands story is done). A real Ruby and FireRed have the
            // same rule, checked by FireRed.
            const compat = frame[13] | (frame[12] << 8);
            // Only Ruby and Sapphire need this here: they have no check of their own, while
            // Emerald checks in its cable club and FireRed/LeafGreen need nothing.
            const ready = this.battle || !this.dressed || this.bypassNationally || (compat & COMPAT_CAN_LINK_NATIONALLY) !== 0;
            if (ready !== !this.hostNotReady) {
                this.hostNotReady = !ready;
                if (!ready) this.log('the Switch\'s game cannot link with Ruby or Sapphire yet: not joining');
                this.onLinked?.(this.linked);
            }
            if (!ready) return;
            this.hostId = header & 0xffff;
            if (!this.joinAllowed) {
                if (!this.groupSeen) {
                    this.groupSeen = true;
                    this.log(`the Switch's ${['', 'single-battle', 'double-battle', '', 'trade'][this.activity]} group ${hex(this.hostId)} is open: ready for the other GBA`);
                    this.onLinked?.(this.linked);
                }
                return;
            }
            this.log(`the Switch's group ${hex(this.hostId)} found: joining`);
            this.setLink(AIR.CONNECTING);
            this.linkFrames = 0;
            this.connectFrames = 0;
            this.connectRoom(this.hostId);
            return;
        }
        if (type === RFU1.CONNECT_ACK) {
            if (this.link !== AIR.CONNECTING) return;
            this.log('the Switch let us in: name exchange');
            const src = this.buildGameData();
            this.resetLink();
            this.ni = newNI(src);
            this.setLink(AIR.NI);
            this.linkFrames = 0;
            return;
        }
        if (type === RFU1.DISCONNECT) {
            this.log('disconnected from the Switch');
            if (this.link === AIR.NI || this.link === AIR.UNI) { this.resetLink(); this.startSearch(); }
            return;
        }
        if (type === RFU1.HOST_SEND && (this.link === AIR.NI || this.link === AIR.UNI)) {
            const length = Math.min(((frame[8] << 24 | frame[9] << 16 | frame[10] << 8 | frame[11]) >>> 0) & 0x7f, 92);
            if (length === 0) return;
            this.silentFrames = 0;
            this.handleHostFrame(frame.subarray(12, 12 + length));
        }
    }

    logHostOp(op, words) {
        if (op === RFUCMD.SEND_BLOCK || op === RFUCMD.SEND_HELD_KEYS || op === 0) return;
        if (op === this.lastHostOp && op !== RFUCMD.SEND_BLOCK_REQ) return;
        this.lastHostOp = op;
        this.log(`Switch ${words.slice(0, 4).map(hex).join(' ')}`);
    }

    // The child's slot for this frame; all zero is an idle frame.
    chooseSlot(words) {
        words.fill(0);
        this.startDueRound();
        if (barrierWant(this.bar, words)) return;
        if (this.bar.mode !== BAR.IDLE) return;
        if (this.repairType !== null) {
            words[0] = RFUCMD.SEND_BLOCK_REQ;
            words[1] = this.repairType;
            this.repairType = null;
            return;
        }
        if (!this.send.active && this.childQueue.length) {
            const block = this.childQueue.shift();
            sendStart(this.send, block.data, block.size, block.isLinkPlayer);
            this.send.isCard = block.isCard;
            this.send.isBattleLP = Boolean(block.isBattleLP);
            this.rx1 = newRecv();
            this.log(`sending a block of ${block.size} bytes (${this.send.count} fragments)`);
        }
        if (this.send.active) {
            const wasLP = this.send.isLinkPlayer, wasCard = this.send.isCard;
            // While the leader's own block is short of fragments, ours stays one short too:
            // the leader then cannot move on, and its block can still be asked for again.
            const rx0 = this.rx0;
            sendTick(this.send, this.rx1, words, !this.battleBlocks && rx0.receiving && !rx0.done && rx0.repairs < REPAIRS);
            if (!this.send.active && wasCard) {
                this.cardSendDone = true;
                this.log('trainer card acknowledged by the Switch');
                this.flushPendingStandby();
            } else if (!this.send.active && wasLP) {
                this.lpSendDone = true;
                this.log('LinkPlayer acknowledged by the Switch');
                this.maybeStartRound0();
            } else if (!this.send.active && this.send.isBattleLP) {
                this.log('our LinkPlayer acknowledged by the Switch');
                this.dueRound('the battle starts');
            } else if (!this.send.active) {
                this.log('block acknowledged by the Switch');
            }
            if (words[0]) return;
        }
        if (this.keysActive) {
            words[0] = RFUCMD.SEND_HELD_KEYS;
            words[1] = ((this.keyCount++ & 0xff) << 8) | this.rubyKeys.pop();
        }
    }

    sendUni(words) {
        const frame = new Uint8Array(2 + SLOT_BYTES);
        if (words[0]) {
            words[0] |= this.tag << 5;
            this.tag = (this.tag + 1) & 7;
        }
        put16(frame, 0, (LCOM.UNI << 10) | SLOT_BYTES);
        for (let i = 0; i < 7; i++) put16(frame, 2 + i * 2, words[i]);
        this.airSend(frame);
    }

    handleHostFrame(data) {
        this.hostFrames++;
        if (data.length < 3) {
            // A bare frame still asks the child to speak; our game data goes first.
            if (this.link === AIR.NI && this.ni.state < 4) {
                const out = niNext(this.ni);
                if (out) this.airSend(out);
            }
            return;
        }
        const header = data[0] | (data[1] << 8) | (data[2] << 16);
        const state = (header >> 14) & 0xf, ack = (header >> 13) & 1, n = (header >> 11) & 3, phase = (header >> 9) & 3;

        if (state !== LCOM.UNI) {
            // The leader's own NI transfer: acknowledge each sub-frame by mirroring it.
            if (this.link !== AIR.NI) return;
            let out = null;
            if (this.ni.state < 4) {
                out = niNext(this.ni);
            } else if (!ack && (state === LCOM.NI_START || state === LCOM.NI || state === LCOM.NI_END)) {
                out = new Uint8Array(2);
                put16(out, 0, childLLSF(state, n, phase, 1, 0));
            }
            if (out) this.airSend(out);
            return;
        }

        if (data.length < HOST_FRAME_BYTES) return;
        if (this.link === AIR.NI) {
            if (this.ni.state < 4) return;
            this.setLink(AIR.UNI);
            this.log(`linked with the Switch (${this.hostFrames} frames)`);
        }

        // Slot 0 is the leader's own command, slot 1 the reflection of ours.
        const slot0 = data.subarray(3, 3 + SLOT_BYTES);
        const slot1 = data.subarray(3 + SLOT_BYTES, 3 + 2 * SLOT_BYTES);
        let sawBarrier = false;
        if (!slotIdle(slot0)) {
            const words0 = slotWords(slot0);
            const op = words0[0] & RFUCMD.MASK;
            this.logHostOp(op, words0);
            switch (op) {
                case RFUCMD.SEND_BLOCK_REQ:
                    this.hostPull(words0[1]);
                    break;
                case RFUCMD.SEND_BLOCK_INIT:
                case RFUCMD.SEND_BLOCK:
                    // The leader's request and its own block go out together, the request once:
                    // a block of a request's size with no request just before it is answered
                    // as that request (not in a battle, where blocks come unasked).
                    if (op === RFUCMD.SEND_BLOCK_INIT && (!this.rx0.receiving || this.rx0.done) && !this.battleBlocks
                        && REQUEST_TYPES[words0[1]] !== undefined && this.hostFrames - this.pullAt > PULL_WITH_BLOCK_FRAMES) {
                        this.log(`the Switch's block of ${words0[1]} fragments came without its request: answering it`);
                        this.hostPull(REQUEST_TYPES[words0[1]]);
                    }
                    const whole = feedRecv(this.rx0, words0, slot0);
                    this.rx0.heardAt = this.hostFrames;
                    if (whole) {
                        const count = this.rx0.need || this.rx0.count, data = this.rx0.buf.slice(0, count * FRAG_BYTES);
                        const repeat = this.repeatDue;
                        this.repeatDue = this.rx0.repairs ? { count: REQUEST_FRAGMENTS[repairType(count)], data, until: this.hostFrames + REPEAT_FRAMES } : null;
                        // The repeat a repair asked for, after the block came whole anyway.
                        if (repeat && this.hostFrames <= repeat.until && this.rx0.count === repeat.count && !this.rx0.repairs
                            && repeat.data.every((b, i) => b === this.rx0.buf[i])) this.repeatDue = null;
                        else this.hostBlock(count, this.rx0.buf);
                        this.rx0.receiving = false;
                        this.rx0.done = false;
                        this.rx0.flags = 0;
                    }
                    break;
                case RFUCMD.SEND_HELD_KEYS:
                    // The high byte counts the leader's frames; a repeated count is the same event.
                    if (this.lastHostKeyCount !== (words0[1] >> 8)) {
                        this.lastHostKeyCount = words0[1] >> 8;
                        this.pushHostKey(words0[1] & 0xff);
                        if ((words0[1] & 0xff) === KEY_EXIT_ROOM) this.exitKeySeen = true;
                    }
                    break;
                case RFUCMD.READY_EXIT_STANDBY:
                    sawBarrier = true;
                    if (this.barrierHostStandby(words0[1])) this.roundPassed();
                    break;
                case RFUCMD.READY_CLOSE_LINK:
                    sawBarrier = true;
                    this.barrierHostClose(words0[1]);
                    this.hostClosedSeen = true;
                    if (this.purpose === PURPOSE.EXIT_CLOSE) this.exitClosePassed();
                    break;
                case RFUCMD.DISCONNECT:
                    this.log('the Switch sent DISCONNECT');
                    break;
            }
        }
        if (!slotIdle(slot1)) feedRecv(this.rx1, slotWords(slot1), slot1);
        const rx0 = this.rx0;
        // Not in a battle: its blocks come back to back without a request, and the game
        // ignores SendBlock failing, so a repeat that keeps the leader busy loses its next one.
        if (!this.battleBlocks && rx0.receiving && !rx0.done && repairType(rx0.need || rx0.count) !== null && rx0.repairs < REPAIRS
            && this.hostFrames - rx0.heardAt >= REPAIR_QUIET_FRAMES) {
            rx0.need ||= rx0.count;
            rx0.repairs++;
            rx0.heardAt = this.hostFrames;
            this.repairType = repairType(rx0.need);
            this.log(`the Switch's block of ${rx0.need} fragments stopped short: asking for it again`);
        }
        if (this.barrierObserve(sawBarrier)) this.roundPassed();
        if (this.link !== AIR.UNI) return;   // the exit above ended the link

        const out = new Array(7).fill(0);
        this.chooseSlot(out);
        this.sendUni(out);
    }

    pushHostKey(code) {
        this.hostKeys.push(code);
        if (this.keysActive) this.keyPushes++;
    }

    // The next key report for the game, one per cable packet.
    hostKey() {
        if (++this.keyPops >= KEY_RATE_WINDOW) {
            this.keyStep = Math.min(3, Math.max(1, this.keyPushes / this.keyPops));
            this.keyPushes = this.keyPops = 0;
        }
        return this.hostKeys.pop(this.keyStep);
    }

    // Once per GBA frame.
    frame() {
        if (this.link < 0 && (this.haveRubyLP || this.holdJoin)) this.startSearch();
        if (this.link === AIR.CONNECTING && ++this.connectFrames > 8 * 60) {
            this.log('the Switch did not answer the join: looking again');
            this.startSearch();
        }
        // The child speaks first after the connect. The Switch sends nothing until it has our
        // game data, so repeat the NI_START every few frames until its first frame (idempotent).
        if (this.link === AIR.NI && this.hostFrames === 0 && this.ni.state === 0 && ++this.linkFrames % 8 === 0) {
            const out = niNext(cloneNI(this.ni));
            if (out) this.airSend(out);
        }
        if (this.link === AIR.NI || this.link === AIR.UNI) {
            if (++this.silentFrames > HOST_SILENT_FRAMES) {
                this.log('the Switch went quiet');
                this.resetLink();
                this.disconnectRoom();
                this.startSearch();
            }
        }
    }

    // ---- cable side

    // The game opened its cable link from scratch.
    cableReset() {
        this.joinAllowed = true;
        this.linkClosing = false;
        this.cablePackets = 0;
        this.readyAt = 0;
        this.announced = false;
        this.expect = EXPECT.NONE;
        this.sessionRubyLP = false;
        this.p0LPDelivered = false;
        this.rxSize = 0;
        this.rxPos = 0;
        this.cq = [];
        this.sessions++;
    }

    gameCommand(command) {
        switch (command[0]) {
            case LINKCMD.INIT_BLOCK:
                this.rxSize = command[1] <= MAX_BLOCK_BYTES ? command[1] : 0;
                this.rxPos = 0;
                break;
            case LINKCMD.CONT_BLOCK:
                if (this.rxSize) {
                    for (let i = 0; i < CMD_WORDS - 1; i++) {
                        const at = this.rxPos + i * 2;
                        if (at + 1 < this.rxBuf.length) put16(this.rxBuf, at, command[1 + i]);
                    }
                    this.rxPos += (CMD_WORDS - 1) * 2;
                    if (this.rxPos >= this.rxSize) {
                        const size = this.rxSize;
                        this.rxSize = 0;
                        this.gameBlock(size, this.rxBuf);
                    }
                }
                break;
            case LINKCMD.SEND_HELD_KEYS:
                this.rubyKeys.push(command[1] & 0xff);
                if ((command[1] & 0xff) === KEY_EXIT_ROOM) this.exitKeySeen = true;
                break;
            case LINKCMD.READY_EXIT_STANDBY:
                this.gameStandby();
                break;
            case LINKCMD.READY_CLOSE_LINK:
                this.gameClose();
                break;
        }
    }

    // The next command for the game, or null for none this packet.
    nextCommand() {
        this.cablePackets++;
        if (this.hostNotReady && this.sessionRubyLP && !this.p0LPDelivered && !this.joined) this.refuse();
        if (this.held.length || this.pendingPull >= 0) this.releaseHeld();
        if (this.cardArmed && this.cablePackets >= this.cardAt) {
            this.cardArmed = false;
            this.requestEarlyCard();
        }
        if (!this.announced && this.cablePackets > ANNOUNCE_PACKETS) {
            // The master asks for the player data exchange.
            this.announced = true;
            this.expect = EXPECT.LINK_PLAYER;
            this.lpEarlyWait = 0;
            return [LINKCMD.SEND_LINK_TYPE, 0x1133, 0, 0, 0, 0, 0, 0];
        }
        if (this.holdJoin && this.expect === EXPECT.LINK_PLAYER && this.haveHostLP && !this.sessionRubyLP && !this.p0LPDelivered
            && ++this.lpEarlyWait > LP_EARLY_PACKETS) this.deliverLinkPlayerToGame(true);
        if (this.cq.length) return this.cq.shift();
        if (this.keysActive) return [LINKCMD.SEND_HELD_KEYS, this.hostKey(), 0, 0, 0, 0, 0, 0];
        return null;
    }
}

function hex(v) { return (v & 0xffff).toString(16).padStart(4, '0'); }
