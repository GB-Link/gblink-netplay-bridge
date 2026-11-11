// Builds the Android app: the interface, the bridge bundle that runs the engine in the page, then
// the APK. Needs the Android SDK (ANDROID_HOME) and a JDK 21 (JAVA_HOME).
// `--web` stops after the web assets, for `npx cap sync` alone.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ngOut = path.join(root, 'dist/android-ng');
const web = path.join(root, 'dist/android-web');
const shim = (name) => path.join(root, 'src/android/shims', name);

// Node and Electron modules the shared code imports, and what stands in for them on Android.
const STAND_INS = {
  'node:events': path.join(root, 'node_modules/events/events.js'),
  'node:net': shim('net.ts'),
  'node:dgram': shim('dgram.ts'),
  'node:crypto': shim('crypto.ts'),
  'node:fs': shim('fs.ts'),
  'node:path': shim('path.ts'),
  electron: shim('electron.ts'),
  usb: shim('usb.ts'),
  serialport: shim('serialport.ts'),
};
// The GB-Link's USB transport is replaced whole: Android opens USB devices asynchronously.
const USB_TRANSPORT = path.join(root, 'src/engine/usb/device.ts');
const ANDROID_USB_TRANSPORT = path.join(root, 'src/android/usb/device.ts');

const standIns = {
  name: 'android-stand-ins',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const standIn = STAND_INS[args.path];
      if (standIn) return { path: standIn };
      if (args.path.startsWith('.') && path.resolve(args.resolveDir, args.path + '.ts') === USB_TRANSPORT) {
        return { path: ANDROID_USB_TRANSPORT };
      }
      return undefined;
    });
  },
};

function run(cmd, args, cwd, env = process.env) {
  execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
}

fs.rmSync(ngOut, { recursive: true, force: true });
run('npx', ['ng', 'build', '--output-path', ngOut], path.join(root, 'src/renderer'));

fs.rmSync(web, { recursive: true, force: true });
fs.cpSync(path.join(ngOut, 'browser'), web, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/android/main.ts')],
  outfile: path.join(web, 'bridge.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome100',
  inject: [shim('inject.ts')],
  define: { APP_VERSION: JSON.stringify(pkg.version) },
  plugins: [standIns],
  minifyWhitespace: true,
  minifySyntax: true,
  logLevel: 'info',
});
// The bridge must exist before the interface starts, as the desktop's preload does.
const indexPath = path.join(web, 'index.html');
const index = fs.readFileSync(indexPath, 'utf8');
if (!index.includes('</title>')) throw new Error('index.html has no <title> to put the bridge after');
fs.writeFileSync(indexPath, index.replace('</title>', '</title>\n  <script src="bridge.js"></script>'));

if (process.argv.includes('--web')) process.exit(0);

run('npx', ['cap', 'sync', 'android'], root);

const env = { ...process.env };
env.ANDROID_HOME ??= path.join(os.homedir(), 'Android/Sdk');
const release = !process.argv.includes('--debug');
run('./gradlew', [release ? 'assembleRelease' : 'assembleDebug'], path.join(root, 'android'), env);

const variant = release ? 'release' : 'debug';
const apk = path.join(root, `android/app/build/outputs/apk/${variant}/app-${variant}.apk`);
if (release) {
  const out = path.join(root, `release/${pkg.name}-${pkg.version}-Android.apk`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(apk, out);
  console.log(`\n${path.relative(root, out)}`);
} else {
  console.log(`\n${path.relative(root, apk)}`);
}
