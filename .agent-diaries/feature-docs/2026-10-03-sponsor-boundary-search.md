# Sponsor boundary search and the cut gate

*2026-10-03*

## What it is

The cut pass used to ask one noul per phrase around a boundary: a 25-phrase
span cost 25 questions, each repeating the `SPONSOR` block, which is what made
the prompts in the local model's log long and slow. It now searches for the
boundary instead, and a segment is only cut when the caller could actually skip
it.

Two new knobs, both threaded through `FindOptions`:

| Option | Values | Default | What it changes |
| --- | --- | --- | --- |
| `boundaryStrategy` | `'search'`, `'per-phrase'` | `'search'` | how the cut pass finds the edge |
| `searchStrategy` | `'binary'`, `'span'` | `'binary'` | groups offered per round: 2, or 3 |
| `cut` | `'skippable'`, `'always'` | `'skippable'` | whether unsure segments are cut |
| `skipThreshold` | number | `thresholds.found` | the confidence `'skippable'` gates on |

## The search

`src/decisionModel/search.ts` owns it. A boundary is one phrase wide and the
segment is contiguous, so the edge is a step in a monotone predicate and code
can halve the span instead of asking about every phrase:

```
cutQuestions/phrases  ->  searchPhrase
   round:  which group of the span holds the edge?   (one choice, k options)
   ... until one phrase is left ...
   confirm: does this phrase belong to the segment?  (one noul)
```

- `searchQuestions` (`prompts.ts`) builds a round: one choice over
  `group_0 … group_k`, each criterion naming the first and last phrase it
  covers. The state carries `group_phrases` (the ids each option holds) and the
  whole span rendered as `video_transcript_excerpt`, so the option text can stay
  short and each request is self-contained.
- `confirmQuestions` puts the judgment the census made per phrase once, to the
  one phrase the search landed on. Below 0.5 there is no answer (`-1`) and the
  line-level boundary stands, exactly as the census behaved.
- `GROUPS_PER_QUESTION` is 2 for `'binary'` and 3 for `'span'`; `searchCost`
  counts the requests a span of n phrases costs.
- Each round is reported through `onProgress` (`{ stage: 'search', edge, from,
  to, picked, probability }`), so `--verbose` shows the descent.

Cost on the demo fixture: the census asks 50 questions in 2 requests, the search
asks 8 in 8. On the logged run that is the difference between repeating a 767
character definition 25 times and repeating it 4 times. A local model pays per
question, so the search is the default.

## The cut gate

`refine` computes the segment's confidence (`min(scan presence, refine
presence)`) and only runs the cut when `cut === 'always'` or that confidence
reaches `skipThreshold`. A gated segment keeps its line-level boundaries and
comes back with `end: null`, which is what the panel needs to refuse to skip it,
and the window is still rescanned so nothing is paid twice.

The gate closes a gap between three numbers that used to disagree: refine
proceeded at `maybe` (0.5), status needed `found` (0.7), and the extension skips
at `settings.threshold` (0.7). A local model answering near 0.4 used to buy two
expensive cuts for a segment that could never be skipped.

## Callers

- The extension passes `skipThreshold: settings.threshold`, and has
  `Boundaries` controls in the popup for `boundaryStrategy` and `cut`. Both are
  in `Settings` with defaults, so results cached by an older version still load.
- `scripts/eval.ts` takes `--boundary per-phrase` and `--cut-always`, so the
  census and the ungated run stay measurable against the search.
- `scripts/analyze.ts` takes `--census` and `--cut-always` for the same reason.

## Tests

`test/search.test.ts` is new: it checks a search lands on the phrase the model
knows is the edge for both strategies, that the request count matches
`searchCost`, that an unconfirmed phrase gives `-1`, that a segment below
`skipThreshold` is not cut while `cut: 'always'` still is, and that the search
and the census agree on the boundary. `test/stub-client.ts` learned the search
and confirmation questions, so the pipeline tests exercise it end to end.

`test/pipeline.test.ts` request counts now read `EDGE_SEARCHES` (4: the span is
8 phrases, 8 → 4 → 2 → 1, then the confirmation), and the long-video and
two-reads cases say in the assertion why their window counts differ.

One assertion changed for an unrelated reason: captions are contiguous, so the
last sponsor line can end exactly where the sign-off begins, and the lead-in
test now allows that boundary rather than requiring it to be earlier.
