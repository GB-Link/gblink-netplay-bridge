// A GBA leading a wireless group, as the ESP32 board's host port sees its adapter: the page
// stands in for both, and the Switch joins the group. pokefirered librfu as a parent with one
// child in slot 0; the board hosts the room and relays frames.
//
// Board side (pia_bridge.c BR_HOST): RFU1 BROADCAST every 500 ms until the join; the board's
// one CONNECT_REQ is answered with CONNECT_ACK; then one HOST_SEND per GBA frame, and the
// Switch's frames arrive as CLIENT_SEND. The name exchange runs end to end.
//
// Link layer: parent frames are a 3-byte header (size 0-6, phase 9-10, n 11-12, ack 13,
// state 14-17, slot bitmap 18-21) and, once linked, five 14-byte slots: slot 0 the leader's
// own command, slot 1 a command of the child's echoed back (sequence bits cleared). Child
// frames are a 2-byte header (size 0-4, phase 5-6, n 7-8, ack 9, state 10-13) and one slot.
//
// The child takes its own commands back from slot 1: a block it sends completes only once
// every fragment came back, and when its last fragment comes back with others missing, it
// sends those again. A board packet can carry several of the child's frames, so each
// distinct command is queued for echoing; a repeat still waiting is not queued twice.

const RFU1 = { BROADCAST: 0, CONNECT_REQ: 1, CONNECT_ACK: 2, CONNECT_NACK: 3, DISCONNECT: 4, HOST_SEND: 5, CLIENT_SEND: 6, CLIENT_ACK: 7 };
const STATE = { NULL: 0, NI_START: 1, NI: 2, NI_END: 3, UNI: 4 };
const CHILD_SLOT_BIT = 1 << 18;
const SLOT_BYTES = 14;
const UNI_PAYLOAD = 70;
const BEACON_TICKS = 30;
const ECHO_RETRY = 16;            // ticks before a child's INIT or whole block's last fragment goes back again
const ECHO_RETRY_MISSING = 48;    // the same for the last fragment with fragments missing
export const FRAG_BYTES = 12;

const put16 = (b, at, v) => { b[at] = v & 0xff; b[at + 1] = (v >> 8) & 0xff; };
const le16 = (b, at) => b[at] | (b[at + 1] << 8);

function rfu1(type, header, payload = null, size = 16) {
    const f = new Uint8Array(size);
    f.set([0x52, 0x46, 0x55, 0x31]);
    const put32 = (at, v) => { f[at] = v >>> 24; f[at + 1] = (v >>> 16) & 0xff; f[at + 2] = (v >>> 8) & 0xff; f[at + 3] = v & 0xff; };
    put32(4, type);
    put32(8, header >>> 0);
    if (payload) f.set(payload.subarray(0, size - 12), 12);
    return f;
}

function parentHeader(state, n, phase, size, ack = false) {
    const h = CHILD_SLOT_BIT | (state << 14) | (ack ? 1 << 13 : 0) | (n << 11) | (phase << 9) | size;
    return Uint8Array.of(h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff);
}

function parentFrame(state, n, phase, payload = [], ack = false) {
    const out = new Uint8Array(3 + payload.length);
    out.set(parentHeader(state, n, phase, payload.length, ack));
    out.set(payload, 3);
    return out;
}

// The join answer, sent as the parent's NI data: control block, then the status byte
// (5 JOIN_GROUP_OK), then END and NULL. Each step repeats until the child acks it.
const JOIN_OK = [
    { state: STATE.NI_START, n: 1, frame: parentFrame(STATE.NI_START, 1, 0, [0x00, 0x05, 0x00, 0x01, 0x00]) },
    { state: STATE.NI_START, n: 2, frame: parentFrame(STATE.NI_START, 2, 0, [0x00, 0x00]) },
    { state: STATE.NI, n: 1, frame: parentFrame(STATE.NI, 1, 0, [0x05]) },
    { state: STATE.NI_END, n: 0, frame: parentFrame(STATE.NI_END, 0, 0, []) },
];

// 24-byte librfu game data broadcast: serial, compatibility, trainer id, activity, name.
export function leaderBeacon({ activity, name, trainerId = 0, compatibility }) {
    const b = new Uint8Array(24);
    put16(b, 0, 0x0002);
    put16(b, 2, compatibility);
    put16(b, 4, trainerId);
    b[12] = activity & 0x7f;
    b.set(name.subarray(0, 8), 16);
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += b[16 + i] + b[2 + i];
    b[15] = ~sum & 0xff;
    return b;
}

