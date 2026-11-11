import { EventEmitter } from 'node:events';
import { Sockets, fromBase64, toBase64 } from '../native';
import { systemError } from './errors';

const sockets = new Map<number, Socket>();
const servers = new Map<number, Server>();
let routing: Promise<void> | null = null;

/** Native events reach the socket or server they name; each id's events arrive in order. */
export function routeSocketEvents(): Promise<void> {
  routing ??= (async () => {
    await Sockets.addListener('data', (e) => sockets.get(e.id)?.received(fromBase64(e.data)));
    await Sockets.addListener('closed', (e) => sockets.get(e.id)?.closedNatively(e.code, e.message));
    await Sockets.addListener('accept', (e) =>
      servers.get(e.server)?.accepted(e.id, e.remoteAddress, e.remotePort),
    );
  })();
  return routing;
}

/** The node:net Socket calls the netplay code makes, over Android sockets. Nagle is always off. */
export class Socket extends EventEmitter {
  connecting = false;
  destroyed = false;
  writable = false;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
  private id: number | null = null;
  private ended = false;
  /** Written before the connection was up; sent once it is. */
  private pending: string[] = [];

  static accepted(id: number, remoteAddress: string, remotePort: number): Socket {
    const sock = new Socket();
    sock.id = id;
    sock.writable = true;
    sock.remoteAddress = remoteAddress;
    sock.remotePort = remotePort;
    sockets.set(id, sock);
    return sock;
  }

  setNoDelay(_noDelay = true): this {
    return this;
  }

  connect(portOrOptions: number | { host?: string; port: number }, host?: string): this {
    const port = typeof portOrOptions === 'number' ? portOrOptions : portOrOptions.port;
    const target = (typeof portOrOptions === 'number' ? host : portOrOptions.host) ?? 'localhost';
    this.connecting = true;
    this.writable = true;
    routeSocketEvents()
      .then(() => Sockets.connect({ host: target, port }))
      .then(
        ({ id, remoteAddress, remotePort }) => {
          if (this.destroyed) {
            Sockets.destroy({ id });
            return;
          }
          this.id = id;
          sockets.set(id, this);
          this.connecting = false;
          this.remoteAddress = remoteAddress;
          this.remotePort = remotePort;
          for (const data of this.pending) Sockets.write({ id, data });
          this.pending = [];
          if (this.ended) Sockets.end({ id });
          this.emit('connect');
          this.emit('ready');
        },
        (e: unknown) => {
          if (this.destroyed) return;
          this.connecting = false;
          this.emit('error', systemError(e, 'connect', `${target}:${port}`));
          this.destroy();
        },
      );
    return this;
  }

  write(data: Uint8Array | string, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean {
    if (this.destroyed || this.ended) return false;
    const bytes = typeof data === 'string' ? Buffer.from(data, typeof encoding === 'string' ? encoding : 'utf8') : data;
    const chunk = toBase64(bytes);
    if (this.id === null) this.pending.push(chunk);
    else Sockets.write({ id: this.id, data: chunk });
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  }

  end(): this {
    if (this.destroyed || this.ended) return this;
    this.ended = true;
    this.writable = false;
    if (this.id !== null) Sockets.end({ id: this.id });
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.markClosed();
    queueMicrotask(() => this.emit('close', false));
    return this;
  }

  received(data: Buffer): void {
    if (!this.destroyed) this.emit('data', data);
  }

  /** The connection ended on its own: an error, or the peer closing it. */
  closedNatively(code?: string, message?: string): void {
    if (this.destroyed) return;
    this.markClosed();
    if (code !== undefined) {
      this.emit('error', systemError({ code, message }, 'read', `${this.remoteAddress}:${this.remotePort}`));
      this.emit('close', true);
    } else {
      this.emit('end');
      this.emit('close', false);
    }
  }

  private markClosed(): void {
    this.destroyed = true;
    this.writable = false;
    this.connecting = false;
    const id = this.id;
    if (id === null) return;
    this.id = null;
    sockets.delete(id);
    Sockets.destroy({ id });
  }
}

export function connect(options: { host?: string; port: number }, listener?: () => void): Socket {
  const sock = new Socket();
  if (listener) sock.once('connect', listener);
  return sock.connect(options);
}

export const createConnection = connect;

/** The node:net Server calls the netplay host makes: listen on a port and take connections. */
export class Server extends EventEmitter {
  private id: number | null = null;
  private port = 0;
  private closed = false;

  constructor(onConnection?: (sock: Socket) => void) {
    super();
    if (onConnection) this.on('connection', onConnection);
  }

  listen(port: number, listening?: () => void): this {
    routeSocketEvents()
      .then(() => Sockets.listen({ port }))
      .then(
        ({ id, port: bound }) => {
          if (this.closed) {
            void Sockets.closeServer({ id });
            return;
          }
          this.id = id;
          this.port = bound;
          servers.set(id, this);
          this.emit('listening');
          listening?.();
        },
        (e: unknown) => this.emit('error', systemError(e, 'listen', `:::${port}`)),
      );
    return this;
  }

  address(): { address: string; family: string; port: number } | null {
    return this.id === null ? null : { address: '::', family: 'IPv6', port: this.port };
  }

  close(callback?: () => void): this {
    this.closed = true;
    const id = this.id;
    this.id = null;
    const done = (): void => {
      this.emit('close');
      callback?.();
    };
    if (id === null) {
      queueMicrotask(done);
      return this;
    }
    servers.delete(id);
    Sockets.closeServer({ id }).then(done, done);
    return this;
  }

  accepted(id: number, remoteAddress: string, remotePort: number): void {
    if (this.closed) {
      Sockets.destroy({ id });
      return;
    }
    this.emit('connection', Socket.accepted(id, remoteAddress, remotePort));
  }
}

export function createServer(onConnection?: (sock: Socket) => void): Server {
  return new Server(onConnection);
}
