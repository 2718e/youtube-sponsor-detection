# Sponsor Skip

Forked from https://github.com/trungdq88/youtube-sponsor-detection

The goals of this adaptation are:

- allow use of local alternative models, decouple from jev specifically
- ability to run as a firefox extension rather than chrome (e.g. so can combine with full featured uBlock origin)

## Building

`npm run build:ext` writes two things:

| Output | What it is |
| --- | --- |
| `extension/` | the Chrome build, loadable as-is from `chrome://extensions` (Developer mode → Load unpacked) |
| `dist/firefox/` | the same code with a Firefox manifest, loadable from `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `dist/firefox/manifest.json` |

