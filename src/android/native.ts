import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** A USB device as Android lists it; `name` is its bus path, stable while it stays plugged in. */
export interface UsbEntry {
  name: string;
  vendorId: number;
  productId: number;
}

export interface UsbLinkPlugin {
  list(): Promise<{ devices: UsbEntry[] }>;
  /** Asks for access when needed, claims interface 0 and starts reading both IN endpoints. */
  open(options: { name: string }): Promise<{ handle: number }>;
  write(options: { handle: number; endpoint: number; data: string }): Promise<void>;
  close(options: { handle: number }): Promise<void>;
  addListener(event: 'attach' | 'detach', fn: (device: UsbEntry) => void): Promise<PluginListenerHandle>;
  addListener(
    event: 'data',
    fn: (e: { handle: number; endpoint: number; data: string }) => void,
  ): Promise<PluginListenerHandle>;
  /** Reading stopped with the adapter still plugged in. */
  addListener(event: 'lost', fn: (e: { handle: number; reason: string }) => void): Promise<PluginListenerHandle>;
}

export interface SerialEntry {
  path: string;
  vendorId: number;
  productId: number;
  manufacturer?: string;
}

export interface SerialLinkPlugin {
  list(): Promise<{ ports: SerialEntry[] }>;
  open(options: { path: string; baudRate: number }): Promise<{ handle: number }>;
  setSignals(options: { handle: number; dtr: boolean; rts: boolean }): Promise<void>;
  write(options: { handle: number; data: string }): Promise<void>;
  close(options: { handle: number }): Promise<void>;
  addListener(event: 'data', fn: (e: { handle: number; data: string }) => void): Promise<PluginListenerHandle>;
  /** The port closed; `error` is set when it was lost rather than closed by us. */
  addListener(event: 'closed', fn: (e: { handle: number; error?: string }) => void): Promise<PluginListenerHandle>;
}

export interface SocketsPlugin {
  connect(options: { host: string; port: number }): Promise<{ id: number; remoteAddress: string; remotePort: number }>;
  /** Fire and forget: bytes go out in call order, and a failure closes the socket. */
  write(options: { id: number; data: string }): void;
  /** Half-closes once everything written so far has gone out. */
  end(options: { id: number }): void;
  destroy(options: { id: number }): void;
  listen(options: { port: number }): Promise<{ id: number; port: number }>;
  closeServer(options: { id: number }): Promise<void>;
  udpBind(options: { port: number }): Promise<{ id: number; port: number }>;
  udpSend(options: { id: number; address: string; port: number; data: string }): void;
  udpClose(options: { id: number }): void;
  addListener(event: 'data', fn: (e: { id: number; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(
    event: 'closed',
    fn: (e: { id: number; code?: string; message?: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'accept',
    fn: (e: { server: number; id: number; remoteAddress: string; remotePort: number }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'udpMessage',
    fn: (e: { id: number; address: string; port: number; data: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export interface AppShellPlugin {
  openUrl(options: { url: string }): Promise<void>;
  copyText(options: { text: string }): Promise<void>;
  /** Keeps the screen on and Wi-Fi at low latency while a session runs. */
  setSessionActive(options: { active: boolean }): Promise<void>;
  moveToBack(): Promise<void>;
  addListener(event: 'backButton', fn: () => void): Promise<PluginListenerHandle>;
}

export const UsbLink = registerPlugin<UsbLinkPlugin>('UsbLink');
export const SerialLink = registerPlugin<SerialLinkPlugin>('SerialLink');
export const Sockets = registerPlugin<SocketsPlugin>('Sockets');
export const AppShell = registerPlugin<AppShellPlugin>('AppShell');

export const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

export const fromBase64 = (data: string): Buffer => Buffer.from(data, 'base64');
