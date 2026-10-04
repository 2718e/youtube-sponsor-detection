// The provider registry: one place that turns a configuration into something
// with a `systemOne(request)`.
//
// Adding a model whose interface is only *broadly* Jev's means writing one
// module, registering it here, and passing the contract test in
// test/provider-contract.test.ts. Nothing in ../decisionModel/ or the extension changes:
// the pipeline only ever calls `systemOne` and reads `answers`.
//
// Configuration is deliberately just data, so the same shape is written by the
// extension popup, read from .env, or passed on the command line:
//
//   { protocol: 'systemone', url, model, apiKey, timeoutMs, sendMetadata }

import {
  createSystemOneProvider,
  DEFAULT_MAX_PARALLEL_REQUESTS,
  DEFAULT_MAX_PARALLEL_REQUESTS_HOSTED,
  DEFAULT_MODEL,
  DEFAULT_URL,
  isLocalUrl,
  type ModelProvider,
  type ProviderConfig
} from './systemone.js';

export type ProtocolFactory = (config: ProviderConfig) => ModelProvider;

/** Protocol name -> factory. A new interface adds a line here. */
export const PROTOCOLS: Record<string, ProtocolFactory> = {
  systemone: createSystemOneProvider
};

export interface ProtocolPreset {
  protocol: string;
  label: string;
  url: string;
  model: string;
}

/** The protocols a UI may offer, with what to prefill when one is picked. */
export const PROTOCOL_PRESETS: ProtocolPreset[] = [
  { protocol: 'systemone', label: 'Jev-compatible (hosted or local)', url: DEFAULT_URL, model: DEFAULT_MODEL }
];

export function createProvider(config: ProviderConfig = {}): ModelProvider {
  const protocol = String(config.protocol ?? '').trim() || 'systemone';
  const factory = PROTOCOLS[protocol];
  if (!factory) throw new Error(`Unknown model protocol "${protocol}". Known: ${Object.keys(PROTOCOLS).join(', ')}.`);
  return factory(config);
}

export type ProviderEnv = Record<string, string | undefined>;

/**
 * The same configuration from the environment, so the web app and the scripts
 * reach a model exactly the way the extension does.
 *
 * The TYPESAFE_* names are still read as a fallback so an older .env keeps
 * working; MODEL_* wins when both are set.
 */
export function providerFromEnv(env: ProviderEnv = globalThis.process?.env ?? {}): ModelProvider {
  return createProvider({
    protocol: env.MODEL_PROTOCOL,
    url: env.MODEL_URL ?? env.TYPESAFE_BASE_URL,
    model: env.MODEL_NAME ?? env.TYPESAFE_DEFAULT_MODEL,
    apiKey: env.MODEL_API_KEY ?? env.TYPESAFE_API_KEY
  });
}

export type { ModelProvider, ProviderConfig };
export {
  DEFAULT_MAX_PARALLEL_REQUESTS,
  DEFAULT_MAX_PARALLEL_REQUESTS_HOSTED,
  DEFAULT_MODEL,
  DEFAULT_URL,
  isLocalUrl
};
