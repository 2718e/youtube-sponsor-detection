// Stage 1: one request per transcript window, all in parallel, and the reading
// of a scan's answers.
//
// findSponsorSegment owns the loop that decides which scans to refine and when
// to rescan a window; this module owns the request for a single window.

import { renderLines, estimateTokens, type Line } from '../transcript.js';
import { noulOf, probabilitiesOf } from '../providers/contract.js';
import { NO_START, scanQuestions } from './prompts.js';
import { type Ask, type Report, type Scan } from './types.js';

export function bestLabel(probabilities: Record<string, number>, allowed: Set<string>): { id: string | null; probability: number } {
  let bestId: string | null = null;
  let best = -1;
  for (const [label, p] of Object.entries(probabilities)) {
    if (!allowed.has(label)) continue;
    if (p > best) {
      best = p;
      bestId = label;
    }
  }
  return { id: bestId, probability: best < 0 ? 0 : best };
}

export function looksLikeSponsor(scan: Scan): number {
  return Math.max(scan.presence, 1 - scan.pNone);
}

export async function scanWindow(
  window: Line[],
  index: number,
  total: number,
  ask: Ask,
  title: string,
  report: Report
): Promise<Scan> {
  const state = {
    video_title: title,
    video_transcript_excerpt: renderLines(window),
    excerpt_position: `part ${index + 1} of ${total} of the video`
  };
  const result = await ask(state, scanQuestions(window));
  const presence = noulOf(result.answers.sponsor_starts_here);
  const pick = bestLabel(probabilitiesOf(result.answers.anchor_line), new Set(window.map((l) => l.id)));
  report({ stage: 'scan', window: index, presence });
  return {
    index,
    lines: window,
    from: window[0].start,
    to: window[window.length - 1].end,
    presence,
    pNone: probabilitiesOf(result.answers.anchor_line)[NO_START] ?? 0,
    startLineId: pick.id,
    startLineProbability: pick.probability,
    estimatedStateTokens: estimateTokens(state.video_transcript_excerpt)
  };
}
