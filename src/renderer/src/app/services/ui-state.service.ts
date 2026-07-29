import { Injectable, signal } from '@angular/core';

/**
 * Cross-component UI state that must survive the idle ↔ in-session view swap
 * (the idle-view components are destroyed while a session is active).
 */
@Injectable({ providedIn: 'root' })
export class UiStateService {
  /** Last chosen tab of the play card. */
  readonly playMode = signal<'join' | 'host'>('join');
  /** Shared nickname, used by join, host and lobby flows. */
  readonly nick = signal('');
  /** True once the nick has been seeded from settings. */
  readonly nickSeeded = signal(false);
}
