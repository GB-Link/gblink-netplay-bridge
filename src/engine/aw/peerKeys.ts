import { AwState, type Maw1Frame } from './maw1';

/**
 * Command of a key frame that is one part of a longer press: the adapter cuts a press every
 * 120 transfers, and the next key frame goes on with it. gpsp reads no command on key frames.
 */
export const KEYS_CONTINUE = 0xfffe;

function hasKeys(frame: Maw1Frame): boolean {
  return frame.state === AwState.Intersync && frame.cnt > 0;
}

/**
 * The adapter's key frames as a gpsp peer takes them. gpsp replays the presses it holds back to
 * back and shows the keys released once it runs out, and it drops a press of one word.
 */
export class PeerKeys {
  /** The first part of a long press, kept until the press's next frame is there to follow it. */
  private kept: Maw1Frame | null = null;
  private inLongPress = false;

  /** The frames to send for one frame of the adapter, in order. */
  toPeer(frame: Maw1Frame): Maw1Frame[] {
    const part = hasKeys(frame) && frame.cmd === KEYS_CONTINUE;
    const first = part && !this.inLongPress;
    this.inLongPress = part;
    if (first) {
      // Parts come as fast as gpsp replays them: sent alone, each next part would arrive just
      // after gpsp ran out, and the held keys would read as released and pressed again.
      this.kept = frame;
      return [];
    }
    const out = this.kept ? [this.kept] : [];
    this.kept = null;
    if (hasKeys(frame) && frame.cnt === 1) {
      // gpsp takes a press from two words up: the second shows the keys released.
      const word = frame.words[0]!;
      out.push({ ...frame, cnt: 2, words: Uint16Array.of(word, word & 0xfc00) });
    } else {
      out.push(frame);
    }
    return out;
  }

  reset(): void {
    this.kept = null;
    this.inLongPress = false;
  }
}
