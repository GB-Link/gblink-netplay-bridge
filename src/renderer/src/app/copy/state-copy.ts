import type { CableSelection, CloseReason, Console, LinkGame, LinkPhase } from '../../../../engine/types';
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
  init: 'Preparing the adapter…',
  starting: 'Starting the link proxy…',
  linked: 'Link proxy running',
  'partner-quiet': 'Other player quiet — link stays up',
  'room-open': 'Leading a wireless room — waiting for players to join',
};

/** Device-state copy for the Advance Wars flow (no Cable Club vocabulary). */
const AW_DEVICE_STATE_COPY: Partial<Record<DeviceStateName, string>> = {
  'awaiting-gba': 'Adapter ready — assigning the link role',
  'handshake-received': 'Adapter armed — starting the link proxy',
  'link-connected': 'Link proxy running — the GBA can link any time',
  reconnecting: 'Other player quiet — link proxy still running',
};

/** Device-state copy for the wireless adapter mode. */
const RFU_DEVICE_STATE_COPY: Partial<Record<DeviceStateName, string>> = {
  'device-ready': 'Adapter ready — starting the wireless adapter',
  'awaiting-gba': 'Wireless adapter live — the GBA can open the Wireless Communication menu',
  'handshake-received': 'Wireless adapter live',
  'link-connected': 'Wireless adapter live — network traffic flowing',
  reconnecting: 'Nothing from the network for a few seconds — the adapter stays live',
};

/** Device-state copy when the Switch's cable link is bridged (no adapter involved). */
const SWITCH_DEVICE_STATE_COPY: Partial<Record<DeviceStateName, string>> = {
  'device-ready': 'ESP32 bridge ready',
  'awaiting-gba': 'Waiting for the Switch to open or join a room',
  'handshake-received': 'The Switch is ready — waiting for the remote player',
  'link-connected': 'Link active — the Switch is talking to the remote player',
  reconnecting: 'Link between activities — the games renegotiate',
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

export function deviceStateText(state: string, game: LinkGame = 'gen3', console: Console = 'gba'): string {
  const special =
    console === 'switch' && game === 'gen3'
      ? SWITCH_DEVICE_STATE_COPY
      : game === 'rfu'
        ? RFU_DEVICE_STATE_COPY
        : game !== 'gen3'
          ? AW_DEVICE_STATE_COPY
          : null;
  const text = special?.[state as DeviceStateName];
  if (text) return text;
  return lookup(DEVICE_STATE_COPY, state);
}

export function linkPhaseText(phase: string): string {
  return lookup(LINK_PHASE_COPY, phase);
}

/**
 * Peer-aware link banner: never says "waiting for a partner" while a peer is
 * connected, and reads as connected whenever the physical relay is live.
 */
export function linkStatusText(
  phase: string,
  peerCount: number,
  peerNick?: string,
  game: LinkGame = 'gen3',
  console: Console = 'gba',
  room: string | null = null,
  joining = false,
): string {
  const partner = peerNick || 'partner';
  const player = console === 'switch' ? 'the Switch' : 'the GBA';
  if (game === 'rfu') {
    switch (phase) {
      case 'idle':
        return console === 'switch' ? 'Waiting for the ESP32 bridge…' : 'Waiting for the wireless adapter…';
      case 'searching':
        return peerCount > 0
          ? `Wireless adapter live — lead a group on ${player} or join one of ${partner}'s`
          : joining
            ? 'Wireless adapter live — joining the session…'
            : 'Wireless adapter live — waiting for other players to join the session';
      case 'room-open':
        return `${player} is leading a room — the others can join it now`;
      case 'handshake':
        return 'Joining a room…';
      case 'connected':
        return room ? `In ${room}'s room` : `Linked — ${player} is in a room`;
      case 'closing':
        return 'Link restarting…';
      case 'closed':
        return 'Link closed';
      default:
        return lookup(LINK_PHASE_COPY, phase);
    }
  }
  if (game !== 'gen3') {
    const title = game === 'aw2' ? 'Advance Wars 2' : 'Advance Wars';
    switch (phase) {
      case 'idle':
        return 'No link activity';
      case 'init':
        return 'Preparing the adapter…';
      case 'starting':
        return 'Starting the link proxy…';
      case 'linked':
        return peerCount > 0
          ? `Linked with ${partner} — open VS Link / Multiplayer in ${title} on both sides`
          : joining
            ? 'Ready — joining the session…'
            : 'Ready — waiting for the other player to join the session';
      case 'partner-quiet':
        return `${partner} has been quiet for a few seconds — the link stays up`;
      case 'closing':
        return 'Link restarting…';
      case 'closed':
        return 'Link closed';
      default:
        return lookup(LINK_PHASE_COPY, phase);
    }
  }
  if (console === 'switch') {
    switch (phase) {
      case 'idle':
        return 'Waiting for the ESP32 bridge…';
      case 'searching':
        return peerCount > 0
          ? `${partner} is online — on the Switch, lead a Trade Center or Colosseum group (or join the one the bridge opens)`
          : 'Waiting for the Switch — open the Direct Corner upstairs in a Pokémon Center';
      case 'cable-club':
        return peerCount > 0 ? `The Switch is ready — linking with ${partner}…` : 'The Switch is ready — waiting for a partner to join';
      case 'handshake':
        return `Linking with ${partner}…`;
      case 'connected':
        return peerCount > 0 ? `Connected — the Switch is linked with ${partner}` : 'Connected';
      case 'closing':
        return 'Visit over — on the Switch, leave the group, then lead or join one again for the next visit';
      case 'closed':
        return 'Link closed';
      default:
        return phase;
    }
  }
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

export function cableSelectionText(selection: CableSelection | undefined): string {
  switch (selection) {
    case 'gba':
      return 'GBA cable (stored on the adapter)';
    case 'gbc':
      return 'GBC cable (stored on the adapter)';
    case 'auto':
      return 'Automatic';
    default:
      return 'Automatic (older firmware)';
  }
}
