// Builds the extension folders.
//
// The pipeline in src/ is shared with the web app and the scripts, but an
// extension can only load files from its own folder, so it ships a copy. This
// script is the only thing that writes those copies.
//
//   extension/        the Chrome build, loadable as-is (developer mode)
//   dist/firefox/     the same code with a Firefox manifest
//
// The two browser builds differ only in the manifest: Firefox does not support
// `background.service_worker`, so it is given `background.scripts` as well and
// picks that one. Everything else is shared.
//
//   npm run build:ext

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extension = path.join(root, 'extension');
const src = path.join(root, 'src');
const firefox = path.join(root, 'dist', 'firefox');

/** Files the extension shares with the web app. */
const SHARED = ['transcript.js', 'jev.js'];

/** Firefox's own add-on id; change it before publishing to AMO. */
const GECKO_ID = 'sponsor-skip@localhost';

/** The shared sources each browser build carries a copy of. */
async function syncShared() {
  for (const name of SHARED) {
    await cp(path.join(src, name), path.join(extension, 'lib', name));
  }
  const providers = path.join(extension, 'lib', 'providers');
  await rm(providers, { recursive: true, force: true });
  await cp(path.join(src, 'providers'), providers, { recursive: true });
}

/** The Chrome manifest, turned into the Firefox one. */
function firefoxManifest(base) {
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
    filter: (from) => path.basename(from) !== 'manifest.json'
  });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  await writeFile(path.join(firefox, 'manifest.json'), `${JSON.stringify(firefoxManifest(manifest), null, 2)}\n`);
}

await syncShared();
await buildFirefox();

const copied = await readdir(path.join(extension, 'lib'));
console.log(`extension/lib: ${copied.join(', ')}`);
console.log('wrote dist/firefox/');
