/**
 * Calls `tick` every `periodMs` on average and returns a stop function. Deadlines accumulate
 * because Node timers fire on whole milliseconds (a 16.74 ms setInterval runs at ~62 Hz).
 * After a stall the clock starts over instead of bursting.
 */
export function frameClock(tick: () => void, periodMs: number): () => void {
  let next = Date.now() + periodMs;
  let timer: NodeJS.Timeout | null = null;
  let running = true;
  const run = (): void => {
    timer = null;
    if (!running) return;
    const now = Date.now();
    if (now - next > periodMs * 8) next = now;
    while (running && now >= next) {
      next += periodMs;
      tick();
    }
    if (!running) return;
    timer = setTimeout(run, Math.max(1, Math.ceil(next - Date.now())));
    timer.unref?.();
  };
  timer = setTimeout(run, Math.ceil(periodMs));
  timer.unref?.();
  return () => {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
