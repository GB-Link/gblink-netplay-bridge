// The child's side of a cable link, where the other GBA is the parent (player 0), turned into
// a wireless group the Switch joins with this page leading it (RfuLeader). The mirror of
// translator.js: there the Switch leads and the page is the cable parent.
//
// Cable side (link.c, the page as player 1): the parent's 0x2222 is answered with the
// LinkPlayer of the Switch's player and this side's own link type, its 0xCCCC requests with
// the Switch's blocks (pulled with the leader's 0xA100). Wireless side: the page leads as
// FireRed would. The Switch's game sets the pace: each of its standby rounds is a point in
// the Cable Club's flow where both GBAs send 0x2FFE (standby) or 0x5FFF (close the link), or
// where the parent has opened a new link. This side sends its own as the Switch gets there
// and answers the Switch once the parent's has come.

import { CMD_WORDS, KeyRuns, KeyQueue, LINKCMD, sizeFromCount, sizeFromRequest } from './translator.js';
import { leaderBeacon } from './leader.js';
import { StepFollower } from './steps.js';

const LP_SIZE = 60;
const LP_VERSION = 16;
const LP_ID = 16 + 0x18;
const LP_LINK_TYPE = 16 + 0x14;
const LP_PROGRESS = 16 + 0x10;
const BATTLE_LP_SIZE = 28;
const LINKTYPE = { TRADE_ROOM: 0x1133, ROOM_AGAIN: 0x1111, TRADE_MENU: 0x1122, TRADE_SCENE: 0x1144, SINGLE: 0x2233, DOUBLE: 0x2244, BATTLE: 0x2211 };
const ACTIVITY_LINK_TYPE = { 4: LINKTYPE.TRADE_ROOM, 1: LINKTYPE.SINGLE, 2: LINKTYPE.DOUBLE };
const MENU = { START: 0xccdd, BOTH_CANCEL: 0xeebb };
const SAVE_STANDBYS = 3;
// After a trade the Switch runs one standby round more than a GBA. The page answers it and
// waits these frames, while the Switch clears its receive state for the menu, before party
// requests and blocks go out; without that round by the deadline they go out anyway.
const AFTER_EXTRA_FRAMES = 30;
const EXTRA_ROUND_DEADLINE = 360;
// Trade-menu commands to the Switch go as three fragments, not two. The board treats a
// two-fragment CONFIRM_FINISH from the leader as a GBA's trade and then holds and replays
// the leader's next block itself, which is meant for a GBA and garbles the page's party.
// The Switch reads only the command words, so the size makes no difference to it.
const MENU_BLOCK_SIZE = 20;
const MENU_BLOCK_SENT = 36;
const VERSION_EMERALD = 3;
const PROGRESS_CLEARED = 0x11;
// LinkPlayer progress flags: Emerald sets 0x10 once its player is Champion, FireRed and
// LeafGreen once the Sevii Islands story allows linking with Hoenn. Emerald's cable club
// refuses a FireRed/LeafGreen partner unless both are set.
const PROGRESS_LINK_HOENN = 0x10;
// A GBA parent sends its LinkPlayer with its 0x2222; a parent that waits for ours first
// (this page as the parent, for another Switch) gets it after this many cable packets.
const LP_WAIT_PACKETS = 20;
// The Switch refuses a block request while its own block is still going out. Like the
// FireRed leader, the next request waits this many frames after the Switch's last block,
// and is asked again (in the page's own frame, never as an extra one) if the Switch has
// not started its answer after the second count.
const REQUEST_GAP_FRAMES = 15;
const REREQUEST_FRAMES = 60;
const REREQUESTS = 3;
const KEY_EMPTY = 0x11;
const KEY_READY = 0x16;
const KEY_EXIT = 0x17;
const KEY_RATE_WINDOW = 40;
const MAGIC = Array.from('GameFreak inc.', (c) => c.charCodeAt(0));
// "CELIO" in the game's charset, for the group's name until the other player is known.
const PLACEHOLDER_NAME = Uint8Array.of(0xbd, 0xbf, 0xc6, 0xc3, 0xc9, 0xff, 0, 0);

