import { Injectable, inject, signal } from '@angular/core';
import { BridgeService } from './bridge.service';

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

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Effective nickname, falling back to the default when blank. */
  effectiveNick(): string {
    return this.nick().trim() || DEFAULT_NICK;
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
