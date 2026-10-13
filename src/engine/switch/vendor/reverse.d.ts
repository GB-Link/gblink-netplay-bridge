/**
 * Types for GB-Link-Switch-LDN web/js/cable/reverse.js (vendored unchanged): the child's side of
 * a cable link (the other GBA is the parent, player 0) led as a wireless group the Switch joins.
 */

import type { RfuLeader } from './leader.js';

export interface ReverseTranslatorOptions {
  leader: RfuLeader;
  /** The group to lead: 4 trade, 1 single battle, 2 double battle. */
  activity?: number;
  log?: (message: string) => void;
}

export class ReverseTranslator {
  constructor(options: ReverseTranslatorOptions);
  bypassNationally: boolean;
  activity: number;
  switchLP: Uint8Array | null;
  parentLP: Uint8Array | null;
  otherChoice: number | null;
  refused: string | null;
  ended: boolean;
  onReady: (() => void) | null;
  onOtherChoice: ((linkType: number) => void) | null;
  onRefused: ((reason: string | null) => void) | null;
  /** The Switch waits in the group. */
  readonly ready: boolean;
  readonly battle: boolean;
  openGroup(): void;
  /** A fresh cable link: the parent opened it (again). */
  cableReset(): void;
  gameCommand(words: ArrayLike<number>): void;
  /** The next command for the parent, or null for none this packet. */
  nextCommand(): number[] | null;
}