// What the Switch's next standby round stands for on the cable.
const NEXT = { LOCAL: 'local', STANDBY: 'standby', CLOSE: 'close', REOPEN: 'reopen', EXTRA: 'extra' };

const le16 = (b, at) => b[at] | (b[at + 1] << 8);
const put16 = (b, at, v) => { b[at] = v & 0xff; b[at + 1] = (v >> 8) & 0xff; };
const isLinkPlayer = (b) => b.length >= LP_SIZE && MAGIC.every((c, i) => b[i] === c && b[44 + i] === c);
const cmd = (c0, c1 = 0, c2 = 0) => [c0, c1, c2, 0, 0, 0, 0, 0];
const hex = (v) => (v & 0xffff).toString(16).padStart(4, '0');

export class ReverseTranslator {
    // leader: an RfuLeader on the board's host port. activity: the group to lead (4 trade,
    // 1 single battle, 2 double battle), which the other player must choose too.
    constructor({ leader, activity = 4, log = () => {} }) {
        this.leader = leader;
        this.activity = activity;
        this.log = log;
        this.bypassNationally = false;

        this.switchLP = null;        // 60 bytes, from the Switch's player exchange
        this.parentLP = null;        // 60 bytes, the other GBA's
        this.switchBattleLP = null;  // 28 bytes, at a battle's start
        this.leaderLPSent = false;
        this.leaderBattleLPSent = false;
        this.pull = null;            // the block type the leader asked the Switch for
        this.cableRequest = null;    // the parent's 0xCCCC waiting for the Switch's block
        this.heldRequests = [];      // requests that wait for the Switch's first round
        this.s1Done = false;
        this.otherChoice = null;     // the other GBA's link type when it chose another room
        this.refused = null;         // why the other GBA refuses the Switch's game, if it does
        this.parentSeen = null;      // the other GBA's latest LinkPlayer, refused or not
        this.lpPending = false;      // this side's LinkPlayer waits for the other GBA's
        this.lpWait = 0;
        this.exchangeDue = false;    // the Switch waits in the group for the player exchange
        this.parentEarly = null;     // the other GBA's first LinkPlayer, before the Switch's
        this.switchBlockAt = -Infinity;  // leader frame of the Switch's last whole block
        this.requestAt = 0;          // leader frame the request in this.pull went out, 0 not yet
        this.rerequests = 0;

        // The Cable Club's flow as this side sees it.
        this.linkType = ACTIVITY_LINK_TYPE[activity];
        this.next = NEXT.LOCAL;
        this.saveStandbys = 0;
        this.menuOutcome = null;     // the parent's START or BOTH_CANCEL in the trade menu
        this.afterTrade = false;     // the menu reopening after a trade is next
        this.quietUntil = 0;         // leader frame from which the Switch gets blocks again
        this.extraDeadline = 0;      // leader frame by which the Switch's extra round is due
        this.deferred = [];          // requests and blocks for the Switch, waiting for it
        this.inBattle = false;
        this.ended = false;

        // Pairing.
        this.switchRounds = [];      // counts of the Switch's 0x6600 rounds, waiting
        this.lastRound = -1;         // the Switch resends a round until answered
        this.step = null;            // { kind, done } sent here, awaiting the parent's
        this.parentSyncs = [];       // the parent's 0x2FFE / 0x5FFF, not yet matched
        this.reopenToken = false;    // a reopened link's LinkPlayer exchange completed
        this.battlePending = false;  // the Switch's battle LinkPlayer, its close not yet started
        this.exitPending = false;    // the Switch's 0x5F00, its close not yet started
        this.switchCloseCount = 0;

        // Cable session.
        this.expectParentLP = false;
        this.rxSize = 0;
        this.rxPos = 0;
        this.rxBuf = new Uint8Array(512);
        this.cq = [];
        this.live = false;           // the parent's link is open: commands can go
        this.held = [];              // commands for the parent while its link is closed
        this.keysToParent = false;
        this.keysToSwitch = false;
        this.keysAwaitSwitch = false;  // a reopened room: keys go to the Switch once it reports its own
        this.switchKeys = new KeyRuns();   // the Switch's reports, replayed at the cable's pace
        this.steps = new StepFollower((code) => this.switchKeys.push(code));
        this.parentKeys = new KeyQueue();
        this.keyStep = 1.5;
        this.keyPushes = 0;
        this.keyPops = 0;

        leader.onJoined = () => this.switchJoined();
        leader.onCommand = (words) => this.switchCommand(words);
        leader.onBlock = (count, data) => this.switchBlock(count, data);
        leader.keySource = () => (this.keysToSwitch ? this.parentKeys.pop() : null);
        leader.onTick = () => this.releaseDeferred();

        this.onReady = null;         // the Switch's player is known
        this.onOtherChoice = null;   // (linkType) the other GBA chose another room
        this.onRefused = null;       // (reason) the other GBA cannot trade with the Switch's game
    }

