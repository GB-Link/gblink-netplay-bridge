import { GBLinkAdapter } from './engine/usb/adapter';
import { GBLinkEngine, type EngineStartOptions } from './engine/index';
import { FwStatus } from './engine/types';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function probe(): Promise<void> {
  const adapter = new GBLinkAdapter();
  adapter.on('status', (s) => log(`status 0x${s.toString(16)} (${FwStatus[s] ?? '?'})`));
  await adapter.start();
  const fw = await adapter.getFirmwareInfo();
  log(`firmware ${fw.major}.${fw.minor}.${fw.patch}`);
  await adapter.initLinkMode((arg('role') as 'master' | 'slave') ?? 'master');
  const cable = await adapter.getCableType().catch(() => -1);
  log(`cable type ${cable}`);
  log('probe OK — watching statuses, Ctrl-C to exit');
}

async function run(opts: EngineStartOptions): Promise<void> {
  const engine = new GBLinkEngine();
  engine.on('device', (d) => log(`device: ${d.state}${d.detail ? ` (${d.detail})` : ''}`));
  engine.on('fw-status', (s) => log(`fw: 0x${s.toString(16)} ${FwStatus[s] ?? ''}`));
  engine.on('link-phase', (p, raw) => log(`link: ${p}${raw !== undefined ? ` (0x${raw.toString(16)})` : ''}`));
  engine.on('session', (s) => log(`session: ${s.phase}${s.closeReason ? ` (${s.closeReason})` : ''}${s.detail ? ` ${s.detail}` : ''}`));
  engine.on('peers', (peers) => log(`peers: ${peers.map((p) => `${p.id}:${p.nick}`).join(', ') || 'none'}`));
  engine.on('host-ready', (h) => log(`hosting on port ${h.extPort}${h.relaySessionId ? ` relay session ${h.relaySessionId}` : ''}`));
  engine.on('log', (msg) => log(msg));
  engine.on('error', (e) => log(`ERROR: ${e.message}`));
  await engine.start(opts);
  process.on('SIGINT', () => {
    void engine.stop().then(() => process.exit(0));
  });
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const nick = arg('nick', 'GBLink') as string;
  switch (cmd) {
    case 'probe':
      await probe();
      break;
    case 'join': {
      const target = process.argv[3];
      if (!target) throw new Error('usage: cli join <host[:port]> [--nick N] [--password P] [--relay-session S]');
      const [host, portStr] = target.split(':');
      await run({
        mode: 'join',
        host: host!,
        port: portStr ? Number(portStr) : 55435,
        nick,
        password: arg('password'),
        relaySession: arg('relay-session'),
      });
      break;
    }
    case 'host':
      await run({
        mode: 'host',
        port: Number(arg('port', '55435')),
        nick,
        password: arg('password'),
        spectatePassword: arg('spectate-password'),
        contentCrc: arg('crc') ? parseInt(arg('crc')!, 16) : undefined,
      });
      break;
    default:
      console.log('usage: cli <probe|join|host> [options]');
      process.exit(1);
  }
}

main().catch((e: Error) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
