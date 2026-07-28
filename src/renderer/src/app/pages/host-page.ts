import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BridgeService } from '../services/bridge.service';
import type { RelayHandle } from '../../../../shared/ipc';

type RelayChoice = RelayHandle | 'off';

const RELAY_CHOICES: { value: RelayChoice; label: string }[] = [
  { value: 'off', label: 'Off (listen directly)' },
  { value: 'nyc', label: 'New York' },
  { value: 'madrid', label: 'Madrid' },
  { value: 'saopaulo', label: 'Sao Paulo' },
  { value: 'singapore', label: 'Singapore' },
  { value: 'custom', label: 'Custom…' },
];

@Component({
  selector: 'app-host-page',
  imports: [FormsModule],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Host</h1>

    @if (!hosting()) {
      <section class="max-w-md rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
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
        <div class="mb-3 flex gap-3">
          <label class="block flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Password (optional)</span>
            <input type="password" [(ngModel)]="password"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700" />
          </label>
          <label class="block flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Spectate password</span>
            <input type="password" [(ngModel)]="spectatePassword"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700" />
          </label>
        </div>
        <label class="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" [(ngModel)]="announce" class="h-4 w-4" />
          <span>Announce to public lobby</span>
        </label>
        <label class="mb-3 block text-sm">
          <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Relay</span>
          <select [(ngModel)]="relay"
            class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900">
            @for (c of relayChoices; track c.value) {
              <option [ngValue]="c.value">{{ c.label }}</option>
            }
          </select>
        </label>
        @if (relay === 'custom') {
          <label class="mb-3 block text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Custom relay address</span>
            <input [(ngModel)]="customAddr" placeholder="relay.example.com:55435"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700" />
          </label>
        }
        <div class="mb-4 flex gap-3">
          <label class="block flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Game name</span>
            <input [(ngModel)]="gameName"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700" />
          </label>
          <label class="block text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">CRC32 (optional)</span>
            <input [(ngModel)]="gameCrc" placeholder="1F1C08FB" maxlength="8"
              class="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1.5 font-mono dark:border-neutral-700" />
          </label>
        </div>
        @if (gameCrc && !crcValid()) {
          <div class="mb-3 text-xs text-red-600 dark:text-red-400">CRC must be exactly 8 hex digits (or empty).</div>
        }
        <button
          (click)="startHosting()"
          [disabled]="bridge.sessionActive() || !crcValid() || (relay === 'custom' && !customAddr.trim())"
          class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
        >Start hosting</button>
      </section>
    } @else {
      <section class="max-w-md rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div class="mb-2 text-base font-medium">Hosting</div>
        <div class="mb-1 text-sm text-neutral-600 dark:text-neutral-400">{{ routeLine() }}</div>
        <div class="mb-1 text-sm" [class]="announceClass()">{{ announceLine() }}</div>
        @if (countdown() !== null) {
          <div class="mb-3 text-xs text-neutral-500">Next announce in {{ countdown() }} s</div>
        }
        <div class="mb-3 text-sm text-neutral-600 dark:text-neutral-400">
          Players: {{ bridge.peers().length }}
        </div>
        <button (click)="stop()"
          class="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
        >Stop</button>
      </section>
    }
  `,
})
export class HostPage {
  protected readonly bridge = inject(BridgeService);
  protected readonly relayChoices = RELAY_CHOICES;

  protected port = 55435;
  protected nick = '';
  protected password = '';
  protected spectatePassword = '';
  protected announce = true;
  protected relay: RelayChoice = 'off';
  protected customAddr = '';
  protected gameName = '';
  protected gameCrc = '';

  private readonly now = signal(Date.now());

  protected readonly hosting = computed(() => this.bridge.sessionPhase() === 'hosting');

  protected readonly countdown = computed<number | null>(() => {
    const a = this.bridge.announce();
    if (a.status === 'off' || a.nextInSec === undefined) return null;
    const elapsed = (this.now() - a.at) / 1000;
    return Math.max(0, Math.round(a.nextInSec - elapsed));
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    void this.bridge.getSettings().then((s) => {
      this.port = s.defaultPort;
      if (!this.nick) this.nick = s.nick;
      if (!this.gameName) this.gameName = s.gameName;
      if (!this.gameCrc) this.gameCrc = s.gameCrc;
      this.relay = s.relayDefault;
    });
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    destroyRef.onDestroy(() => clearInterval(timer));
  }

  protected crcValid(): boolean {
    return this.gameCrc === '' || /^[0-9a-fA-F]{8}$/.test(this.gameCrc);
  }

  protected async startHosting(): Promise<void> {
    if (this.bridge.sessionActive()) return;
    await this.bridge.host({
      port: this.port,
      nick: this.nick.trim() || 'Player',
      password: this.password || undefined,
      spectatePassword: this.spectatePassword || undefined,
      announce: this.announce,
      relay:
        this.relay === 'off'
          ? undefined
          : {
              handle: this.relay,
              customAddr: this.relay === 'custom' ? this.customAddr.trim() : undefined,
            },
      gameName: this.gameName.trim(),
      gameCrc: this.gameCrc || undefined,
    });
  }

  protected async stop(): Promise<void> {
    await this.bridge.stop();
  }

  protected routeLine(): string {
    const hr = this.bridge.hostReady();
    if (!hr) return 'Starting…';
    if (hr.relaySessionId) {
      return `Hosting through relay — session ${hr.relaySessionId} (port ${hr.extPort})`;
    }
    return `Listening directly on port ${hr.extPort}`;
  }

  protected announceLine(): string {
    const a = this.bridge.announce();
    switch (a.status) {
      case 'ok':
        return a.roomId !== undefined
          ? `Announced to the public lobby (room #${a.roomId})`
          : 'Announced to the public lobby';
      case 'not-connectable':
        return 'Announced, but the lobby could not reach your port — players may be unable to join directly. Consider hosting through a relay.';
      case 'failed':
        return 'Lobby announce failed — the room is not listed publicly.';
      default:
        return 'Not announced (private session)';
    }
  }

  protected announceClass(): string {
    switch (this.bridge.announce().status) {
      case 'ok':
        return 'text-emerald-600 dark:text-emerald-400';
      case 'not-connectable':
        return 'text-amber-600 dark:text-amber-400';
      case 'failed':
        return 'text-red-600 dark:text-red-400';
      default:
        return 'text-neutral-500';
    }
  }
}
