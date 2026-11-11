/** Keeps the settings file in the web view's storage, which lasts until the app is uninstalled. */
const key = (path: string): string => `file:${path}`;

function readFileSync(path: string, _encoding: 'utf8'): string {
  const text = localStorage.getItem(key(path));
  if (text === null) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
  return text;
}

function writeFileSync(path: string, data: string, _encoding: 'utf8'): void {
  localStorage.setItem(key(path), data);
}

function mkdirSync(_path: string, _options?: { recursive?: boolean }): void {}

export default { readFileSync, writeFileSync, mkdirSync };
