import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BridgeService } from '../services/bridge.service';
import { UiStateService } from '../services/ui-state.service';
import type { LobbyRoom } from '../../../../shared/ipc';

@Component({
  selector: 'app-lobby-list',
  imports: [FormsModule],
  template: `
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-semibold text-neutral-500 dark:text-neutral-400">Public lobby</h2>
      <span class="flex-1"></span>
      <button
        (click)="showAll.set(!showAll())"
        class="rounded-full border px-3 py-1 text-xs"
        [class]="showAll()
          ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
          : 'border-neutral-300 text-neutral-500 dark:border-neutral-700'"
        title="Include rooms that are not joinable gpSP sessions"
      >Show all</button>
      <input
        [ngModel]="search()"
        (ngModelChange)="search.set($event)"
        placeholder="Search…"
        class="w-48 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
      />
      <button
        (click)="refresh()"
        class="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >{{ loading() ? 'Refreshing…' : 'Refresh' }}</button>
      <span class="text-xs text-neutral-400">auto 30 s</span>
    </div>

    <div
      class="overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <table class="w-full text-left text-sm">
        <thead
          class="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800"
        >
          <tr>
            <th class="px-3 py-2">Game</th>
            <th class="px-3 py-2">Host</th>
            <th class="px-3 py-2">Route</th>
            <th class="px-3 py-2">Players</th>
            <th class="px-1 py-2"></th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          @for (room of filteredRooms(); track room.ip + room.port + room.username) {
            <tr class="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
              <td class="px-3 py-2" [title]="'CRC32 ' + crcHex(room)">
                {{ room.gameName }}
                <span class="block text-xs text-neutral-400">
                  {{ room.coreName }} {{ room.coreVersion }}
                </span>
              </td>
              <td class="px-3 py-2">
                {{ room.username }}
                <span class="text-xs text-neutral-400">{{ room.country }}</span>
              </td>
              <td class="px-3 py-2">
                {{ room.lan ? 'LAN' : room.hostMethod === 3 ? 'Relay' : 'Direct' }}
              </td>
              <td class="px-3 py-2 tabular-nums">{{ room.playerCount }}</td>
              <td class="px-1 py-2">
                @if (room.hasPassword) {
                  <svg
                    class="h-3.5 w-3.5 text-neutral-500"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-label="password required"
                  >
                    <path
                      d="M4 7V5a4 4 0 1 1 8 0v2h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1Zm2 0h4V5a2 2 0 1 0-4 0v2Z"
                    />
                  </svg>
                }
              </td>
              <td class="px-3 py-2 text-right">
                <button
                  (click)="joinClicked(room)"
                  [disabled]="!room.joinable || bridge.sessionActive()"
                  class="rounded border border-emerald-600 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-emerald-400 dark:hover:bg-emerald-950"
                >Join</button>
              </td>
            </tr>
          } @empty {
            <tr>
              <td colspan="6" class="px-3 py-6 text-center text-neutral-500">
                {{ loading() ? 'Loading lobby…' : 'No rooms match the filters.' }}
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>

    @if (pendingRoom(); as room) {
      <div class="fixed inset-0 z-20 flex items-center justify-center bg-black/40">
        <div
          class="w-80 rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        >
          <div class="mb-2 text-sm font-semibold">Password for {{ room.username }}</div>
          <input
            type="password"
            [(ngModel)]="modalPassword"
            (keyup.enter)="confirmPassword()"
            class="mb-3 w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
          />
          <div class="flex justify-end gap-2">
            <button
              (click)="pendingRoom.set(null)"
              class="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700"
            >Cancel</button>
            <button
              (click)="confirmPassword()"
              class="rounded bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-700"
            >Join</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class LobbyList {
  protected readonly bridge = inject(BridgeService);
  protected readonly ui = inject(UiStateService);

  protected readonly rooms = signal<LobbyRoom[]>([]);
  protected readonly loading = signal(false);
  /** Off = the default joinable-gpsp filter; on = every announced room. */
  protected readonly showAll = signal(false);
  protected readonly search = signal('');

  protected readonly pendingRoom = signal<LobbyRoom | null>(null);
  protected modalPassword = '';

  protected readonly filteredRooms = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.rooms().filter((r) => {
      if (!this.showAll() && !(r.joinable && r.coreName.toLowerCase().includes('gpsp'))) {
        return false;
      }
      if (q) {
        const hay = `${r.gameName} ${r.username} ${r.coreName} ${r.country}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), 30_000);
    destroyRef.onDestroy(() => clearInterval(timer));
  }

  protected async refresh(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    try {
      const [lobby, lan] = await Promise.allSettled([
        this.bridge.lobbyRefresh(),
        this.bridge.lanScan(),
      ]);
      const lanRooms = lan.status === 'fulfilled' ? lan.value : [];
      const lobbyRooms = lobby.status === 'fulfilled' ? lobby.value : [];
      this.rooms.set([...lanRooms, ...lobbyRooms]);
    } finally {
      this.loading.set(false);
    }
  }

  protected joinClicked(room: LobbyRoom): void {
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
    const nick = this.ui.effectiveNick();
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
  }

  protected crcHex(room: LobbyRoom): string {
    return (room.gameCrc >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }
}
