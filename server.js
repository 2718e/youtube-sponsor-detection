// Sponsor-skip demo server. The model configuration stays here, server-side:
// the browser only ever talks to this process.

import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseVideoId, fetchTranscript, parsePastedTranscript, TranscriptUnavailable } from './src/youtube.js';
import { buildLines, formatTimestamp } from './src/transcript.js';
import { findSponsorSegment } from './src/jev.js';
import { providerFromEnv } from './src/providers/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(here, 'public')));

// One provider for the process: it holds the URL, key, model and timeouts.
// Point MODEL_URL at api.typesafe.ai or at a local Jev-compatible server.
const provider = providerFromEnv();
const ready = provider.hasKey;

app.get('/api/health', (_req, res) => {
  res.json({
    ready,
    provider: { protocol: provider.protocol, label: provider.label, url: provider.url, model: provider.model ?? null, isLocal: provider.isLocal }
  });
});

app.post('/api/analyze', async (req, res) => {
  const { url, transcript } = req.body ?? {};

  if (!ready) {
    return res.status(503).json({
      error: `No API key for ${provider.label}. Set MODEL_API_KEY in .env and restart the server.`
    });
  }

  try {
    const source = await loadTranscript({ url, transcript });
    const lines = buildLines(source.cues);
    if (!lines.length) return res.status(422).json({ error: 'That transcript came back empty.' });

    const started = Date.now();
    const result = await findSponsorSegment(lines, { client: provider, model: provider.model, title: source.title, thresholds: provider.thresholds });

    res.json({
      video: { id: source.videoId, title: source.title, source: source.kind },
      transcript: { lines: lines.length, seconds: lines[lines.length - 1].end },
      result: decorate(result),
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    if (error instanceof TranscriptUnavailable) {
      if (error.cause) console.warn(`transcript unavailable: ${error.cause}`);
      return res.status(422).json({ error: error.message, detail: error.cause ?? null, canPaste: true });
    }
    console.error(error);
    res.status(500).json({ error: error?.message ?? 'Something went wrong.' });
  }
});

async function loadTranscript({ url, transcript }) {
  if (typeof transcript === 'string' && transcript.trim()) {
    const cues = parsePastedTranscript(transcript);
    if (!cues.length) throw new TranscriptUnavailable('That pasted transcript had no readable lines.');
    return { cues, videoId: parseVideoId(url), title: 'Pasted transcript', kind: 'pasted' };
  }

  if (url === 'demo') {
    const fixture = JSON.parse(await readFile(path.join(here, 'fixtures/demo-transcript.json'), 'utf8'));
    return { cues: fixture.cues, videoId: null, title: fixture.title, kind: 'demo' };
  }

  const videoId = parseVideoId(url);
  if (!videoId) throw new TranscriptUnavailable('That does not look like a YouTube link.');

  const { title, cues } = await fetchTranscript(videoId);
  return { cues, videoId, title, kind: 'youtube' };
}

/** Add the human-readable timestamps; the model never sees or produces these. */
function decorate(result) {
  if (result.start) result.start.timestamp = formatTimestamp(result.start.seconds);
  if (result.end) result.end.timestamp = formatTimestamp(result.end.seconds);
  for (const seg of result.segments ?? []) {
    seg.start.timestamp = formatTimestamp(seg.start.seconds);
    if (seg.end) seg.end.timestamp = formatTimestamp(seg.end.seconds);
  }
  for (const w of result.windows ?? []) {
    w.fromTimestamp = formatTimestamp(w.from);
    w.toTimestamp = formatTimestamp(w.to);
  }
  return result;
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Sponsor skip demo on http://localhost:${port}`);
  console.log(`Model: ${provider.label} at ${provider.endpoint}${provider.model ? ` (${provider.model})` : ''}`);
  if (!ready) console.log(`No API key for ${provider.label} — set MODEL_API_KEY in .env before analysing a video.`);
});
