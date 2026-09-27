// Run the pipeline on a real video from the command line, printing every
// segment with the lines around its boundaries, so the questions can be
// judged against real videos.
//
//   MODEL_URL=http://localhost:8000 MODEL_API_KEY=... node scripts/analyze.ts <url>
//   node scripts/analyze.ts --transcript path/to/pasted-transcript.txt
//
// Add --json to dump the full result, --verbose to print every scan window.
// Point MODEL_URL at a local Jev-compatible server to run without a key.

import { readFile } from 'node:fs/promises';

import { parseVideoId, fetchTranscript, parsePastedTranscript } from '../src/youtube.js';
import { buildLines, formatTimestamp, type Cue } from '../src/transcript.js';
import { findSponsorSegment } from '../src/jev.js';
import { providerFromEnv } from '../src/providers/index.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string): string | null => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const target = args.find((a) => !a.startsWith('--') && a !== opt('--transcript') && a !== opt('--title'));

const provider = providerFromEnv();
if (!provider.hasKey) {
  console.error(`No API key for ${provider.label}. Set MODEL_API_KEY, or point MODEL_URL at a local server.`);
  process.exit(1);
}

let cues: Cue[];
let title = opt('--title') ?? 'unknown';
const transcriptFile = opt('--transcript');
if (transcriptFile) {
  cues = parsePastedTranscript(await readFile(transcriptFile, 'utf8'));
} else {
  const videoId = parseVideoId(target ?? '');
  if (!videoId) {
    console.error('Give a YouTube link, or --transcript <file>.');
    process.exit(1);
  }
  ({ cues, title } = await fetchTranscript(videoId));
}

const lines = buildLines(cues);
console.log(`${title}\n${lines.length} lines, ${formatTimestamp(lines.at(-1)!.end)} long\n`);

const started = Date.now();
const result = await findSponsorSegment(lines, {
  client: provider,
  model: provider.model,
  title,
  thresholds: provider.thresholds,
  onProgress: (e) => {
    if (flag('--verbose')) console.log('  ', JSON.stringify(e));
  }
});

if (flag('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`status: ${result.status}   confidence: ${result.confidence.toFixed(2)}   ` +
  `${result.usage.input_tokens.toLocaleString()} input tokens   ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

if (flag('--verbose')) {
  for (const w of result.windows) {
    console.log(`window ${w.index}  ${formatTimestamp(w.from)}–${formatTimestamp(w.to)}  begins-here ${w.presence.toFixed(2)}  anchor ${w.startLineId ?? '-'} (${w.startLineProbability?.toFixed(2)})`);
  }
  console.log();
}

result.segments.forEach((seg, i) => {
  const end = seg.end ? formatTimestamp(seg.end.seconds) : '?';
  console.log(`segment ${i + 1}: ${formatTimestamp(seg.start.seconds)} – ${end}   confidence ${seg.confidence.toFixed(2)}`);
  console.log(`  start  ${seg.start.lineId} p=${seg.start.probability.toFixed(2)}`);
  console.log(`  named  ${seg.anchor.lineId} p=${seg.anchor.probability.toFixed(2)}  ${formatTimestamp(seg.anchor.seconds)}`);
  if (seg.end) console.log(`  end    ${seg.end.lineId} p=${seg.end.probability.toFixed(2)}`);

  const ids = new Set(seg.lineIds);
  const endLineId = seg.end?.lineId;
  const show = seg.context.filter((l) => {
    const i = seg.context.indexOf(l);
    const s = seg.context.findIndex((x) => x.id === seg.start.lineId);
    const e = endLineId ? seg.context.findIndex((x) => x.id === endLineId) : s + 3;
    return (i >= s - 4 && i <= s + 3) || (i >= e - 2 && i <= e + 3);
  });
  let last: (typeof seg.context)[number] | null = null;
  for (const l of show) {
    if (last && seg.context.indexOf(l) - seg.context.indexOf(last) > 1) console.log('       …');
    const mark = l.id === seg.start.lineId ? '▶' : l.id === seg.anchor.lineId ? '★' : ids.has(l.id) ? '│' : ' ';
    console.log(`  ${mark} ${formatTimestamp(l.start).padStart(7)}  ${l.text.slice(0, 110)}`);
    last = l;
  }
  console.log();
});
if (!result.segments.length) console.log('No sponsor segment found.');
