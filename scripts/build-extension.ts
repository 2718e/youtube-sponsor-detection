// Builds the extension folders.
//
// The extension sources are TypeScript; a browser can only load JavaScript, so
// esbuild bundles each entry next to its source (which is also the loadable
// Chrome build). Firefox gets the same code with a Firefox manifest.
//
//   extension/        the Chrome build, loadable as-is (developer mode)
//   dist/firefox/     the same code with a Firefox manifest
//
// The two browser builds differ only in the manifest: Firefox does not support
// `background.service_worker`, so it is given `background.scripts` as well and
// picks that one. Everything else is shared.
//
//   npm run build:ext

import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extension = path.join(root, 'extension');
const firefox = path.join(root, 'dist', 'firefox');

/** Firefox's own add-on id; change it before publishing to AMO. */
const GECKO_ID = 'sponsor-skip@localhost';

/** Each entry, and the module format its slot in the extension needs. */
const ENTRIES: { entry: string; format: 'esm' | 'iife' }[] = [
  { entry: 'background.ts', format: 'esm' },
  { entry: 'content.ts', format: 'iife' },
  { entry: 'popup.ts', format: 'iife' },
  { entry: 'page-bridge.ts', format: 'iife' }
];

async function buildEntries() {
  for (const { entry, format } of ENTRIES) {
    await build({
      entryPoints: [path.join(extension, entry)],
      outfile: path.join(extension, entry.replace(/\.ts$/, '.js')),
      bundle: true,
      format,
      target: 'es2022',
      logLevel: 'warning'
    });
  }
}

/** The Chrome manifest, turned into the Firefox one. */
function firefoxManifest(base: any) {
  const { service_worker, ...background } = base.background;
  return {
    ...base,
    background: { ...background, scripts: [service_worker], service_worker },
    browser_specific_settings: {
      gecko: { id: GECKO_ID, strict_min_version: '128.0' }
    }
  };
}

async function buildFirefox() {
  await rm(firefox, { recursive: true, force: true });
  await mkdir(firefox, { recursive: true });
  await cp(extension, firefox, {
    recursive: true,
    // TypeScript sources and the Chrome manifest do not belong in the build.
    filter: (from) => !from.endsWith('.ts') && path.basename(from) !== 'manifest.json'
  });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  await writeFile(path.join(firefox, 'manifest.json'), `${JSON.stringify(firefoxManifest(manifest), null, 2)}\n`);
}

await buildEntries();
await buildFirefox();

const built = (await readdir(extension)).filter((name) => name.endsWith('.js'));
console.log(`extension: ${built.join(', ')}`);
console.log('wrote dist/firefox/');