    // Ready once the Switch waits in the group ("Awaiting other members!"), where it waits for
    // as long as a person takes. Its player exchange starts only when the other GBA's player
    // comes: a Switch left waiting partway through the exchange gives up.
    get ready() { return this.leader.linked; }
    get battle() { return this.activity !== 4; }

    // The group the Switch joins, named for the other player once known.
    openGroup() {
        const name = this.parentLP ? this.parentLP.slice(24, 32) : PLACEHOLDER_NAME;
        const trainerId = this.parentLP ? le16(this.parentLP, 20) : 0;
        // Shown as FireRed so the Switch joins without its checks for other versions.
        const compatibility = 2 | (1 << 7) | (1 << 8) | (1 << 9) | (4 << 10);
        this.leader.open(leaderBeacon({ activity: this.activity, name, trainerId, compatibility }));
    }

    // ---- the Switch (wireless child)

    switchJoined() {
        this.log('the Switch is in the group: ready for the other GBA');
        this.exchangeDue = true;
        this.maybeStartExchange();
    }

    maybeStartExchange() {
        if (!this.exchangeDue || !(this.parentEarly || this.parentLP)) return;
        this.exchangeDue = false;
        this.log('the other GBA\'s player is here: exchanging players with the Switch');
        this.leader.playerIds();
        this.pull = 0;
        this.leader.request(0);
    }

    switchCommand(words) {
        const op = words[0] & 0xff00;
        if (op === 0x6600) {
            if (words[1] === 0xffff || words[1] === this.lastRound) return;   // 0xFFFF: the board answered it
            this.lastRound = words[1];
            this.switchRounds.push(words[1]);
            this.pair();
        } else if (op === 0x5f00) {
            if (this.exitPending || this.ended) return;
            this.switchCloseCount = words[1];
            this.exitPending = true;
            this.pair();
        } else if (op === 0xbe00) {
            if (this.keysAwaitSwitch) {
                this.keysAwaitSwitch = false;
                this.parentKeys.clear();
                this.keysToSwitch = true;
            }
            const code = words[1] & 0xff;
            this.steps.report(code, words[1] >> 8);
            if (this.keysToParent) this.keyPushes++;
        }
    }

