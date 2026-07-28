import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { BridgeService } from './services/bridge.service';
import { StatusDot, type DotColor } from './components/status-dot';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, StatusDot],
  templateUrl: './app.html',
})
export class App {
  protected readonly bridge = inject(BridgeService);

  protected readonly nav = [
    { path: '/device', label: 'Device' },
    { path: '/join', label: 'Join' },
    { path: '/host', label: 'Host' },
    { path: '/session', label: 'Session' },
    { path: '/settings', label: 'Settings' },
  ];

  protected readonly deviceDot = computed<DotColor>(() => {
    switch (this.bridge.deviceState()) {
      case 'link-connected':
        return 'green';
      case 'handshake-received':
        return 'blue';
      case 'present':
      case 'device-ready':
      case 'awaiting-gba':
      case 'reconnecting':
        return 'amber';
      case 'access-denied':
        return 'red';
      default:
        return 'gray';
    }
  });

  protected readonly sessionDot = computed<DotColor>(() => {
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

  protected readonly announceDot = computed<DotColor>(() => {
    switch (this.bridge.announce().status) {
      case 'ok':
        return 'green';
      case 'not-connectable':
        return 'amber';
      case 'failed':
        return 'red';
      default:
        return 'gray';
    }
  });
}
