// Stage 3's boundary search: find the phrase where the sponsor segment begins
// or ends without asking about every phrase.
//
// The phrases around a boundary are consecutive, and so is the segment inside
// them: sponsor, then not. Code can therefore narrow the edge with a search
// instead of a census, which costs about log(n) questions rather than n and
// keeps the transcript in state short enough for a local model. Which search is
// a strategy (see SearchStrategy); the census that asks about every phrase is
// the other way through ./cut.ts.

import { renderLines, type Phrase } from '../transcript.js';
import { noulOf, probabilitiesOf } from '../providers/contract.js';
import { confirmQuestions, searchQuestions } from './prompts.js';
import { type Ask, type SearchCall, type SearchStrategy } from './types.js';

/**
 * Requests a search of `count` phrases takes: one a round until the span is a
 * single phrase, then the confirming question. A round keeps at most a
 * `ceil(span / groups)` slice of the span, so this is the number of halvings
 * that gets the span to one.
 */
export function searchCost(count: number, strategy: SearchStrategy): number {
  const groups = GROUPS_PER_QUESTION[strategy] ?? 2;
  let rounds = 0;
  for (let span = count; span > 1; rounds += 1) {
    const inPlay = Math.min(groups, span);
    const step = Math.ceil(span / inPlay);
    // splitSpan puts the remainder in the last group, so that is the largest.
    span = Math.min(step, span - step * (inPlay - 1));
  }
  return rounds + 1;
}

/** Groups of the span offered in one round; the base of the search's logarithm. */
export const GROUPS_PER_QUESTION: Record<SearchStrategy, number> = { binary: 2, span: 3 };

export interface SearchRequest {
  /** The phrases the edge is somewhere among, in order. */
  phrases: Phrase[];
  edge: 'start' | 'end';
  /** What the model needs besides the phrases: the line naming the sponsor, the title. */
  context: Record<string, unknown>;
  ask: Ask;
  strategy: SearchStrategy;
}

export interface SearchOutcome {
  /** Index into `phrases` of the edge phrase, or -1 when nothing qualified. */
  index: number;
  probability: number;
  calls: SearchCall[];
}

/**
 * Narrow the edge to one phrase and return its index.
 *
 * Each round offers equal-sized groups of the part of the span still in play
 * and keeps the group the model picks, so a span of n phrases takes about
 * log(n) rounds. The last one asks whether the phrase the search landed on is
 * really part of the segment, which is the judgment the census asks per phrase,
 * and is what decides between an answer and -1.
 */
export async function searchPhrase({ phrases, edge, context, ask, strategy }: SearchRequest): Promise<SearchOutcome> {
  const groups = GROUPS_PER_QUESTION[strategy] ?? 2;
  const calls: SearchCall[] = [];

  let low = 0;
  let high = phrases.length - 1;
  while (low < high) {
    const bounds = splitSpan(low, high, groups);
    const picked = await pickGroup(phrases, bounds, edge, context, ask);
    const chosen = bounds[picked.index] ?? bounds[0];
    calls.push({ stage: 'search', from: low, to: high, picked: picked.index, probability: picked.probability });
    low = chosen[0];
    high = chosen[1];
  }

  const phrase = phrases[low];
  const result = await ask(
    {
      ...context,
      video_transcript_excerpt: `${phrase.id}| ${phrase.text}`,
      excerpt_position: 'the phrase the search narrowed to'
    },
    confirmQuestions(phrase, edge)
  );
  const probability = noulOf(result.answers.is_edge_phrase);
  calls.push({ stage: 'confirm', from: low, to: low, picked: probability >= 0.5 ? low : -1, probability });
  return { index: probability >= 0.5 ? low : -1, probability, calls };
}

/** Equal-sized groups covering [low, high], the last one taking the remainder. */
export function splitSpan(low: number, high: number, groups: number): [number, number][] {
  const count = Math.max(1, Math.min(groups, high - low + 1));
  const step = Math.ceil((high - low + 1) / count);
  const bounds: [number, number][] = [];
  for (let start = low; start <= high; start += step) bounds.push([start, Math.min(high, start + step - 1)]);
  return bounds;
}

interface Pick {
  index: number;
  probability: number;
}

/** One round: which group of the span holds the edge. */
async function pickGroup(
  phrases: Phrase[],
  bounds: [number, number][],
  edge: 'start' | 'end',
  context: Record<string, unknown>,
  ask: Ask
): Promise<Pick> {
  const result = await ask(
    {
      ...context,
      video_transcript_excerpt: renderLines(phrases),
      // Which phrases each option covers, so the option text can stay short.
      group_phrases: bounds.map(([from, to]) => phrases.slice(from, to + 1).map((p) => p.id)),
      excerpt_position: 'the phrases around one boundary of the sponsor segment'
    },
    searchQuestions(phrases, bounds, edge)
  );
  const probabilities = probabilitiesOf(result.answers.search_group);
  let best = -1;
  let probability = 0;
  bounds.forEach((_, i) => {
    const p = probabilities[`group_${i}`] ?? 0;
    if (p > probability) {
      probability = p;
      best = i;
    }
  });
  return { index: best, probability };
}
