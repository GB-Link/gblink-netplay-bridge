import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'device' },
  {
    path: 'device',
    loadComponent: () => import('./pages/device-page').then((m) => m.DevicePage),
  },
  {
    path: 'join',
    loadComponent: () => import('./pages/join-page').then((m) => m.JoinPage),
  },
  {
    path: 'host',
    loadComponent: () => import('./pages/host-page').then((m) => m.HostPage),
  },
  {
    path: 'session',
    loadComponent: () => import('./pages/session-page').then((m) => m.SessionPage),
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings-page').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: 'device' },
];
