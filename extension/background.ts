// Service worker: holds the model configuration, asks the configured provider
// to find the sponsor reads, caches results per video and keeps the running
// stats. The content script never sees a key.
//
// Which model answers is configuration, not code: `createProvider` turns the
// settings into something with a `systemOne(request)`, and the pipeline in
// ../src/decisionModel/ only ever calls that. Point `modelUrl` at a local
// Jev-compatible server or at api.typesafe.ai and nothing else changes.

import { buildLines, type Cue } from '../src/transcript.js';
import { findSponsorSegment } from '../src/decisionModel/findSponsorSegment.js';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../src/decisionModel/thresholds.js';
import type { SponsorResult } from '../src/decisionModel/types.js';
import {
  createProvider,
  PROTOCOL_PRESETS,
  DEFAULT_URL,
  DEFAULT_MODEL,
  type ModelProvider,
  type ProtocolPreset
} from '../src/providers/index.js';

export interface Settings {
  // Provider: protocol name plus where it lives. `systemone` is the bare
  // POST <url>/v1/systemone protocol, which both hosted Jev and a local
  // Jev-compatible server speak.
  protocol: string;
  modelUrl: string;
  // Only ever sent to api.typesafe.ai, whatever URL is configured.
  apiKey: string;
  model: string;
  autoSkip: boolean;
  // Confidence needed before a skip happens, as the user sets it.
  threshold: number;
  // USD per million input tokens, from docs.typesafe.ai/models (Sept 2026).
  // Output tokens are free. Editable in the popup.
  pricePerMillionInput: number;
  // The pipeline's own bands, which are calibrated per model. null means "use
  // whatever the provider says", which is right until the user overrides them.
  engine: Partial<Thresholds> | null;
}

// A local Jev-compatible server is the default: it needs no key, so the
// extension works before anything is saved.
export const DEFAULT_SETTINGS: Settings = {
  protocol: 'systemone',
  modelUrl: DEFAULT_URL,
  apiKey: '',
  model: DEFAULT_MODEL,
  autoSkip: true,
  threshold: 0.7,
  pricePerMillionInput: 0.042,
  engine: null
};

export interface Stats {
  videosAnalyzed: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  sponsorsFound: number;
  skips: number;
  secondsSkipped: number;
}

const EMPTY_STATS: Stats = {
  videosAnalyzed: 0,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  sponsorsFound: 0,
  skips: 0,
  secondsSkipped: 0
};

export interface ProviderDescription {
  protocol?: string;
  label?: string;
  url?: string;
  endpoint?: string;
  model?: string | null;
  isLocal?: boolean;
  requiresKey?: boolean;
  hasKey?: boolean;
  thresholds?: Thresholds | null;
  error?: string;
}

interface Message {
  type?: string;
  [key: string]: unknown;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message as Message)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));
  return true; // async response
});

async function handle(message: Message): Promise<Record<string, unknown>> {
  switch (message?.type) {
    case 'analyze':
      return analyze(message as unknown as AnalyzeMessage);
    case 'skipped':
      return recordSkip(message.seconds as number);
    case 'get-state':
      return getState();
    case 'set-settings':
      return setSettings(message.settings as Partial<Settings>);
    case 'test-provider':
      return testProvider(message.provider as Partial<Settings> | undefined);
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

interface AnalyzeMessage {
  videoId: string;
  title: string;
  cues: Cue[];
  force?: boolean;
}

/** Build a provider from settings, or throw a message worth showing. */
function providerFor(settings: Settings): ModelProvider {
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
  const merged: Settings = { ...DEFAULT_SETTINGS, ...((settings ?? {}) as Partial<Settings>) };
  const s: Stats = { ...EMPTY_STATS, ...((stats ?? {}) as Partial<Stats>) };
  const provider = describeProvider(merged);
  return {
    settings: merged,
    provider,
    // What the popup offers in its protocol picker, straight from the registry.
    protocols: PROTOCOL_PRESETS as ProtocolPreset[],
    engine: (merged.engine ?? provider.thresholds ?? DEFAULT_THRESHOLDS) as Thresholds,
    stats: {
      ...s,
      estimatedCost: cost(s.inputTokens, merged.pricePerMillionInput)
    },
    cachedVideos: Object.keys((results ?? {}) as Record<string, unknown>).length
  };
}

/** The bits of a provider the popup and the panel need, never the key. */
function describeProvider(settings: Settings): ProviderDescription {
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
    return { error: (error as Error).message, thresholds: null };
  }
}

/** One real question to the endpoint, so the popup can say whether it answers.
 *  Takes the fields as typed, so Test works before Save. */
async function testProvider(overrides?: Partial<Settings>) {
  const { settings } = await getState();
  const provider = providerFor({ ...settings, ...(overrides ?? {}) });
  return { health: await provider.health(), provider: describeProvider({ ...settings, ...(overrides ?? {}) }) };
}

async function setSettings(patch: Partial<Settings>) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...((settings ?? {}) as Partial<Settings>), ...patch } });
  return getState();
}

async function analyze({ videoId, title, cues, force }: AnalyzeMessage) {
  const { settings, engine } = await getState();
  const provider = providerFor(settings);
  if (provider.requiresKey && !settings.apiKey) {
    throw new Error(`No API key for ${provider.label}. Click the extension icon to add one.`);
  }

  const { results = {} } = await chrome.storage.local.get('results');
  const cached = results as Record<string, any>;
  if (!force && cached[videoId]) {
    return { cached: true, ...cached[videoId], settings };
  }

  const lines = buildLines(cues);
  if (!lines.length) throw new Error('The transcript was empty.');

  let requests = 0;
  const client = {
    systemOne(request: Parameters<ModelProvider['systemOne']>[0]) {
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
  const next: Stats = { ...EMPTY_STATS, ...((stats ?? {}) as Partial<Stats>) };
  next.videosAnalyzed += 1;
  next.requests += requests;
  next.inputTokens += usage.input_tokens;
  next.outputTokens += usage.output_tokens;
  if (result.status === 'found' || result.status === 'uncertain') next.sponsorsFound += 1;

  cached[videoId] = entry;
  await chrome.storage.local.set({ results: cached, stats: next });
  return { cached: false, ...entry, settings };
}

async function recordSkip(seconds: number) {
  const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
  const next: Stats = { ...EMPTY_STATS, ...((stats ?? {}) as Partial<Stats>) };
  next.skips += 1;
  next.secondsSkipped += Math.max(0, Number(seconds) || 0);
  await chrome.storage.local.set({ stats: next });
  return getState();
}

/** Keep only what the page needs; the full context slice is big. */
function slim(result: SponsorResult) {
  return {
    status: result.status,
    confidence: result.confidence ?? 0,
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

function cost(inputTokens: number, pricePerMillion: number): number {
  return (Number(inputTokens) || 0) * (Number(pricePerMillion) || 0) / 1e6;
}
