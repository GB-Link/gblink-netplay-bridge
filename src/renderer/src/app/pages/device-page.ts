import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { BridgeService, UDEV_RULE_PATH, UDEV_RULE_TEXT } from '../services/bridge.service';
import { cableTypeText, deviceStateText, firmwareText } from '../copy/state-copy';

@Component({
  selector: 'app-device-page',
  imports: [DatePipe],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Device</h1>

    <section class="mb-4 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div class="text-base font-medium">{{ stateText() }}</div>
      <div class="mt-2 flex gap-6 text-sm text-neutral-600 dark:text-neutral-400">
        <span>Firmware: {{ fwText() }}</span>
        <span>Cable: {{ cableText() }}</span>
      </div>
    </section>

    @if (bridge.usbAccessDenied()) {
      <section class="mb-4 rounded-lg border border-amber-400 bg-amber-50 p-4 dark:border-amber-600 dark:bg-amber-950">
        <div class="font-medium text-amber-800 dark:text-amber-200">
          Linux: USB access denied
        </div>
        <p class="mt-1 text-sm text-amber-700 dark:text-amber-300">
          Your user cannot open the GB-Link device. Install this udev rule as
          <code>{{ rulePath }}</code>, then replug the adapter:
        </p>
        <pre class="mt-2 overflow-x-auto rounded bg-white p-2 text-xs dark:bg-neutral-900">{{ ruleText }}</pre>
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
            <span class="text-sm" [class]="res.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">
              {{ res.ok ? 'Rule installed — replug the adapter' : 'Install failed: ' + (res.detail ?? 'unknown error') }}
            </span>
          }
        </div>
      </section>
    }

    <section class="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <h2 class="mb-2 text-sm font-semibold text-neutral-500 dark:text-neutral-400">Link timeline</h2>
      @if (bridge.timeline().length === 0) {
        <div class="text-sm text-neutral-500">No events yet.</div>
      } @else {
        <ul class="max-h-96 overflow-y-auto text-sm">
          @for (entry of bridge.timeline(); track entry.ts + entry.text) {
            <li class="flex gap-3 border-b border-neutral-100 py-1 last:border-0 dark:border-neutral-800">
              <span class="w-20 shrink-0 tabular-nums text-neutral-400">{{ entry.ts | date: 'HH:mm:ss' }}</span>
              <span class="w-14 shrink-0 text-xs uppercase tracking-wide"
                [class]="entry.kind === 'device' ? 'text-sky-600 dark:text-sky-400' : 'text-emerald-600 dark:text-emerald-400'"
              >{{ entry.kind }}</span>
              <span>{{ entry.text }}</span>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class DevicePage {
  protected readonly bridge = inject(BridgeService);
  protected readonly rulePath = UDEV_RULE_PATH;
  protected readonly ruleText = UDEV_RULE_TEXT;
  protected readonly copied = signal(false);
  protected readonly installResult = signal<{ ok: boolean; detail?: string } | null>(null);

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
