/**
 * Types for GB-Link-Switch-LDN web/js/cable/translator.js (vendored unchanged): a cable-only
 * game's Cable Club link as player 0 (the parent), played as an FRLG child in the Switch's room.
 */

export const CMD_WORDS: 8;

export const LINKCMD: {
  SEND_LINK_TYPE: 0x2222;
  READY_EXIT_STANDBY: 0x2ffe;
  READY_CLOSE_LINK: 0x5fff;
  CONT_BLOCK: 0x8888;
  INIT_BLOCK: 0xbbbb;
  SEND_HELD_KEYS: 0xcafe;
  SEND_BLOCK_REQ: 0xcccc;
};

export function sizeFromCount(count: number): number;
export function sizeFromRequest(type: number): number;

export class KeyRuns {
  runs: { code: number; count: number }[];
  push(code: number): void;
  readonly frames: number;
  pop(step: number): number;
  clear(): void;
}

export class KeyQueue {
  push(code: number): void;
  pop(): number;
  readonly count: number;
  clear(): void;
}

/** An RFU1 frame from the board, as the page's FrameReader hands them over. */
export interface BoardFrame {
  type: number;
  header: number;
  frame: Uint8Array;
}

export interface CableTranslatorOptions {
  /** One child frame (LLSF header and data) for the board. */
  send: (payload: Uint8Array) => void;
  connect: (devid: number) => void;
  disconnect: () => void;
  log?: (message: string) => void;
  /** Join only once the cable opens (cableReset), under the name "CELIO". */
  holdJoin?: boolean;
}

export class CableTranslator {
  constructor(options: CableTranslatorOptions);
  bypassNationally: boolean;
  activity: number;
  hostNotReady: boolean;
  refusing: boolean;
  groupSeen: boolean;
  severalRooms: boolean;
  onLinked: ((linked: boolean) => void) | null;
  readonly linked: boolean;
  readonly readyToLink: boolean;
  readonly joined: boolean;
  readonly gameVersion: number;
  readonly dressed: boolean;
  readonly haveRubyLP: boolean;
  readonly haveHostLP: boolean;
  boardFrame(frame: BoardFrame): void;
  /** Once per GBA frame. */
  frame(): void;
  /** The game opened its cable link from scratch. */
  cableReset(): void;
  /** A command the game sent (eight words). */
  gameCommand(command: ArrayLike<number>): void;
  /** The next command for the game, or null for none this packet. */
  nextCommand(): number[] | null;
}