export class RfuLeader {
    // send(rfu1Frame): to the board. onCommand(words) for each command of the Switch (block
    // fragments included), onJoined(childGameData) once linked.
    constructor({ send, log = () => {} }) {
        this.send = send;
        this.log = log;
        this.devid = 1 + Math.floor(Math.random() * 0xfffe);
        this.beacon = null;
        this.state = 'idle';          // idle | open | naming | answering | linked | closed
        this.childDevid = 0;
        this.ticks = 0;
        this.childFrames = [];
        this.childName = [];
        this.nameDone = false;
        this.niAck = null;            // parent ack of the child's NI, sent until it moves on
        this.recvN = [0, 0, 0, 0];
        this.joinStep = 0;
        this.idleNull = 0;
        this.own = [];                // the leader's own commands, one per frame
        this.echoes = [];             // the child's commands to echo, one a frame
        this.childSeq = 0xff;
        this.recv = null;             // the child's block being received: { count, flags, data }
        this.childQuietAt = 0;        // ticks of the child's last empty frame
        this.childBusyAt = -1;        // and of its last command
        this.keyCount = 0;
        this.keySource = null;        // () => key code for this frame, or null for none
        this.onCommand = null;        // (words) each command of the Switch, blocks excepted
        this.onBlock = null;          // (count, data) a block the Switch finished sending
        this.onJoined = null;
        this.onClosed = null;
        this.onTick = null;           // once per GBA frame
    }

    // ---- game level (link_rfu_2.c as the leader)

    playerIds() { this.command([0x7700, 2, 0x0001, 0, 0, 0, 0]); }
    request(type) { this.command([0xa100, type, 0, 0, 0, 0, 0]); }
    standby(count) { const words = [0x6600, count, 0, 0, 0, 0, 0]; this.command(words); this.command(words.slice()); }
    closeLink(count) { this.command([0x5f00, count, 0, 0, 0, 0, 0]); }
    // The child closes once its own READY_CLOSE_LINK comes back, which it sends only once:
    // echoed for it, a lost one cannot leave it waiting.
    echoCloseLink(count) { this.echoes.push([0x5f00, count, 0, 0, 0, 0, 0]); }

    // The leader's block: its INIT on four frames, then each fragment on `repeat` frames in
    // a row, never resent.
    sendBlock(data, repeat = 1) {
        const count = Math.max(1, Math.ceil(data.length / FRAG_BYTES));
        for (let i = 0; i < 4; i++) this.command([0x8800, count, 0x80, 0, 0, 0, 0]);
        for (let i = 0; i < count; i++) {
            const words = [0x8900 | i];
            for (let k = 0; k < 6; k++) {
                const at = i * FRAG_BYTES + k * 2;
                words.push((data[at] ?? 0) | ((data[at + 1] ?? 0) << 8));
            }
            for (let r = 0; r < repeat; r++) this.command(words.slice());
        }
        return count;
    }

    // The Switch's blocks: INIT, then fragments (repeated or resent until our echoes show
    // them all).
    childBlock(words) {
        const op = words[0] & 0xff00;
        if (op === 0x8800) {
            const count = words[1];
            if (count < 1 || count > 24) return;
            if (!this.recv || this.recv.done || this.recv.count !== count) this.recv = { count, flags: 0, data: new Uint8Array(count * FRAG_BYTES), done: false };
            return;
        }
        const r = this.recv;
        if (!r || r.done) return;
        const index = words[0] & 0x1f;
        if (index >= r.count) return;
        for (let k = 0; k < 6; k++) { r.data[index * FRAG_BYTES + k * 2] = words[1 + k] & 0xff; r.data[index * FRAG_BYTES + k * 2 + 1] = words[1 + k] >> 8; }
        r.flags = (r.flags | (1 << index)) >>> 0;
        if (r.flags === ((1 << r.count) - 1) >>> 0) {
            r.done = true;
            this.onBlock?.(r.count, r.data.slice());
        }
    }

    get linked() { return this.state === 'linked'; }
    // The child's send queue is empty: its last frame carried no command.
    get childQuiet() { return this.childQuietAt > this.childBusyAt; }
    get joined() { return this.state === 'naming' || this.state === 'answering' || this.state === 'linked'; }

    // Opens (or updates) the group the Switch sees.
    open(beacon) {
        this.beacon = beacon;
        if (this.state === 'idle' || this.state === 'closed') this.state = 'open';
        this.broadcast();
    }

