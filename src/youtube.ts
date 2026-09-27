// Getting a transcript, and getting a video ID out of whatever gets pasted.

import { Innertube } from 'youtubei.js';
import type { Cue } from './transcript.js';

export interface CaptionTrack {
  language_code?: string;
  kind?: string;
  base_url: string;
}

export interface Json3Segment {
  utf8?: string;
  tOffsetMs?: number;
}

export interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Segment[];
}

export interface Json3Data {
  events?: Json3Event[];
}

export interface FetchedTranscript {
  title: string;
  cues: Cue[];
  route: string;
}

/**
 * Accepts a full URL, a share link, an embed link, or a bare ID.
 */
export function parseVideoId(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  if (/^[\w-]{11}$/.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') return clean(url.pathname.slice(1));
  if (!/(^|\.)youtube\.com$/.test(host) && host !== 'youtube-nocookie.com') return null;

  const v = url.searchParams.get('v');
  if (v) return clean(v);

  const path = url.pathname.split('/').filter(Boolean);
  if (['embed', 'shorts', 'live', 'v'].includes(path[0])) return clean(path[1]);
  return null;
}

function clean(id: string | null | undefined): string | null {
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

let innertube: Innertube | undefined;

/**
 * Fetch a video's transcript from YouTube.
 *
 * Two routes, tried in order, because neither is reliable on its own:
 *  1. the caption tracks in the player response, fetched as json3 (the same
 *     files the player uses for subtitles);
 *  2. the transcript panel behind YouTube's own "Show transcript" button.
 */
export async function fetchTranscript(videoId: string): Promise<FetchedTranscript> {
  innertube ??= await Innertube.create({ generate_session_locally: true });

  const info = await innertube.getInfo(videoId);
  const title = info.basic_info?.title ?? videoId;
  const failures: string[] = [];

  for (const client of ['WEB', 'ANDROID'] as const) {
    try {
      const source = client === 'WEB' ? info : await innertube.getBasicInfo(videoId, { client });
      const tracks = (source.captions?.caption_tracks ?? []) as CaptionTrack[];
      const track = pickCaptionTrack(tracks);
      if (!track) throw new Error(`no caption tracks in the ${client} player response`);
      const cues = await fetchCaptionTrack(track.base_url);
      if (cues.length) return { title, cues, route: `captions/${client}` };
      throw new Error(`caption track "${track.language_code}" came back empty`);
    } catch (error) {
      failures.push(`captions via ${client}: ${(error as Error).message}`);
    }
  }

  try {
    const transcript = (await info.getTranscript()) as any;
    const segments = transcript?.transcript?.content?.body?.initial_segments ?? [];
    const cues: Cue[] = segments
      .filter((s: any) => s.start_ms !== undefined && s.snippet)
      .map((s: any) => ({
        text: s.snippet.text ?? '',
        startMs: Number(s.start_ms),
        endMs: Number(s.end_ms ?? s.start_ms)
      }))
      .filter((c: Cue) => c.text.trim() && Number.isFinite(c.startMs));
    if (cues.length) return { title, cues, route: 'transcript-panel' };
    failures.push('transcript panel: no segments');
  } catch (error) {
    failures.push(`transcript panel: ${(error as Error).message}`);
  }

  // Cloud and datacenter addresses get "sign in to confirm you're not a bot"
  // from the player endpoint, which hides the caption tracks. An Invidious
  // instance serves the same tracks as WebVTT, so try one before giving up.
  try {
    const cues = await fetchViaInvidious(videoId);
    if (cues.length) return { title: title === videoId ? await fetchTitle(videoId) : title, cues, route: 'invidious' };
    failures.push('invidious: no cues');
  } catch (error) {
    failures.push(`invidious: ${(error as Error).message}`);
  }

  throw new TranscriptUnavailable(
    'YouTube returned no transcript for this video. It may have captions turned off.',
    { cause: failures.join(' | ') }
  );
}

/** Invidious instances to try, in order. Override with INVIDIOUS_INSTANCES=a,b,c */
const INVIDIOUS_INSTANCES = (process.env.INVIDIOUS_INSTANCES ?? 'https://inv.nadeko.net')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

async function fetchViaInvidious(videoId: string): Promise<Cue[]> {
  const errors: string[] = [];
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const body = await fetchTextWithRetry(`${base}/api/v1/captions/${videoId}`, (t) => t.trimStart().startsWith('{'));
      const tracks: CaptionTrack[] = (JSON.parse(body).captions ?? []).map((t: any) => ({
        language_code: t.languageCode ?? t.language_code,
        kind: /auto-generated/i.test(t.label ?? '') ? 'asr' : undefined,
        base_url: `${base}${t.url}`
      }));
      const track = pickCaptionTrack(tracks);
      if (!track) throw new Error('no caption tracks');
      const vtt = await fetchTextWithRetry(track.base_url, (t) => t.startsWith('WEBVTT'));
      return parseVtt(vtt);
    } catch (error) {
      errors.push(`${base}: ${(error as Error).message}`);
    }
  }
  throw new Error(errors.join('; '));
}

