import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BridgeService } from '../services/bridge.service';
import { UiStateService } from '../services/ui-state.service';
import type { AppSettings } from '../../../../shared/ipc';
import { normalizePort } from '../util/ports';

@Component({
  selector: 'app-settings-modal',
  imports: [FormsModule],
  template: `
    <div class="fixed inset-0 z-20 flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/40" (click)="closed.emit()"></div>
      <div
        class="relative max-h-full w-[28rem] max-w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-sm font-semibold">Settings</h2>
          <button
            (click)="closed.emit()"
            class="rounded px-2 py-0.5 text-lg leading-none text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label="Close"
          >&times;</button>
        </div>

        @if (model(); as m) {
          <div class="mb-3 flex gap-3">
            <label class="block flex-1 text-sm">
              <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Nick</span>
              <input
                [(ngModel)]="m.nick"
                class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
              />
            </label>
            <label class="block text-sm">
              <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Default port</span>
              <input
                type="number"
                [(ngModel)]="m.defaultPort"
                class="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
              />
            </label>
          </div>
          <div class="mb-3 flex gap-3">
            <label class="block flex-1 text-sm">
              <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Game name</span>
              <input
                [(ngModel)]="m.gameName"
                class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
              />
            </label>
            <label class="block text-sm">
              <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Game CRC32</span>
              <input
                [(ngModel)]="m.gameCrc"
                maxlength="8"
                placeholder="1F1C08FB"
                class="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1.5 font-mono dark:border-neutral-700"
              />
            </label>
          </div>
          <label class="mb-3 block text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Default relay</span>
            <select
              [(ngModel)]="m.relayDefault"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="off">Off</option>
              <option value="nyc">North America (East Coast, USA)</option>
              <option value="madrid">Western Europe</option>
              <option value="saopaulo">South America (Southeast, Brazil)</option>
              <option value="singapore">Southeast Asia</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label class="mb-3 flex items-center gap-2 text-sm">
            <input type="checkbox" [(ngModel)]="m.lanDiscovery" class="h-4 w-4" />
            <span>LAN discovery</span>
          </label>
          <div class="mb-4 flex gap-3">
            <label class="block flex-1 text-sm">
              <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Theme</span>
              <select
                [(ngModel)]="m.theme"
                class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label class="block flex-1 text-sm">
              <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Log level</span>
              <select
                [(ngModel)]="m.logLevel"
                class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="info">Info</option>
                <option value="debug">Debug</option>
              </select>
            </label>
          </div>
          <div class="flex items-center gap-3">
            <button
              (click)="save()"
              class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >Save</button>
            @if (confirmingReset()) {
              <button
                (click)="resetDefaults()"
                class="rounded border border-red-500 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
              >Reset everything?</button>
              <button
                (click)="confirmingReset.set(false)"
                class="rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700"
              >Cancel</button>
            } @else {
              <button
                (click)="confirmingReset.set(true)"
                class="rounded border border-neutral-300 px-3 py-2 text-sm text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >Reset to defaults</button>
            }
            <span class="flex-1"></span>
            @if (saved(); as what) {
              <span class="text-sm text-emerald-600 dark:text-emerald-400">{{ what }}</span>
            }
          </div>
        } @else {
          <div class="text-sm text-neutral-500">Loading settings…</div>
        }
      </div>
    </div>
  `,
})
export class SettingsModal {
  protected readonly bridge = inject(BridgeService);
  private readonly ui = inject(UiStateService);
  protected readonly model = signal<AppSettings | null>(null);
  protected readonly saved = signal<string | null>(null);
  protected readonly confirmingReset = signal(false);
  readonly closed = output<void>();

  constructor() {
    void this.bridge.getSettings().then((s) => this.model.set({ ...s }));
  }

  protected async save(): Promise<void> {
    const m = this.model();
    if (!m) return;
    const sanitized: AppSettings = {
      ...m,
      nick: m.nick.trim(),
      defaultPort: normalizePort(m.defaultPort),
      hostPort: normalizePort(m.hostPort, normalizePort(m.defaultPort)),
    };
    const result = await this.bridge.setSettings(sanitized);
    this.model.set({ ...result });
    // Keep the play card's shared nickname in step with the saved value.
    this.ui.nick.set(result.nick);
    this.ui.nickSeeded.set(true);
    this.flash('Saved');
  }

  protected async resetDefaults(): Promise<void> {
    this.confirmingReset.set(false);
    const result = await this.bridge.resetSettings();
    this.model.set({ ...result });
    this.ui.nick.set(result.nick);
    this.ui.nickSeeded.set(true);
    this.flash('Reset to defaults');
  }

  private flash(text: string): void {
    this.saved.set(text);
    setTimeout(() => this.saved.set(null), 1500);
  }
}
