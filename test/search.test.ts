// The boundary search and the cut gate: a search costs a round per halving,
// and a cut is only paid for when the caller could actually skip the segment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildLines, type Cue, type Phrase } from '../src/transcript.js';
import { findSponsorSegment } from '../src/decisionModel/findSponsorSegment.js';
import { searchCost, searchPhrase } from '../src/decisionModel/search.js';
import type { Answer, CanonicalRequest, ProviderAnswer } from '../src/providers/contract.js';
import { createStubClient } from './stub-client.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/demo-transcript.json', import.meta.url), 'utf8')) as {
  title: string;
  cues: Cue[];
};

/** Phrases to search over: enough that a census would cost a question each. */
const phrases: Phrase[] = Array.from({ length: 33 }, (_, i) => ({
  id: `P${String(i + 1).padStart(2, '0')}`,
  lineId: `L${String(Math.floor(i / 3) + 1).padStart(3, '0')}`,
  text: `words number ${i + 1}`,
  start: i,
  end: i + 1
}));

/** A model that knows the edge is at `at`, whatever it is asked. */
function knowsEdge(at: number, calls: CanonicalRequest[] = []) {
  return async (state: Record<string, unknown>, questions: Record<string, { type: string; criteria: Record<string, unknown> }>): Promise<ProviderAnswer> => {
    calls.push({ state, questions } as CanonicalRequest);
    const answers: Record<string, Answer> = {};
    for (const [name, question] of Object.entries(questions)) {
      const labels = Object.keys(question.criteria);
      if (question.type === 'choice' && name === 'search_group') {
        const groups = state.group_phrases as string[][];
        const picked = labels.find((_, i) => (groups[i] ?? []).includes(phrases[at].id)) ?? labels[0];
        answers[name] = { type: 'choice', probabilities: distribute(labels, picked) };
      } else {
        answers[name] = { type: 'noul', noul: String(state.video_transcript_excerpt).startsWith(phrases[at].id) ? 0.93 : 0.05 };
      }
    }
    return { model: 'stub', answers, usage: { input_tokens: 10, output_tokens: 1 } };
  };
}

function distribute(labels: string[], picked: string): Record<string, number> {
  const rest = 0.1 / Math.max(1, labels.length - 1);
  return Object.fromEntries(labels.map((l) => [l, l === picked ? 0.9 : rest]));
}

for (const strategy of ['binary', 'span'] as const) {
  test(`the ${strategy} search lands on the edge in rounds, not one question per phrase`, async () => {
    const calls: CanonicalRequest[] = [];
    const outcome = await searchPhrase({
      phrases,
      edge: 'start',
      context: {},
      ask: knowsEdge(21, calls),
      strategy
    });

    assert.equal(outcome.index, 21, 'the search finds the phrase the model knows is the edge');
    assert.equal(outcome.probability, 0.93);
    assert.equal(calls.length, searchCost(phrases.length, strategy), `${calls.length} requests for ${phrases.length} phrases`);
    assert.ok(calls.length < phrases.length / 4, 'far fewer requests than the census would ask');
    // Each round offers the group the edge is in, plus the confirmation.
    assert.equal(calls.filter((c) => c.questions.search_group).length, calls.length - 1);
  });
}

test('a search that cannot confirm the phrase gives no cut', async () => {
  const outcome = await searchPhrase({
    phrases,
    edge: 'end',
    context: {},
    strategy: 'binary',
    ask: async (_state, questions) => ({
      model: 'stub',
      answers: Object.fromEntries(
        Object.entries(questions).map(([name, question]) => [
          name,
          question.type === 'choice'
            ? { type: 'choice' as const, probabilities: distribute(Object.keys(question.criteria), Object.keys(question.criteria)[0]) }
            : { type: 'noul' as const, noul: 0.05 }
        ])
      ),
      usage: { input_tokens: 1, output_tokens: 1 }
    })
  });

  assert.equal(outcome.index, -1, 'an unconfirmed phrase is no answer at all');
});

test('searchCost counts a round per halving, then the confirmation', () => {
  for (const [phrases, rounds] of [[8, 4], [20, 5], [33, 6]] as const) {
    assert.equal(searchCost(phrases, 'binary'), rounds, `${phrases} phrases`);
  }
  assert.ok(searchCost(20, 'span') < searchCost(20, 'binary'), 'more groups a round means fewer rounds');
});

test('a segment too unsure to skip is not cut', async () => {
  const lines = buildLines(fixture.cues);

  const gated = createStubClient();
  await findSponsorSegment(lines, { client: gated, skipThreshold: 0.999 });
  assert.equal(
    gated.requests.filter((r) => r.questions.search_group || r.questions.is_edge_phrase).length,
    0,
    'the stub answers 0.94, below the 0.999 the caller would skip at'
  );

  const calibrated = createStubClient();
  const result = await findSponsorSegment(lines, { client: calibrated, cut: 'always' });
  assert.ok(
    calibrated.requests.some((r) => r.questions.search_group),
    'a calibration run still cuts, whatever the segment scores'
  );
  assert.ok(result.segments[0].end, 'and the cut still lands an end');
});

test('the search and the census agree about the boundary', async () => {
  const bySearch = createStubClient();
  const searched = await findSponsorSegment(buildLines(fixture.cues), { client: bySearch, boundaryStrategy: 'search' });
  const byCensus = createStubClient();
  const censused = await findSponsorSegment(buildLines(fixture.cues), { client: byCensus, boundaryStrategy: 'per-phrase' });

  assert.equal(searched.start?.seconds, censused.start?.seconds, 'the same start');
  assert.equal(searched.end?.seconds, censused.end?.seconds, 'the same end');
  const asked = (requests: CanonicalRequest[]) =>
    requests.reduce((n, r) => n + Object.keys(r.questions).length, 0);
  assert.ok(
    asked(bySearch.requests) < asked(byCensus.requests),
    `the census asks a question per phrase (${asked(byCensus.requests)}); the search asks per round (${asked(bySearch.requests)})`
  );
});
