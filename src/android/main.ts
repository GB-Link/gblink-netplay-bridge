import { IPC, type BridgeApi, type BridgeEvent } from '../shared/ipc';
import { EngineHost } from '../main/engine-host';
import { scanLan } from '../main/lan-discovery';
import { fetchRooms } from '../main/lobby';
import { SettingsStore } from '../main/settings';
import { AppShell } from './native';
import { routeDatagramEvents } from './shims/dgram';
import { onWindowMessage } from './shims/electron';
import { routeSocketEvents } from './shims/net';
import { routeSerialEvents } from './shims/serialport';
import { initUsb } from './shims/usb';
import { routeUsbReads } from './usb/device';

declare const APP_VERSION: string;

/**
 * The desktop's main process, run in the page: the same host code behind the same bridge. Every
 * native listener is in place before any I/O starts, so none is added while events are flowing.
 */
const started = (async () => {
  await Promise.all([
    initUsb(),
    routeUsbReads(),
    routeSerialEvents(),
    routeSocketEvents(),
    routeDatagramEvents(),
  ]);
  const settings = new SettingsStore();
  return { settings, host: new EngineHost(settings) };
})();

/** Requests and answers cross as copies, as they do over Electron's IPC. */
const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

async function invoke<T>(run: (app: Awaited<typeof started>) => T | Promise<T>): Promise<T> {
  return copy(await run(await started));
}

const ACTIVE_PHASES = new Set(['connecting', 'relay-connecting', 'handshaking', 'connected', 'hosting']);

let sessionActive = false;
onWindowMessage((channel, payload) => {
  const ev = payload as BridgeEvent;
  if (channel !== IPC.event || ev.type !== 'session') return;
  const active = ACTIVE_PHASES.has(ev.phase);
  if (active === sessionActive) return;
  sessionActive = active;
  void AppShell.setSessionActive({ active }).catch(() => undefined);
});

// The interface closes an open panel by cancelling 'backbutton'; otherwise the app steps back.
void AppShell.addListener('backButton', () => {
  const back = new Event('backbutton', { cancelable: true });
  window.dispatchEvent(back);
  if (!back.defaultPrevented) void AppShell.moveToBack();
});

const api: BridgeApi = {
  platform: 'android',
  joinDirect: (req) => invoke(({ host }) => host.joinDirect(copy(req))),
  joinRelay: (req) => invoke(({ host }) => host.joinRelay(copy(req))),
  host: (req) => invoke(({ host }) => host.host(copy(req))),
  stop: () => invoke(({ host }) => host.stop()),
  getVersion: async () => APP_VERSION,
  lobbyRefresh: () => invoke(() => fetchRooms()),
  lanScan: () => invoke(() => scanLan()),
  getSettings: () => invoke(({ settings }) => settings.get()),
  setSettings: (patch) => invoke(({ settings }) => settings.update(copy(patch))),
  resetSettings: () => invoke(({ settings }) => settings.reset()),
  installUdevRule: async () => ({ ok: false, detail: 'Android needs no USB rule.' }),
  openExternal: async (url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`refusing to open ${parsed.protocol} URL`);
    }
    await AppShell.openUrl({ url });
  },
  copyText: (text) => AppShell.copyText({ text: String(text) }),
  onEvent: (cb) => {
    const off = onWindowMessage((channel, payload) => {
      if (channel === IPC.event) cb(copy(payload as BridgeEvent));
    });
    // The interface subscribes once it has loaded; replay device presence then, as the desktop does.
    void started.then(({ host }) => host.refreshDevice());
    return off;
  },
};

window.bridge = api;
