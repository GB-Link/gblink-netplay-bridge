import path from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import {
  IPC,
  type AppSettings,
  type BridgeEvent,
  type HostRequest,
  type JoinDirectRequest,
  type JoinRelayRequest,
} from '../shared/ipc';
import type { CableSelection } from '../engine/types';
import { EngineHost } from './engine-host';
import { scanLan } from './lan-discovery';
import { fetchRooms } from './lobby';
import { SettingsStore } from './settings';
import { installUdevRule } from './udev';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main(): void {
  const settings = new SettingsStore();
  const host = new EngineHost(settings);
  let mainWindow: BrowserWindow | null = null;

  function createWindow(): void {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 1000,
      minHeight: 700,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    mainWindow = win;
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });
    // The renderer subscribes only after load; replay device presence then.
    win.webContents.on('did-finish-load', () => {
      host.refreshDevice();
    });
    if (process.env['GBLINK_DEV']) {
      void win.loadURL('http://localhost:4200');
      win.webContents.openDevTools();
    } else {
      void win.loadFile(path.join(__dirname, '../renderer/browser/index.html'));
    }
  }

  function registerIpc(): void {
    ipcMain.handle(IPC.joinDirect, (_e, req: JoinDirectRequest) => host.joinDirect(req));
    ipcMain.handle(IPC.joinRelay, (_e, req: JoinRelayRequest) => host.joinRelay(req));
    ipcMain.handle(IPC.host, (_e, req: HostRequest) => host.host(req));
    ipcMain.handle(IPC.stop, () => host.stop());
    ipcMain.handle(IPC.getVersion, () => app.getVersion());
    ipcMain.handle(IPC.lobbyRefresh, () => fetchRooms());
    ipcMain.handle(IPC.lanScan, () => scanLan());
    ipcMain.handle(IPC.getSettings, () => settings.get());
    ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => settings.update(patch));
    ipcMain.handle(IPC.resetSettings, () => settings.reset());
    ipcMain.handle(IPC.installUdevRule, () => installUdevRule());
    ipcMain.handle(IPC.setCableSelection, (_e, sel: CableSelection) => host.setCableSelection(sel));
    ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`refusing to open ${parsed.protocol} URL`);
      }
      await shell.openExternal(url);
    });
    ipcMain.handle(IPC.copyText, (_e, text: string) => {
      clipboard.writeText(String(text));
    });
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    void host.stop();
  });
}
