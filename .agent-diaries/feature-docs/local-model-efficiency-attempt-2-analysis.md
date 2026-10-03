# Local-model efficiency, attempt 2: analysis and plans

*Answers to the four questions in `specs/local-model-efficiency-attempt-2.md`.*

**Built:** 3 (the boundary search, default) and 4 (the cut gate), with 1's
prompt-trimming noted as follow-up. `boundaryStrategy` is `'search'` by default
with `'per-phrase'` kept for comparison; `cut` is `'skippable'` by default with
`'always'` kept for calibration. See
`2026-10-03-sponsor-boundary-search.md`. 2 is not needed: the search already
keeps each request small, which was the reason splitting was on the table.

## Where the cost actually is

Reproduced from the code, for the two requests in the log:

- Each question carries its own copy of the `SPONSOR` block: the definition (173 chars)
  and the shape (594 chars) — 767 chars, on top of the question (276) and its criteria
  (281). A scan/anchor/cut question serialises to about 1,700 characters, and almost all
  of that is identical across the questions in a request.
- The cut request in the log is 10 phrases → ~2,000 characters of transcript and
  ~17,000 characters of repeated definition; the second is 17 phrases. `input_tokens` of
  3,880 and 8,296 match the question count, not the transcript: the transcript in state
  is a few hundred tokens either way.
- Wall time tracks the same thing. 17 questions took 22.9 s and 10 took 7.1 s, so roughly
  1.3 s per question against this server, while the state barely changed. That is worth
  measuring properly (`npm run eval` reports usage per run), but the shape is clear: on
  this server we pay per question, and most of a question is the repeated block.

So the prompt is long because it says the same 767 characters once per question, and the
cut pass asks one question per phrase. That is the thing to fix, and it is a pipeline
change, not a Jev/Laya change — see below.

## 1. Can Jev or Laya share the `SPONSOR` definitions between questions?

**No. There is no inheritance, no shared context, and no prompt cache to exploit, and the
docs say not to want one.**

What the interfaces offer, from the docs:

