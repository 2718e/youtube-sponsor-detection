// Finding the sponsor segment with Jev (TypeSafe System One).
//
// Shape of the work, following the docs' "select instead of generate" advice:
// code finds the candidates (labelled transcript lines) and Jev picks between
// them. Two stages, because stage two's state depends on stage one's answer:
//
//   Stage 1 (scan)   one request per transcript window, all in parallel. Each
//                    asks a noul (does a sponsor read begin in this excerpt?)
//                    and a choice (which line begins it?) over the same state.
//   Stage 2 (refine) one request over the lines around the winning line, to
//                    pin down the first line exactly and find the last one.
//   Stage 3 (cut)    the first and last lines split into phrases of a few
//                    words, and Jev picks the phrase where the segment begins
//                    and the one where it ends, so the skip lands on a word
//                    rather than on a line that started seconds earlier.
//
// Nothing here asks Jev for a number: it names a line or phrase ID and code
// reads the timestamp off it.
//
// This file has no dependencies beyond ./transcript.ts and the provider
// contract, so the Chrome extension can run the same pipeline: pass any
// `client` with a `systemOne(request)`.

import { renderLines, windowLines, estimateTokens, buildPhrases, type Line, type Phrase } from './transcript.js';
import {
  noulOf,
  probabilitiesOf,
  type CanonicalRequest,
  type ProviderAnswer,
  type Questions,
  type Usage
} from './providers/contract.js';

/** Confidence bands, following the cookbook's 0.7 / 0.35 split. Tune on real data. */
export const FOUND = 0.7;
export const MAYBE = 0.35;

/** The bands above are calibrated to Jev's own probabilities, so they do not
 *  transfer to a different model unchanged. A provider carries its own defaults
 *  (see src/providers) and callers may override them per run; nothing else in
 *  this file needs to know which model answered. */
