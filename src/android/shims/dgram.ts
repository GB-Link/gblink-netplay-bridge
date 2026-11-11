import { EventEmitter } from 'node:events';
import { Sockets, fromBase64, toBase64 } from '../native';
import { systemError } from './errors';

export interface RemoteInfo {
  address: string;
  family: 'IPv4';
  port: number;
  size: number;
}

const bound = new Map<number, Socket>();
let routing: Promise<void> | null = null;

export function routeDatagramEvents(): Promise<void> {
  routing ??= (async () => {
    await Sockets.addListener('udpMessage', (e) => {
      const data = fromBase64(e.data);
      bound.get(e.id)?.emit('message', data, { address: e.address, family: 'IPv4', port: e.port, size: data.length });
    });
  })();
  return routing;
}

/** The node:dgram calls LAN discovery makes: bind, broadcast a query, answer one. Broadcast is always on. */
export class Socket extends EventEmitter {
  private id: number | null = null;
  private port = 0;
  private closed = false;

  bind(port = 0, listening?: () => void): this {
    routeDatagramEvents()
      .then(() => Sockets.udpBind({ port }))
      .then(
        ({ id, port: boundPort }) => {
          if (this.closed) {
            Sockets.udpClose({ id });
            return;
          }
          this.id = id;
          this.port = boundPort;
          bound.set(id, this);
          this.emit('listening');
          listening?.();
        },
        (e: unknown) => this.emit('error', systemError(e, 'bind', `0.0.0.0:${port}`)),
      );
    return this;
  }

  address(): { address: string; family: 'IPv4'; port: number } {
    if (this.id === null) throw new Error('Not running');
    return { address: '0.0.0.0', family: 'IPv4', port: this.port };
  }

  setBroadcast(_on: boolean): void {
    if (this.id === null) throw new Error('Not running');
  }

  send(msg: Uint8Array, port: number, address: string): void {
    if (this.id === null) throw new Error('Not running');
    Sockets.udpSend({ id: this.id, address, port, data: toBase64(msg) });
  }

  close(): void {
    if (this.closed) throw new Error('Not running');
    this.closed = true;
    const id = this.id;
    this.id = null;
    if (id !== null) {
      bound.delete(id);
      Sockets.udpClose({ id });
    }
    queueMicrotask(() => this.emit('close'));
  }
}

export function createSocket(_options: { type: 'udp4'; reuseAddr?: boolean } | 'udp4'): Socket {
  return new Socket();
}

export default { createSocket, Socket };
