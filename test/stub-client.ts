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
      const endRow = anchorRow ? rows.slice(anchorAt).find((r) => has(r, END_MARKERS)) : undefined;
      const answers: Record<string, Answer> = {};

      for (const [name, question] of Object.entries(request.questions)) {
        if (question.type === 'noul' && /^P\d+$/.test(name)) {
          // Cut pass: a phrase is sponsor from the first marker phrase up to the hand-back.
          const first = rows.indexOf(phraseWhere(rows, [...LEAD_IN_MARKERS, ...SPONSOR_MARKERS]) as Row);
          const back = rows.indexOf(phraseWhere(rows, END_MARKERS) as Row);
          const i = rows.findIndex((r) => r.id === name);
          const inSponsor = (first < 0 || i >= first) && (back < 0 || i < back) && !(first < 0 && back < 0 && !anchorRow);
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

function distribute(labels: string[], picked: string, mass: number): Record<string, number> {
  const rest = (1 - mass) / Math.max(1, labels.length - 1);
  return Object.fromEntries(labels.map((l) => [l, l === picked ? mass : rest]));
}