export interface Thresholds {
  found: number;
  maybe: number;
  keepContent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { found: FOUND, maybe: MAYBE, keepContent: 0.8 };

/** Lines of context kept around the anchor in the refine pass. A lead-in
 *  story can run three or four minutes before the sponsor is even named, so
 *  the reach backwards is generous. */
const REFINE_BEFORE = 45;
const REFINE_AFTER = 40;

const NO_START = 'none';
const RUNS_PAST_EXCERPT = 'continues_past_excerpt';

/** Lines of context on each side of a boundary line in the cut pass. */
const CUT_CONTEXT_LINES = 3;

/**
 * How sure the pipeline wants to be that a skip never eats content: a phrase
 * is only skipped when it is sponsor with at least this probability. Sitting
 * through a second of a sponsor read is the price of never cutting a second
 * of the video.
 */
export const KEEP_CONTENT = 0.8;

/**
 * What counts as a sponsor segment. Written for a model that reads literally:
 * the lead-in is spelled out because the naive reading ("the line that names
 * the sponsor") misses everything the creator says to set the pitch up.
 */
export const SPONSOR = {
  definition:
    'A sponsor segment is the part of a video that exists to promote a third party that paid ' +
    'for placement: a product, service, app or company. It is usually read by the creator.',
  shape: [
    'A sponsor segment normally has three parts, and it begins with the first one:',
    '1. a lead-in, where the creator leaves the subject of the video and starts a story, an anecdote, ' +
      'a problem, a question, a joke or a "quick break" whose only purpose is to arrive at the sponsor;',
    '2. the pitch, where the sponsor or its product is named and described;',
    '3. the offer, with a link, discount code, free trial, QR code or "link in the description".',
    'The lead-in can last several minutes and can sound like normal content until the sponsor is named. ' +
      'It still belongs to the sponsor segment from its first line.'
  ].join(' '),
  not_a_sponsor_segment: [
    'The creator promoting their own merchandise, membership, Patreon, newsletter, courses or other videos.',
    'Asking viewers to like, comment, subscribe or share.',
    'Thanking viewers, patrons or the crew.',
    'Content that stays on the subject of the video.'
  ]
};

/** A client the pipeline can drive: the provider contract's one method. */
export interface PipelineClient {
  systemOne(request: CanonicalRequest): Promise<ProviderAnswer>;
}

export interface ProgressEvent {
  stage: string;
  [key: string]: unknown;
}

/** One scan request's answer, plus the window it came from. */
export interface Scan {
  index: number;
  lines: Line[];
  from: number;
  to: number;
  presence: number;
  pNone: number;
  startLineId: string | null;
  startLineProbability: number;
  estimatedStateTokens: number;
}

/** A scan without its transcript lines: what the result reports as `windows`. */
export interface ScanWindow extends Omit<Scan, 'lines'> {
  fromTimestamp?: string;
  toTimestamp?: string;
}

export interface PhraseCut {
  id: string;
  text: string;
  start: number;
  end: number;
  probability: number;
}

export interface SegmentBoundary {
  lineId: string;
  seconds: number;
  lineSeconds: number;
  text: string;
  probability: number;
  phrase: PhraseCut | null;
  runsPastExcerpt?: number;
  timestamp?: string;
}

export interface SegmentAnchor {
  lineId: string;
  seconds: number;
  text: string;
  probability: number;
}

export interface SponsorSegment {
  confidence: number;
  scanPresence: number;
  refinePresence: number;
  start: SegmentBoundary;
  anchor: SegmentAnchor;
  end: SegmentBoundary | null;
  lineIds: string[];
  context: Line[];
}

export type SponsorStatus = 'found' | 'uncertain' | 'not-found' | 'no-transcript';

export interface SponsorResult {
  status: SponsorStatus;
  confidence: number;
  start: SegmentBoundary | null;
  end: SegmentBoundary | null;
  context: Line[];
  segments: SponsorSegment[];
  windows: ScanWindow[];
  usage: Usage;
}

type Ask = (state: Record<string, unknown>, questions: Questions) => Promise<ProviderAnswer>;
type Report = (event: ProgressEvent) => void;

/** One scan request: "is a sponsor segment in here, and where is the sponsor named?" */
export function scanQuestions(lines: Line[]): Questions {
  const options: Record<string, string | null> = {};
  for (const line of lines) options[line.id] = null;
  options[NO_START] = 'No line in this excerpt names a sponsor, its product or its offer.';

  return {
    sponsor_starts_here: {
      type: 'noul',
      instructions: {
        question: 'Does a sponsor segment begin somewhere in this excerpt of the video transcript?',
        ...SPONSOR
      },
      criteria: {
        true: 'Somewhere in this excerpt the creator leaves the subject of the video and starts a sponsor segment: a lead-in, a pitch or an offer for a paying third party.',
        false: 'No sponsor segment begins in this excerpt. Either it is all regular content, or a sponsor segment that started before this excerpt is still running through it.'
      }
    },
    anchor_line: {
      type: 'choice',
      instructions: {
        question:
          'Which labelled line is the first line that names the sponsor, its product, or its offer? ' +
          'For example "thanks to X for sponsoring", "X is an app that", "today\'s video is brought to you by X", ' +
          'or a discount code or link for X. Choose the first such line, not the lead-in before it.',
        ...SPONSOR
      },
      criteria: options
    }
  };
}

/**
 * Refine, request one: confirm the segment, pin the line that names the
 * sponsor, and find the last line.
 */
export function anchorQuestions(lines: Line[]): Questions {
  const anchorOptions: Record<string, string | null> = {};
  for (const line of lines) anchorOptions[line.id] = null;
  anchorOptions[NO_START] = 'No line in this excerpt names a sponsor, its product or its offer.';

  const endOptions: Record<string, string | null> = {};
  for (const line of lines) endOptions[line.id] = null;
  endOptions[RUNS_PAST_EXCERPT] = 'The sponsor segment is still running at the end of this excerpt.';
  endOptions[NO_START] = 'This excerpt contains no sponsor segment.';

  return {
    has_sponsor: {
      type: 'noul',
      instructions: { question: 'Does this excerpt of the video transcript contain a sponsor segment?', ...SPONSOR },
      criteria: {
        true: 'A sponsor segment for a paying third party is in this excerpt: its lead-in, its pitch, its offer, or all three.',
        false: 'This excerpt is the video\'s own content with no sponsor segment in it.'
      }
    },
    anchor_line: {
      type: 'choice',
      instructions: {
        question:
          'Which labelled line is the first line that names the sponsor, its product, or its offer? ' +
          'Choose the first such line, not the lead-in before it.',
        ...SPONSOR
      },
      criteria: anchorOptions
    },
    end_line: {
      type: 'choice',
      instructions: {
        question:
          'Which labelled line is the LAST line of the sponsor segment: the final line of the pitch or the offer, ' +
          'after which the creator returns to the video\'s own content, signs off, or the video ends?',
        ...SPONSOR
      },
      criteria: endOptions
    }
  };
}

/**
 * Refine, request two: with the naming line known and in the state, read
 * backwards for the first line of the lead-in.
 */
export function startQuestions(lines: Line[]): Questions {
  const options: Record<string, string | null> = {};
  for (const line of lines) options[line.id] = null;

  return {
    start_line: {
      type: 'choice',
      instructions: {
        question:
          'The sponsor is named on the line given in `sponsor_named_at`. Reading backwards from that line, ' +
          'which labelled line is the FIRST line of the sponsor segment: the moment the creator leaves the ' +
          'subject of the video (`video_title`) and begins the lead-in that ends at the sponsor?',
        rules: [
          'The lead-in belongs to the sponsor segment from its first line, even when it sounds like a personal story, an anecdote, a problem or a question and the sponsor is only named minutes later.',
          'A lead-in exists to arrive at the sponsor: the story, problem or question it raises is what the sponsor answers.',
          'Lines that are still about the subject of the video are not part of the sponsor segment, even the ones immediately before it.',
          'Wrapping up the video, thanking hosts, guests, crew or viewers, and a closing call for comments, likes or subscriptions belong to the video, not to the sponsor segment, even right before the sponsor is named.',
          'If there is no lead-in and the segment opens by naming the sponsor, choose the line given in `sponsor_named_at`.'
        ],
        ...SPONSOR
      },
      criteria: options
    }
  };
}

/**
 * Cut pass: the lines at a boundary split into phrases of a few words, and
 * one noul per phrase: is this phrase part of the sponsor segment? Asking per
 * phrase rather than "which phrase is first" keeps each judgment narrow, and
 * the answers read as a profile that code cuts at (see cutPoint).
 */
export function cutQuestions(phrases: Phrase[]): Questions {
  const questions: Questions = {};
  for (const phrase of phrases) {
    questions[phrase.id] = {
      type: 'noul',
      instructions: {
        question:
          `Does phrase ${phrase.id} in \`phrases\` belong to the sponsor segment rather than to the video's own content? ` +
          'The phrases are consecutive pieces of the transcript, a few words each; `before` and `after` are the ' +
          'surrounding transcript, and the sponsor is named at `sponsor_named_at_text`.',
        ...SPONSOR
      },
      criteria: {
        true: `Phrase ${phrase.id} is part of the sponsor segment: its lead-in, its pitch or its offer.`,
        false: `Phrase ${phrase.id} is the video's own content: on the subject of the video (\`video_title\`), a hand-back like "now back to the video", a sign-off, or a call to like, comment or subscribe.`
      }
    };
  }
  return questions;
}

function bestLabel(probabilities: Record<string, number>, allowed: Set<string>): { id: string | null; probability: number } {
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

/** Most sponsor reads a single video is allowed to have; a loop guard as much as a limit. */
const MAX_SEGMENTS = 6;
/** Lines masked after a start when the refine pass could not find the end. */
const BLIND_MASK_LINES = 12;

export interface FindOptions {
  client: PipelineClient;
  model?: string;
  title?: string;
  thresholds?: Partial<Thresholds>;
  onProgress?: Report;
}

/**
 * Locate every sponsor segment in an already-built line index.
 *
 * Videos often carry more than one read, and two can sit in the same scan
 * window. So after each segment is confirmed, its lines are removed from the
 * window it came from and that window is scanned again; the loop ends when no
 * window still looks like it has a sponsor read starting in it.
 */
export async function findSponsorSegment(lines: Line[], opts: FindOptions): Promise<SponsorResult> {
  const client = opts?.client;
  if (!client) throw new Error('findSponsorSegment needs a client with systemOne()');
  const model = opts.model;
  const title = opts.title ?? 'unknown';
  const limits: Thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const report: Report = opts.onProgress ?? (() => {});

  if (!lines.length) {
    return {
      status: 'no-transcript',
      confidence: 0,
      start: null,
      end: null,
      context: [],
      segments: [],
      windows: [],
      usage: { input_tokens: 0, output_tokens: 0 }
    };
  }

  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  const track = (result: ProviderAnswer) => {
    usage.input_tokens += result.usage?.input_tokens ?? 0;
    usage.output_tokens += result.usage?.output_tokens ?? 0;
    return result;
  };

  const ask: Ask = async (state, questions) => {
    const request: CanonicalRequest = { state, questions };
    if (model) request.model = model;
    return track(await client.systemOne(request));
  };

  const scan = async (window: Line[], index: number, total: number): Promise<Scan> => {
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
  };

  // Stage 1: every window scanned in parallel.
  const windows = windowLines(lines);
  report({ stage: 'scan', windows: windows.length });
  const scans = await Promise.all(windows.map((w, i) => scan(w, i, windows.length)));
  const scanLog: ScanWindow[] = scans.map(summarise);

  // Stage 2: confirm the strongest candidate, mask it out, rescan its window,
  // repeat until nothing is left that looks like a sponsor read.
  const segments: SponsorSegment[] = [];
  const taken = new Set<string>(); // line ids already inside a confirmed segment

  while (segments.length < MAX_SEGMENTS) {
    // A window is worth refining when either answer says so: the noul, or a
    // choice that puts little weight on "none" (a read without the usual
    // "sponsored by" wording can score low on the first and high on the
    // second). The refine pass's own noul then confirms or rejects it.
    const candidates = scans.filter(
      (s) => looksLikeSponsor(s) >= limits.maybe && s.startLineId && !taken.has(s.startLineId)
    );
    if (!candidates.length) break;
    const winner = candidates.reduce((a, b) => (looksLikeSponsor(b) > looksLikeSponsor(a) ? b : a));

    const segment = await refine(winner, lines, taken, ask, report, title, limits);
    if (segment) {
      segments.push(segment);
      for (const id of segment.lineIds) taken.add(id);
    }

    // Rescan this window without the lines just claimed. A rescan also happens
    // when the refine pass rejected the candidate, so the loop cannot spin.
    const remaining = winner.lines.filter((l) => !taken.has(l.id));
    if (!segment || remaining.length < 3) {
      winner.presence = 0;
      winner.pNone = 1;
      continue;
    }
    const rescan = await scan(remaining, winner.index, windows.length);
    scanLog.push(summarise(rescan));
    Object.assign(winner, rescan);
  }

  segments.sort((a, b) => a.start.seconds - b.start.seconds);
  const best = segments.reduce<SponsorSegment | null>(
    (a, b) => (!a || b.confidence > a.confidence ? b : a),
    null
  );
  const status: SponsorStatus = !segments.length
    ? 'not-found'
    : segments.some((s) => s.confidence >= limits.found)
      ? 'found'
      : 'uncertain';

  return {
    status,
    // The strongest segment, kept at the top level for callers that want one answer.
    confidence: best?.confidence ?? Math.max(0, ...scans.map((s) => s.presence)),
    start: segments[0]?.start ?? null,
    end: segments[0]?.end ?? null,
    context: segments[0]?.context ?? [],
    segments,
    windows: scanLog,
    usage
  };
}

/**
 * Pin down one candidate. Two requests: the first confirms the segment and
 * finds the line naming the sponsor and the last line; the second, with that
 * naming line written into the state, reads backwards for the first line of
 * the lead-in. Returns null when the refine pass rejects the candidate.
 */
async function refine(
  winner: Scan,
  lines: Line[],
  taken: Set<string>,
  ask: Ask,
  report: Report,
  title: string,
  limits: Thresholds
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

  const startIndex = slice.indexOf(startLine);
  const endIndex = endOk ? slice.indexOf(endLine as Line) : Math.min(slice.length - 1, anchorIndex + BLIND_MASK_LINES);
  const lineIds = slice.slice(startIndex, endIndex + 1).map((l) => l.id);

  // Third request(s): where inside the first and last lines the segment
  // really begins and ends. Both edges are independent, so they run together.
  report({ stage: 'cut' });
  let [startCut, endCut] = await Promise.all([
    cut(lines, startLine, 'start', ask, title, anchorLine, limits),
    endOk ? cut(lines, endLine as Line, 'end', ask, title, anchorLine, limits) : null
  ]);
  // A read of a few words can end up with its end cut before its start (no
  // phrase was surely sponsor); the line-level end stands then.
  if (endCut && endCut.seconds <= (startCut?.seconds ?? startLine.start)) endCut = null;

  return {
    confidence: Math.min(looksLikeSponsor(winner), presence),
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

/**
 * The cut pass for one edge: split the boundary line and its neighbours into
 * phrases, ask which phrases are sponsor, and cut where the answers say the
 * segment begins or ends. Returns null when the answers give no cut, in which
 * case the line-level boundary stands.
 */
async function cut(
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

function looksLikeSponsor(scan: Scan): number {
  return Math.max(scan.presence, 1 - scan.pNone);
}

function summarise(scan: Scan): ScanWindow {
  const { lines: _lines, ...rest } = scan;
  return rest;
}