    switchBlock(count, data) {
        this.switchBlockAt = this.leader.ticks;
        this.requestAt = 0;
        if (this.pull === 0 && isLinkPlayer(data)) {
            this.pull = null;
            if (!this.switchLP) {
                this.switchLP = data.slice(0, LP_SIZE);
                this.log('the Switch player is known');
                this.onReady?.();
            }
            if (this.parentEarly) {
                const early = this.parentEarly;
                this.parentEarly = null;
                this.parentBlock(early);
            }
            this.maybeLeaderLP();
            return;
        }
        if (!this.inBattle && count === Math.ceil(BATTLE_LP_SIZE / 12) && data[1] === 0x40 && data[0] >= 1 && data[0] <= 5) {
            this.switchBattleLP = data.slice(0, BATTLE_LP_SIZE);
            this.leaderBattleLPSent = false;
            this.log(`the Switch started the battle from spot ${data[0x18]}`);
            this.sendLeaderBattleLP();
            this.battlePending = true;
            this.pair();
            return;
        }
        if (this.pull !== null && this.cableRequest === this.pull) {
            const size = sizeFromRequest(this.pull);
            this.log(`the Switch answered request ${this.pull}`);
            this.pull = null;
            this.cableRequest = null;
            this.cablePushBlock(data.subarray(0, size), size);
            return;
        }
        const size = this.inBattle ? count * 12 : sizeFromCount(count);
        if (this.inBattle) this.log(`the Switch's battle block of ${size} bytes received`);
        this.cablePushBlock(data.subarray(0, size), size);
    }

    // The leader's LinkPlayer: the other GBA's, once it is known.
    maybeLeaderLP() {
        const parent = this.parentLP;
        if (this.leaderLPSent || !this.switchLP || !parent) return;
        this.leaderLPSent = true;
        const block = new Uint8Array(200);
        block.set(this.forSwitch(parent));
        block.fill(0, LP_LINK_TYPE, LP_LINK_TYPE + 4);
        this.leader.sendBlock(block);
        this.log('players exchanged both ways');
    }

    // The other GBA as the Switch sees it: Ruby and Sapphire as an Emerald that has
    // finished the game (FireRed checks nothing more for Emerald), the others as they are.
    // Over wireless the Switch's game checks no Sevii Islands progress, so the bypass
    // changes nothing here.
    forSwitch(lp) {
        const out = lp.slice(0, LP_SIZE);
        if (out[LP_VERSION] === 1 || out[LP_VERSION] === 2) {
            put16(out, LP_VERSION, 0x4000 | VERSION_EMERALD);
            out[LP_PROGRESS] = PROGRESS_CLEARED;
            out[LP_PROGRESS + 1] = 0;
            out[LP_PROGRESS + 2] = PROGRESS_CLEARED;
        }
        return out;
    }

    // The Switch's player as the other GBA sees it: as itself, a FireRed or LeafGreen, with
    // this side's link type.
    forParent() {
        const out = this.switchLP.slice(0, LP_SIZE);
        put16(out, LP_LINK_TYPE, this.linkType);
        out[LP_LINK_TYPE + 2] = 0; out[LP_LINK_TYPE + 3] = 0;
        // In the Colosseum the id is the spot each player stands on.
        if (this.linkType === LINKTYPE.BATTLE && this.switchBattleLP) out[LP_ID] = this.switchBattleLP[0x18];
        else if (this.battle) out[LP_ID] = this.parentSeen ? this.parentSeen[LP_ID] ^ 1 : 1;
        // With the bypass on, an Emerald parent whose player is Champion gets the Switch
        // player with the Sevii Islands story done; any other gets the Switch player as another
        // Emerald, whose trades it does not check (and draws as one).
        if (this.bypassNationally && !this.battle && this.parentSeen?.[LP_VERSION] === VERSION_EMERALD) {
            if (this.parentSeen[LP_PROGRESS] & PROGRESS_LINK_HOENN) {
                out[LP_PROGRESS] = PROGRESS_CLEARED;
                out[LP_PROGRESS + 2] = PROGRESS_CLEARED;
            } else {
                put16(out, LP_VERSION, 0x4000 | VERSION_EMERALD);
            }
        }
        return out;
    }

    // Why the other GBA's cable club will refuse the Switch's game, or null.
    refusal(lp) {
        if (this.battle || this.bypassNationally || lp[LP_VERSION] !== VERSION_EMERALD) return null;
        if (!(lp[LP_PROGRESS] & PROGRESS_LINK_HOENN)) return 'emerald-not-champion';
        if (!(this.switchLP[LP_PROGRESS] & PROGRESS_LINK_HOENN)) return 'switch-not-sevii';
        return null;
    }

