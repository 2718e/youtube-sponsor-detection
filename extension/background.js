// Service worker: holds the model configuration, asks the configured provider
// to find the sponsor reads, caches results per video and keeps the running
// stats. The content script never sees a key.
//
// Which model answers is configuration, not code: `createProvider` turns the
// settings into something with a `systemOne(request)`, and the pipeline in
// lib/jev.js only ever calls that. Point `modelUrl` at api.typesafe.ai or at a
// local Jev-compatible server and nothing else changes.

import { buildLines } from './lib/transcript.js';
import { DEFAULT_THRESHOLDS, findSponsorSegment } from './lib/jev.js';
import { createProvider, PROTOCOL_PRESETS } from './lib/providers/index.js';

export const DEFAULT_SETTINGS = {
  // Provider: protocol name plus where it lives. `systemone` is the bare
  // POST <url>/v1/systemone protocol, which both hosted Jev and a local
  // Jev-compatible server speak.
  protocol: 'systemone',
  modelUrl: 'https://api.typesafe.ai',
  // Only ever sent to api.typesafe.ai, whatever URL is configured.
  apiKey: '',
  model: 'jev-latest',
  autoSkip: true,
  // Confidence needed before a skip happens, as the user sets it.
  threshold: 0.7,
  // USD per million input tokens, from docs.typesafe.ai/models (Sept 2026).
  // Output tokens are free. Editable in the popup.
  pricePerMillionInput: 0.042,
  // The pipeline's own bands, which are calibrated per model. null means "use
  // whatever the provider says", which is right until the user overrides them.
  engine: null
};

const EMPTY_STATS = {
  videosAnalyzed: 0,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  sponsorsFound: 0,
  skips: 0,
  secondsSkipped: 0
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));
  return true; // async response
});

async function handle(message) {
  switch (message?.type) {
    case 'analyze':
      return analyze(message);
    case 'skipped':
      return recordSkip(message.seconds);
    case 'get-state':
      return getState();
    case 'set-settings':
      return setSettings(message.settings);
    case 'test-provider':
      return testProvider(message.provider);
    case 'reset-stats':
      await chrome.storage.local.set({ stats: EMPTY_STATS });
      return getState();
    case 'clear-cache':
      await chrome.storage.local.set({ results: {} });
      return getState();
    default:
      throw new Error(`unknown message ${message?.type}`);
  }
}

/** Build a provider from settings, or throw a message worth showing. */
function providerFor(settings) {
  return createProvider({
    protocol: settings.protocol,
    url: settings.modelUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    thresholds: settings.engine ?? undefined
  });
}

async function getState() {
  const { settings, stats, results } = await chrome.storage.local.get(['settings', 'stats', 'results']);
  const merged = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const s = { ...EMPTY_STATS, ...(stats ?? {}) };
  const provider = describeProvider(merged);
  return {
    settings: merged,
    provider,
    // What the popup offers in its protocol picker, straight from the registry.
    protocols: PROTOCOL_PRESETS,
    engine: merged.engine ?? provider.thresholds ?? DEFAULT_THRESHOLDS,
    stats: {
      ...s,
      estimatedCost: cost(s.inputTokens, merged.pricePerMillionInput)
    },
    cachedVideos: Object.keys(results ?? {}).length
  };
}

/** The bits of a provider the popup and the panel need, never the key. */
function describeProvider(settings) {
  try {
    const provider = providerFor(settings);
    return {
      protocol: provider.protocol,
      label: provider.label,
      url: provider.url,
      endpoint: provider.endpoint,
      model: provider.model ?? null,
      isLocal: provider.isLocal,
      requiresKey: provider.requiresKey,
      hasKey: provider.hasKey,
      thresholds: provider.thresholds ?? null
    };
  } catch (error) {
    return { error: error.message, thresholds: null };
  }
}

/** One real question to the endpoint, so the popup can say whether it answers.
 *  Takes the fields as typed, so Test works before Save. */
async function testProvider(overrides) {
  const { settings } = await getState();
  const provider = providerFor({ ...settings, ...(overrides ?? {}) });
  return { health: await provider.health(), provider: describeProvider({ ...settings, ...(overrides ?? {}) }) };
}

async function setSettings(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}), ...patch } });
  return getState();
}

async function analyze({ videoId, title, cues, force }) {
  const { settings, engine } = await getState();
  const provider = providerFor(settings);
  if (provider.requiresKey && !settings.apiKey) {
    throw new Error(`No API key for ${provider.label}. Click the extension icon to add one.`);
  }

  const { results = {} } = await chrome.storage.local.get('results');
  if (!force && results[videoId]) {
    return { cached: true, ...results[videoId], settings };
  }

  const lines = buildLines(cues);
  if (!lines.length) throw new Error('The transcript was empty.');

  let requests = 0;
  const client = {
    systemOne(request) {
      requests += 1;
      return provider.systemOne(request);
    }
  };

  const started = Date.now();
  const result = await findSponsorSegment(lines, { client, model: settings.model, title, thresholds: engine });
  const usage = result.usage ?? { input_tokens: 0, output_tokens: 0 };
  const entry = {
    videoId,
    title,
    at: Date.now(),
    elapsedMs: Date.now() - started,
    requests,
    provider: { protocol: provider.protocol, label: provider.label, url: provider.url, isLocal: provider.isLocal },
    usage,
    // A local server costs nothing to run, so it is not priced.
    cost: provider.isLocal ? 0 : cost(usage.input_tokens, settings.pricePerMillionInput),
    result: slim(result)
  };

  const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
  const next = { ...EMPTY_STATS, ...stats };
  next.videosAnalyzed += 1;
  next.requests += requests;
  next.inputTokens += usage.input_tokens;
  next.outputTokens += usage.output_tokens;
  if (result.status === 'found' || result.status === 'uncertain') next.sponsorsFound += 1;

  results[videoId] = entry;
  await chrome.storage.local.set({ results, stats: next });
  return { cached: false, ...entry, settings };
}

async function recordSkip(seconds) {
  const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
  const next = { ...EMPTY_STATS, ...stats };
  next.skips += 1;
  next.secondsSkipped += Math.max(0, Number(seconds) || 0);
  await chrome.storage.local.set({ stats: next });
  return getState();
}

/** Keep only what the page needs; the full context slice is big. */
function slim(result) {
  return {
    status: result.status,
    confidence: result.confidence ?? result.presence ?? 0,
    start: result.start ? { seconds: result.start.seconds, text: result.start.text, probability: result.start.probability } : null,
    end: result.end ? { seconds: result.end.seconds, text: result.end.text, probability: result.end.probability } : null,
    segments: (result.segments ?? []).map((seg) => ({
      confidence: seg.confidence,
      start: { seconds: seg.start.seconds, text: seg.start.text, probability: seg.start.probability },
      end: seg.end ? { seconds: seg.end.seconds, text: seg.end.text, probability: seg.end.probability } : null
    })),
    windows: (result.windows ?? []).map((w) => ({ from: w.from, to: w.to, presence: w.presence }))
  };
}

function cost(inputTokens, pricePerMillion) {
  return (Number(inputTokens) || 0) * (Number(pricePerMillion) || 0) / 1e6;
}
