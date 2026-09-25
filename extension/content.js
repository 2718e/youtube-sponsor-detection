// Runs on youtube.com. Gets the captions for the current video, hands them to
// the background worker for the configured model, then draws the panel and
// does the skipping. Which model answers is the worker's business: this script
// only ever sees the timestamps it returns.

const PANEL_ID = 'sponsor-skip-panel';
const MARKER_CLASS = 'sponsor-skip-marker';

const state = {
  videoId: null,
  title: null,
  analysis: null, // { result, usage, cost, cached, requests, elapsedMs }
  settings: null,
  provider: null,
  stats: null,
  skipped: new Set(), // segment indices already skipped on this video
  paused: false, // user hit undo: no more auto-skips on this video
  busy: false,
  error: null,
  errorDetail: null // which caption routes failed and how, shown under the error
};

// ---- lifecycle ------------------------------------------------------------

document.addEventListener('yt-navigate-finish', () => onNavigate());
window.addEventListener('load', () => onNavigate());
setInterval(() => {
  if (currentVideoId() !== state.videoId) onNavigate();
}, 1500);
onNavigate();

document.addEventListener('timeupdate', onTimeUpdate, true);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  state.settings = changes.settings.newValue;
  render();
});

function currentVideoId() {
  if (location.pathname !== '/watch') return null;
  return new URLSearchParams(location.search).get('v');
}

async function onNavigate() {
  const videoId = currentVideoId();
  if (videoId === state.videoId) return;

  state.videoId = videoId;
  state.analysis = null;
  state.error = null;
  state.errorDetail = null;
  state.skipped = new Set();
  state.paused = false;
  removeMarkers();

  if (!videoId) {
    document.getElementById(PANEL_ID)?.remove();
    return;
  }

  await refreshState();
  render();
  analyze(false);
}

async function refreshState() {
  const response = await send({ type: 'get-state' });
  if (response?.ok) {
    state.settings = response.settings;
    state.provider = response.provider;
    state.stats = response.stats;
  }
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response);
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

// ---- analysis -------------------------------------------------------------

async function analyze(force) {
  const videoId = state.videoId;
  if (!videoId || state.busy) return;
  state.busy = true;
  state.error = null;
  state.errorDetail = null;
  render();

  try {
    const { cues, title } = await getCaptions(videoId);
    if (videoId !== state.videoId) return;
    state.title = title;

    const response = await send({ type: 'analyze', videoId, title, cues, force });
    if (videoId !== state.videoId) return;
    if (!response.ok) throw new Error(response.error);

    state.analysis = response;
    state.settings = response.settings ?? state.settings;
    await refreshState();
    drawMarkers();
  } catch (error) {
    state.error = error.message;
    state.errorDetail = error.detail ?? null;
  } finally {
    if (videoId === state.videoId) {
      state.busy = false;
      render();
    }
  }
}

/**
 * Captions for the video, from whichever route YouTube still serves:
 *  1. the caption track from the live player (or the watch page HTML), fetched as json3;
 *  2. the caption track the ANDROID client is given, which needs no token;
 *  3. the transcript panel behind YouTube's own "Show transcript" button,
 *     requested from the page itself with the page's cookies and signature;
 *  4. the same panel, requested anonymously from this content script.
 *
 * Route 1 is the same file the player uses for subtitles, but YouTube now
 * answers those URLs with an empty 200 unless the request carries a
 * proof-of-origin token the player generates internally. The others are the
 * routes transcript tools fell back to when that started.
 */
async function getCaptions(videoId) {
  let tracks = null;
  let title = null;
  let innertube = null;

  for (let attempt = 0; attempt < 6 && !tracks; attempt++) {
    const answer = await askPage();
    innertube ??= answer?.innertube ?? null;
    if (answer?.videoId === videoId && answer.tracks?.length) {
      tracks = answer.tracks;
      title = answer.title;
    } else {
      await sleep(500);
    }
  }

  if (!tracks) {
    const html = await (await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { credentials: 'include' })).text();
    const player = extractPlayerResponse(html);
    tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null;
    title = player?.videoDetails?.title ?? title;
    innertube ??= extractInnertubeConfig(html);
  }

  title ??= document.title.replace(/ - YouTube$/, '');
  const failures = [];

  const track = pickCaptionTrack(tracks ?? []);
  const routes = [
    ['caption file', () => (track ? fetchCaptionTrack(track.baseUrl) : Promise.reject(new Error('no caption tracks in the player response')))],
    ['android captions', () => fetchAndroidCaptions(videoId)],
    ['transcript panel (page)', () => fetchTranscriptPanelViaPage(videoId)],
    ['transcript panel', () => fetchTranscriptPanel(videoId, innertube)]
  ];
  for (const [name, run] of routes) {
    try {
      const cues = await run();
      if (cues.length) return { cues, title };
      failures.push(`${name}: no text`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }

  const detail = failures.join(' | ');
  console.warn('[sponsor-skip] no transcript:', detail);
  const error = new Error(
    track
      ? 'YouTube would not hand over the transcript for this video. Try again in a moment.'
      : 'This video has no captions, so there is no transcript to read.'
  );
  error.detail = detail;
  throw error;
}

async function fetchCaptionTrack(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`YouTube captions responded ${response.status}.`);
  const text = await response.text();
  if (!text.trim()) throw new Error('YouTube returned an empty caption file.');
  return parseJson3(JSON.parse(text));
}