    sendLeaderBattleLP() {
        if (this.leaderBattleLPSent || !this.parentLP) return;
        this.leaderBattleLPSent = true;
        const lp = this.forSwitch(this.parentLP);
        const out = lp.slice(16, 16 + BATTLE_LP_SIZE);
        put16(out, 0x14, LINKTYPE.BATTLE);
        out[0x16] = 0; out[0x17] = 0;
        out[0x18] = this.switchBattleLP ? this.switchBattleLP[0x18] ^ 1 : 0;
        this.leader.sendBlock(out);
    }

    // ---- pairing the Switch's rounds with the parent's

    pair() {
        for (;;) {
            if (!this.step && !this.startStep()) return;
            if (!this.step) continue;
            if (!this.parentSyncs.length) return;
            const got = this.parentSyncs.shift();
            const step = this.step;
            this.step = null;
            if (got !== step.kind) this.log(`the other GBA sent ${hex(got)} where this side sent ${hex(step.kind)}`);
            step.done();
        }
    }

    // Starts the next step from the Switch's side: false when there is none yet.
    startStep() {
        if (this.ended) return false;
        if (this.exitPending) {
            // The Switch's exit key, still on its way to the cable, goes first: the other GBA
            // leaves the room only on that key, and the close ends the keys.
            if (this.switchKeys.runs.some((run) => run.code === KEY_EXIT || run.code === KEY_READY)) return false;
            this.exitPending = false;
            return this.send(LINKCMD.READY_CLOSE_LINK, () => {
                this.log('both left the room');
                this.ended = true;
                this.leader.closeLink(this.switchCloseCount);
            });
        }
        if (this.battlePending) {
            this.battlePending = false;
            return this.send(LINKCMD.READY_CLOSE_LINK, () => {
                this.log('both started the battle');
                this.closed(LINKTYPE.BATTLE);
                this.inBattle = true;
                this.next = NEXT.REOPEN;
            });
        }
        if (!this.switchRounds.length) return false;
        const count = this.switchRounds[0];
        switch (this.next) {
            case NEXT.LOCAL:
                // Its first round follows the player exchange; the cable has none there.
                if (!this.leaderLPSent) return false;
                this.s1Done = true;
                this.answerSwitch(count, 'after the player exchange');
                this.next = NEXT.STANDBY;
                for (const type of this.heldRequests.splice(0)) this.requestFromSwitch(type);
                return true;
            case NEXT.REOPEN:
                if (!this.reopenToken) return false;
                this.reopenToken = false;
                this.answerSwitch(count, 'the other GBA has linked again');
                this.next = NEXT.CLOSE;
                if (this.afterTrade) {
                    this.afterTrade = false;
                    this.next = NEXT.EXTRA;
                    this.quietUntil = Infinity;
                    this.extraDeadline = this.leader.ticks + EXTRA_ROUND_DEADLINE;
                }
                return true;
            case NEXT.EXTRA:
                this.answerSwitch(count, 'the Switch\'s extra round after a trade');
                this.endExtra();
                return true;
        }
        // A standby or a close: the parent's own, if it came first, decides which.
        const guess = this.next === NEXT.STANDBY ? LINKCMD.READY_EXIT_STANDBY : LINKCMD.READY_CLOSE_LINK;
        const kind = this.parentSyncs[0] ?? guess;
        return this.send(kind, () => {
            if (kind === LINKCMD.READY_EXIT_STANDBY) {
                this.answerSwitch(count, 'standby on both');
                this.afterStandby();
            } else {
                this.answerSwitch(count, 'the link closes');
                this.afterClose();
            }
        });
    }

