import { Component, computed, inject, output } from '@angular/core';
import { BridgeService } from '../services/bridge.service';
import { StatusDot, type DotColor } from './status-dot';
import { cableTypeText, firmwareText, linkPhaseText, sessionStatusText } from '../copy/state-copy';

@Component({
  selector: 'app-status-bar',
  imports: [StatusDot],
  template: `
    <header
      class="flex shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <button
        (click)="deviceClick.emit()"
        title="Adapter details"
        class="flex items-center gap-2 rounded-full border border-neutral-200 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        <app-status-dot [color]="adapterDot()" />
        <span class="text-neutral-700 dark:text-neutral-200">{{ adapterText() }}</span>
      </button>

      @if (bridge.esp32().state !== 'absent') {
        <button
          (click)="deviceClick.emit()"
          title="ESP32 bridge details"
          class="flex items-center gap-2 rounded-full border border-neutral-200 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          <app-status-dot [color]="espDot()" />
          <span class="text-neutral-700 dark:text-neutral-200">{{ espText() }}</span>
        </button>
      }

      <span class="flex items-center gap-2 px-2 py-1 text-sm">
        <app-status-dot [color]="linkDot()" />
        <span class="text-neutral-600 dark:text-neutral-300">{{ linkText() }}</span>
      </span>

      <span class="flex-1"></span>

      @if (bridge.isMock) {
        <span class="text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
          Mock bridge
        </span>
      }

      <button
        (click)="gearClick.emit()"
        title="Settings"
        class="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-label="settings">
          <path
            fill-rule="evenodd"
            d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 0 1-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 0 1 .947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 0 1 2.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 0 1 2.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 0 1 .947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 0 1-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 0 1-2.287-.947zM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    </header>
  `,
})
export class StatusBar {
  protected readonly bridge = inject(BridgeService);

  readonly deviceClick = output<void>();
  readonly gearClick = output<void>();

  protected readonly adapterDot = computed<DotColor>(() => {
    switch (this.bridge.deviceState()) {
      case 'present':
      case 'device-ready':
      case 'awaiting-gba':
      case 'handshake-received':
      case 'link-connected':
        return 'green';
      case 'reconnecting':
      case 'access-denied':
        return 'amber';
      default:
        return 'gray';
    }
  });

  protected readonly adapterText = computed(() => {
    const state = this.bridge.deviceState();
    if (state === 'absent' || state === 'closed') return 'GB-Link not detected';
    if (state === 'access-denied') return 'GB-Link — USB access denied';
    const fw = this.bridge.firmware();
    const name = fw ? `GB-Link ${firmwareText(fw)}` : 'GB-Link';
    const cable = this.bridge.cableType();
    return cable !== null ? `${name} · ${cableTypeText(cable)}` : name;
  });

  protected readonly espDot = computed<DotColor>(() => {
    const esp = this.bridge.esp32();
    if (esp.state === 'error') return 'amber';
    if (esp.state === 'present') return esp.keys === false ? 'amber' : 'green';
    return 'gray';
  });

  protected readonly espText = computed(() => {
    const esp = this.bridge.esp32();
    if (esp.state === 'error') return 'ESP32 — not answering';
    const name = esp.version ? `ESP32 bridge v${esp.version}` : 'ESP32 bridge';
    if (esp.keys === false) return `${name} · no Switch keys`;
    return name;
  });

  protected readonly linkDot = computed<DotColor>(() => {
    switch (this.bridge.sessionPhase()) {
      case 'connected':
      case 'hosting':
        return 'green';
      case 'connecting':
      case 'relay-connecting':
      case 'handshaking':
        return 'amber';
      default:
        return 'gray';
    }
  });

  protected readonly linkText = computed(() => {
    if (this.bridge.sessionActive()) {
      return sessionStatusText(this.bridge.sessionPhase(), this.bridge.peers().length);
    }
    const phase = this.bridge.linkPhase();
    return phase === 'idle' || phase === 'closed' ? 'Link idle' : linkPhaseText(phase);
  });
}