// ---- android captions -----------------------------------------------------

/**
 * The ANDROID client's player response carries caption URLs that YouTube still
 * serves without a proof-of-origin token (the route youtube-transcript-api uses).
 */
async function fetchAndroidCaptions(videoId) {
  const context = { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en' } };
  const player = await innertubeCall('player', { videoId }, { apiKey: null, context }, { clientName: '3' });
  const status = player?.playabilityStatus;
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = pickCaptionTrack(tracks);
  if (!track) throw new Error(status?.reason ?? status?.status ?? 'no caption tracks');
  return fetchCaptionTrack(track.baseUrl);
}

// ---- transcript panel -----------------------------------------------------

const INNERTUBE_FALLBACK = {
  apiKey: null,
  context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } }
};

/**
 * The transcript panel is two InnerTube calls: `next` gives the panel's
 * `getTranscriptEndpoint.params` for this video, `get_transcript` returns the
 * segments. Cookies are left out on purpose: with them, YouTube demands the
 * signed Authorization header the page adds, and answers 401 without it.
 */
async function fetchTranscriptPanel(videoId, innertube) {
  const config = innertube?.context ? innertube : INNERTUBE_FALLBACK;
  const next = await innertubeCall('next', { videoId }, config);
  const params = findTranscriptParams(next);
  if (!params) throw new Error('no transcript panel for this video');

  const data = await innertubeCall('get_transcript', { params }, config);
  return cuesFromTranscriptSegments(findKey(data, 'transcriptSegmentListRenderer')?.initialSegments ?? []);
}

/** The same two calls, made by the page bridge as the page itself would make them. */
async function fetchTranscriptPanelViaPage(videoId) {
  const answer = await askPageTranscript(videoId);
  if (!answer) throw new Error('page did not answer');
  if (answer.error) throw new Error(answer.error);
  return cuesFromTranscriptSegments(answer.segments ?? []);
}

function cuesFromTranscriptSegments(segments) {
  const cues = [];
  for (const item of segments) {
    const seg = item.transcriptSegmentRenderer;
    if (!seg?.snippet) continue;
    const text = (seg.snippet.runs ?? [])
      .map((r) => r.text ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    const startMs = Number(seg.startMs);
    if (!text || !Number.isFinite(startMs)) continue;
    cues.push({ text, startMs, endMs: Number(seg.endMs ?? seg.startMs) });
  }
  return cues;
}

async function innertubeCall(endpoint, body, config, headers = {}) {
  const url = new URL(`https://www.youtube.com/youtubei/v1/${endpoint}`);
  url.searchParams.set('prettyPrint', 'false');
  if (config.apiKey) url.searchParams.set('key', config.apiKey);
  const client = config.context.client ?? {};
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'content-type': 'application/json',
      'x-youtube-client-name': headers.clientName ?? '1',
      'x-youtube-client-version': client.clientVersion ?? INNERTUBE_FALLBACK.context.client.clientVersion
    },
    body: JSON.stringify({ context: config.context, ...body })
  });
  if (!response.ok) throw new Error(`${endpoint} responded ${response.status}`);
  return response.json();
}

function findTranscriptParams(next) {
  for (const panel of next?.engagementPanels ?? []) {
    const endpoint = findKey(panel, 'getTranscriptEndpoint');
    if (endpoint?.params) return endpoint.params;
  }
  return findKey(next, 'getTranscriptEndpoint')?.params ?? null;
}

/** Depth-first search for the first object stored under `key`. */
function findKey(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findKey(item, key, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (node[key] && typeof node[key] === 'object') return node[key];
  for (const value of Object.values(node)) {
    const found = findKey(value, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractInnertubeConfig(html) {
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? null;
  const at = html.indexOf('"INNERTUBE_CONTEXT":');
  if (at < 0) return null;
  const context = extractJsonObject(html, html.indexOf('{', at));
  return context ? { apiKey: key, context } : null;
}

function askPageTranscript(videoId) {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, 15000);
    function onMessage(event) {
      if (event.source !== window || event.data?.type !== 'sponsor-skip:transcript' || event.data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'sponsor-skip:get-transcript', requestId, videoId }, '*');
  });
}

function askPage() {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, 800);
    function onMessage(event) {
      if (event.source !== window || event.data?.type !== 'sponsor-skip:captions' || event.data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'sponsor-skip:get-captions', requestId }, '*');
  });
}