    broadcast() {
        const body = new Uint8Array(24);
        for (let i = 0; i < 6; i++) {
            const word = (this.beacon[i * 4] | this.beacon[i * 4 + 1] << 8 | this.beacon[i * 4 + 2] << 16 | this.beacon[i * 4 + 3] << 24) >>> 0;
            body[i * 4] = word >>> 24; body[i * 4 + 1] = (word >>> 16) & 0xff; body[i * 4 + 2] = (word >>> 8) & 0xff; body[i * 4 + 3] = word & 0xff;
        }
        this.send(rfu1(RFU1.BROADCAST, this.devid | (this.state === 'open' ? 0 : 0xff << 16), body, 36));
    }

    close() {
        if (this.childDevid) this.send(rfu1(RFU1.DISCONNECT, this.childDevid));
        this.state = 'closed';
        this.childDevid = 0;
    }

    // The leader's command for one frame (seven words); queued, one per frame.
    command(words) { this.own.push(words); }
    get queued() { return this.own.length; }

    boardFrame({ type, header, frame }) {
        if (type === RFU1.CONNECT_REQ) {
            if (this.state !== 'open' || (header & 0xffff) !== this.devid) { this.send(rfu1(RFU1.CONNECT_NACK, 0)); return; }
            this.childDevid = 1 + Math.floor(Math.random() * 0xfffe);
            this.state = 'naming';
            this.childName = [];
            this.childFrames = [];
            this.nameDone = false;
            this.recvN = [0, 0, 0, 0];
            this.niAck = null;
            this.joinStep = 0;
            this.idleNull = 0;
            this.childSeq = 0xff;
            this.recv = null;
            this.own = [];
            this.echoes = [];
            this.childQuietAt = 0;
            this.childBusyAt = -1;
            this.send(rfu1(RFU1.CONNECT_ACK, this.childDevid));
            this.log('the Switch joined the group: name exchange');
            this.broadcast();
            return;
        }
        if (type === RFU1.DISCONNECT) {
            if (!this.childDevid) return;
            this.childDevid = 0;
            this.state = 'closed';
            this.log('the Switch left the group');
            this.onClosed?.();
            return;
        }
        if (type === RFU1.CLIENT_SEND && this.childDevid) {
            const length = Math.min(frame[8], 92);
            if (length) this.childFrames.push(frame.slice(12, 12 + length));
        }
    }

    // Once per GBA frame (59.727 Hz).
    tick() {
        this.ticks++;
        this.onTick?.();
        if (this.state === 'open' && this.ticks % BEACON_TICKS === 0) this.broadcast();
        if (!this.childDevid) return;
        const child = this.childFrames.shift();
        if (child) this.fromChild(child);
        const payload = this.nextFrame();
        const f = rfu1(RFU1.HOST_SEND, payload.length & 0x7f, null, 104);
        f.set(payload.subarray(0, 92), 12);
        this.send(f);
    }

    // A child packet may hold several subframes back to back.
    fromChild(data) {
        for (let o = 0; o + 2 <= data.length;) {
            const h = le16(data, o), size = h & 31;
            if (o + 2 + size > data.length) break;
            const state = (h >> 10) & 15;
            if (state === STATE.UNI) this.childUni(data.subarray(o + 2, o + 2 + size));
            else this.childNi(h, data.subarray(o + 2, o + 2 + size));
            o += 2 + size;
            if (h === 0) break;
        }
    }

    childNi(h, payload) {
        const state = (h >> 10) & 15, ack = (h >> 9) & 1, n = (h >> 7) & 3, phase = (h >> 5) & 3;
        if (ack) {
            // The child acking a step of the join answer.
            const step = JOIN_OK[this.joinStep];
            if (this.state === 'answering' && step && step.state === state && step.n === n) {
                if (++this.joinStep === JOIN_OK.length) { this.idleNull = 2; this.log('the Switch accepted into the group'); }
            }
            return;
        }
        if (this.state !== 'naming') return;
        if (state === STATE.NI_START || state === STATE.NI || state === STATE.NI_END) {
            if (state === STATE.NI && n === ((this.recvN[phase] + 1) & 3)) {
                this.recvN[phase] = n;
                this.childName.push({ phase, data: payload.slice() });
            }
            this.niAck = parentFrame(state, state === STATE.NI_END ? 0 : n, phase, [], true);
            if (state === STATE.NI_END) this.nameDone = true;
        } else if (state === STATE.NULL && this.nameDone) {
            // The child finished its name send: answer the join.
            this.state = 'answering';
            this.niAck = null;
            this.log('the Switch\'s name is in: admitting it');
        }
    }

