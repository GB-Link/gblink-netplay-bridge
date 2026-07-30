import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { BridgeService } from '../services/bridge.service';

const LEVELS = ['info', 'warn', 'error', 'debug'] as const;
type Level = (typeof LEVELS)[number];

@Component({
  selector: 'app-log-drawer',
  imports: [DatePipe],
  template: `
    <footer
      class="shrink-0 border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <button
        (click)="open.set(!open())"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
      >
        <span
          class="inline-block text-neutral-400 transition-transform"
          [class.rotate-90]="open()"
        >▸</span>
        <span class="shrink-0 font-semibold text-neutral-500 dark:text-neutral-400">Event log</span>
        @if (errorCount() > 0) {
          <span
            class="shrink-0 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white"
          >{{ errorCount() }}</span>
        }
        @if (!open()) {
          @if (lastEntry(); as e) {
            <span class="min-w-0 flex-1 truncate font-mono text-neutral-500">
              <span [class]="levelClass(e.level)">{{ e.level }}</span>
              {{ e.msg }}
            </span>
          } @else {
            <span class="min-w-0 flex-1 text-neutral-400">No log entries.</span>
          }
        } @else {
          <span class="min-w-0 flex-1"></span>
        }
        @if (bridge.appVersion(); as version) {
          <span class="ml-auto shrink-0 text-neutral-400">Version {{ version }}</span>
        }
      </button>

      @if (open()) {
        <div class="border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
          <div class="mb-2 flex items-center gap-2">
            @for (level of levels; track level) {
              <button
                (click)="toggleLevel(level)"
                class="rounded-full border px-2 py-0.5 text-xs"
                [class]="enabledLevels().has(level)
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'border-neutral-300 text-neutral-400 dark:border-neutral-700'"
              >{{ level }}</button>
            }
          </div>
          <ul class="max-h-56 overflow-y-auto font-mono text-xs">
            @for (entry of filteredLog(); track entry.ts + entry.msg) {
              <li
                class="flex gap-2 border-b border-neutral-100 py-0.5 last:border-0 dark:border-neutral-800"
              >
                <span class="shrink-0 tabular-nums text-neutral-400">
                  {{ entry.ts | date: 'HH:mm:ss' }}
                </span>
                <span class="w-12 shrink-0" [class]="levelClass(entry.level)">{{ entry.level }}</span>
                <span class="break-all">{{ entry.msg }}</span>
              </li>
            } @empty {
              <li class="py-2 text-neutral-500">No log entries.</li>
            }
          </ul>
        </div>
      }
    </footer>
  `,
})
export class LogDrawer {
  protected readonly bridge = inject(BridgeService);
  protected readonly levels = LEVELS;
  protected readonly open = signal(false);
  protected readonly enabledLevels = signal<Set<Level>>(new Set(LEVELS));

  protected readonly lastEntry = computed(() => this.bridge.log()[0] ?? null);
  protected readonly errorCount = computed(
    () => this.bridge.log().filter((e) => e.level === 'error').length,
  );

  protected readonly filteredLog = computed(() => {
    const enabled = this.enabledLevels();
    return this.bridge.log().filter((e) => enabled.has(e.level));
  });

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
}
