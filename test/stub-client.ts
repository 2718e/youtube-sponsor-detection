// A stand-in for a Jev-compatible model that answers the way Jev would on an
// obvious case, and records every request so the tests can check what we send.
//
// It spots three kinds of line by keyword: where the sponsor is named, where
// a lead-in story begins, and where the creator hands back to the video.

import type { Answer, CanonicalRequest, ProviderAnswer } from '../src/providers/contract.js';

export const SPONSOR_MARKERS = ['sponsored by', 'brought to you by', 'thanks to boot.dev', 'boot.dev is'];
export const LEAD_IN_MARKERS = ['a couple months back', 'quick story', 'making today\'s video possible', 'quick pause because'];
export const END_MARKERS = ['now let us get back', 'now back to', 'thank you kestrel', 'scan the qr code'];

interface Row {
  id: string;
  text: string;
}

export interface StubClient {
  requests: CanonicalRequest[];
  systemOne(request: CanonicalRequest): Promise<ProviderAnswer>;
}

export function createStubClient(): StubClient {
  const requests: CanonicalRequest[] = [];

  return {
    requests,
    async systemOne(request: CanonicalRequest): Promise<ProviderAnswer> {
      requests.push(request);
      const state = request.state as Record<string, any>;
      // The cut pass sends phrases instead of lines; the same keyword lookup works on them.
      const text = String(state.video_transcript_excerpt ?? state.phrases ?? state);
      const rows: Row[] = text.split('\n').map((row) => {
        const [id, ...rest] = row.split('| ');
        return { id, text: rest.join('| ').toLowerCase() };
      });
      const has = (r: Row, markers: string[]) => markers.some((m) => r.text.includes(m));

      const anchorAt = rows.findIndex((r) => has(r, SPONSOR_MARKERS));
      const anchorRow = anchorAt >= 0 ? rows[anchorAt] : undefined;
      const endAt = anchorAt >= 0 ? markerAt(rows, END_MARKERS, anchorAt + 1) : -1;
      const endRow = rows[endAt];
      const answers: Record<string, Answer> = {};

      for (const [name, question] of Object.entries(request.questions)) {
        // Search pass, one round: pick the group that holds the edge phrase.
        if (name === 'search_group') {
          const labels = Object.keys(question.criteria);
          const groups = (state.group_phrases ?? []) as string[][];
          const edge = edgePhrase(rows, state, groups, question.instructions.question.includes('last') ? 'end' : 'start');
          const picked = labels.find((_, i) => edge !== undefined && (groups[i] ?? []).includes(edge.id)) ?? labels[0];
          answers[name] = { type: 'choice', probabilities: distribute(labels, picked, 0.9) };
          continue;
        }
        // Search pass, last round: is the phrase the search landed on sponsor?
        if (name === 'is_edge_phrase') {
          const landed = rows.findIndex((r) => r.id === String(state.video_transcript_excerpt).split('| ')[0]);
          const edge = edgePhrase(rows, state, null, question.instructions.question.includes('begin') ? 'start' : 'end');
          answers[name] = { type: 'noul', noul: edge && landed === rows.indexOf(edge) ? 0.93 : 0.05 };
          continue;
        }
        if (question.type === 'noul' && /^P\d+$/.test(name)) {
          // Cut pass: a phrase is sponsor from the first marker phrase up to the hand-back.
          const i = rows.findIndex((r) => r.id === name);
          const first = edgePhrase(rows, state, null, 'start');
          const from = first ? rows.indexOf(first) : -1;
          const back = markerAt(rows, END_MARKERS, 0);
          const inSponsor = i >= 0 && (from < 0 || i >= from) && (back < 0 || i < back);
          answers[name] = { type: 'noul', noul: inSponsor ? 0.93 : 0.05 };
          continue;
        }
        if (question.type === 'noul') {
          answers[name] = { type: 'noul', noul: anchorRow ? 0.94 : 0.04 };
          continue;
        }
        const labels = Object.keys(question.criteria);
        let target: string | undefined;
        if (name === 'start_line') {
          // Reading backwards from the naming line for a lead-in.
          const namedAt = rows.findIndex((r) => r.id === state.sponsor_named_at);
          const leadIn = rows.slice(Math.max(0, namedAt - 40), namedAt + 1).find((r) => has(r, LEAD_IN_MARKERS));
          target = (leadIn ?? rows[namedAt])?.id;
        } else if (name === 'end_line') {
          target = endRow?.id;
        } else {
          target = anchorRow?.id;
        }
        const picked = target && labels.includes(target) ? target : labels[labels.length - 1];
        answers[name] = { type: 'choice', probabilities: distribute(labels, picked, 0.88) };
      }

      return { model: 'jev-1.13.0', answers, usage: { input_tokens: text.length / 4, output_tokens: 12 } };
    }
  };
}

/** Phrases are a few words each, so a marker can span two; find the phrase it starts in. */
function phraseWhere(rows: Row[], markers: string[]): Row | undefined {
  const joined = rows.map((r) => r.text).join(' ');
  const at = markers.map((m) => joined.indexOf(m)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return undefined;
  let offset = 0;
  for (const row of rows) {
    if (at < offset + row.text.length) return row;
    offset += row.text.length + 1;
  }
  return rows[rows.length - 1];
}

/** Index of the first row with one of `markers` at or after `from`. */
function markerAt(rows: Row[], markers: string[], from: number): number {
  for (let i = Math.max(0, from); i < rows.length; i++) {
    if (markers.some((m) => rows[i].text.includes(m))) return i;
  }
  return -1;
}

/**
 * The phrase an edge of the segment is at, in the rows of one request.
 *
 * A round of the search sees a subset, so when the markers that identify the
 * edge are not in it, what the round knows from its groups is used instead: the
 * edge is the first phrase of the group the search has not ruled out, and for
 * the end that is the phrase before the hand-back when the hand-back is here.
 */
function edgePhrase(rows: Row[], state: Record<string, any>, groups: string[][] | null, edge: 'start' | 'end'): Row | undefined {
  const anchorAt = rows.findIndex((r) => SPONSOR_MARKERS.some((m) => r.text.includes(m)));
  if (edge === 'start') {
    const leadIn = markerAt(rows, LEAD_IN_MARKERS, 0);
    if (leadIn >= 0 && (anchorAt < 0 || leadIn < anchorAt)) return rows[leadIn];
    if (anchorAt >= 0) return rows[anchorAt];
    const landed = rows.findIndex((r) => r.id === String(state.video_transcript_excerpt).split('| ')[0]);
    return rows[landed >= 0 ? landed : 0];
  }
  const back = markerAt(rows, END_MARKERS, 0);
  // The hand-back phrase is the first phrase of the video's own content again,
  // so the last sponsor phrase is the one before it.
  if (back >= 0) return rows[Math.max(0, back - 1)];
  const covered = groups?.flat();
  // No hand-back in these rows: the end the search is looking for is the last
  // of the phrases it is still considering.
  const inPlay = covered ? rows.filter((r) => covered.includes(r.id)) : rows;
  return inPlay.length ? inPlay[inPlay.length - 1] : rows[rows.length - 1];
}

function distribute(labels: string[], picked: string, mass: number): Record<string, number> {
  const rest = (1 - mass) / Math.max(1, labels.length - 1);
  return Object.fromEntries(labels.map((l) => [l, l === picked ? mass : rest]));
}