function extractPlayerResponse(html) {
  const at = html.indexOf('ytInitialPlayerResponse');
  if (at < 0) return null;
  return extractJsonObject(html, html.indexOf('{', at));
}

/** Parse the JSON object that opens at `open`, tracking braces through strings. */
function extractJsonObject(html, open) {
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function pickCaptionTrack(tracks) {
  if (!tracks.length) return null;
  const english = tracks.filter((t) => /^en\b/i.test(t.languageCode ?? ''));
  return english.find((t) => t.kind !== 'asr') ?? english[0] ?? tracks[0];
}

// Same as parseJson3 in src/youtube.js: auto-generated tracks time every
// word, and those offsets let a skip land on a word instead of a whole cue.
function parseJson3(data) {
  const cues = [];
  for (const event of data?.events ?? []) {
    if (!event.segs) continue;
    const text = event.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const startMs = Number(event.tStartMs ?? 0);
    const cue = { text, startMs, endMs: startMs + Number(event.dDurationMs ?? 0) };
    // The first word of an event carries no tOffsetMs: it starts with the event.
    const words = event.segs
      .filter((s) => (s.utf8 ?? '').trim())
      .map((s) => ({ text: s.utf8.trim(), offsetMs: Number(s.tOffsetMs ?? 0) }));
    if (words.length > 1 && words.some((w) => w.offsetMs > 0)) cue.words = words;
    cues.push(cue);
  }
  return cues;
}

// ---- skipping -------------------------------------------------------------

function segments() {
  return state.analysis?.result?.segments ?? [];
}

function skippable(seg) {
  return seg.end && seg.confidence >= (state.settings?.threshold ?? 0.7);
}

function onTimeUpdate(event) {
  const video = event.target;
  if (!(video instanceof HTMLVideoElement)) return;
  if (!state.settings?.autoSkip || state.paused) return;

  segments().forEach((seg, index) => {
    if (state.skipped.has(index) || !skippable(seg)) return;
    const t = video.currentTime;
    if (t < seg.start.seconds || t >= seg.end.seconds - 0.5) return;
    skipTo(video, seg, index, true);
  });
}

function skipTo(video, seg, index, automatic) {
  const from = video.currentTime;
  video.currentTime = seg.end.seconds;
  state.skipped.add(index);
  const saved = Math.max(0, seg.end.seconds - from);
  send({ type: 'skipped', seconds: saved }).then((r) => {
    if (r?.ok) {
      state.stats = r.stats;
      render();
    }
  });
  toast(`${automatic ? 'Skipped' : 'Jumped past'} the sponsor read, ${stamp(from)} → ${stamp(seg.end.seconds)}`, () => {
    video.currentTime = from;
    state.paused = true;
    state.skipped.delete(index);
    render();
  });
}

// ---- progress bar markers -------------------------------------------------

function drawMarkers() {
  removeMarkers();
  const bar = document.querySelector('.ytp-progress-bar');
  const video = document.querySelector('video.html5-main-video') ?? document.querySelector('video');
  if (!bar || !video || !video.duration) {
    setTimeout(drawMarkers, 1000);
    return;
  }
  for (const seg of segments()) {
    const start = seg.start.seconds / video.duration;
    const end = (seg.end?.seconds ?? seg.start.seconds + 5) / video.duration;
    const marker = document.createElement('div');
    marker.className = MARKER_CLASS;
    marker.style.left = `${(start * 100).toFixed(3)}%`;
    marker.style.width = `${Math.max(0.3, (end - start) * 100).toFixed(3)}%`;
    marker.title = `Sponsor read ${stamp(seg.start.seconds)}${seg.end ? ` – ${stamp(seg.end.seconds)}` : ''}`;
    bar.appendChild(marker);
  }
}

function removeMarkers() {
  document.querySelectorAll(`.${MARKER_CLASS}`).forEach((m) => m.remove());
}

// ---- panel ----------------------------------------------------------------
//
// The panel is a fixed set of slots so nothing moves while it works: a status
// line, the reads, the controls and one line of usage.

function render() {
  if (!state.videoId) return;
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
  }
  const collapsed = panel.dataset.collapsed === 'true';
  panel.replaceChildren(header(collapsed));
  if (!collapsed) panel.append(body());
}