    // Sends this side's 0x2FFE or 0x5FFF; done() runs once the parent's has come.
    send(kind, done) {
        this.cablePush(cmd(kind));
        if (kind === LINKCMD.READY_CLOSE_LINK) {
            // Blocks from here on wait for the next link.
            this.live = false;
            this.keysToParent = false;
            this.keysToSwitch = false;
            this.keysAwaitSwitch = false;
        }
        this.step = { kind, done };
        return true;
    }

    answerSwitch(count, why) {
        this.switchRounds.shift();
        this.leader.standby(count);
        this.log(`standby round ${count}: ${why}`);
    }

    afterStandby() {
        if (this.linkType === LINKTYPE.TRADE_SCENE) {
            // The save after a trade: three standbys, then the close back to the menu.
            this.next = ++this.saveStandbys < SAVE_STANDBYS ? NEXT.STANDBY : NEXT.CLOSE;
            return;
        }
        // Into the room: keys until the next close. The other GBA may have walked in first;
        // its idle reports from before the Switch arrived are dropped, as it cannot move
        // until the Switch's keys come.
        this.next = NEXT.CLOSE;
        this.parentKeys.clear();
        this.steps.reset();
        this.keysToParent = true;
        this.keysToSwitch = true;
    }

    // A close for the next part of the flow: the link type of the link the parent opens next.
    afterClose() {
        switch (this.linkType) {
            case LINKTYPE.TRADE_MENU:
                if (this.menuOutcome === MENU.START) {
                    // Into the trade scene: its link comes without a round of the Switch's.
                    this.closed(LINKTYPE.TRADE_SCENE);
                    this.saveStandbys = 0;
                    this.next = NEXT.STANDBY;
                    return;
                }
                this.closed(this.menuOutcome === MENU.BOTH_CANCEL ? LINKTYPE.ROOM_AGAIN : LINKTYPE.TRADE_MENU);
                break;
            case LINKTYPE.TRADE_SCENE:
                this.closed(LINKTYPE.TRADE_MENU);
                this.afterTrade = true;
                break;
            case LINKTYPE.BATTLE:
                this.inBattle = false;
                this.closed(ACTIVITY_LINK_TYPE[this.activity]);
                break;
            default:
                this.closed(LINKTYPE.TRADE_MENU);
                break;
        }
        this.next = NEXT.REOPEN;
    }

    closed(nextLinkType) {
        this.live = false;
        this.linkType = nextLinkType;
        this.menuOutcome = null;
        this.reopenToken = false;
    }

    requestFromSwitch(type) {
        this.pull = type;
        this.cableRequest = type;
        this.rerequests = 0;
        this.quietUntil = Math.max(this.quietUntil, this.switchBlockAt + REQUEST_GAP_FRAMES);
        this.toSwitch(() => { this.leader.request(type); this.requestAt = this.leader.ticks; });
    }

    // A request the Switch has not started to answer is asked again.
    repeatRequest() {
        if (this.pull === null || !this.requestAt || this.leader.ticks - this.requestAt < REREQUEST_FRAMES) return;
        if (this.leader.recv && !this.leader.recv.done) return;
        if (this.rerequests >= REREQUESTS) { this.requestAt = 0; return; }
        this.rerequests++;
        this.requestAt = this.leader.ticks;
        this.leader.request(this.pull);
        this.log(`the Switch has not answered request ${this.pull}: asking again`);
    }

    // Requests and blocks for the Switch, in order; held through the quiet after a trade.
    toSwitch(send) {
        if (this.leader.ticks < this.quietUntil || this.deferred.length) this.deferred.push(send);
        else send();
    }

    endExtra() {
        this.next = NEXT.CLOSE;
        this.quietUntil = this.leader.ticks + AFTER_EXTRA_FRAMES;
    }

    releaseDeferred() {
        this.repeatRequest();
        if (this.next === NEXT.EXTRA && this.leader.ticks >= this.extraDeadline) {
            this.log('no extra round from the Switch after the trade: going on');
            this.endExtra();
        }
        if (!this.deferred.length || this.leader.ticks < this.quietUntil) return;
        for (const send of this.deferred.splice(0)) send();
    }

