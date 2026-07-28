import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BridgeService } from '../services/bridge.service';
import type { AppSettings } from '../../../../shared/ipc';

@Component({
  selector: 'app-settings-page',
  imports: [FormsModule],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Settings</h1>

    @if (model(); as m) {
      <section class="max-w-md rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div class="mb-3 flex gap-3">
          <label class="block flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Nick</span>
            <input [(ngModel)]="m.nick"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700" />
          </label>
          <label class="block text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Default port</span>
            <input type="number" [(ngModel)]="m.defaultPort"
              class="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700" />
          </label>
        </div>
        <div class="mb-3 flex gap-3">
          <label class="block flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Game name</span>
            <input [(ngModel)]="m.gameName"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700" />
          </label>
          <label class="block text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Game CRC32</span>
            <input [(ngModel)]="m.gameCrc" maxlength="8" placeholder="1F1C08FB"
              class="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1.5 font-mono dark:border-neutral-700" />
          </label>
        </div>
        <label class="mb-3 block text-sm">
          <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Default relay</span>
          <select [(ngModel)]="m.relayDefault"
            class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900">
            <option value="off">Off</option>
            <option value="nyc">New York</option>
            <option value="madrid">Madrid</option>
            <option value="saopaulo">Sao Paulo</option>
            <option value="singapore">Singapore</option>
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
            <select [(ngModel)]="m.theme"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900">
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label class="block flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Log level</span>
            <select [(ngModel)]="m.logLevel"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900">
              <option value="info">Info</option>
              <option value="debug">Debug</option>
            </select>
          </label>
        </div>
        <div class="flex items-center gap-3">
          <button (click)="save()"
            class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >Save</button>
          @if (saved()) {
            <span class="text-sm text-emerald-600 dark:text-emerald-400">Saved</span>
          }
        </div>
      </section>
    } @else {
      <div class="text-sm text-neutral-500">Loading settings…</div>
    }
  `,
})
export class SettingsPage {
  protected readonly bridge = inject(BridgeService);
  protected readonly model = signal<AppSettings | null>(null);
  protected readonly saved = signal(false);

  constructor() {
    void this.bridge.getSettings().then((s) => this.model.set({ ...s }));
  }

  protected async save(): Promise<void> {
    const m = this.model();
    if (!m) return;
    const result = await this.bridge.setSettings({ ...m });
    this.model.set({ ...result });
    this.saved.set(true);
    setTimeout(() => this.saved.set(false), 1500);
  }
}
