import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { BridgeService } from '../services/bridge.service';
import { closeReasonText, linkStatusText, sessionStatusText } from '../copy/state-copy';

const LEVELS = ['info', 'warn', 'error', 'debug'] as const;
type Level = (typeof LEVELS)[number];

@Component({
  selector: 'app-session-page',
  imports: [DatePipe],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Session</h1>

    <section class="mb-4 rounded-lg p-5 text-center" [class]="bannerClass()">
      <div class="text-xl font-semibold">{{ linkText() }}</div>
      <div class="mt-1 text-sm opacity-80">
        {{ sessionText() }}
        @if (closeText(); as reason) {
          <span> — {{ reason }}</span>
        }
      </div>
    </section>

    <div class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
      <section class="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 class="mb-2 text-sm font-semibold text-neutral-500 dark:text-neutral-400">Peers</h2>
        @if (bridge.peers().length === 0) {
          <div class="text-sm text-neutral-500">No peers connected.</div>
        } @else {
          <ul class="text-sm">
            @for (peer of bridge.peers(); track peer.id) {
              <li class="flex gap-3 py-1">
                <span class="w-8 tabular-nums text-neutral-400">#{{ peer.id }}</span>
                <span>{{ peer.nick }}</span>
              </li>
            }
          </ul>
        }
      </section>

      <section class="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 class="mb-2 text-sm font-semibold text-neutral-500 dark:text-neutral-400">Traffic</h2>
        <div class="flex gap-8 text-sm">
          <div>
            <div class="text-2xl font-semibold tabular-nums">{{ bridge.counters().txPackets }}</div>
            <div class="text-xs text-neutral-500">packets sent</div>
          </div>
          <div>
            <div class="text-2xl font-semibold tabular-nums">{{ bridge.counters().rxPackets }}</div>
            <div class="text-xs text-neutral-500">packets received</div>
          </div>
        </div>
        <button (click)="disconnectClicked()"
          [disabled]="!bridge.sessionActive()"
          class="mt-4 rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
        >Disconnect</button>
      </section>
    </div>

    <section class="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div class="mb-2 flex items-center gap-2">
        <h2 class="text-sm font-semibold text-neutral-500 dark:text-neutral-400">Event log</h2>
        @for (level of levels; track level) {
          <button (click)="toggleLevel(level)"
            class="rounded-full border px-2 py-0.5 text-xs"
            [class]="enabledLevels().has(level)
              ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
              : 'border-neutral-300 text-neutral-400 dark:border-neutral-700'"
          >{{ level }}</button>
        }
      </div>
      <ul class="max-h-80 overflow-y-auto font-mono text-xs">
        @for (entry of filteredLog(); track entry.ts + entry.msg) {
          <li class="flex gap-2 border-b border-neutral-100 py-0.5 last:border-0 dark:border-neutral-800">
            <span class="shrink-0 tabular-nums text-neutral-400">{{ entry.ts | date: 'HH:mm:ss' }}</span>
            <span class="w-12 shrink-0" [class]="levelClass(entry.level)">{{ entry.level }}</span>
            <span class="break-all">{{ entry.msg }}</span>
          </li>
        } @empty {
          <li class="py-2 text-neutral-500">No log entries.</li>
        }
      </ul>
    </section>

    @if (confirmOpen()) {
      <div class="fixed inset-0 z-10 flex items-center justify-center bg-black/40">
        <div class="w-96 rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
          <div class="mb-3 text-sm">
            A trade may be in progress — disconnecting now can lose Pokémon. Disconnect anyway?
          </div>
          <div class="flex justify-end gap-2">
            <button (click)="confirmOpen.set(false)"
              class="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700">Stay connected</button>
            <button (click)="doDisconnect()"
              class="rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700">Disconnect</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SessionPage {
  protected readonly bridge = inject(BridgeService);
  protected readonly levels = LEVELS;
  protected readonly enabledLevels = signal<Set<Level>>(new Set(LEVELS));
  protected readonly confirmOpen = signal(false);

  protected readonly filteredLog = computed(() => {
    const enabled = this.enabledLevels();
    return this.bridge.log().filter((e) => enabled.has(e.level));
  });

  protected linkText(): string {
    const peers = this.bridge.peers();
    return linkStatusText(this.bridge.linkPhase(), peers.length, peers[0]?.nick);
  }
  protected sessionText(): string {
    return sessionStatusText(this.bridge.sessionPhase(), this.bridge.peers().length);
  }
  protected closeText(): string | null {
    const reason = this.bridge.closeReason();
    return reason ? closeReasonText(reason) : null;
  }

  protected bannerClass(): string {
    switch (this.bridge.linkPhase()) {
      case 'connected':
        return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100';
      case 'searching':
      case 'cable-club':
      case 'handshake':
        return 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100';
      case 'closing':
      case 'closed':
        return 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';
      default:
        return 'bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-800';
    }
  }

  protected toggleLevel(level: Level): void {
    this.enabledLevels.update((set) => {
      const next = new Set(set);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  protected levelClass(level: Level): string {
    switch (level) {
      case 'error':
        return 'text-red-600 dark:text-red-400';
      case 'warn':
        return 'text-amber-600 dark:text-amber-400';
      case 'debug':
        return 'text-neutral-400';
      default:
        return 'text-sky-600 dark:text-sky-400';
    }
  }

  protected disconnectClicked(): void {
    if (this.bridge.linkPhase() === 'connected') this.confirmOpen.set(true);
    else void this.bridge.stop();
  }

  protected doDisconnect(): void {
    this.confirmOpen.set(false);
    void this.bridge.stop();
  }
}