- A request is `{ state, questions }`; every question is `{ id, type, instructions,
  criteria }` ([Primitives](https://docs.typesafe.ai/primitives)).
- "Question IDs are for your code. They are not sent to the model. Write the complete
  question in `instructions`, even when the ID seems self-explanatory."
- Questions are evaluated independently, in parallel, and "one primitive's result does not
  become hidden context that changes another primitive's result"
  ([How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)). There
  is no field a question can point at to inherit wording.
- State is the other half of the split: "The state contains the content and supporting
  facts. Questions define the judgments the model should make about that material"
  ([State](https://docs.typesafe.ai/concepts/state)). The NanoJev contract audit makes the
  same point about encoding: each leaf carries one state, one instruction and its own
  candidate, and the candidate paths repeat the state
  ([TYPESAFE_CONTRACT.md](https://github.com/TianyuCodings/NanoJev/blob/master/docs/TYPESAFE_CONTRACT.md)).

Two things that look like shares but are not:

- **Put the definition in `state`.** Every question would then see it, but it stops being
  an instruction and becomes material to interpret — exactly what the state/questions split
  says not to do — and it would be read as part of the transcript. It also spends the state
  budget we are trying to protect (Jev's limit is 32k, and `estimateTokens` guards window
  size against it).
- **`instructions` as an object/array.** Structured instructions put the question in one
  field and the data it refers to in others
  ([Advanced: structure](https://docs.typesafe.ai/primitives/advanced)). The useful part
  for us is the inverse: the *question* can be self-contained and short while the material
  lives in state. That is a reason to stop repeating the block, not a way to share it.

**What we can do instead, in cost order.** The only way to stop paying per question is to
ask fewer questions, and the per-question block should be no bigger than the question
needs:

- **A. One question instead of N per phrase (the big one).** Replace the N nouls of the
  cut pass with a single choice (or a binary search, question 3). One reproduced cut
  question is ~1,700 characters; a corrected single-question version would be the same
  question once, a few hundred more.
- **B. Shrink `SPONSOR` once, structurally.** `shape` is 594 of the 767 characters and
  spells out three parts twice; the lead-in sentence and rules 1–3 in `startQuestions` say
  the same thing again. Dropping to definition + a two-line shape + the one rule that
  carries the lead-in judgement is maybe half the block, paid N times in any request that
  still has several questions.
- **C. Keep the shared prefix byte-identical across requests of a pass**, so a server that
  does grow prompt caching can hit it. Cheap to do (same state keys, same instruction
  order, only the phrase line varies) and worth a note in the code even if today's local
  server does not cache prefixes.

**Plan for 1 (small, do it regardless of 2 and 3):**

- `prompts.ts`: trim `SPONSOR` to definition + shape + the lead-in rule; move the
  near-duplicate rules out of `startQuestions` into the shared block, written once.
- `prompts.ts`: build every question's `instructions` for a pass from one shared object
  and vary only the per-question fields, so identical text stays identical.
- Add a prompt-size assertion to `test/pipeline.test.ts`: characters per question for each
  pass, so a block that grows by accident fails a test. This is also how we measure A–C.

## 2. Split the questions across several calls?

**Possible, safe, and usually worse on the server in the logs.**

Mechanically it is easy: `Ask` is a plain function (`src/decisionModel/types.ts`), the
limiter already caps requests per endpoint at `maxParallel` (`src/providers/limit.ts`), and
`Promise.all` over chunks would keep the door open for a hosted model that answers in
parallel. A `FindOptions.split` of `0` (one request, today) or `n` questions per request
fits the existing shape: build `Questions` per chunk, renumber `P…`/`L…` labels so each
request stays self-contained, merge the answers into one map before the pass reads them.

Why it is usually worse here:

- Every chunk repeats the shared block, so total prompt work is
  `ceil(N/split) × (shared + per-question)` — strictly more input tokens than one call, and
  the hosted bill is per input token. At `split=4` with a 1,700-char question, a 16-question
  pass goes from ~27k to ~30k characters, and 12k of that is now the same block four times.
- 1.3 s per question looks like serial work on a local server, so parallel chunks queue:
  wall time stays the same or grows. Split is a win only when the server truly runs
  requests concurrently *and* the per-request fixed cost is small relative to the
  per-question cost.
- The scan pass, where the volume actually is on long videos, is already one request per
  window and already parallel. Splitting it further repeats the transcript *and* the
  questions.

**Plan for 2 (only if measurements ask for it):**

- Add `split?: number` to `FindOptions` and `Ask`, default `0` = one request.
- Implement chunking in one place (`src/decisionModel/ask.ts` or in `prompts.ts` as a
  `questionsInChunks` helper) so scan, anchor, start and cut all inherit it.
- Expose it in the popup's Advanced section next to the parallel cap, and record it in the
  cached per-video entry so results stay reproducible.
- Do not tune it by guess: run `npm run eval` at `split = 0, 4, 8` on a handful of videos
  and compare wall time and tokens. If nothing wins, ship the option off by default and
  leave it off.

## 3. Does every phrase need its own question? Can we search instead?

**Yes, we can stop asking every phrase, and the correct tool is a search, because the
property we are looking for is monotone.**

The cut pass currently sends `CUT_CONTEXT_LINES` around the boundary, so `phrases` is 10–25
and every phrase is a question with its own copy of the block. But inside a segment,
membership is contiguous — sponsor, then not — so "phrase *i* is sponsor" is a step
function and finding its edge is a search, not a census. Each cut request is a code-side
search already: `cutPoint` throws away most of the answers and reads one edge.

A binary search over phrases recovers the same boundary in `⌈log₂ N⌉` questions: 25 phrases
→ 5 questions instead of 25, 4–5× less prompt and 4–5× less wall time on the logged server.

Two designs, and the first is less code:

- **B1, choice over halves.** Keep `buildPhrases`. Ask, over a half-open span of phrase
  labels, a choice: "(a) the transition is inside `[Pa…Pm]`, (b) it is after `Pm`." Code
  descends into the half the model picked; each question carries only that span's phrases
  and a line of context on each side, so state per probe is small too. The wording maps
  onto the question we already ask — "does P01 belong to the sponsor" becomes "does the
  hand-back happen by Pm" — so the `SPONSOR` block is still needed, but once per probe.
- **B2, one noul at the midpoint.** Ask the existing per-phrase noul at the midpoint only,
  using the answer plus the monotone assumption to halve the range. Same request count,
  and it keeps the question wording identical to today's, which is friendlier to a model
  that is already shaky on this task. Slightly more sensitive to one wrong answer, so take
  a confirming probe at the landing phrase before returning.

**Plan for 3:**

- `FindOptions.boundaryStrategy?: 'per-phrase' | 'binary'`, default `'per-phrase'` so
  nothing changes until it is measured; `Thresholds` gains nothing, the strategy is not a
  band.
- New `src/decisionModel/search.ts`: `findEdgeSpan(phrases, edge, ask, state, limits)` →
  phrase index or `-1` (same contract as `cutPoint`, so `cut.ts` swaps one call). Binary
  search over indices using B2 midpoint nouls, with the confirming probe.
- `cut.ts` gains the branch; `findSponsorSegment.ts` passes the option through in
  `FindOptions`, alongside the existing `thresholds`/`onProgress` plumbing.
- Report each probe via `report({ stage: 'cut', probe, span })` so the panel's log shows
  progress instead of one long silence.
- Tests: extend `createStubClient` with a monotone phrase membership (it already scores a
  phrase span with markers, so `cutPoint` can be reimplemented from the same predicate),
  assert binary and per-phrase land on the same boundary, and assert the request count is
  `⌈log₂ N⌉ + 1`. Keep one exact-match test for `cutPoint` so the fallback path stays
  covered.

## 4. Why does the cut stage run at the MAYBE threshold when nothing will be skipped?

Because three different numbers gate three different things, and the cut is gated by the
loosest one:

- `refine` proceeds when `presence ≥ limits.maybe` (0.5, raised from 0.35 in the last
  commit) — `src/decisionModel/refine.ts:51`.
- The skip needs `seg.confidence ≥ settings.threshold` **and** an end time —
  `extension/content.ts:467`.
- `status = 'found'` needs a segment at `limits.found` (0.7) —
  `src/decisionModel/findSponsorSegment.ts:137`.

The cut is the most expensive part of a run (it is two of the five requests per segment,
and the two in the log), and it runs for any segment that clears `maybe`, including
segments that will be reported at 0.6 and never skipped. It gets worse with a local model,
whose answers sit near 0.4: those phrases are compared against `keepContent = 0.8`, so
`cutPoint` returns `-1`, `cut` returns `null`, and the whole request was paid for a
boundary the line-level answer keeps anyway. The logged run is exactly that shape — the
answers are 0.39–0.42 and the cuts still went out.

The fix is to make the decision that matters the gate:

**Plan for 4:**

- Add `skipThreshold?: number` to `FindOptions` (the extension passes
  `settings.threshold`; scripts keep `limits.found`).
- In `refine`, compute the segment's confidence from what it already has —
  `min(looksLikeSponsor(winner), presence)` — and only run the cut when it clears
  `skipThreshold`. When it does not, return the segment with the line-level boundaries and
  `end: null`: incapable of being auto-skipped, still available to the panel, never
  re-scanned.
- Keep the current behaviour available with `cut: 'always'` for calibration runs, so the
  eval can still compare boundaries.
- Collapse the gates: one effective pair (`skipThreshold` for acting, `maybe` for scanning)
  instead of a user threshold, `found` and `maybe` competing. `maybe` at 0.5 is now above
  what a local model answers at all — the run in the log has no answer above 0.42 — so it
  is worth re-checking with `npm run eval` whether the last commit's 0.35 → 0.5 change
  removed the local model's only working band.

## Incidental: the working tree is red before any of this

`npm test` on `HEAD` (d5f5a13, "First go at not overloading local models") fails 6 tests:
4 in `test/pipeline.test.ts`, 1 in `test/provider-contract.test.ts`, 1 in
`extension-background.test.ts`. No local changes are involved (`git status` is clean apart
from the untracked spec).

The cause looks like the same commit: `REFINE_AFTER` went 40 → 10 and `MAYBE` 0.35 → 0.5.
The refine slice is `[centre − 20, centre + 10)`, i.e. it excludes the line 10 after the
anchor. In `fixtures/demo-transcript.json` the read is named at L014 and hands back at
L024, so the end line is just outside the window, `end_line` picks `none`,
`endOk` is false and the segment comes back with `end: null` — which is the assertion that
fails ("the end comes after the start"). That is not only a test problem: any sponsor read
longer than ten lines now loses its end, and a segment with no end cannot be skipped.

Worth deciding before building on top of this: either widen `REFINE_AFTER` (verified: 11
turns all four `test/pipeline.test.ts` failures green, because it includes L024 and stops
one short of the next line — but the read length is what should drive the number) or make
the refine window grow when the end is not visible — which the `RUNS_PAST_EXCERPT` option already exists to
express.
