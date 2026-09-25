// The `systemone` provider: the bare POST <url>/v1/systemone protocol.
//
// This one adapter covers both ends of the range the project cares about. A
// hosted Jev (https://api.typesafe.ai) and a local server that speaks the same
// protocol (Kev, stuntd, test/mock-typesafe-api.js) differ only in the URL and
// whether a key is expected, so local-versus-hosted is configuration here, not
// a second code path.
//
// The wire request is the canonical request with a model name; the wire answer
// is normalized against the questions that were asked.

import { normalizeAnswer } from './contract.js';
import { DEFAULT_THRESHOLDS } from '../jev.js';

export const DEFAULT_URL = 'https://api.typesafe.ai';
export const DEFAULT_MODEL = 'jev-latest';

/** Where the hosted TypeSafe API lives: the only host a TypeSafe key is sent to. */
export const TYPESAFE_HOST = 'api.typesafe.ai';

/**
 * A request that failed in a way worth retrying (the server is busy or down).
 * A 4xx that is not 408/429 is the caller's fault and is thrown straight away.
 * @param {Response} response
 */
function retryable(response) {
  return response.status === 408 || response.status === 429 || response.status >= 500;
}

/**
 * POST a canonical request and return the canonical answer.
 *
 * @param {{ endpoint: string, apiKey: string, model?: string, timeoutMs: number,
 *           headers?: Record<string, string> }} connection
 * @param {any} request
 * @param {{ signal?: AbortSignal, fetch?: typeof fetch }} [options]
 */
export async function postSystemOne(connection, request, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const body = JSON.stringify(connection.model ? { model: connection.model, ...request } : request);
  const headers = { 'content-type': 'application/json', ...(connection.headers ?? {}) };
  if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    let response;
    try {
      response = await doFetch(connection.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: options.signal ?? AbortSignal.timeout(connection.timeoutMs)
      });
    } catch (error) {
      lastError = new Error(`Could not reach ${connection.endpoint}: ${error.message}`);
      continue;
    }
    if (response.ok) return response.json();

    const text = (await response.text()).slice(0, 200);
    const status = response.status;
    lastError = new Error(
      status === 401 || status === 403
        ? `${connection.endpoint} rejected the API key.`
        : `${connection.endpoint} responded ${status}: ${text}`
    );
    if (!retryable(response)) throw lastError;
  }
  throw lastError;
}

/**
 * The canonical shape of this provider's configuration.
 * @param {any} config
 */
export function createSystemOneProvider(config = {}) {
  const url = String(config.url ?? DEFAULT_URL).trim().replace(/\/+$/, '') || DEFAULT_URL;
  const model = String(config.model ?? '').trim() || undefined;
  const apiKey = String(config.apiKey ?? '').trim();
  const timeoutMs = Number(config.timeoutMs) || 30_000;
  const endpoint = `${url}/v1/systemone`;

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  // The user's TypeSafe key is only ever sent to TypeSafe, whatever URL is
  // configured. A local server needs no key; a self-hosted one that does can be
  // given its own headers by a future adapter.
  const key = host === TYPESAFE_HOST ? apiKey : '';

  return {
    protocol: 'systemone',
    label: isLocal ? 'Local Jev-compatible server' : host === TYPESAFE_HOST ? 'TypeSafe (hosted Jev)' : url,
    url,
    endpoint,
    model,
    isLocal,
    requiresKey: host === TYPESAFE_HOST,
    hasKey: host !== TYPESAFE_HOST || Boolean(key),
    // This protocol's probabilities come from Jev itself or a Jev-compatible
    // model, so its bands are the pipeline's defaults until a calibration run
    // says otherwise.
    thresholds: { ...DEFAULT_THRESHOLDS, ...(config.thresholds ?? {}) },

    /** @param {any} request */
    systemOne(request, options) {
      return postSystemOne({ endpoint, apiKey: key, model, timeoutMs }, request, options).then((result) =>
        normalizeAnswer(result, request?.questions)
      );
    },

    /**
     * One tiny question against the configured endpoint, so the popup can say
     * whether the server is reachable and answering. Asking the provider itself
     * rather than a health route means it works for any server that speaks the
     * protocol.
     */
    async health(options) {
      const started = Date.now();
      const result = await this.systemOne(
        {
          state: { status: 'ok' },
          questions: {
            reachable: {
              type: 'noul',
              instructions: { question: 'Is the value of `status` in the state equal to "ok"?' },
              criteria: { true: 'The status is ok.', false: 'The status is not ok.' }
            }
          }
        },
        options
      );
      return {
        ok: true,
        protocol: 'systemone',
        endpoint,
        model: result.model ?? model ?? null,
        ms: Date.now() - started,
        probability: result.answers.reachable?.noul ?? null
      };
    }
  };
}
