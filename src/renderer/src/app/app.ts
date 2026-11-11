import { Component, computed, inject, signal } from '@angular/core';
import { BridgeService } from './services/bridge.service';
import { closeReasonText } from './copy/state-copy';
import { StatusBar } from './components/status-bar';
import { PlayCard } from './components/play-card';
import { LobbyList } from './components/lobby-list';
import { SessionView } from './components/session-view';
import { LogDrawer } from './components/log-drawer';
import { SettingsModal } from './components/settings-modal';
import { DeviceDrawer } from './components/device-drawer';

@Component({
  selector: 'app-root',
  imports: [StatusBar, PlayCard, LobbyList, SessionView, LogDrawer, SettingsModal, DeviceDrawer],
  templateUrl: './app.html',
  host: { '(window:backbutton)': 'closePanel($event)' },
})
export class App {
  protected readonly bridge = inject(BridgeService);

  protected readonly settingsOpen = signal(false);
  protected readonly deviceOpen = signal(false);

  /** Why the last session ended, shown in the idle view until dismissed. */
  protected readonly closeNotice = computed(() => {
    const failure = this.bridge.actionError();
    if (failure) return { text: failure, detail: null, graceful: false };
    const reason = this.bridge.closeReason();
    if (!reason) return null;
    return {
      text: closeReasonText(reason),
      detail: this.bridge.closeDetail(),
      graceful: reason === 'graceful',
    };
  });

  /** Android's back button closes an open panel before it leaves the app. */
  protected closePanel(event: Event): void {
    if (this.settingsOpen()) this.settingsOpen.set(false);
    else if (this.deviceOpen()) this.deviceOpen.set(false);
    else return;
    event.preventDefault();
  }

  protected dismissNotice(): void {
    this.bridge.actionError.set(null);
    this.bridge.closeReason.set(null);
    this.bridge.closeDetail.set(null);
  }
}
