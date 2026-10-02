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
// This file is the entry point and the loop that drives the passes; ./scan.ts,
// ./refine.ts and ./cut.ts are those passes. The questions they ask live in
// ./prompts.ts.
//
// Nothing here asks Jev for a number: it names a line or phrase ID and code
// reads the timestamp off it.
//
// The folder has no dependencies beyond ./transcript.ts and the provider
// contract, so the Chrome extension can run the same pipeline: pass any
// `client` with a `systemOne(request)`.

import { windowLines, type Line } from '../transcript.js';
import { type CanonicalRequest, type ProviderAnswer, type Usage } from '../providers/contract.js';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds.js';
import { looksLikeSponsor, scanWindow } from './scan.js';
import { refine } from './refine.js';
import {
  type Ask,
  type FindOptions,
  type Report,
  type Scan,
  type ScanWindow,
  type SponsorResult,
  type SponsorSegment,
  type SponsorStatus
} from './types.js';

/** Most sponsor reads a single video is allowed to have; a loop guard as much as a limit. */
const MAX_SEGMENTS = 6;

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

  // Stage 1: every window scanned in parallel.
  const windows = windowLines(lines);
  report({ stage: 'scan', windows: windows.length });
  const scans = await Promise.all(windows.map((w, i) => scanWindow(w, i, windows.length, ask, title, report)));
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
    const rescan = await scanWindow(remaining, winner.index, windows.length, ask, title, report);
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

function summarise(scan: Scan): ScanWindow {
  const { lines: _lines, ...rest } = scan;
  return rest;
}
