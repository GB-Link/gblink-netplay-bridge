// The Switch player's held keys as a cable GBA should see them. In a link room a direction
// key reaching an idle avatar starts a one-tile step of 16 frames; keys are ignored until it
// ends, and a key present on the first idle frame starts the next. A GBA clears a partner's
// key every frame, so the late tail of a hold (the cable's pace and the network stretch it)
// can reach it just after the step and start one the Switch never took.
//
// This follows the Switch's own avatar through its key frames and passes each step's
// direction on at once, for a window at the step's start, then no key for the rest of the
// step. A GBA over Celio gets a command on only about two frames in three and pauses a frame
// at some step ends, so it falls behind in a walk: the window grows with each step of a
// walk, always ending before the step does.

const STEP_FRAMES = 16;
const WINDOW_FRAMES = 4;        // a step's direction for a GBA a little behind
const DRIFT_PER_STEP = 1.1;     // frames a GBA falls behind per step of a walk
const MAX_WINDOW = 14;
const MAX_GAP = 8;              // frames filled in from the reports' counter
const KEY = { EMPTY: 0x11, DOWN: 0x12, UP: 0x13, LEFT: 0x14, RIGHT: 0x15, READY: 0x16, EXIT: 0x17 };

const isDirection = (code) => code >= KEY.DOWN && code <= KEY.RIGHT;
const isLinkState = (code) => code === KEY.READY || code === KEY.EXIT;

export class StepFollower {
    // out(code): one key frame for the GBA.
    constructor(out) {
        this.out = out;
        this.reset();
    }

    reset() {
        this.left = 0;          // frames left in the Switch avatar's step, 0 idle
        this.age = 0;           // frames into the step
        this.dir = 0;           // the step's direction
        this.window = 0;        // frames of the step that carry its direction
        this.chain = 0;         // steps in the current walk, one after another
        this.counter = -1;
        this.last = KEY.EMPTY;
    }

    // One report: the key code and the Switch's frame counter (8 bits).
    report(code, counter) {
        let frames = 1;
        if (this.counter >= 0) {
            const gap = (counter - this.counter) & 0xff;
            frames = gap >= 1 && gap <= MAX_GAP ? gap : 1;
        }
        this.counter = counter;
        // Frames the board did not pass on held the last key.
        for (let i = 1; i < frames; i++) this.frame(this.last);
        this.frame(code);
        this.last = code;
    }

    frame(code) {
        if (isLinkState(code)) {
            // Taking a seat or leaving goes out as it comes.
            this.out(code);
        } else if (this.left === 0) {
            if (isDirection(code)) {
                // A step straight after the last one continues the walk.
                this.chain = this.age === STEP_FRAMES ? this.chain + 1 : 1;
                this.left = STEP_FRAMES;
                this.age = 0;
                this.dir = code;
                this.window = Math.min(MAX_WINDOW, WINDOW_FRAMES + Math.round(DRIFT_PER_STEP * (this.chain - 1)));
            } else {
                this.chain = 0;
            }
            this.out(code);
        } else {
            // Mid-step the Switch ignores keys; the GBA gets the step's direction while it
            // may still be starting it.
            this.out(this.age < this.window ? this.dir : KEY.EMPTY);
        }
        if (this.left > 0) this.left--;
        this.age++;
    }
}