    // ---- the parent (cable)

    // A command for the parent. Held while its link is closed (from this side's close until
    // the next link's LinkPlayers), sent once it is open again.
    cablePush(words) {
        if (this.live) this.cq.push(words);
        else this.held.push(words);
    }

    // A block to the parent: INIT_BLOCK, then CONT_BLOCK chunks of seven words.
    cablePushBlock(data, size) {
        this.cablePush(cmd(LINKCMD.INIT_BLOCK, size, 1 + 128));
        for (let pos = 0; pos < size; pos += (CMD_WORDS - 1) * 2) {
            const words = [LINKCMD.CONT_BLOCK];
            for (let i = 0; i < CMD_WORDS - 1; i++) {
                const at = pos + i * 2;
                words.push((at < size ? data[at] ?? 0 : 0) | ((at + 1 < size ? data[at + 1] ?? 0 : 0) << 8));
            }
            this.cablePush(words);
        }
    }

    // A fresh cable link: the parent opened it (again).
    cableReset() {
        this.expectParentLP = false;
        this.rxSize = 0;
        this.cq = [];
        this.live = false;
        this.keysToParent = false;
    }

    gameCommand(words) {
        switch (words[0]) {
            case LINKCMD.SEND_LINK_TYPE:
                this.linkUp();
                break;
            case LINKCMD.INIT_BLOCK:
                this.rxSize = words[1] <= this.rxBuf.length ? words[1] : 0;
                this.rxPos = 0;
                break;
            case LINKCMD.CONT_BLOCK:
                if (!this.rxSize) break;
                for (let i = 0; i < CMD_WORDS - 1; i++) put16(this.rxBuf, this.rxPos + i * 2, words[1 + i]);
                this.rxPos += (CMD_WORDS - 1) * 2;
                if (this.rxPos >= this.rxSize) {
                    const size = this.rxSize;
                    this.rxSize = 0;
                    this.parentBlock(this.rxBuf.slice(0, size));
                }
                break;
            case LINKCMD.SEND_BLOCK_REQ:
                // The other GBA asks for the Switch's trainer card right after the LinkPlayers
                // and finishes its link-up ("Please enter") only with it. The Switch has it
                // ready once it has walked to its room, after its first round.
                if (!this.s1Done) this.heldRequests.push(words[1]);
                else this.requestFromSwitch(words[1]);
                break;
            case LINKCMD.READY_EXIT_STANDBY:
            case LINKCMD.READY_CLOSE_LINK:
                if (words[0] === LINKCMD.READY_CLOSE_LINK) { this.keysToParent = false; this.keysToSwitch = false; this.keysAwaitSwitch = false; }
                if ((this.otherChoice !== null || this.refused) && !this.parentLP) {
                    // The other GBA ends a link-up it refused: answered here.
                    if (words[0] === LINKCMD.READY_CLOSE_LINK) this.cablePush(cmd(LINKCMD.READY_CLOSE_LINK));
                    break;
                }
                this.parentSyncs.push(words[0]);
                this.pair();
                break;
            case LINKCMD.SEND_HELD_KEYS:
                this.parentKeys.push(words[1] & 0xff);
                break;
        }
    }

    // The parent's 0x2222: everyone sends a LinkPlayer with their own link type.
    linkUp() {
        this.expectParentLP = true;
        // The Switch's player comes once the other GBA's has started its exchange.
        if (!this.switchLP) { this.lpPending = true; this.lpWait = 0; return; }
        // On the first link the other GBA's LinkPlayer decides how the Switch's is shown.
        // A GBA parent sends its own with the 0x2222 and waits well past this delay.
        if (!this.parentLP) { this.lpPending = true; this.lpWait = 0; return; }
        this.sendOwnLP();
    }

    sendOwnLP() {
        if (!this.switchLP) return;
        this.lpPending = false;
        this.live = true;
        this.cablePushBlock(this.forParent(), LP_SIZE);
        this.cq.push(...this.held.splice(0));
    }

