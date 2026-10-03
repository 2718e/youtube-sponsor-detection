// Stage 3: split the lines at a boundary into phrases and find the point in
// those answers where the segment begins or ends.

import { buildPhrases, type Line, type Phrase } from '../transcript.js';
import { noulOf } from '../providers/contract.js';
import { cutQuestions } from './prompts.js';
import { searchPhrase } from './search.js';
import { KEEP_CONTENT, type Thresholds } from './thresholds.js';
import { type Ask, type BoundaryStrategy, type PhraseCut, type Report, type SearchStrategy } from './types.js';

/** Lines of context on each side of a boundary line in the cut pass. */
const CUT_CONTEXT_LINES = 3;

/**
 * The cut pass for one edge: split the boundary line and its neighbours into
 * phrases, narrow them to the phrase where the segment begins or ends, and
 * return it. Two ways to narrow are kept behind `strategy`: the search (the
 * default, about log(n) questions) and the census that asks about every phrase
 * (see ./search.ts and ./prompts.ts). Returns null when the answers give no
 * cut, in which case the line-level boundary stands.
 */
export async function cut(
  lines: Line[],
  line: Line,
  edge: 'start' | 'end',
  ask: Ask,
  title: string,
  anchorLine: Line,
  limits: Thresholds,
  strategy: BoundaryStrategy,
  searchStrategy: SearchStrategy,
  report: Report
): Promise<{ seconds: number; phrase: PhraseCut | null } | null> {
  const at = lines.indexOf(line);
  if (at < 0) return null;
  // The end line is the one most often a line late (a "[Music]" or a hand-back
  // line gets chosen), so the end looks two lines back.
  const from = Math.max(0, at - (edge === 'end' ? 2 : 1));
  const to = at + 2;
  const phrases = buildPhrases(lines.slice(from, to));
  if (phrases.length < 2) return null;
  const before = lines.slice(Math.max(0, from - CUT_CONTEXT_LINES), from);
  const after = lines.slice(to, to + CUT_CONTEXT_LINES);
  const state = {
    video_title: title,
    before: before.map((l) => l.text).join(' ') || '(start of the video)',
    after: after.map((l) => l.text).join(' ') || '(end of the video)',
    sponsor_named_at_text: anchorLine.text
  };

  const found =
    strategy === 'search'
      ? await searched(phrases, edge, state, ask, searchStrategy, report)
      : await censused(phrases, edge, state, ask, limits);
  if (found.index < 0) {
    // No phrase here is surely sponsor. For the start, the line-level answer
    // stands: a lead-in reads as ordinary content phrase by phrase, and only
    // the pass that saw the whole segment could tell it belongs. For the end,
    // the read is over before these lines, so nothing in them is skipped.
    return edge === 'end' ? { seconds: phrases[0].start, phrase: null } : null;
  }
  const phrase = phrases[found.index];
  return {
    seconds: edge === 'start' ? phrase.start : phrase.end,
    phrase: { id: phrase.id, text: phrase.text, start: phrase.start, end: phrase.end, probability: found.probability }
  };
}

/** Search for the edge: about log(n) questions instead of one per phrase. */
async function searched(
  phrases: Phrase[],
  edge: 'start' | 'end',
  state: Record<string, unknown>,
  ask: Ask,
  strategy: SearchStrategy,
  report: Report
): Promise<{ index: number; probability: number }> {
  const outcome = await searchPhrase({ phrases, edge, context: state, ask, strategy });
  for (const call of outcome.calls) report({ edge, ...call });
  return { index: outcome.index, probability: outcome.probability };
}

/** Ask about every phrase and read the profile of answers. */
async function censused(
  phrases: Phrase[],
  edge: 'start' | 'end',
  state: Record<string, unknown>,
  ask: Ask,
  limits: Thresholds
): Promise<{ index: number; probability: number }> {
  const result = await ask({ ...state, phrases: phrases.map((p) => `${p.id}| ${p.text}`).join('\n') }, cutQuestions(phrases));
  const inSponsor = phrases.map((p) => noulOf(result.answers[p.id]));
  const index = cutPoint(inSponsor, edge, limits.keepContent);
  return { index, probability: index < 0 ? 0 : inSponsor[index] };
}

/** A phrase this likely to be sponsor still counts as part of a run that a surer phrase started. */
const IN_RUN = 0.5;

/**
 * Where to cut, given how likely each consecutive phrase is to be sponsor.
 *
 * Only a phrase that is sponsor with at least KEEP_CONTENT probability gets
 * skipped, so doubt always falls on the side of watching a little of the read
 * rather than losing content. The start is the first such phrase whose
 * neighbour after it is at least plausibly sponsor too (one phrase alone does
 * not start a segment); the end is the last such phrase whose neighbour before
 * it is. Returns the phrase index, or -1 when no phrase qualifies.
 */
export function cutPoint(inSponsor: number[], edge: 'start' | 'end', keepContent: number = KEEP_CONTENT): number {
  const n = inSponsor.length;
  if (edge === 'start') {
    for (let i = 0; i < n; i++) {
      if (inSponsor[i] >= keepContent && (i === n - 1 || inSponsor[i + 1] >= IN_RUN)) return i;
    }
    return -1;
  }
  for (let i = n - 1; i >= 0; i--) {
    if (inSponsor[i] >= keepContent && (i === 0 || inSponsor[i - 1] >= IN_RUN)) return i;
  }
  return -1;
}
