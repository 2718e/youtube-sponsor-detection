# Decision-model split

*2026-10-02*

## What it is

`src/jev.ts` was 664 lines: prompt wording, thresholds, result types and the
scan/cut/refine orchestration in one file. It is now seven modules under
`src/decisionModel/`, split by what changes together:

```
src/decisionModel/
  prompts.ts             the SPONSOR definition and the four question builders
  thresholds.ts          confidence bands and the defaults a run starts from
  types.ts               the shapes that cross module boundaries
  scan.ts                stage 1: one request per window, and reading its answers
  refine.ts              stage 2: pin down one candidate
  cut.ts                 stage 3: split a boundary line into phrases and cut
  findSponsorSegment.ts  the entry point and the scan/refine/rescan loop
```

- **`prompts.ts`** owns the words the model is asked: `SPONSOR`,
  `scanQuestions`, `anchorQuestions`, `startQuestions`, `cutQuestions`, plus the
  `NO_START` / `RUNS_PAST_EXCERPT` option labels the builders emit.
- **`thresholds.ts`** owns `FOUND`, `MAYBE`, `KEEP_CONTENT` and
  `DEFAULT_THRESHOLDS`. Providers and the extension read their defaults from
  here, so they no longer reach into the pipeline for them.
- **`types.ts`** owns the shared vocabulary: `Scan`, the `Sponsor*` result
  types, `PipelineClient`, and the internal `Ask` / `Report` plumbing.
- **`scan.ts`** owns one window's request (`scanWindow`) and the helpers that
  read a scan's answers (`bestLabel`, `looksLikeSponsor`).
- **`refine.ts`** owns stage 2, including its `REFINE_BEFORE` /
  `REFINE_AFTER` / `BLIND_MASK_LINES` constants.
- **`cut.ts`** owns stage 3: `cut`, `cutPoint`, `CUT_CONTEXT_LINES`, `IN_RUN`.
- **`findSponsorSegment.ts`** owns the entry point and the loop that decides
  which candidates to refine and when to rescan a window.

The dependency direction is one-way, with no cycles:

```
findSponsorSegment → refine → cut
        ↘             ↘
         scan ────────┴──→ types, thresholds, prompts
```

Fields are grouped by which pass uses them: constants and helpers used by a
single pass live in that pass's file (`summarise` in `findSponsorSegment.ts`,
the cut-point constants in `cut.ts`), while `bestLabel` and `looksLikeSponsor`
are shared by scan and refine, so they live in `scan.ts`.

## No behaviour change

The code moved verbatim. A normalized diff of the split modules against the
previous `runner.ts` + `prompts.ts` shows only one difference: the inner
`scan` arrow function became the exported `scanWindow`, so its signature and
its two call sites changed. Everything else is identical.

Callers now import from the module that owns the name:

- `findSponsorSegment` → `src/decisionModel/findSponsorSegment.js`
- `DEFAULT_THRESHOLDS` / `Thresholds` → `src/decisionModel/thresholds.js`
- `SponsorResult`, `PipelineClient` → `src/decisionModel/types.js`
- the question builders → `src/decisionModel/prompts.js`

`npm run typecheck` and `npm test` (34 tests) both pass, and
`npm run build:ext` bundles the extension against the new entry.
