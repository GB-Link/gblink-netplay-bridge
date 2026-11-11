/**
 * Node globals the shared code uses, given to the bridge bundle without touching the page's own:
 * Buffer, setImmediate, and timers whose handles have Node's unref() and ref().
 */
export { Buffer } from 'buffer';

class Timeout {
  constructor(readonly id: number) {}

  /** The page has no event loop to keep alive. */
  unref(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  hasRef(): boolean {
    return true;
  }

  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

type Handle = Timeout | number | undefined | null;

const idOf = (handle: Handle): number | undefined =>
  handle instanceof Timeout ? handle.id : (handle ?? undefined);

export function setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timeout {
  return new Timeout(window.setTimeout(callback, ms, ...args));
}

export function setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timeout {
  return new Timeout(window.setInterval(callback, ms, ...args));
}

export function clearTimeout(handle: Handle): void {
  window.clearTimeout(idOf(handle));
}

export function clearInterval(handle: Handle): void {
  window.clearInterval(idOf(handle));
}

export function setImmediate(callback: (...args: unknown[]) => void, ...args: unknown[]): Timeout {
  return setTimeout(callback, 0, ...args);
}