    parentBlock(data) {
        if (this.expectParentLP && isLinkPlayer(data)) {
            // Its checks need the Switch's player, which its arrival lets the Switch send.
            if (!this.switchLP) {
                this.parentEarly = data.slice(0, LP_SIZE);
                this.maybeStartExchange();
                return;
            }
            this.expectParentLP = false;
            const type = le16(data, LP_LINK_TYPE);
            this.parentSeen = data.slice(0, LP_SIZE);
            if (this.lpPending) this.sendOwnLP();
            if (!this.parentLP && type !== this.linkType) {
                // The other GBA says the link partners made different selections.
                this.otherChoice = type;
                this.log(`the other GBA chose link type ${hex(type)}, this side ${hex(this.linkType)}`);
                this.onOtherChoice?.(type);
                return;
            }
            this.otherChoice = null;
            const refusal = this.parentLP ? null : this.refusal(data);
            if (refusal !== this.refused) {
                this.refused = refusal;
                this.onRefused?.(refusal);
            }
            if (refusal) {
                // Its game says so and closes the link. The Switch is not let in: its
                // wireless link is dropped before it gets the other player.
                this.log(refusal === 'emerald-not-champion'
                    ? 'Emerald trades with FireRed and LeafGreen only after its player is Champion'
                    : 'Emerald trades with the Switch\'s game only after it has finished the Sevii Islands story');
                this.leader.close();
                return;
            }
            if (!this.parentLP) this.parentLP = data.slice(0, LP_SIZE);
            this.log(`the other GBA's player is in (version ${hex(le16(data, LP_VERSION))}, link type ${hex(type)})`);
            if (!this.leaderLPSent) this.maybeLeaderLP();
            else if (this.linkType !== LINKTYPE.TRADE_SCENE) {
                // A reopened link: the Switch's round waiting for it can pass, and in a room
                // the keys go on.
                this.reopenToken = true;
                if (this.linkType !== LINKTYPE.BATTLE && this.linkType !== LINKTYPE.TRADE_MENU) {
                    this.steps.reset();
                    this.keysToParent = true;
                    // Keys reach the Switch once it reports its own: after a battle it may
                    // still be saving, and every key frame then waits in its 20-slot receive
                    // queue until it overflows and the link is lost.
                    this.keysToSwitch = false;
                    this.keysAwaitSwitch = true;
                }
            }
            this.pair();
            return;
        }
        // The parent's own answer to its request, or its trade-menu and battle blocks.
        if (data.length === 20 && this.linkType === LINKTYPE.TRADE_MENU) {
            const command = le16(data, 0);
            if (command === MENU.START || command === MENU.BOTH_CANCEL) this.menuOutcome = command;
        }
        const request = this.cableRequest;
        const size = request !== null ? sizeFromRequest(request) : data.length;
        const block = new Uint8Array(size === MENU_BLOCK_SIZE && !this.inBattle ? MENU_BLOCK_SENT : size);
        block.set(data.subarray(0, size));
        if (this.inBattle) this.log(`sending a battle block of ${size} bytes`);
        this.toSwitch(() => this.leader.sendBlock(block));
    }

    // The next command for the parent, or null for none this packet.
    nextCommand() {
        if (this.lpPending && ++this.lpWait >= LP_WAIT_PACKETS) this.sendOwnLP();
        if (this.cq.length) return this.cq.shift();
        if (!this.keysToParent) return null;
        if (++this.keyPops >= KEY_RATE_WINDOW) {
            this.keyStep = Math.min(3, Math.max(1, this.keyPushes / this.keyPops));
            this.keyPushes = this.keyPops = 0;
        }
        const key = cmd(LINKCMD.SEND_HELD_KEYS, this.switchKeys.pop(this.keyStep) ?? KEY_EMPTY);
        if (this.exitPending && !this.step) this.pair();
        return key;
    }
}
