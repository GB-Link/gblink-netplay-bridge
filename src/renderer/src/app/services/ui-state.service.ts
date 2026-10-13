import { Injectable, inject, signal } from '@angular/core';
import { BridgeService } from './bridge.service';
import type { Console, LinkGame, SwitchRoom } from '../../../../engine/types';
import { CONSOLE_GAMES } from '../../../../shared/games';

export const DEFAULT_NICK = 'Anonymous';

/** Delay before an edited nickname is written back to settings. */
const NICK_SAVE_DEBOUNCE_MS = 600;

/**
 * Cross-component UI state that must survive the idle ↔ in-session view swap
 * (the idle-view components are destroyed while a session is active).
 */
@Injectable({ providedIn: 'root' })
export class UiStateService {
  private readonly bridge = inject(BridgeService);

  /** Last chosen tab of the play card. */
  readonly playMode = signal<'join' | 'host'>('join');
  /** Shared nickname, used by join, host and lobby flows. */
  readonly nick = signal('');
  /** True once the nick has been seeded from settings. */
  readonly nickSeeded = signal(false);
  /** Selected link game, shared by the play card and the lobby. */
  readonly game = signal<LinkGame>('gen3');
  readonly gameSeeded = signal(false);
  /** Which device the bridge drives: a GBA on a GB-Link, or a Switch behind an ESP32. */
  readonly console = signal<Console>('gba');
  /** Switch cable link, joining: the group led for the Switch. */
  readonly switchRoom = signal<SwitchRoom>('trade');
  readonly nationalBypass = signal(false);

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Effective nickname, falling back to the default when blank. */
  effectiveNick(): string {
    return this.nick().trim() || DEFAULT_NICK;
  }

  /** Update the game selection and persist it so it survives a restart. */
  setGame(game: LinkGame): void {
    this.game.set(game);
    this.gameSeeded.set(true);
    void this.bridge.setSettings({ game });
  }

  /** Change console; a game the console cannot carry falls back to its first. */
  setConsole(console: Console): void {
    this.console.set(console);
    const games = CONSOLE_GAMES[console];
    if (!games.includes(this.game())) this.setGame(games[0]!);
    void this.bridge.setSettings({ console });
  }

  setSwitchRoom(room: SwitchRoom): void {
    this.switchRoom.set(room);
    void this.bridge.setSettings({ switchRoom: room });
  }

  setNationalBypass(value: boolean): void {
    this.nationalBypass.set(value);
    void this.bridge.setSettings({ nationalBypass: value });
  }

  /** Update the nickname and persist it so it survives a restart. */
  setNick(value: string): void {
    this.nick.set(value);
    this.nickSeeded.set(true);
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.bridge.setSettings({ nick: this.effectiveNick() });
    }, NICK_SAVE_DEBOUNCE_MS);
  }
}
