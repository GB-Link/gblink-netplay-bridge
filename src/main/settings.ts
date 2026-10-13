import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppSettings } from '../shared/ipc';
import { isConsole, isLinkGame, isSwitchRoom } from '../shared/games';

export const DEFAULT_SETTINGS: AppSettings = {
  nick: 'Anonymous',
  defaultPort: 55435,
  game: 'gen3',
  console: 'gba',
  switchRoom: 'trade',
  nationalBypass: false,
  lastAddress: '',
  hostPort: 55435,
  announce: true,
  gameName: 'Pokemon Ruby',
  gameCrc: '',
  relayDefault: 'off',
  lanDiscovery: true,
  theme: 'system',
  logLevel: 'info',
};

function pickKnown(patch: Partial<AppSettings>): Partial<AppSettings> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    const value = patch[key];
    if (value !== undefined) out[key] = value;
  }
  if (out['game'] !== undefined && !isLinkGame(out['game'])) delete out['game'];
  if (out['console'] !== undefined && !isConsole(out['console'])) delete out['console'];
  if (out['switchRoom'] !== undefined && !isSwitchRoom(out['switchRoom'])) delete out['switchRoom'];
  if (out['nationalBypass'] !== undefined && typeof out['nationalBypass'] !== 'boolean') delete out['nationalBypass'];
  return out as Partial<AppSettings>;
}

export class SettingsStore {
  private cached: AppSettings | null = null;

  get(): AppSettings {
    if (this.cached === null) this.cached = this.load();
    return this.cached;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = { ...this.get(), ...pickKnown(patch) };
    this.cached = next;
    this.save(next);
    return next;
  }

  /** Restore every setting to its shipped default. */
  reset(): AppSettings {
    const next: AppSettings = { ...DEFAULT_SETTINGS };
    this.cached = next;
    this.save(next);
    return next;
  }

  private get file(): string {
    return path.join(app.getPath('userData'), 'settings.json');
  }

  private load(): AppSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AppSettings>;
      return { ...DEFAULT_SETTINGS, ...pickKnown(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private save(settings: AppSettings): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    } catch {
      /* settings persistence is best-effort */
    }
  }
}
