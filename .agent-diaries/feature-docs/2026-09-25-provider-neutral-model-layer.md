# Provider-neutral model layer

*2026-09-25*

## What it is

The pipeline in `src/jev.js` asks typed questions — a yes/no probability over a
stated criterion (`noul`), or a distribution over labelled options (`choice`) —
and reads probabilities back. Nothing in it knows which server, model or
protocol answered. That request/answer shape is the project's own language.

The provider layer is the other half: everything that turns a *configuration*
into something with a `systemOne(request)`, and turns a reply back into the
canonical answer.

```
src/providers/
  contract.js    the rules an answer must satisfy, and their enforcement
  systemone.js   the bare POST <url>/v1/systemone protocol
  index.js       the registry: createProvider(config), providerFromEnv()
```

`systemone` covers both ends of the range: hosted Jev at
`https://api.typesafe.ai` and a local server that speaks the same protocol
(Kev, `test/mock-typesafe-api.js`). **Local versus hosted is configuration, not
a second code path.**

## The contract

```js
// request
{ state: {...}, questions: { name: { type: 'noul'|'choice', instructions, criteria } }, model? }

// answer — the only shape the pipeline ever sees
{ answers: { name: { noul: 0.83 } | { probabilities: { L007: 0.6, none: 0.2 } } },
  usage: { input_tokens, output_tokens } }
```

A provider may be loose internally; `normalizeAnswer` fills in the parts the
pipeline is allowed to assume (missing labels count as 0, missing usage as 0)
and `assertCanonical` is the same rules as a hard check.

## Configuration

One shape, written by the popup, read from `.env`, or passed on the command
line:

```js
{ protocol: 'systemone', url, model, apiKey, timeoutMs, thresholds }
```

```sh
MODEL_URL=http://127.0.0.1:8009   # or https://api.typesafe.ai
MODEL_API_KEY=                    # only needed for api.typesafe.ai
MODEL_NAME=jev-latest
```

## Adding a model with a different interface

1. Write `src/providers/<name>.js` exporting a factory that returns
   `{ protocol, label, isLocal, requiresKey, hasKey, thresholds, systemOne, health }`.
2. Add it to `PROTOCOLS` and `PROTOCOL_PRESETS` in `src/providers/index.js`.
   The popup's protocol picker is built from `PROTOCOL_PRESETS`, so it appears
   in the UI with no popup change.
3. Run `npm run build:ext` (the extension ships a copy of `src/providers/`).
4. Add a case to `test/provider-contract.test.js`. Passing it means the
   pipeline can consume the backend without `src/jev.js` changing.

An adapter whose wire format is only *broadly* Jev's — an OpenAI-compatible
server, say — does its translation inside `systemOne`: build a prompt from
`instructions` and `criteria`, constrain the output, convert logprobs to a
probability, normalise the result. None of that leaks outward.

## Calibration belongs to the provider

A confidence band is a property of a model's probability scale, not of the
algorithm. `FOUND` / `MAYBE` / `KEEP_CONTENT` moved out of the pipeline body
into `DEFAULT_THRESHOLDS`, which `findSponsorSegment` accepts as an option and
a provider carries as `thresholds`. The popup's *Model calibration* fields
write `settings.engine`; leaving it `null` means "use the provider's defaults".

A new model's numbers will not land where Jev's do. Compare providers with
`npm run eval` and re-tune the bands per provider.

## Security note

The user's TypeSafe key is attached **only** when the configured host is
`api.typesafe.ai`, whatever URL is set. The key cannot leak to a typo'd or
hostile endpoint. A local server needs no key at all.

Hosts beyond the statically-permitted ones are requested at runtime through
`optional_host_permissions` when the user saves a provider URL. **Test** asks
one real question using the fields as *typed*, so it reports on what is on
screen rather than on the last saved configuration, and it does not persist
anything.

## Where the same code runs

The extension worker and the Node side (`server.js`, `scripts/analyze.js`,
`scripts/eval.js`) both use `src/providers/`, so a backend behaves identically
in both. This retired `@typesafe-ai/sdk`, which had been a second, divergent
way of reaching a model.

## Tests

- `test/provider-contract.test.js` — registry, contract enforcement, the
  pipeline running end to end through a provider over real HTTP, key scoping,
  health, and an unreachable server.
- `test/extension-background.test.js` — provider switching from the worker,
  including the assertion that the key is not sent to a local host.
- `test/lib-in-sync.test.js` — `extension/lib/` matches `src/`.
