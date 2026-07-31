export const DEFAULT_NETPLAY_PORT = 55435;

/**
 * Coerce a port field to a usable value. A cleared `type="number"` input
 * binds as null, which would otherwise reach the engine and make Node listen
 * on a random port (hosting) or fail to connect (joining).
 */
export function normalizePort(value: unknown, fallback = DEFAULT_NETPLAY_PORT): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const port = Math.trunc(parsed);
  return port >= 1 && port <= 65535 ? port : fallback;
}
