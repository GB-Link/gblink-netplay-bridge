import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';

const RULE_FILE = '70-gblink.rules';
const INSTALLED_PATHS = [
  `/etc/udev/rules.d/${RULE_FILE}`,
  `/usr/lib/udev/rules.d/${RULE_FILE}`,
];

/** True without a rule, or with one from before the adapter's IDs changed (firmware 3.0.0). */
export function needsUdevRule(): boolean {
  if (process.platform !== 'linux') return false;
  return !INSTALLED_PATHS.some((p) => {
    try {
      return fs.readFileSync(p, 'utf8').includes('b011');
    } catch {
      return false;
    }
  });
}

function bundledRulePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, RULE_FILE)
    : path.join(app.getAppPath(), 'resources', RULE_FILE);
}

export function installUdevRule(): Promise<{ ok: boolean; detail?: string }> {
  if (process.platform !== 'linux') {
    return Promise.resolve({ ok: false, detail: 'udev rules only apply on Linux' });
  }
  let ruleText: string;
  try {
    ruleText = fs.readFileSync(bundledRulePath(), 'utf8');
  } catch (e) {
    return Promise.resolve({ ok: false, detail: `bundled rule missing: ${(e as Error).message}` });
  }
  return new Promise((resolve) => {
    const child = spawn(
      'pkexec',
      [
        'sh',
        '-c',
        `cat > ${INSTALLED_PATHS[0]} && udevadm control --reload-rules && udevadm trigger`,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (e) => resolve({ ok: false, detail: e.message }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, detail: stderr.trim() || `pkexec exited with code ${code}` });
    });
    child.stdin.end(ruleText);
  });
}