/** Public instances answer 502 or an empty body now and then; try a few times. */
async function fetchTextWithRetry(
  url: string,
  looksRight: (text: string) => boolean,
  attempts = 4
): Promise<string> {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000 * i));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (res.ok && looksRight(text)) return text;
      last = `${res.status} ${text.slice(0, 40).replace(/\s+/g, ' ')}`;
    } catch (error) {
      last = (error as Error).message;
    }
  }
  throw new Error(`${url.split('?')[0]} kept failing (${last})`);
}

/**
 * Parse WebVTT into cues. Only the cue timing line and its text matter.
 */
export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = vtt.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->').map((s) => vttSeconds(s.trim().split(' ')[0]));
    const text = lines.slice(at + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text || !Number.isFinite(from)) continue;
    cues.push({ text, startMs: Math.round(from * 1000), endMs: Math.round((Number.isFinite(to) ? to : from) * 1000) });
  }
  return cues;
}

function vttSeconds(stamp: string): number {
  const parts = stamp.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

/** The title through oEmbed, which is not behind the bot check. */
async function fetchTitle(videoId: string): Promise<string> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) return (await res.json()).title ?? videoId;
  } catch {}
  return videoId;
}

/** Prefer a human-made English track, then auto-generated English, then whatever is first. */
export function pickCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (!tracks.length) return null;
  const english = tracks.filter((t) => /^en\b/i.test(t.language_code ?? ''));
  return english.find((t) => t.kind !== 'asr') ?? english[0] ?? tracks[0];
}

async function fetchCaptionTrack(baseUrl: string): Promise<Cue[]> {
  const url = new URL(baseUrl);
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`timedtext responded ${response.status}`);
  const body = await response.text();
  if (!body.trim()) throw new Error('timedtext responded with an empty body');
  return parseJson3(JSON.parse(body));
}

/**
 * Parse YouTube's json3 caption format into cues. Auto-generated tracks time
 * every word (`tOffsetMs` on each segment); those offsets are kept on the cue
 * as `words`, so a boundary can land on a word instead of a whole cue.
 */
export function parseJson3(data: Json3Data): Cue[] {
  const cues: Cue[] = [];
  for (const event of data?.events ?? []) {
    if (!event.segs) continue;
    const text = event.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const startMs = Number(event.tStartMs ?? 0);
    const cue: Cue = { text, startMs, endMs: startMs + Number(event.dDurationMs ?? 0) };
    // The first word of an event carries no tOffsetMs: it starts with the event.
    const words = event.segs
      .filter((s) => (s.utf8 ?? '').trim())
      .map((s) => ({ text: (s.utf8 as string).trim(), offsetMs: Number(s.tOffsetMs ?? 0) }));
    if (words.length > 1 && words.some((w) => w.offsetMs > 0)) cue.words = words;
    cues.push(cue);
  }
  return cues;
}

export class TranscriptUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranscriptUnavailable';
  }
}

/**
 * Parse a transcript pasted from YouTube's own "Show transcript" panel:
 * a timestamp line followed by text, or "0:42 text" on one line.
 * Untimed text still works; it just gets evenly spaced seconds.
 */
export function parsePastedTranscript(text: string | null | undefined): Cue[] {
  const rows = (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const cues: { text: string; startMs: number | null }[] = [];
  let pending: number | null = null;

  for (const row of rows) {
    const inline = row.match(/^(?:\[)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?\s+(.*)$/);
    const alone = row.match(/^(?:\[)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?$/);

    if (alone) {
      pending = toSeconds(alone[1]);
    } else if (inline) {
      push(cues, toSeconds(inline[1]), inline[2]);
      pending = null;
    } else if (pending !== null) {
      push(cues, pending, row);
      pending = null;
    } else {
      push(cues, null, row);
    }
  }

  // Fill in times for untimed rows so lines still carry a position.
  const APPROX_SECONDS_PER_ROW = 4;
  cues.forEach((cue, i) => {
    if (cue.startMs === null) cue.startMs = i * APPROX_SECONDS_PER_ROW * 1000;
  });
  return cues.map((cue, i) => ({
    text: cue.text,
    startMs: cue.startMs as number,
    endMs: cues[i + 1]?.startMs ?? (cue.startMs as number) + APPROX_SECONDS_PER_ROW * 1000
  }));
}

function push(cues: { text: string; startMs: number | null }[], seconds: number | null, text: string): void {
  if (!text.trim()) return;
  cues.push({ text: text.trim(), startMs: seconds === null ? null : seconds * 1000 });
}

function toSeconds(stamp: string): number {
  const parts = stamp.split(':').map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}
