/** The Electron calls the shared host code makes: events to the window, and where settings live. */
type Listener = (channel: string, payload: unknown) => void;

const listeners = new Set<Listener>();

/** The interface's side of `webContents.send`. */
export function onWindowMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const webContents = {
  send(channel: string, payload: unknown): void {
    for (const listener of listeners) listener(channel, payload);
  },
};

export const BrowserWindow = {
  getAllWindows: (): { webContents: typeof webContents }[] => [{ webContents }],
};

export const app = {
  getPath: (_name: string): string => '/app',
};
