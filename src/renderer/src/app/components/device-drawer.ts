import { Component, inject, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { BridgeService, UDEV_RULE_PATH, UDEV_RULE_TEXT } from '../services/bridge.service';
import { cableTypeText, deviceStateText, firmwareText } from '../copy/state-copy';

@Component({
  selector: 'app-device-drawer',
  imports: [DatePipe],
  template: `
    <div class="fixed inset-0 z-20">
      <div class="absolute inset-0 bg-black/40" (click)="closed.emit()"></div>
      <aside
        class="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div
          class="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800"
        >
          <h2 class="text-sm font-semibold">Adapter</h2>
          <button
            (click)="closed.emit()"
            class="rounded px-2 py-0.5 text-lg leading-none text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label="Close"
          >&times;</button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-4">
          <section
            class="mb-4 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <div class="text-base font-medium">{{ stateText() }}</div>
            <div class="mt-2 flex gap-6 text-sm text-neutral-600 dark:text-neutral-400">
              <span>Firmware: {{ fwText() }}</span>
              <span>Cable: {{ cableText() }}</span>
            </div>
          </section>

          @if (bridge.usbAccessDenied()) {
            <section
              class="mb-4 rounded-lg border border-amber-400 bg-amber-50 p-4 dark:border-amber-600 dark:bg-amber-950"
            >
              <div class="font-medium text-amber-800 dark:text-amber-200">
                Linux: USB access denied
              </div>
              <p class="mt-1 text-sm text-amber-700 dark:text-amber-300">
                Your user cannot open the GB-Link device. Install this udev rule as
                <code>{{ rulePath }}</code>, then replug the adapter:
              </p>
              <pre
                class="mt-2 overflow-x-auto rounded bg-white p-2 text-xs dark:bg-neutral-900"
              >{{ ruleText }}</pre>
              <div class="mt-3 flex items-center gap-2">
                <button
                  (click)="copyRule()"
                  class="rounded border border-amber-500 px-3 py-1 text-sm hover:bg-amber-100 dark:hover:bg-amber-900"
                >{{ copied() ? 'Copied' : 'Copy' }}</button>
                <button
                  (click)="installRule()"
                  class="rounded bg-amber-600 px-3 py-1 text-sm text-white hover:bg-amber-700"
                >Install rule…</button>
                @if (installResult(); as res) {
                  <span
                    class="text-sm"
                    [class]="res.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'"
                  >
                    {{ res.ok ? 'Rule installed — replug the adapter' : 'Install failed: ' + (res.detail ?? 'unknown error') }}
                  </span>
                }
              </div>
            </section>
          }

          <section
            class="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <h3 class="mb-2 text-sm font-semibold text-neutral-500 dark:text-neutral-400">
              Link timeline
            </h3>
            @if (bridge.timeline().length === 0) {
              <div class="text-sm text-neutral-500">No events yet.</div>
            } @else {
              <ul class="text-sm">
                @for (entry of bridge.timeline(); track entry.ts + entry.text) {
                  <li
                    class="flex gap-3 border-b border-neutral-100 py-1 last:border-0 dark:border-neutral-800"
                  >
                    <span class="w-20 shrink-0 tabular-nums text-neutral-400">
                      {{ entry.ts | date: 'HH:mm:ss' }}
                    </span>
                    <span
                      class="w-14 shrink-0 text-xs uppercase tracking-wide"
                      [class]="entry.kind === 'device' ? 'text-sky-600 dark:text-sky-400' : 'text-emerald-600 dark:text-emerald-400'"
                    >{{ entry.kind }}</span>
                    <span>{{ entry.text }}</span>
                  </li>
                }
              </ul>
            }
          </section>
        </div>
      </aside>
    </div>
  `,
})
export class DeviceDrawer {
  protected readonly bridge = inject(BridgeService);
  protected readonly rulePath = UDEV_RULE_PATH;
  protected readonly ruleText = UDEV_RULE_TEXT;
  protected readonly copied = signal(false);
  protected readonly installResult = signal<{ ok: boolean; detail?: string } | null>(null);

  readonly closed = output<void>();

  protected stateText(): string {
    const state = this.bridge.deviceState();
    if (state === 'handshake-received' && this.bridge.peers().length > 0) {
      return 'GBA in the Cable Club — linking with partner…';
    }
    return deviceStateText(state);
  }
  protected fwText(): string {
    return firmwareText(this.bridge.firmware());
  }
  protected cableText(): string {
    return cableTypeText(this.bridge.cableType());
  }

  protected async copyRule(): Promise<void> {
    await this.bridge.copyText(this.ruleText);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  protected async installRule(): Promise<void> {
    this.installResult.set(null);
    this.installResult.set(await this.bridge.installUdevRule());
  }
}
