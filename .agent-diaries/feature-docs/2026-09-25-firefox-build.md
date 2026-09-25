# Firefox build

*2026-09-25*

## What it is

`npm run build:ext` writes two things:

| Output | What it is |
| --- | --- |
| `extension/` | the Chrome build, loadable as-is from `chrome://extensions` (Developer mode → Load unpacked) |
| `dist/firefox/` | the same code with a Firefox manifest, loadable from `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `dist/firefox/manifest.json` |

Both are generated from `extension/` plus `src/`; `dist/` is gitignored.

## What actually differs

Only the manifest, in two places (`scripts/build-extension.mjs`):

1. **Background.** Firefox does not support `background.service_worker`
   ([bug 1573659](https://bugzil.la/1573659)); it runs MV3 backgrounds as event
   pages. The Firefox manifest therefore carries **both** keys — Firefox picks
   `scripts`, Chrome 121+ picks `service_worker` and ignores the other. Splitting
   the builds rather than shipping one dual manifest avoids the Chrome <121
   refusal to load an MV3 extension that mentions `background.scripts`.
2. **Add-on id.** `browser_specific_settings.gecko.id`
   (`sponsor-skip@localhost` — change it before publishing to AMO) and
   `strict_min_version: "128.0"`.

Everything else was already portable: `world: "MAIN"` content scripts,
`storage`, `runtime` messaging, `optional_host_permissions`, and promises on
the `chrome.*` namespace, which MDN no longer lists as a Firefox
incompatibility.

Because the extension is transcript-only, none of Chrome's offscreen document,
tab-capture or audio-worklet surface is involved — that was the only genuinely
Firefox-hostile part of the original design and it is gone.

## Verifying

```sh
npm run build:ext
npx web-ext lint --source-dir dist/firefox
npx web-ext run  --source-dir dist/firefox
```

`web-ext` is not a project dependency; `npx` fetches it. The Playwright e2e
(`npm run test:ext`) still targets Chromium — Playwright cannot load an
unpacked extension into Firefox — so Firefox coverage is `web-ext` plus the
manual checklist: the panel appears, reads are listed, Skip works, and
Re-analyze re-runs.