function header(collapsed) {
  const h = el('div', 'ss-header');
  h.append(el('span', 'ss-title', 'Sponsor Skip'));
  h.append(el('span', 'ss-mode', state.provider?.isLocal ? 'local' : 'hosted'));
  const working = state.busy;
  const bad = Boolean(state.error);
  h.append(el('span', `ss-light ${working ? 'busy' : bad ? 'bad' : segments().length ? 'found' : 'idle'}`));
  h.append(button(collapsed ? '▸' : '▾', () => {
    const panel = document.getElementById(PANEL_ID);
    panel.dataset.collapsed = collapsed ? 'false' : 'true';
    render();
  }, 'ss-icon'));
  return h;
}

/** The one-line summary at the top of the body. */
function statusText() {
  const segs = segments();
  if (state.busy) return { text: 'Reading the transcript and asking the model' };
  if (state.error) return { text: state.error, bad: true, detail: state.errorDetail };
  if (!state.analysis) return { text: 'Waiting for the video' };
  if (!segs.length) return { text: 'No sponsor read found' };
  const n = `${segs.length} sponsor read${segs.length > 1 ? 's' : ''}`;
  return { text: `${n}${state.analysis.cached ? ' (cached)' : ''}` };
}

function readsList() {
  const list = el('div', 'ss-reads');
  const video = document.querySelector('video');
  segments().forEach((seg, index) => {
    const row = el('div', 'ss-segment');
    row.append(el('span', 'ss-range', seg.end ? `${stamp(seg.start.seconds)} – ${stamp(seg.end.seconds)}` : `${stamp(seg.start.seconds)} – ?`));
    row.append(el('span', `ss-pill ${seg.confidence >= (state.settings?.threshold ?? 0.7) ? 'good' : 'warn'}`, `${Math.round(seg.confidence * 100)}%`));
    const skip = button(state.skipped.has(index) ? 'Skipped' : 'Skip', () => skipTo(video, seg, index, false), 'ss-small', !(seg.end && video) || state.skipped.has(index));
    row.append(skip);
    list.append(row);
  });
  return list;
}

function controls() {
  const row = el('div', 'ss-controls');
  const auto = el('label', 'ss-toggle');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = Boolean(state.settings?.autoSkip);
  box.addEventListener('change', async () => {
    const r = await send({ type: 'set-settings', settings: { autoSkip: box.checked } });
    if (r?.ok) state.settings = r.settings;
    render();
  });
  auto.append(box, document.createTextNode(state.paused ? 'Auto-skip (paused here)' : 'Auto-skip'));
  auto.title = state.paused ? 'You undid a skip, so nothing more is skipped on this video' : 'Skip sponsor reads without asking';
  row.append(auto);

  const actions = el('div', 'ss-actions');
  actions.append(button('Re-analyze', () => analyze(true), 'ss-small ss-quiet', state.busy));
  row.append(actions);
  return row;
}

/** One or two compact lines of usage. */
function usageLines() {
  const a = state.analysis;
  const s = state.stats;
  const wrap = el('div', 'ss-stats');
  if (a) {
    const model = a.provider?.label ?? state.provider?.label ?? '';
    const where = a.cached ? 'Cached' : 'This video';
    wrap.append(statRow(model ? `${where} · ${model}` : where, `${fmtTokens(a.usage?.input_tokens)} tokens · ${a.requests ?? '?'} calls · ${money(a.cost)}`));
  }
  if (s) {
    wrap.append(statRow('All time', `${s.skips} reads · ${stamp(s.secondsSkipped)} saved · ${money(s.estimatedCost)}`));
  }
  return wrap;
}

function body() {
  const b = el('div', 'ss-body');
  const status = statusText();
  const line = el('div', `ss-status${status.bad ? ' ss-error' : ''}`, status.text);
  line.title = status.detail ?? status.text;
  b.append(line);
  if (segments().length) b.append(readsList());
  b.append(controls());
  b.append(usageLines());
  return b;
}

function statRow(label, value) {
  const row = el('div', 'ss-stat');
  row.append(el('span', 'ss-stat-label', label), el('span', 'ss-stat-value', value));
  row.title = `${label}: ${value}`;
  return row;
}

function toast(text, onUndo) {
  document.querySelector('.ss-toast')?.remove();
  const t = el('div', 'ss-toast');
  t.append(el('span', '', text));
  if (onUndo) t.append(button('Undo', () => { onUndo(); t.remove(); }, 'ss-small'));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

// ---- helpers --------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, onClick, className = '', disabled = false) {
  const b = el('button', `ss-button ${className}`, text);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function stamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function money(usd) {
  const n = Number(usd) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(3)}`;
}

function fmtTokens(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
