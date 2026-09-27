// Builds the web app's browser bundle. The server serves public/ as static
// files, so app.ts has to be JavaScript on disk.
//
//   npm run build:web

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [path.join(root, 'public', 'app.ts')],
  outfile: path.join(root, 'public', 'app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning'
});

console.log('wrote public/app.js');
