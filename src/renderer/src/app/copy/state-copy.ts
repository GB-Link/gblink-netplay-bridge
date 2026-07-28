import type { CloseReason, LinkPhase } from '../../../../engine/types';
import type { DeviceStateName, SessionPhase } from '../../../../shared/ipc';

const DEVICE_STATE_COPY: Record<DeviceStateName, string> = {
  absent: 'GB-Link adapter not detected — plug it in via USB',
  present: 'GB-Link adapter connected — ready',
  'device-ready': 'Adapter ready — waiting for the GBA',
  'awaiting-gba': 'Waiting for the GBA to enter the Cable Club',
  'handshake-received': 'GBA entered the Cable Club — waiting for partner',
  'link-connected': 'Link active — GBA is talking to the remote player',
  reconnecting: 'Link dropped — reconnecting…',
  closed: 'Link closed',
  'access-denied': 'Adapter found, but USB access was denied',
};

const LINK_PHASE_COPY: Record<LinkPhase, string> = {
  idle: 'No link activity',
  searching: 'Searching for a partner…',
  'cable-club': 'GBA is in the Cable Club — waiting for the remote player',
  handshake: 'Handshaking with the remote player…',
  connected: 'Link established — both players in the Cable Club',
  closing: 'Link closing…',
  closed: 'Link closed',
};

const SESSION_PHASE_COPY: Record<SessionPhase, string> = {
  idle: 'Not connected',
  connecting: 'Connecting to host…',
  'relay-connecting': 'Connecting through relay…',
  handshaking: 'Negotiating netplay session…',
  connected: 'Connected to session',
  hosting: 'Hosting — waiting for players',
  closed: 'Session closed',
};

const CLOSE_REASON_COPY: Record<CloseReason, string> = {
  graceful: 'Session ended',
  'socket-closed': 'The connection was closed by the remote side',
  'socket-error': 'Network error — the connection was lost',
  full: 'This session is full',
  banned: 'This host has banned you',
  nak: 'The host rejected the connection',
  'wrong-password': 'Wrong password',
  'protocol-version': 'Netplay protocol version mismatch — update one side',
  'core-mismatch': 'The host is running a different core',
  refused: 'The host refused the connection',
  'bad-client-id': 'Protocol error (bad client id)',
  'relay-error': 'The relay reported an error',
};

function lookup(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

export function deviceStateText(state: string): string {
  return lookup(DEVICE_STATE_COPY, state);
}

export function linkPhaseText(phase: string): string {
  return lookup(LINK_PHASE_COPY, phase);
}

/**
 * Peer-aware link banner: never says "waiting for a partner" while a peer is
 * connected, and reads as connected whenever the physical relay is live.
 */
export function linkStatusText(phase: string, peerCount: number, peerNick?: string): string {
  const partner = peerNick || 'partner';
  switch (phase) {
    case 'idle':
      return 'No link activity';
    case 'searching':
      return peerCount > 0
        ? `${partner} is online — take the GBA to the Cable Club`
        : 'Waiting for the GBA — enter the Cable Club in any Pokémon Center';
    case 'cable-club':
      return peerCount > 0
        ? `In the Cable Club — linking with ${partner}…`
        : 'GBA is in the Cable Club — waiting for a partner to join';
    case 'handshake':
      return `Linking with ${partner}…`;
    case 'connected':
      return peerCount > 0
        ? `Connected — in the Cable Club with ${partner}`
        : 'Connected — in the Cable Club';
    case 'closing':
      return 'Link closing…';
    case 'closed':
      return 'Link closed';
    default:
      return phase;
  }
}

export function sessionStatusText(phase: string, peerCount: number): string {
  if (phase === 'hosting' && peerCount > 0) {
    return `Hosting — ${peerCount} player${peerCount > 1 ? 's' : ''} connected`;
  }
  return lookup(SESSION_PHASE_COPY, phase);
}

export function sessionPhaseText(phase: string): string {
  return lookup(SESSION_PHASE_COPY, phase);
}

export function closeReasonText(reason: string): string {
  return lookup(CLOSE_REASON_COPY, reason);
}

// Firmware enum CableType: GBA = 0, GBC = 1 (linkLayer.h). The firmware only
// samples the pin at link-mode entry, so the value exists per session; a
// floating (unplugged) cable pin reads the same as GBC. Either cable works
// for GBA cable link — detection just selects which pin carries SD.
export function cableTypeText(cableType: number | null): string {
  if (cableType === null) return 'detected when the link starts';
  if (cableType === 0) return 'GBA cable';
  if (cableType === 1) return 'GBC cable (or none attached)';
  return `cable type ${cableType}`;
}

export function firmwareText(fw: { major: number; minor: number; patch: number } | null): string {
  return fw ? `v${fw.major}.${fw.minor}.${fw.patch}` : '—';
}
