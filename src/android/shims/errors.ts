/** A Node-style system error: the engine and its messages read `code`. */
export function systemError(e: unknown, syscall: string, where: string): Error & { code?: string } {
  const code = (e as { code?: unknown }).code;
  const text = e instanceof Error ? e.message : String(e);
  if (typeof code !== 'string' || !/^E[A-Z]+$/.test(code)) return new Error(text);
  return Object.assign(new Error(`${syscall} ${code} ${where}`), { code, syscall });
}