    // The child's game data from its NI windows, in send order.
    childGameData() {
        const out = new Uint8Array(26);
        let at = 0;
        for (const piece of this.childName) { out.set(piece.data.subarray(0, 26 - at), at); at += piece.data.length; if (at >= 26) break; }
        return out;
    }

    childUni(slot) {
        if (this.state === 'answering' || this.state === 'naming') {
            this.state = 'linked';
            this.log('linked with the Switch');
            this.onJoined?.(this.childGameData());
        }
        if (slot.length < SLOT_BYTES || slot[1] === 0) { this.childQuietAt = this.ticks; return; }
        this.childBusyAt = this.ticks;
        const seq = slot[0] >> 5;
        const words = Array.from({ length: 7 }, (_, i) => le16(slot, i * 2));
        // The child resends block fragments untagged; they sit outside the sequence.
        const untagged = seq === 0 && (words[0] & 0xff00) === 0x8900 && this.childSeq !== 0xff && this.childSeq !== 7;
        if (!untagged) {
            if (this.childSeq !== 0xff && seq !== ((this.childSeq + 1) & 7)) {
                this.log(`the Switch's command out of order (${seq} after ${this.childSeq})`);
            }
            this.childSeq = seq;
        }
        words[0] &= 0xff1f;
        const op = words[0] & 0xff00;
        if (op === 0x8800 || op === 0x8900) this.childBlock(words);
        if (this.echoWanted(words)) {
            const waiting = this.echoes.at(-1);
            if (!waiting || waiting.some((word, i) => word !== words[i])) this.echoes.push(words);
        }
        if (op !== 0x8800 && op !== 0x8900) this.onCommand?.(words);
    }

    // Each echo of a block's last fragment makes the child resend every fragment still
    // missing, so echoing every repeat overflows its 40-command send queue. The last fragment
    // goes back when it first arrives and when the block is whole, then only after a pause.
    // INIT goes back once, then only after a pause: a one-fragment block's last fragment
    // shares INIT's index 0.
    echoWanted(words) {
        const r = this.recv;
        const op = words[0] & 0xff00;
        if (!r || (op === 0x8800 && words[1] !== r.count)) return true;
        if (op === 0x8800) {
            if (r.initEcho !== undefined && this.ticks - r.initEcho < ECHO_RETRY) return false;
            r.initEcho = this.ticks;
            return true;
        }
        if (op !== 0x8900 || (words[0] & 0x1f) !== r.count - 1) return true;
        const wait = r.done ? (r.wholeEchoed ? ECHO_RETRY : 0) : ECHO_RETRY_MISSING;
        if (r.lastEcho !== undefined && this.ticks - r.lastEcho < wait) return false;
        r.lastEcho = this.ticks;
        if (r.done) r.wholeEchoed = true;
        return true;
    }

    nextFrame() {
        if (this.state === 'naming') return this.niAck ?? Uint8Array.of(0, 0, 0);
        if (this.state === 'answering') {
            const step = JOIN_OK[this.joinStep];
            if (step) return step.frame;
            if (this.idleNull > 0) { this.idleNull--; return parentFrame(STATE.NULL, 1, 0); }
        }
        return uniFrame(this.nextOwn(), this.takeEcho());
    }

    // Queued commands first; otherwise held keys every frame while the game sends them.
    nextOwn() {
        if (this.own.length) return this.own.shift();
        const code = this.keySource?.();
        if (code === null || code === undefined) return null;
        const words = [0xbe00, (code & 0xff) | ((this.keyCount & 0xff) << 8), 0, 0, 0, 0, 0];
        this.keyCount++;
        return words;
    }

    // An empty slot 1 reads as index 0, the echo a child waiting on a one-fragment block
    // resends on: it holds a word with no command or index until the block is through.
    takeEcho() {
        const echo = this.echoes.shift();
        if (echo) return echo;
        const r = this.recv;
        if (r?.count === 1 && !(r.wholeEchoed && this.ticks - r.lastEcho >= ECHO_RETRY)) return [0x00ff, 0, 0, 0, 0, 0, 0];
        return null;
    }
}

function uniFrame(own, echo) {
    const out = new Uint8Array(3 + UNI_PAYLOAD);
    out.set(parentHeader(STATE.UNI, 0, 0, UNI_PAYLOAD));
    if (own) for (let i = 0; i < 7; i++) put16(out, 3 + i * 2, own[i]);
    if (echo) for (let i = 0; i < 7; i++) put16(out, 3 + SLOT_BYTES + i * 2, echo[i]);
    return out;
}
