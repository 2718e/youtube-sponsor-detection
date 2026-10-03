# Cap on parallel model requests

*2026-10-03*

## What it is

The scan stage asks one question per transcript window and used to fire all of
them at once. On a long video that is dozens of requests against a local model
simultaneously, which is the suspected cause of slow calls and overload. There
is now a configurable cap on how many requests are in flight at once, defaulting
to 4, with retries counted against the same cap.

## Where it lives

- **`src/providers/limit.ts`** — a small FIFO semaphore (`createLimiter`) plus a
  module-level registry (`limiterFor`). One limiter is shared per endpoint, so a
  second provider pointed at the same server shares the same slots. The
  extension builds a fresh provider per analysis, and two tabs can analyse at
  once, so a per-provider cap would have multiplied.
- **`src/providers/systemone.ts`** — resolves the cap and wraps the whole
  `systemOne` call in the limiter. The retry loop lives inside `postSystemOne`,
  so a retry holds its slot for the backoff and the next attempt rather than
  entering a fresh one.
- **`extension/background.ts`** — `maxParallelLocal` and `maxParallelHosted`
  settings, chosen by `isLocalUrl(settings.modelUrl)`.
- **`extension/popup.html` / `popup.ts`** — the two numbers, under Advanced →
  Requests.

## Configuration

| Where | Knob | Default |
| --- | --- | --- |
| Extension popup | At once, local server | 4 |
| Extension popup | At once, hosted | 4 |
| `ProviderConfig` | `maxParallel` | local/hosted constant |
| `src/providers/systemone.ts` | `DEFAULT_MAX_PARALLEL_REQUESTS`, `DEFAULT_MAX_PARALLEL_REQUESTS_HOSTED` | 4 |

There is deliberately no environment variable: `.env` is read only by
`server.ts` and the scripts, never by the built extension, so the constants are
the default and the popup is the extension's knob. Local and hosted are separate
settings because a local model is the one that falls over; hosted may be raised
later.

## What did not change

`src/decisionModel/**` is untouched. `Promise.all` still fans the windows out;
the excess simply queues inside the provider. Requests to different endpoints
(hosted vs local) have independent caps. The `console.log("Configured timeout
millis", …)` in `systemone.ts` is intentionally left in place while the timeout
theory is tested.

## Tests

`test/limit.test.ts` covers the semaphore: cap, FIFO order, release on throw,
raising the cap, one limiter per endpoint. `test/provider-contract.test.ts`
checks the provider end to end with an injected `fetch`: peak in-flight never
passes the cap, and a retry holds its slot (with the 5s backoff driven by mock
timers). `test/extension-background.test.ts` checks the defaults and that the
cap follows the endpoint kind.

`npm run typecheck` and `npm test` (43 tests) pass.
