# Video metadata on requests to a local model

*2026-10-03*

## What it is

A local Jev-compatible server can accept an extra `metadata` field that the
hosted protocol does not. When the extension is pointed at a local model and the
user turns on **Send the video's url with each request**, every model request for
a run carries:

```json
{ "clientId": "yt-sponsor-skip", "uri": "https://www.youtube.com/watch?v=<id>" }
```

A server configured to record annotated requests can then keep the whole run for
tuning or for investigating how the model decided on one video.

## Where it lives

- **`src/providers/systemone.ts`** — `ProviderConfig.sendMetadata` is resolved to
  `sendMetadata = isLocal && flag`, so a hosted model can never be given it.
  `SystemOneOptions.uri` is the video the call is about. `requestBody` builds the
  wire body and adds `metadata` only when both are present, so `uri` never
  travels as a protocol field. `METADATA_CLIENT_ID` is the one place this app
  names itself to the server.
- **`extension/background.ts`** — `Settings.sendMetadata` (default `false`) is
  passed to `createProvider`. `analyze` closes over the video's watch url and
  gives it to every request, health checks excluded.
- **`extension/popup.html` / `popup.ts`** — a checkbox under Advanced → Tuning.

## Configuration

| Where | Knob | Default |
| --- | --- | --- |
| Extension popup → Advanced → Tuning | Send the video's url with each request | off |
| `ProviderConfig` | `sendMetadata` | off |
| `SystemOneOptions` | `uri` | none, so no metadata |

The flag is an extension setting, not an environment variable. The provider
layer supports it, but nothing in `server.ts` or the scripts turns it on.

## What did not change

- **`src/decisionModel/**` is untouched.** The pipeline still calls
  `systemOne(request)` and reads answers; the uri rides on the per-call options
  rather than on the canonical request, so the provider contract keeps its
  original shape.
- A request without a video (`health`, `test-provider`) carries no metadata.
- The body is otherwise byte-for-byte what it was: `model`, `state`, `questions`.

## Tests

`test/provider-contract.test.ts` records the body a fake `fetch` is given and
checks all four cases: local with the flag (metadata present, no top-level
`uri`), local without it, hosted with it (still absent), and no uri.
`test/extension-background.test.ts` drives the service worker end to end and
checks the same three ways from the extension's settings, including that every
request of a run shares the run's video. Its default-settings test pins the flag
to off.
