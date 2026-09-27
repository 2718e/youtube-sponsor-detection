# Local default provider + TypeScript migration

*2026-09-27*

## Default provider is now local

The extension's `DEFAULT_SETTINGS.modelUrl` and the provider layer's
`DEFAULT_URL` are now `http://localhost:8000` (endpoint
`http://localhost:8000/v1/systemone`), not `https://api.typesafe.ai`. A local
Jev-compatible server needs no key, so a fresh install — including a Firefox
temporary extension where `chrome.storage` may not persist settings — works
without saving anything. `.env.example` defaults `MODEL_URL` the same way.

Hosted Jev is unchanged and still selected by setting `modelUrl` /
`MODEL_URL` to `https://api.typesafe.ai`; the TypeSafe key is still only ever
sent to that host.

## TypeScript

All source is now `.ts`. The toolchain is three devDependencies:

| Tool | Job |
| --- | --- |
| `typescript` | `npm run typecheck` (`tsc --noEmit`) |
| `tsx` | runs the Node side straight from source (server, scripts, tests) |
| `esbuild` | bundles the browser side (extension entries, `public/app.ts`) |

`tsconfig.json` is `strict`, `NodeNext`, with both the Node and DOM type
libraries. Source uses `.js` import specifiers, which `tsc` and `tsx` resolve
to the `.ts` file.

### Commands

```sh
npm run typecheck     # tsc --noEmit
npm test              # node --import tsx --test test/*.test.ts
npm start             # builds public/app.js, then runs server.ts
npm run build         # public/app.js + extension/*.js + dist/firefox/
npm run test:ext      # builds, then the Playwright e2e
```

### What changed structurally

- The extension sources import the shared pipeline directly from `../src/`
  (`../src/jev.js`, `../src/providers/index.js`). esbuild bundles
  `extension/background.ts` into a single `extension/background.js`; the other
  entries have no imports and are transpiled in place.
- `extension/lib/` and the `test/lib-in-sync.test.js` copy check are gone: they
  existed only because a browser cannot load files outside the extension, which
  bundling now solves.
- Generated JavaScript (`extension/*.js`, `public/app.js`, `dist/`) is
  gitignored and produced by `npm run build`. `extension/` still holds the
  static manifest, HTML, CSS and icons, so the Chrome build is loadable once
  built.
- Node now requires `>=22.9` for `--env-file-if-exists` and `--import tsx`.

### Bug found while typing the popup

`extension/popup.ts` called `providerState()` on load, but the function is
named `pill()`. The untyped original threw a `ReferenceError` at that point, so
the provider pill was never refreshed. The call is now `pill()`.

## Not run here

`npm run test:ext` could not execute in this container: the Playwright Chromium
binary fails to launch because the image lacks `libglib-2.0.so.0`. The built
extension bundle was instead smoke-tested directly under Node (load, `get-state`,
`test-provider`, one `analyze`), and the server was exercised over HTTP against
`test/mock-typesafe-api.ts`.
