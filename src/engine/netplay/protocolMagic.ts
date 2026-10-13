import type { LinkGame } from '../types';

/** The gpsp netpacket family a buffer belongs to, by its 4-byte magic. */
export type PacketProtocol = 'mpk1' | 'rfu1' | 'maw1';

const MAGICS: [string, PacketProtocol][] = [
  ['MPK1', 'mpk1'],
  ['RFU1', 'rfu1'],
  ['MAW1', 'maw1'],
];

export function identifyPacket(buf: Buffer): PacketProtocol | null {
  if (buf.length < 4) return null;
  const magic = buf.toString('latin1', 0, 4);
  return MAGICS.find(([m]) => m === magic)?.[1] ?? null;
}

export function protocolOf(game: LinkGame): PacketProtocol {
  if (game === 'gen3') return 'mpk1';
  if (game === 'rfu') return 'rfu1';
  return 'maw1';
}

const PROTOCOL_GAME: Record<PacketProtocol, string> = {
  mpk1: 'Pokémon Gen 3 · Link cable',
  rfu1: 'Pokémon Gen 3 · Wireless Adapter',
  maw1: 'Advance Wars',
};

/** The lobby doesn't say which link mode a gpSP host runs, so a mismatch shows only in its packets. */
export function mismatchWarning(game: LinkGame, seen: PacketProtocol): string {
  return `the other player's packets are ${PROTOCOL_GAME[seen]} ones, but this session is ${PROTOCOL_GAME[protocolOf(game)]} — stop and pick the game the host runs`;
}
