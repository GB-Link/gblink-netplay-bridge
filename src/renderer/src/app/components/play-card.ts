import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BridgeService } from '../services/bridge.service';
import { UiStateService } from '../services/ui-state.service';
import type { AppSettings, RelayHandle } from '../../../../shared/ipc';
import type { Console, LinkGame, SwitchRoom } from '../../../../engine/types';
import {
  CONSOLE_GAMES,
  CONSOLE_LABELS,
  DEFAULT_GAME_NAMES,
  GAME_LABELS,
  GPSP_SERIAL_OPTION,
  SWITCH_ROOM_LABELS,
  isConsole,
  isLinkGame,
  isSwitchRoom,
} from '../../../../shared/games';
import { DEFAULT_NETPLAY_PORT, normalizePort } from '../util/ports';

const CONSOLE_CHOICES: Console[] = ['gba', 'switch'];
const ROOM_CHOICES: SwitchRoom[] = ['trade', 'single', 'double'];

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
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <span class="text-sm text-neutral-600 dark:text-neutral-400">Console</span>
        <div
          class="inline-flex overflow-hidden rounded border border-neutral-300 text-sm dark:border-neutral-700"
        >
          @for (c of consoleChoices; track c) {
            <button
              (click)="ui.setConsole(c)"
              class="px-3 py-1.5 first:border-0 border-l border-neutral-300 dark:border-neutral-700"
              [class.bg-neutral-200]="ui.console() === c"
              [class.font-semibold]="ui.console() === c"
              [class.dark:bg-neutral-700]="ui.console() === c"
              [class.text-neutral-500]="ui.console() !== c"
            >{{ consoleLabels[c] }}</button>
          }
        </div>
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <span class="text-sm text-neutral-600 dark:text-neutral-400">Game</span>
        <div
          class="inline-flex overflow-hidden rounded border border-neutral-300 text-sm dark:border-neutral-700"
        >
          @for (g of gameChoices(); track g) {
            <button
              (click)="selectGame(g)"
              class="px-3 py-1.5 first:border-0 border-l border-neutral-300 dark:border-neutral-700"
              [class.bg-neutral-200]="ui.game() === g"
              [class.font-semibold]="ui.game() === g"
              [class.dark:bg-neutral-700]="ui.game() === g"
              [class.text-neutral-500]="ui.game() !== g"
            >{{ gameLabels[g] }}</button>
          }
        </div>
      </div>

      <p class="mb-3 text-xs text-neutral-500">
        RetroArch players set gpsp's <span class="font-medium">Link Cable Connectivity</span> to
        <span class="font-medium">{{ gpspOption() }}</span> before loading the game.
      </p>

      @if (ui.console() === 'switch') {
        <div class="mb-3 flex flex-wrap items-center gap-4">
          @if (ui.game() === 'gen3' && ui.playMode() === 'join') {
            <label class="flex items-center gap-2 text-sm">
              <span class="text-neutral-600 dark:text-neutral-400">Switch joins</span>
              <select
                [ngModel]="ui.switchRoom()"
                (ngModelChange)="ui.setSwitchRoom($event)"
                class="rounded border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              >
                @for (r of roomChoices; track r) {
                  <option [ngValue]="r">{{ roomLabels[r] }}</option>
                }
              </select>
            </label>
          }
          <label
            class="flex items-center gap-2 text-sm"
            title="Lets the Switch link with Emerald (or Ruby and Sapphire by cable) before the Sevii Islands story and the National Dex. Leave it off when the other players run FireRed or LeafGreen: they would see the Switch as an Emerald and check their own progress."
          >
            <input type="checkbox" [ngModel]="ui.nationalBypass()" (ngModelChange)="ui.setNationalBypass($event)" class="h-4 w-4" />
            <span>National Dex bypass (partner on Emerald, Ruby or Sapphire)</span>
          </label>
        </div>
      }

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
                  (blur)="relayPort = normalizePort(relayPort, defaultPort)"
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
          @if (wireless()) {
            <div
              class="mb-3 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            >
              Wireless Adapter games can't join through a relay. Ask the host to turn their relay off,
              then empty the session field and connect to their address.
            </div>
          } @else {
            <div
              class="mb-3 rounded bg-sky-50 px-2 py-1 text-xs text-sky-700 dark:bg-sky-950 dark:text-sky-300"
            >
              Relay session set — will join through the relay.
            </div>
          }
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
              (blur)="hostPort = normalizePort(hostPort, defaultPort)"
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
            [ngModel]="hostRelay()"
            (ngModelChange)="relay = $event"
            [disabled]="wireless()"
            class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900"
          >
            @for (c of relayChoices; track c.value) {
              <option [ngValue]="c.value">{{ c.label }}</option>
            }
          </select>
          @if (wireless()) {
            <span class="mt-1 block text-xs text-neutral-500">
              Wireless Adapter games host without a relay, which adds more delay than they can take.
              Players on your network can join you directly; anyone else needs your port forwarded.
            </span>
          }
        </label>
        @if (hostRelay() === 'custom') {
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
          [disabled]="bridge.sessionActive() || !crcValid() || (hostRelay() === 'custom' && !customAddr.trim())"
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
  protected readonly consoleChoices = CONSOLE_CHOICES;
  protected readonly consoleLabels = CONSOLE_LABELS;
  protected readonly roomChoices = ROOM_CHOICES;
  protected readonly roomLabels = SWITCH_ROOM_LABELS;
  protected readonly gameLabels = GAME_LABELS;
  protected readonly gameChoices = computed(() => CONSOLE_GAMES[this.ui.console()]);
  protected readonly gpspOption = computed(() => GPSP_SERIAL_OPTION[this.ui.game()]);
  /** A relay's delay is more than the Wireless Adapter games can take, on either console. */
  protected readonly wireless = computed(() => this.ui.game() === 'rfu');

  // Join form.
  protected readonly normalizePort = normalizePort;
  private settingsLoaded = false;
  protected address = '';
  protected password = '';
  protected readonly relayOpen = signal(false);
  protected relayAddr = '';
  protected relayPort = 55435;
  protected relaySession = '';
  protected defaultPort = 55435;

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
      this.defaultPort = normalizePort(s.defaultPort);
      this.relayPort = this.defaultPort;
      this.hostPort = normalizePort(s.hostPort, this.defaultPort);
      if (!this.address) this.address = s.lastAddress;
      if (!this.ui.gameSeeded() && isLinkGame(s.game)) {
        this.ui.game.set(s.game);
        this.ui.gameSeeded.set(true);
        if (isConsole(s.console)) this.ui.console.set(s.console);
        if (isSwitchRoom(s.switchRoom)) this.ui.switchRoom.set(s.switchRoom);
        this.ui.nationalBypass.set(Boolean(s.nationalBypass));
      }
      if (!this.gameName) this.gameName = s.gameName;
      if (!this.gameCrc) this.gameCrc = s.gameCrc;
      this.relay = s.relayDefault;
      this.announce = s.announce;
      this.settingsLoaded = true;
    });
  }

  protected selectGame(game: LinkGame): void {
    this.ui.setGame(game);
    // Follow the announce-name default unless the host typed a custom one.
    const defaults = Object.values(DEFAULT_GAME_NAMES) as string[];
    if (this.gameName.trim() === '' || defaults.includes(this.gameName.trim())) {
      this.gameName = DEFAULT_GAME_NAMES[game];
    }
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
    if (this.relaySession.trim()) return this.wireless() || !(this.relayAddr.trim() || this.address.trim());
    return !this.address.trim();
  }

  protected async connect(): Promise<void> {
    if (this.connectDisabled()) return;
    try {
      await this.tryConnect();
    } catch (e) {
      this.bridge.reportActionError(e);
    }
  }

  /** Persist the fields a player would otherwise retype every launch. */
  private remember(patch: Partial<AppSettings>): void {
    if (!this.settingsLoaded) return;
    void this.bridge.setSettings(patch);
  }

  private setup(): { game: LinkGame; console: Console; switchRoom: SwitchRoom; nationalBypass: boolean } {
    return {
      game: this.ui.game(),
      console: this.ui.console(),
      switchRoom: this.ui.switchRoom(),
      nationalBypass: this.ui.nationalBypass(),
    };
  }

  private async tryConnect(): Promise<void> {
    this.remember({ lastAddress: this.address.trim() });
    const nick = this.ui.effectiveNick();
    const password = this.password || undefined;
    const session = this.relaySession.trim();
    if (session) {
      await this.bridge.joinRelay({
        addr: this.relayAddr.trim() || this.address.trim(),
        port: normalizePort(this.relayPort, this.defaultPort),
        session,
        nick,
        password,
        ...this.setup(),
      });
      return;
    }
    let host = this.address.trim();
    let port = this.defaultPort;
    const m = /^([^:]+):(\d{1,5})$/.exec(host);
    if (m) {
      host = m[1];
      port = normalizePort(m[2], this.defaultPort);
    }
    await this.bridge.joinDirect({
      host,
      port: normalizePort(port, this.defaultPort),
      nick,
      password,
      ...this.setup(),
    });
  }

  /** Wireless Adapter games host without a relay; the saved choice still applies to the others. */
  protected hostRelay(): RelayChoice {
    return this.wireless() ? 'off' : this.relay;
  }

  protected crcValid(): boolean {
    return this.gameCrc === '' || /^[0-9a-fA-F]{8}$/.test(this.gameCrc);
  }

  protected async startHosting(): Promise<void> {
    if (this.bridge.sessionActive()) return;
    try {
      await this.hostSession();
    } catch (e) {
      this.bridge.reportActionError(e);
    }
  }

  private async hostSession(): Promise<void> {
    const port = normalizePort(this.hostPort, this.defaultPort);
    this.hostPort = port;
    const gameName = this.gameName.trim() || DEFAULT_GAME_NAMES[this.ui.game()];
    const relay = this.hostRelay();
    this.remember({
      hostPort: port,
      announce: this.announce,
      relayDefault: this.relay,
      gameName,
      gameCrc: this.gameCrc,
    });
    await this.bridge.host({
      port,
      nick: this.ui.effectiveNick(),
      password: this.hostPassword || undefined,
      spectatePassword: this.spectatePassword || undefined,
      announce: this.announce,
      relay:
        relay === 'off'
          ? undefined
          : {
              handle: relay,
              customAddr: relay === 'custom' ? this.customAddr.trim() : undefined,
            },
      gameName,
      gameCrc: this.gameCrc || undefined,
      ...this.setup(),
    });
  }
}
