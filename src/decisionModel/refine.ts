// Stage 2: pin down one candidate window.

import { renderLines, type Line } from '../transcript.js';
import { noulOf, probabilitiesOf } from '../providers/contract.js';
import { RUNS_PAST_EXCERPT, anchorQuestions, startQuestions } from './prompts.js';
import { bestLabel, looksLikeSponsor } from './scan.js';
import { cut } from './cut.js';
import { type Thresholds } from './thresholds.js';
import {
  type Ask,
  type CutOptions,
  type Report,
  type Scan,
  type SponsorSegment
} from './types.js';

/** Lines of context kept around the anchor in the refine pass. A lead-in
 *  story can run three or four minutes before the sponsor is even named, so
 *  the reach backwards is generous. */
const REFINE_BEFORE = 20;
const REFINE_AFTER = 15;

/** Lines masked after a start when the refine pass could not find the end. */
const BLIND_MASK_LINES = 10;

/**
 * Pin down one candidate. Two requests: the first confirms the segment and
 * finds the line naming the sponsor and the last line; the second, with that
 * naming line written into the state, reads backwards for the first line of
 * the lead-in. Returns null when the refine pass rejects the candidate.
 */
export async function refine(
  winner: Scan,
  lines: Line[],
  taken: Set<string>,
  ask: Ask,
  report: Report,
  title: string,
  limits: Thresholds,
  cutOptions: CutOptions
): Promise<SponsorSegment | null> {
  const centre = lines.findIndex((l) => l.id === winner.startLineId);
  const from = Math.max(0, centre - REFINE_BEFORE);
  const slice = lines.slice(from, Math.min(lines.length, centre + REFINE_AFTER)).filter((l) => !taken.has(l.id));
  if (slice.length < 2) return null;
  report({ stage: 'refine', lines: slice.length });

  const allowed = new Set(slice.map((l) => l.id));
  const byId = new Map(slice.map((l) => [l.id, l]));
  const position = `an excerpt from the video, starting around ${Math.round(slice[0].start)} seconds in`;

  const anchored = await ask(
    { video_title: title, video_transcript_excerpt: renderLines(slice), excerpt_position: position },
    anchorQuestions(slice)
  );

  const presence = noulOf(anchored.answers.has_sponsor);
  if (presence < limits.maybe) return null;

  const anchorPick = bestLabel(probabilitiesOf(anchored.answers.anchor_line), allowed);
  const endPick = bestLabel(probabilitiesOf(anchored.answers.end_line), allowed);
  const endRunsOn = probabilitiesOf(anchored.answers.end_line)[RUNS_PAST_EXCERPT] ?? 0;
  const anchorLine = byId.get(anchorPick.id ?? '') ?? byId.get(winner.startLineId ?? '') ?? slice[0];
  const anchorIndex = slice.indexOf(anchorLine);

  // Second request: the lines up to and including the naming line, with the
  // naming line spelled out in the state so the model reads backwards from it.
  const before = slice.slice(0, anchorIndex + 1);
  let startLine = anchorLine;
  let startProbability = anchorPick.probability;
  if (before.length > 1) {
    const traced = await ask(
      {
        video_title: title,
        video_transcript_excerpt: renderLines(before),
        sponsor_named_at: anchorLine.id,
        sponsor_named_at_text: anchorLine.text,
        excerpt_position: position
      },
      startQuestions(before)
    );
    const startPick = bestLabel(probabilitiesOf(traced.answers.start_line), new Set(before.map((l) => l.id)));
    if (startPick.id) {
      startLine = byId.get(startPick.id) ?? anchorLine;
      startProbability = startPick.probability;
    }
  }

  const endLine = endPick.id ? byId.get(endPick.id) : undefined;
  const endOk = Boolean(endLine && endRunsOn < endPick.probability && endLine.end > startLine.start);
  const confidence = Math.min(looksLikeSponsor(winner), presence);

  const startIndex = slice.indexOf(startLine);
  const endIndex = endOk ? slice.indexOf(endLine as Line) : Math.min(slice.length - 1, anchorIndex + BLIND_MASK_LINES);
  const lineIds = slice.slice(startIndex, endIndex + 1).map((l) => l.id);

  // Third request(s): where inside the first and last lines the segment
  // really begins and ends. Both edges are independent, so they run together.
  // The cut is the most expensive pass in a run, so a caller that would not
  // skip a segment this unsure does not pay for one.
  report({ stage: 'cut' });
  let [startCut, endCut] = cutOptions.cut === 'always' || confidence >= cutOptions.skipThreshold
    ? await Promise.all([
        cut(lines, startLine, 'start', ask, title, anchorLine, limits, cutOptions.boundaryStrategy, cutOptions.searchStrategy, report),
        endOk
          ? cut(lines, endLine as Line, 'end', ask, title, anchorLine, limits, cutOptions.boundaryStrategy, cutOptions.searchStrategy, report)
          : null
      ])
    : [null, null];
  // A read of a few words can end up with its end cut before its start (no
  // phrase was surely sponsor); the line-level end stands then.
  if (endCut && endCut.seconds <= (startCut?.seconds ?? startLine.start)) endCut = null;

  return {
    confidence,
    scanPresence: winner.presence,
    refinePresence: presence,
    start: {
      lineId: startLine.id,
      seconds: startCut?.seconds ?? startLine.start,
      lineSeconds: startLine.start,
      text: startLine.text,
      probability: startProbability,
      phrase: startCut?.phrase ?? null
    },
    anchor: { lineId: anchorLine.id, seconds: anchorLine.start, text: anchorLine.text, probability: anchorPick.probability },
    end: endOk
      ? {
          lineId: (endLine as Line).id,
          seconds: endCut?.seconds ?? (endLine as Line).end,
          lineSeconds: (endLine as Line).end,
          text: (endLine as Line).text,
          probability: endPick.probability,
          runsPastExcerpt: endRunsOn,
          phrase: endCut?.phrase ?? null
        }
      : null,
    lineIds,
    context: slice
  };
}
