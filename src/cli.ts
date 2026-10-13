import { GBLinkAdapter } from './engine/usb/adapter';
import { EspDevice } from './engine/esp32/espDevice';
import { GBLinkEngine, formatAwStats, type EngineStartOptions } from './engine/index';
import { FwStatus, type AwTimingOverride, type Console, type LinkGame, type SwitchRoom } from './engine/types';
import { isConsole, isLinkGame, isSwitchRoom } from './shared/games';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function gameArg(): LinkGame {
  const value = arg('game', 'gen3')!;
  if (!isLinkGame(value)) {
    throw new Error(`--game must be gen3, rfu, aw1 or aw2 (got "${value}")`);
  }
  return value;
}

function consoleArg(): Console {
  const value = arg('console', 'gba')!;
  if (!isConsole(value)) throw new Error(`--console must be gba or switch (got "${value}")`);
  return value;
}

function roomArg(): SwitchRoom {
  const value = arg('room', 'trade')!;
  if (!isSwitchRoom(value)) throw new Error(`--room must be trade, single or double (got "${value}")`);
  return value;
}

function awTimingArgs(): AwTimingOverride | undefined {
  const pxg = arg('aw-pxg-us');
  const sync = arg('aw-sync-us');
  if (pxg === undefined && sync === undefined) return undefined;
  const timing: AwTimingOverride = {};
  if (pxg !== undefined) timing.pxgUs = Number(pxg);
  if (sync !== undefined) timing.syncUs = Number(sync);
  return timing;
}

/** The device and play options every session command shares. */
function setupArgs(): Pick<EngineStartOptions, 'game' | 'console' | 'espPort' | 'switchRoom' | 'nationalBypass' | 'awTiming'> {
  return {
    game: gameArg(),
    console: consoleArg(),
    espPort: arg('esp-port'),
    switchRoom: roomArg(),
    nationalBypass: flag('national-bypass'),
    awTiming: awTimingArgs(),
  };
}

async function probe(): Promise<void> {
  const adapter = new GBLinkAdapter();
  adapter.on('status', (s) => log(`status 0x${s.toString(16)} (${FwStatus[s] ?? '?'})`));
  adapter.on('data-raw', (b) => {
    if (b.length > 6) log(`telemetry tag 0x${b[0]!.toString(16)} (${b.length} B)`);
  });
  await adapter.start();
  const fw = await adapter.getFirmwareInfo();
  log(
    `firmware ${fw.major}.${fw.minor}.${fw.patch}` +
      (fw.cableSelection !== undefined ? ` (cable selection: ${fw.cableSelection})` : '') +
      (fw.minor >= 2 ? `, wireless adapter mode: ${(await adapter.probeWireless()) ? 'yes' : 'no'}` : ''),
  );
  await adapter.initLinkMode((arg('role') as 'master' | 'slave') ?? 'master', gameArg(), awTimingArgs());
  const cable = await adapter.getCableType().catch(() => -1);
  log(`cable type ${cable}`);
  log('probe OK — watching statuses, Ctrl-C to exit');
}

async function probeEsp(): Promise<void> {
  const ports = await EspDevice.listPorts();
  const path = arg('esp-port') ?? ports[0]?.path;
  if (!path) throw new Error('no ESP32 board found on a serial port');
  const port = ports.find((p) => p.path === path);
  const esp = new EspDevice(path, port?.vendorId);
  esp.on('log', (m) => log(m));
  esp.on('event', (m) => log(`board: ${m}`));
  await esp.open();
  log(`${esp.hello} on ${path} at ${esp.baudRate} baud`);
  log(`info ${JSON.stringify(esp.info)}`);
  log(`keys ${JSON.stringify(await esp.keyStatus())}`);
  log(`bridge ${JSON.stringify(await esp.bridgeStatus())}`);
  await esp.close();
}

async function run(opts: EngineStartOptions): Promise<void> {
  const engine = new GBLinkEngine();
  engine.on('device', (d) => log(`device: ${d.state}${d.detail ? ` (${d.detail})` : ''}`));
  engine.on('esp32', (d) => log(`esp32: ${d.state}${d.info ? ` ${d.info.label}` : ''}${d.detail ? ` (${d.detail})` : ''}`));
  engine.on('fw-status', (s) => log(`fw: 0x${s.toString(16)} ${FwStatus[s] ?? ''}`));
  engine.on('link-phase', (p, raw) => log(`link: ${p}${raw !== undefined ? ` (0x${raw.toString(16)})` : ''}`));
  engine.on('room', (host) => log(host ? `in ${host}'s room` : 'left the room'));
  engine.on('session', (s) => log(`session: ${s.phase}${s.closeReason ? ` (${s.closeReason})` : ''}${s.detail ? ` ${s.detail}` : ''}`));
  engine.on('peers', (peers) => log(`peers: ${peers.map((p) => `${p.id}:${p.nick}`).join(', ') || 'none'}`));
  engine.on('host-ready', (h) => log(`hosting on port ${h.extPort}${h.relaySessionId ? ` relay session ${h.relaySessionId}` : ''}`));
  if (flag('stats')) engine.on('aw-stats', (s) => log(formatAwStats(s)));
  engine.on('warn', (msg) => log(`WARN: ${msg}`));
  engine.on('log', (msg) => log(msg));
  engine.on('error', (e) => log(`ERROR: ${e.message}`));
  await engine.start(opts);
  process.on('SIGINT', () => {
    void engine.stop().then(() => process.exit(0));
  });
}

const USAGE = [
  'usage: cli <probe|probe-esp|join|host> [options]',
  '  --game gen3|rfu|aw1|aw2      link protocol (Pokémon cable, Wireless Adapter, Advance Wars 1/2)',
  '  --console gba|switch         a GBA on a GB-Link, or a Switch behind an ESP32 bridge',
  '  --esp-port <path>            the ESP32 serial port (default: the first one found)',
  '  --room trade|single|double   Switch cable link, joining: the group led for the Switch',
  '  --national-bypass            Switch: link FireRed/LeafGreen and Emerald before the National Dex',
  '  --nick N  --password P  --relay-session S  --port P  --crc HEX  --stats',
].join('\n');

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const nick = arg('nick', 'Anonymous') as string;
  switch (cmd) {
    case 'probe':
      await probe();
      break;
    case 'probe-esp':
      await probeEsp();
      break;
    case 'join': {
      const target = process.argv[3];
      if (!target) throw new Error(USAGE);
      const [host, portStr] = target.split(':');
      await run({
        mode: 'join',
        ...setupArgs(),
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
        ...setupArgs(),
        port: Number(arg('port', '55435')),
        nick,
        password: arg('password'),
        spectatePassword: arg('spectate-password'),
        contentCrc: arg('crc') ? parseInt(arg('crc')!, 16) : undefined,
      });
      break;
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
