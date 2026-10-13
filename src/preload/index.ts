import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AppSettings,
  type BridgeApi,
  type BridgeEvent,
  type HostRequest,
  type JoinDirectRequest,
  type JoinRelayRequest,
  type LobbyRoom,
} from '../shared/ipc';
import type { CableSelection, FirmwareVersion } from '../engine/types';

const api: BridgeApi = {
  platform: process.platform,
  joinDirect: (req: JoinDirectRequest) => ipcRenderer.invoke(IPC.joinDirect, req) as Promise<void>,
  joinRelay: (req: JoinRelayRequest) => ipcRenderer.invoke(IPC.joinRelay, req) as Promise<void>,
  host: (req: HostRequest) => ipcRenderer.invoke(IPC.host, req) as Promise<void>,
  stop: () => ipcRenderer.invoke(IPC.stop) as Promise<void>,
  getVersion: () => ipcRenderer.invoke(IPC.getVersion) as Promise<string>,
  lobbyRefresh: () => ipcRenderer.invoke(IPC.lobbyRefresh) as Promise<LobbyRoom[]>,
  lanScan: () => ipcRenderer.invoke(IPC.lanScan) as Promise<LobbyRoom[]>,
  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<AppSettings>,
  setSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke(IPC.setSettings, patch) as Promise<AppSettings>,
  resetSettings: () => ipcRenderer.invoke(IPC.resetSettings) as Promise<AppSettings>,
  installUdevRule: () =>
    ipcRenderer.invoke(IPC.installUdevRule) as Promise<{ ok: boolean; detail?: string }>,
  setCableSelection: (selection: CableSelection) =>
    ipcRenderer.invoke(IPC.setCableSelection, selection) as Promise<FirmwareVersion>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  copyText: (text: string) => ipcRenderer.invoke(IPC.copyText, text) as Promise<void>,
  onEvent: (cb: (ev: BridgeEvent) => void) => {
    const listener = (_e: IpcRendererEvent, ev: BridgeEvent): void => cb(ev);
    ipcRenderer.on(IPC.event, listener);
    return () => {
      ipcRenderer.removeListener(IPC.event, listener);
    };
  },
};

contextBridge.exposeInMainWorld('bridge', api);
