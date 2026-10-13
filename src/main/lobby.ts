import type { LobbyRoom } from '../shared/ipc';
import { gameFromRoomName } from '../shared/games';

export const LOBBY_BASE = 'http://lobby.libretro.com/';

export interface TunnelEndpoint {
  addr: string;
  port: number;
}

export interface AnnounceBody {
  username: string;
  coreName: string;
  coreVersion: string;
  gameName: string;
  /** 8 uppercase hex digits. */
  gameCrc: string;
  port: number;
  mitmServer: string;
  mitmSession: string;
  mitmCustomAddr?: string;
  mitmCustomPort?: number;
  hasPassword: boolean;
  hasSpectatePassword: boolean;
  forceMitm: boolean;
  retroarchVersion: string;
  frontend: string;
  subsystemName: string;
  playerCount: number;
  spectatorCount: number;
}

export interface AnnounceResult {
  id?: number;
  connectable?: boolean;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  return v == null ? '' : String(v);
}

function asNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'True';
}

export function versionAtLeast(version: string, min: string): boolean {
  const parse = (s: string): number[] => s.trim().split('.').map((p) => parseInt(p, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function normalizeRoom(item: unknown): LobbyRoom | null {
  const wrapped =
    item !== null && typeof item === 'object' && 'fields' in item
      ? (item as { fields: unknown }).fields
      : item;
  if (wrapped === null || typeof wrapped !== 'object') return null;
  const f = wrapped as Record<string, unknown>;

  const coreName = asString(f['core_name']);
  const retroarchVersion = asString(f['retroarch_version']);
  const connectable = f['connectable'] === undefined ? true : asBool(f['connectable']);
  const isRetroarch = f['is_retroarch'] === undefined ? true : asBool(f['is_retroarch']);

  return {
    username: asString(f['username']),
    gameName: asString(f['game_name']),
    gameCrc:
      typeof f['game_crc'] === 'number'
        ? f['game_crc']
        : parseInt(asString(f['game_crc']), 16) || 0,
    coreName,
    coreVersion: asString(f['core_version']),
    ip: asString(f['ip']),
    port: asNumber(f['port']),
    hasPassword: asBool(f['has_password']),
    hasSpectatePassword: asBool(f['has_spectate_password']),
    mitmIp: asString(f['mitm_ip']),
    mitmPort: asNumber(f['mitm_port']),
    mitmSession: asString(f['mitm_session']),
    hostMethod: asNumber(f['host_method']),
    retroarchVersion,
    country: asString(f['country']),
    frontend: asString(f['frontend']),
    connectable,
    isRetroarch,
    playerCount: asNumber(f['player_count']),
    spectatorCount: asNumber(f['spectator_count']),
    joinable:
      isRetroarch &&
      connectable &&
      coreName.toLowerCase() === 'gpsp' &&
      versionAtLeast(retroarchVersion, '1.9.1'),
    game: gameFromRoomName(asString(f['game_name'])) ?? undefined,
  };
}

export async function fetchRooms(base: string = LOBBY_BASE): Promise<LobbyRoom[]> {
  const res = await fetch(base + 'list');
  if (!res.ok) throw new Error(`lobby list failed: HTTP ${res.status}`);
  const json: unknown = await res.json();
  if (!Array.isArray(json)) return [];
  return json
    .map((item) => normalizeRoom(item))
    .filter((room): room is LobbyRoom => room !== null);
}

function parseKeyValueLines(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return map;
}

export async function resolveTunnel(
  handle: string,
  base: string = LOBBY_BASE,
): Promise<TunnelEndpoint> {
  const res = await fetch(base + 'tunnel?name=' + encodeURIComponent(handle));
  if (!res.ok) throw new Error(`tunnel lookup for "${handle}" failed: HTTP ${res.status}`);
  const kv = parseKeyValueLines(await res.text());
  const addr = kv.get('tunnel_addr');
  const port = Number(kv.get('tunnel_port'));
  if (!addr || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`tunnel "${handle}" did not resolve to an address`);
  }
  return { addr, port };
}

export async function announce(
  body: AnnounceBody,
  base: string = LOBBY_BASE,
): Promise<AnnounceResult> {
  const form = new URLSearchParams({
    username: body.username,
    core_name: body.coreName,
    core_version: body.coreVersion,
    game_name: body.gameName,
    game_crc: body.gameCrc,
    port: String(body.port),
    mitm_server: body.mitmServer,
    has_password: body.hasPassword ? '1' : '0',
    has_spectate_password: body.hasSpectatePassword ? '1' : '0',
    force_mitm: body.forceMitm ? '1' : '0',
    retroarch_version: body.retroarchVersion,
    frontend: body.frontend,
    subsystem_name: body.subsystemName,
    mitm_session: body.mitmSession,
    mitm_custom_addr: body.mitmCustomAddr ?? '',
    mitm_custom_port: String(body.mitmCustomPort ?? 0),
    player_count: String(body.playerCount),
    spectator_count: String(body.spectatorCount),
  });
  const res = await fetch(base + 'add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`lobby announce failed: HTTP ${res.status}`);
  const kv = parseKeyValueLines(await res.text());
  const result: AnnounceResult = {};
  const id = kv.get('id');
  if (id !== undefined && id !== '' && Number.isFinite(Number(id))) result.id = Number(id);
  const connectable = kv.get('connectable');
  if (connectable !== undefined) {
    result.connectable = connectable === '1' || connectable.toLowerCase() === 'true';
  }
  return result;
}
