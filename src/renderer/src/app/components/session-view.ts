import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { BridgeService } from '../services/bridge.service';
import { closeReasonText, linkStatusText, sessionStatusText } from '../copy/state-copy';

@Component({
  selector: 'app-session-view',
  template: `
    <div class="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div class="w-full max-w-xl rounded-lg p-6" [class]="bannerClass()">
        <div class="text-xl font-semibold">{{ linkText() }}</div>
        <div class="mt-1 text-sm opacity-80">
          {{ sessionText() }}
          @if (closeText(); as reason) {
            <span> — {{ reason }}</span>
          }
        </div>
      </div>

      <div class="text-sm text-neutral-600 dark:text-neutral-300">
        @if (peerNames(); as names) {
          <span>with {{ names }}</span>
        } @else {
          <span>No peers connected yet</span>
        }
        <span class="mx-2 text-neutral-400">·</span>
        <span class="tabular-nums">
          tx {{ bridge.counters().txPackets }} · rx {{ bridge.counters().rxPackets }}
        </span>
      </div>

      @if (hosting()) {
        <div
          class="w-full max-w-xl rounded-lg border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          @if (bridge.hostReady(); as hr) {
            <div class="flex flex-wrap items-center justify-center gap-2">
              <span>
                Port <span class="font-mono">{{ hr.extPort }}</span>
              </span>
              @if (hr.relaySessionId; as sid) {
                <span class="text-neutral-400">·</span>
                <span>
                  Relay session
                  <code
                    class="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:bg-neutral-800"
                  >{{ sid }}</code>
                </span>
                <button
                  (click)="copySession(sid)"
                  class="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >{{ copied() ? 'Copied' : 'Copy' }}</button>
              }
            </div>
          } @else {
            <div class="text-neutral-500">Starting…</div>
          }
          <div class="mt-2" [class]="announceClass()">{{ announceLine() }}</div>
          @if (countdown() !== null) {
            <div class="mt-1 text-xs text-neutral-500">Next announce in {{ countdown() }} s</div>
          }
        </div>
      }

      <button
        (click)="stopClicked()"
        class="rounded bg-red-600 px-6 py-2 text-sm font-medium text-white hover:bg-red-700"
      >Stop</button>
    </div>

    @if (confirmOpen()) {
      <div class="fixed inset-0 z-20 flex items-center justify-center bg-black/40">
        <div
          class="w-96 rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        >
          <div class="mb-3 text-sm">
            A trade may be in progress — disconnecting now can lose Pokémon. Disconnect anyway?
          </div>
          <div class="flex justify-end gap-2">
            <button
              (click)="confirmOpen.set(false)"
              class="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700"
            >Stay connected</button>
            <button
              (click)="doStop()"
              class="rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700"
            >Disconnect</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SessionView {
  protected readonly bridge = inject(BridgeService);
  protected readonly confirmOpen = signal(false);
  protected readonly copied = signal(false);

  private readonly now = signal(Date.now());

  protected readonly hosting = computed(() => this.bridge.sessionPhase() === 'hosting');

  protected readonly peerNames = computed(() => {
    const peers = this.bridge.peers();
    return peers.length ? peers.map((p) => p.nick).join(', ') : null;
  });

  protected readonly countdown = computed<number | null>(() => {
    const a = this.bridge.announce();
    if (a.status === 'off' || a.nextInSec === undefined) return null;
    const elapsed = (this.now() - a.at) / 1000;
    return Math.max(0, Math.round(a.nextInSec - elapsed));
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    destroyRef.onDestroy(() => clearInterval(timer));
  }

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

  protected async copySession(sid: string): Promise<void> {
    await this.bridge.copyText(sid);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  protected stopClicked(): void {
    if (this.bridge.linkPhase() === 'connected') this.confirmOpen.set(true);
    else void this.bridge.stop();
  }

  protected doStop(): void {
    this.confirmOpen.set(false);
    void this.bridge.stop();
  }
}
