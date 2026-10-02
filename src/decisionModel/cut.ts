// Stage 3: split the lines at a boundary into phrases and find the point in
// those answers where the segment begins or ends.

import { buildPhrases, type Line } from '../transcript.js';
import { noulOf } from '../providers/contract.js';
import { cutQuestions } from './prompts.js';
import { KEEP_CONTENT, type Thresholds } from './thresholds.js';
import { type Ask, type PhraseCut } from './types.js';

/** Lines of context on each side of a boundary line in the cut pass. */
const CUT_CONTEXT_LINES = 3;

/**
 * The cut pass for one edge: split the boundary line and its neighbours into
 * phrases, ask which phrases are sponsor, and cut where the answers say the
 * segment begins or ends. Returns null when the answers give no cut, in which
 * case the line-level boundary stands.
 */
export async function cut(
  lines: Line[],
  line: Line,
  edge: 'start' | 'end',
  ask: Ask,
  title: string,
  anchorLine: Line,
  limits: Thresholds
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

  const result = await ask(
    {
      video_title: title,
      before: before.map((l) => l.text).join(' ') || '(start of the video)',
      phrases: phrases.map((p) => `${p.id}| ${p.text}`).join('\n'),
      after: after.map((l) => l.text).join(' ') || '(end of the video)',
      sponsor_named_at_text: anchorLine.text
    },
    cutQuestions(phrases)
  );
  const inSponsor = phrases.map((p) => noulOf(result.answers[p.id]));
  const index = cutPoint(inSponsor, edge, limits.keepContent);
  if (index < 0) {
    // No phrase here is surely sponsor. For the start, the line-level answer
    // stands: a lead-in reads as ordinary content phrase by phrase, and only
    // the pass that saw the whole segment could tell it belongs. For the end,
    // the read is over before these lines, so nothing in them is skipped.
    return edge === 'end' ? { seconds: phrases[0].start, phrase: null } : null;
  }
  const phrase = phrases[index];
  return {
    seconds: edge === 'start' ? phrase.start : phrase.end,
    phrase: { id: phrase.id, text: phrase.text, start: phrase.start, end: phrase.end, probability: inSponsor[index] }
  };
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
