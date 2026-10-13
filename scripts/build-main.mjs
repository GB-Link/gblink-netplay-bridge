// Bundles the Electron main process and preload to CommonJS.
// Windows note: the npm "dev" script uses POSIX `GBLINK_DEV=1` env syntax;
// on Windows run `npm run build:main && npx cross-env GBLINK_DEV=1 electron .`.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.cjs'),
    external: ['electron', 'usb', 'serialport'],
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(root, 'dist/preload/index.cjs'),
    external: ['electron'],
  }),
]);
