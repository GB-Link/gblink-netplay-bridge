import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BridgeService } from '../services/bridge.service';
import type { LobbyRoom } from '../../../../shared/ipc';

@Component({
  selector: 'app-join-page',
  imports: [FormsModule],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Join</h1>

    <div class="mb-4 flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
      @for (t of tabs; track t.id) {
        <button
          (click)="tab.set(t.id)"
          class="rounded-t px-4 py-2 text-sm"
          [class]="tab() === t.id
            ? 'border border-b-0 border-neutral-200 bg-white font-semibold dark:border-neutral-800 dark:bg-neutral-900'
            : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'"
        >{{ t.label }}</button>
      }
    </div>

    @if (tab() === 'direct') {
      <section class="max-w-md rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <label class="mb-3 block text-sm">
          <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Host (or paste a RetroArch "host|port|session" string)</span>
          <input [ngModel]="hostInput" (ngModelChange)="onHostChange($event)"
            class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
            placeholder="192.168.1.20" />
        </label>
        @if (relaySession) {
          <div class="mb-3 rounded bg-sky-50 px-2 py-1 text-xs text-sky-700 dark:bg-sky-950 dark:text-sky-300">
            Relay session detected — will join through the relay.
          </div>
        }
        <div class="mb-3 flex gap-3">
          <label class="block text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Port</span>
            <input type="number" [(ngModel)]="port"
              class="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700" />
          </label>
          <label class="block flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Nick</span>
            <input [(ngModel)]="nick"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700" />
          </label>
        </div>
        <label class="mb-4 block text-sm">
          <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Password (optional)</span>
          <input type="password" [(ngModel)]="password"
            class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700" />
        </label>
        <button
          (click)="submitDirect()"
          [disabled]="bridge.sessionActive() || !hostInput.trim()"
          class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
        >{{ relaySession ? 'Join via relay' : 'Join' }}</button>
        @if (bridge.sessionActive()) {
          <span class="ml-2 text-xs text-neutral-500">A session is already active.</span>
        }
      </section>
    } @else {
      <section>
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <button (click)="gpspOnly.set(!gpspOnly())"
            class="rounded-full border px-3 py-1 text-xs"
            [class]="gpspOnly()
              ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
              : 'border-neutral-300 text-neutral-500 dark:border-neutral-700'"
          >gpSP only</button>
          <button (click)="joinableOnly.set(!joinableOnly())"
            class="rounded-full border px-3 py-1 text-xs"
            [class]="joinableOnly()
              ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
              : 'border-neutral-300 text-neutral-500 dark:border-neutral-700'"
          >joinable</button>
          <input [ngModel]="search()" (ngModelChange)="search.set($event)" placeholder="Search…"
            class="w-48 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" />
          <button (click)="refresh()"
            class="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >{{ loading() ? 'Refreshing…' : 'Refresh' }}</button>
        </div>

        <div class="overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table class="w-full text-left text-sm">
            <thead class="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <tr>
                <th class="px-3 py-2">Game</th>
                <th class="px-3 py-2">Host</th>
                <th class="px-3 py-2">Core</th>
                <th class="px-3 py-2">Route</th>
                <th class="px-3 py-2"></th>
                <th class="px-3 py-2">Players</th>
              </tr>
            </thead>
            <tbody>
              @for (room of filteredRooms(); track room.ip + room.port + room.username) {
                <tr
                  (click)="rowClicked(room)"
                  class="border-b border-neutral-100 last:border-0 dark:border-neutral-800"
                  [class]="bridge.sessionActive()
                    ? 'cursor-not-allowed opacity-50'
                    : 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50'"
                >
                  <td class="px-3 py-2" [title]="'CRC32 ' + crcHex(room)">{{ room.gameName }}</td>
                  <td class="px-3 py-2">{{ room.username }} <span class="text-xs text-neutral-400">{{ room.country }}</span></td>
                  <td class="px-3 py-2">{{ room.coreName }} <span class="text-xs text-neutral-400">{{ room.coreVersion }}</span></td>
                  <td class="px-3 py-2">{{ room.hostMethod === 3 ? 'Relay' : 'Direct' }}</td>
                  <td class="px-1 py-2">
                    @if (room.hasPassword) {
                      <svg class="h-3.5 w-3.5 text-neutral-500" viewBox="0 0 16 16" fill="currentColor" aria-label="password required">
                        <path d="M4 7V5a4 4 0 1 1 8 0v2h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1Zm2 0h4V5a2 2 0 1 0-4 0v2Z"/>
                      </svg>
                    }
                  </td>
                  <td class="px-3 py-2 tabular-nums">{{ room.playerCount }}</td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="px-3 py-6 text-center text-neutral-500">
                  {{ loading() ? 'Loading lobby…' : 'No rooms match the filters.' }}
                </td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }

    @if (pendingRoom(); as room) {
      <div class="fixed inset-0 z-10 flex items-center justify-center bg-black/40">
        <div class="w-80 rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
          <div class="mb-2 text-sm font-semibold">Password for {{ room.username }}</div>
          <input type="password" [(ngModel)]="modalPassword" (keyup.enter)="confirmPassword()"
            class="mb-3 w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700" />
          <div class="flex justify-end gap-2">
            <button (click)="pendingRoom.set(null)"
              class="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700">Cancel</button>
            <button (click)="confirmPassword()"
              class="rounded bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-700">Join</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class JoinPage {
  protected readonly bridge = inject(BridgeService);
  private readonly router = inject(Router);

  protected readonly tabs = [
    { id: 'direct' as const, label: 'Direct' },
    { id: 'lobby' as const, label: 'Lobby' },
  ];
  protected readonly tab = signal<'direct' | 'lobby'>('direct');

  protected hostInput = '';
  protected port = 55435;
  protected nick = '';
  protected password = '';
  protected relaySession: string | null = null;

  protected readonly rooms = signal<LobbyRoom[]>([]);
  protected readonly loading = signal(false);
  protected readonly gpspOnly = signal(true);
  protected readonly joinableOnly = signal(true);
  protected readonly search = signal('');

  protected readonly pendingRoom = signal<LobbyRoom | null>(null);
  protected modalPassword = '';

  protected readonly filteredRooms = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.rooms().filter((r) => {
      if (this.gpspOnly() && !r.coreName.toLowerCase().includes('gpsp')) return false;
      if (this.joinableOnly() && !r.joinable) return false;
      if (q) {
        const hay = `${r.gameName} ${r.username} ${r.coreName} ${r.country}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    void this.bridge.getSettings().then((s) => {
      if (!this.nick) this.nick = s.nick;
      this.port = s.defaultPort;
    });
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), 30_000);
    destroyRef.onDestroy(() => clearInterval(timer));
  }

  protected onHostChange(value: string): void {
    if (value.includes('|')) {
      const [host, portStr, session] = value.split('|');
      this.hostInput = (host ?? '').trim();
      const port = Number.parseInt(portStr ?? '', 10);
      if (Number.isFinite(port) && port > 0 && port < 65536) this.port = port;
      this.relaySession = session?.trim() ? session.trim() : null;
    } else {
      this.hostInput = value;
      this.relaySession = null;
    }
  }

  protected async refresh(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    try {
      this.rooms.set(await this.bridge.lobbyRefresh());
    } finally {
      this.loading.set(false);
    }
  }

  protected async submitDirect(): Promise<void> {
    if (this.bridge.sessionActive()) return;
    const common = {
      port: this.port,
      nick: this.nick.trim() || 'Player',
      password: this.password || undefined,
    };
    if (this.relaySession) {
      await this.bridge.joinRelay({ addr: this.hostInput.trim(), session: this.relaySession, ...common });
    } else {
      await this.bridge.joinDirect({ host: this.hostInput.trim(), ...common });
    }
    await this.router.navigate(['/session']);
  }

  protected rowClicked(room: LobbyRoom): void {
    if (this.bridge.sessionActive()) return;
    if (room.hasPassword) {
      this.modalPassword = '';
      this.pendingRoom.set(room);
    } else {
      void this.joinRoom(room);
    }
  }

  protected confirmPassword(): void {
    const room = this.pendingRoom();
    if (!room) return;
    this.pendingRoom.set(null);
    void this.joinRoom(room, this.modalPassword || undefined);
  }

  private async joinRoom(room: LobbyRoom, password?: string): Promise<void> {
    const nick = this.nick.trim() || 'Player';
    if (room.hostMethod === 3) {
      await this.bridge.joinRelay({
        addr: room.mitmIp,
        port: room.mitmPort,
        session: room.mitmSession,
        nick,
        password,
      });
    } else {
      await this.bridge.joinDirect({ host: room.ip, port: room.port, nick, password });
    }
    await this.router.navigate(['/session']);
  }

  protected crcHex(room: LobbyRoom): string {
    return (room.gameCrc >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }
}
