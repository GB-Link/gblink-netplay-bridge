import type { Console, LinkGame, SwitchRoom } from '../engine/types';

export const GAME_LABELS: Record<LinkGame, string> = {
  gen3: 'Pokémon Gen 3 · Link cable',
  rfu: 'Pokémon Gen 3 · Wireless Adapter',
  aw1: 'Advance Wars',
  aw2: 'Advance Wars 2',
};

export const GAME_BADGES: Record<LinkGame, string> = {
  gen3: 'Cable',
  rfu: 'Wireless',
  aw1: 'AW1',
  aw2: 'AW2',
};

/** Lobby/LAN game name announced when the host leaves the field blank. */
export const DEFAULT_GAME_NAMES: Record<LinkGame, string> = {
  gen3: 'Pokemon Ruby',
  rfu: 'Pokemon FireRed',
  aw1: 'Advance Wars',
  aw2: 'Advance Wars 2 - Black Hole Rising',
};

export const CONSOLE_LABELS: Record<Console, string> = {
  gba: 'Game Boy Advance',
  switch: 'Nintendo Switch',
};

export const SWITCH_ROOM_LABELS: Record<SwitchRoom, string> = {
  trade: 'Trade Center',
  single: 'Colosseum · single battle',
  double: 'Colosseum · double battle',
};

export const CONSOLE_GAMES: Record<Console, LinkGame[]> = {
  gba: ['gen3', 'rfu', 'aw1', 'aw2'],
  switch: ['gen3', 'rfu'],
};

export function isLinkGame(v: unknown): v is LinkGame {
  return v === 'gen3' || v === 'rfu' || v === 'aw1' || v === 'aw2';
}

export function isConsole(v: unknown): v is Console {
  return v === 'gba' || v === 'switch';
}

export function isSwitchRoom(v: unknown): v is SwitchRoom {
  return v === 'trade' || v === 'single' || v === 'double';
}

/** The gpsp core option each link protocol needs on the RetroArch side. */
export const GPSP_SERIAL_OPTION: Record<LinkGame, string> = {
  gen3: 'Link Cable - Pokemon Gen3 mode',
  rfu: 'GBA Wireless Adapter',
  aw1: 'Link Cable - Advance Wars 1 mode',
  aw2: 'Link Cable - Advance Wars 2 mode',
};

/** Best-effort game family from a lobby room's content name, which can't tell Pokémon cable from wireless. */
export function gameFromRoomName(name: string): LinkGame | 'pokemon' | null {
  if (/advance\s*wars\s*2|black\s*hole/i.test(name)) return 'aw2';
  if (/advance\s*wars/i.test(name)) return 'aw1';
  if (/pok[eé]mon/i.test(name)) return 'pokemon';
  return null;
}

export function badgeForRoom(name: string): string | null {
  const family = gameFromRoomName(name);
  if (family === null) return null;
  return family === 'pokemon' ? 'Pokémon' : GAME_BADGES[family];
}

/** The game to select for a lobby room, keeping the player's cable/wireless choice for Pokémon. */
export function gameForRoom(name: string, current: LinkGame): LinkGame | null {
  const family = gameFromRoomName(name);
  if (family === null) return null;
  if (family === 'pokemon') return current === 'rfu' ? 'rfu' : 'gen3';
  return family;
}
