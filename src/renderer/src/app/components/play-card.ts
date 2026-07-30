import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BridgeService } from '../services/bridge.service';
import { UiStateService } from '../services/ui-state.service';
import type { RelayHandle } from '../../../../shared/ipc';

type RelayChoice = RelayHandle | 'off';

const RELAY_CHOICES: { value: RelayChoice; label: string }[] = [
  { value: 'off', label: 'Off (listen directly)' },
  { value: 'nyc', label: 'North America (East Coast, USA)' },
  { value: 'madrid', label: 'Western Europe' },
  { value: 'saopaulo', label: 'South America (Southeast, Brazil)' },
  { value: 'singapore', label: 'Southeast Asia' },
  { value: 'custom', label: 'Custom…' },
];

@Component({
  selector: 'app-play-card',
  imports: [FormsModule],
  template: `
    <section
      class="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          class="inline-flex overflow-hidden rounded border border-neutral-300 text-sm dark:border-neutral-700"
        >
          <button
            (click)="ui.playMode.set('join')"
            class="px-4 py-1.5"
            [class]="ui.playMode() === 'join'
              ? 'bg-neutral-200 font-semibold dark:bg-neutral-700'
              : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'"
          >Join</button>
          <button
            (click)="ui.playMode.set('host')"
            class="border-l border-neutral-300 px-4 py-1.5 dark:border-neutral-700"
            [class]="ui.playMode() === 'host'
              ? 'bg-neutral-200 font-semibold dark:bg-neutral-700'
              : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'"
          >Host</button>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <span class="text-neutral-600 dark:text-neutral-400">Nickname</span>
          <input
            [ngModel]="ui.nick()"
            (ngModelChange)="ui.setNick($event)"
            class="w-36 rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
          />
        </label>
      </div>

      @if (ui.playMode() === 'join') {
        <div class="mb-3 flex gap-3">
          <label class="block min-w-0 flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Address</span>
            <input
              [ngModel]="address"
              (ngModelChange)="onAddressChange($event)"
              placeholder='host, host:port, or paste "host|port|session"'
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
            />
          </label>
          <label class="block w-36 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Password</span>
            <input
              type="password"
              [(ngModel)]="password"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
            />
          </label>
        </div>

        <button
          (click)="relayOpen.set(!relayOpen())"
          class="mb-3 flex items-center gap-1.5 text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          <span class="inline-block transition-transform" [class.rotate-90]="relayOpen()">▸</span>
          <span>Relay session</span>
          @if (relaySession.trim() && !relayOpen()) {
            <span class="text-xs text-sky-600 dark:text-sky-400">(set)</span>
          }
        </button>

        @if (relayOpen()) {
          <div
            class="mb-3 rounded border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <div class="mb-3 flex gap-3">
              <label class="block min-w-0 flex-1 text-sm">
                <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Relay address</span>
                <input
                  [(ngModel)]="relayAddr"
                  placeholder="nyc.libretro.com"
                  class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
                />
              </label>
              <label class="block text-sm">
                <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Port</span>
                <input
                  type="number"
                  [(ngModel)]="relayPort"
                  class="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
                />
              </label>
            </div>
            <label class="block text-sm">
              <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Session</span>
              <input
                [(ngModel)]="relaySession"
                placeholder="base64 session id"
                class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 font-mono dark:border-neutral-700"
              />
            </label>
          </div>
        }

        @if (relaySession.trim()) {
          <div
            class="mb-3 rounded bg-sky-50 px-2 py-1 text-xs text-sky-700 dark:bg-sky-950 dark:text-sky-300"
          >
            Relay session set — will join through the relay.
          </div>
        }

        <button
          (click)="connect()"
          [disabled]="connectDisabled()"
          class="w-full rounded bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
        >{{ relaySession.trim() ? 'Connect via relay' : 'Connect' }}</button>
      } @else {
        <div class="mb-3 flex gap-3">
          <label class="block text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Port</span>
            <input
              type="number"
              [(ngModel)]="hostPort"
              class="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
            />
          </label>
          <label class="block flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Password (optional)</span>
            <input
              type="password"
              [(ngModel)]="hostPassword"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
            />
          </label>
          <label class="block flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Spectate password</span>
            <input
              type="password"
              [(ngModel)]="spectatePassword"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
            />
          </label>
        </div>
        <label class="mb-3 block text-sm">
          <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Relay</span>
          <select
            [(ngModel)]="relay"
            class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
          >
            @for (c of relayChoices; track c.value) {
              <option [ngValue]="c.value">{{ c.label }}</option>
            }
          </select>
        </label>
        @if (relay === 'custom') {
          <label class="mb-3 block text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Custom relay address</span>
            <input
              [(ngModel)]="customAddr"
              placeholder="relay.example.com:55435"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
            />
          </label>
        }
        <label class="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" [(ngModel)]="announce" class="h-4 w-4" />
          <span>Announce to public lobby</span>
        </label>
        <div class="mb-3 flex gap-3">
          <label class="block flex-1 text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">Game name</span>
            <input
              [(ngModel)]="gameName"
              class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
            />
          </label>
          <label class="block text-sm">
            <span class="mb-1 block text-neutral-600 dark:text-neutral-400">CRC32 (optional)</span>
            <input
              [(ngModel)]="gameCrc"
              placeholder="1F1C08FB"
              maxlength="8"
              class="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1.5 font-mono dark:border-neutral-700"
            />
          </label>
        </div>
        @if (gameCrc && !crcValid()) {
          <div class="mb-3 text-xs text-red-600 dark:text-red-400">
            CRC must be exactly 8 hex digits (or empty).
          </div>
        }
        <button
          (click)="startHosting()"
          [disabled]="bridge.sessionActive() || !crcValid() || (relay === 'custom' && !customAddr.trim())"
          class="w-full rounded bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
        >Start hosting</button>
      }
    </section>
  `,
})
export class PlayCard {
  protected readonly bridge = inject(BridgeService);
  protected readonly ui = inject(UiStateService);
  protected readonly relayChoices = RELAY_CHOICES;

  // Join form.
  protected address = '';
  protected password = '';
  protected readonly relayOpen = signal(false);
  protected relayAddr = '';
  protected relayPort = 55435;
  protected relaySession = '';
  private defaultPort = 55435;

  // Host form.
  protected hostPort = 55435;
  protected hostPassword = '';
  protected spectatePassword = '';
  protected announce = true;
  protected relay: RelayChoice = 'off';
  protected customAddr = '';
  protected gameName = '';
  protected gameCrc = '';

  constructor() {
    void this.bridge.getSettings().then((s) => {
      if (!this.ui.nickSeeded()) {
        this.ui.nick.set(s.nick);
        this.ui.nickSeeded.set(true);
      }
      this.defaultPort = s.defaultPort;
      this.relayPort = s.defaultPort;
      this.hostPort = s.defaultPort;
      if (!this.gameName) this.gameName = s.gameName;
      if (!this.gameCrc) this.gameCrc = s.gameCrc;
      this.relay = s.relayDefault;
    });
  }

  protected onAddressChange(value: string): void {
    if (!value.includes('|')) {
      this.address = value;
      return;
    }
    // RetroArch "host|port|session" paste: fill + expand the relay section.
    const [host, portStr, session] = value.split('|');
    this.address = (host ?? '').trim();
    this.relayAddr = this.address;
    const port = Number.parseInt(portStr ?? '', 10);
    if (Number.isFinite(port) && port > 0 && port < 65536) this.relayPort = port;
    this.relaySession = (session ?? '').trim();
    this.relayOpen.set(true);
  }

  protected connectDisabled(): boolean {
    if (this.bridge.sessionActive()) return true;
    if (this.relaySession.trim()) return !(this.relayAddr.trim() || this.address.trim());
    return !this.address.trim();
  }

  protected async connect(): Promise<void> {
    if (this.connectDisabled()) return;
    const nick = this.ui.effectiveNick();
    const password = this.password || undefined;
    const session = this.relaySession.trim();
    if (session) {
      await this.bridge.joinRelay({
        addr: this.relayAddr.trim() || this.address.trim(),
        port: this.relayPort,
        session,
        nick,
        password,
      });
      return;
    }
    let host = this.address.trim();
    let port = this.defaultPort;
    const m = /^([^:]+):(\d{1,5})$/.exec(host);
    if (m) {
      host = m[1];
      port = Number(m[2]);
    }
    await this.bridge.joinDirect({ host, port, nick, password });
  }

  protected crcValid(): boolean {
    return this.gameCrc === '' || /^[0-9a-fA-F]{8}$/.test(this.gameCrc);
  }

  protected async startHosting(): Promise<void> {
    if (this.bridge.sessionActive()) return;
    await this.bridge.host({
      port: this.hostPort,
      nick: this.ui.effectiveNick(),
      password: this.hostPassword || undefined,
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
}
