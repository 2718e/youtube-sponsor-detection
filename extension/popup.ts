import type { ProviderDescription, Settings } from './background.js';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function send(message: unknown): Promise<any> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

let provider: ProviderDescription | null = null;

async function load() {
  const r = await send({ type: 'get-state' });
  if (!r?.ok) return;
  const { settings, stats, cachedVideos, protocols, engine } = r as {
    settings: Settings;
    stats: any;
    cachedVideos: number;
    protocols: { protocol: string; label: string; url: string; model: string }[];
    engine: { found: number; maybe: number; keepContent: number };
  };
  provider = r.provider;

  // Provider
  const select = $<HTMLSelectElement>('protocol');
  select.replaceChildren(
    ...(protocols ?? []).map((p) => {
      const option = document.createElement('option');
      option.value = p.protocol;
      option.textContent = p.label;
      option.dataset.url = p.url;
      option.dataset.model = p.model;
      return option;
    })
  );
  select.value = settings.protocol;
  $<HTMLInputElement>('modelUrl').value = settings.modelUrl;
  $<HTMLInputElement>('model').value = settings.model;
  keyState($('keyState'), settings.apiKey);
  pill();

  // Skipping
  $<HTMLInputElement>('autoSkip').checked = settings.autoSkip;
  $<HTMLInputElement>('threshold').value = String(settings.threshold);
  $('thresholdOut').textContent = `${Math.round(settings.threshold * 100)}%`;

  // Advanced
  $<HTMLInputElement>('price').value = String(settings.pricePerMillionInput);
  $<HTMLInputElement>('maxParallelLocal').value = String(settings.maxParallelLocal);
  $<HTMLInputElement>('maxParallelHosted').value = String(settings.maxParallelHosted);
  $<HTMLInputElement>('engineFound').value = String(engine.found);
  $<HTMLInputElement>('engineMaybe').value = String(engine.maybe);
  $<HTMLInputElement>('engineKeep').value = String(engine.keepContent);
  $<HTMLSelectElement>('boundaryStrategy').value = settings.boundaryStrategy;
  $<HTMLSelectElement>('cut').value = settings.cut;

  // Usage
  const totalCost = stats.estimatedCost ?? 0;
  tiles([
    [stamp(stats.secondsSkipped ?? 0), 'time saved'],
    [String(stats.skips ?? 0), 'skips'],
    [`$${totalCost.toFixed(totalCost < 0.01 ? 4 : 2)}`, 'estimated spend']
  ]);
  const rows: [string, unknown][] = [
    ['Videos analysed', stats.videosAnalyzed],
    ['Sponsor reads found', stats.sponsorsFound],
    ['Model requests', stats.requests],
    ['Input tokens', stats.inputTokens.toLocaleString()],
    ['Output tokens', stats.outputTokens.toLocaleString()],
    ['Estimated cost', `$${(stats.estimatedCost ?? 0).toFixed(5)}`],
    ['Reads skipped', stats.skips],
    ['Time saved', stamp(stats.secondsSkipped)],
    ['Cached videos', cachedVideos]
  ];
  $('stats').replaceChildren(
    ...rows.map(([k, v]) => {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      const b = document.createElement('td');
      a.textContent = k;
      b.textContent = String(v);
      tr.append(a, b);
      return tr;
    })
  );

  pill();
}

function keyState(node: HTMLElement, key: string) {
  node.textContent = key ? `saved …${key.slice(-4)}` : 'not set';
  node.className = `key-state ${key ? 'ok' : 'missing'}`;
  node.title = key ? 'TypeSafe key saved in this browser' : 'Paste your TypeSafe key below';
}

/** The pill top right, and the line under the provider fields. */
function pill() {
  const el = $('statusPill');
  const out = $('providerState');
  if (provider?.error) {
    el.textContent = 'provider error';
    el.className = 'pill bad';
    out.textContent = provider.error;
    return;
  }
  if (!provider) return;
  el.className = `pill ${provider.isLocal ? 'on' : ''}`;
  if (!provider.hasKey) {
    el.textContent = 'needs API key';
    el.className = 'pill bad';
  } else {
    el.textContent = provider.isLocal ? 'local model' : 'hosted model';
  }
  out.textContent = `${provider.label} · ${provider.endpoint}${provider.model ? ` · ${provider.model}` : ''}`;
}

function tiles(items: [string, string][]) {
  $('tiles').replaceChildren(
    ...items.map(([value, label]) => {
      const t = document.createElement('div');
      t.className = 'tile';
      const b = document.createElement('b');
      b.textContent = value;
      const s = document.createElement('span');
      s.textContent = label;
      t.append(b, s);
      return t;
    })
  );
}

/** The origin a URL needs permission for. Match patterns have no port, so any
 *  port on that host is covered. */
function originPattern(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

/** Ask for access to the configured host, if the browser can grant it. Returns
 *  false only when the browser explicitly refused. */
async function requestHost(url: string): Promise<boolean> {
  const pattern = originPattern(url);
  if (!pattern || !chrome.permissions?.request) return true;
  try {
    // Callback-only implementations resolve undefined; that is not a refusal.
    return (await chrome.permissions.request({ origins: [pattern] })) !== false;
  } catch {
    return false;
  }
}

// ---- events ---------------------------------------------------------------

$<HTMLSelectElement>('protocol').addEventListener('change', (e) => {
  const option = (e.target as HTMLSelectElement).selectedOptions[0];
  if (!option) return;
  $<HTMLInputElement>('modelUrl').value = option.dataset.url ?? '';
  $<HTMLInputElement>('model').value = option.dataset.model ?? '';
});

$('saveProvider').addEventListener('click', async () => {
  const modelUrl = $<HTMLInputElement>('modelUrl').value.trim();
  if (!(await requestHost(modelUrl))) {
    $('providerState').textContent = `The browser would not grant access to ${modelUrl}. The provider was not changed.`;
    return;
  }
  const r = await send({
    type: 'set-settings',
    settings: { protocol: $<HTMLSelectElement>('protocol').value, modelUrl, model: $<HTMLInputElement>('model').value.trim() }
  });
  if (r?.ok) provider = r.provider;
  await load();
});

$('testProvider').addEventListener('click', async () => {
  const fields = { protocol: $<HTMLSelectElement>('protocol').value, modelUrl: $<HTMLInputElement>('modelUrl').value.trim(), model: $<HTMLInputElement>('model').value.trim() };
  if (!(await requestHost(fields.modelUrl))) {
    $('providerState').textContent = `The browser would not grant access to ${fields.modelUrl}.`;
    return;
  }
  $('providerState').textContent = 'Asking the model…';
  const r = await send({ type: 'test-provider', provider: fields });
  if (r?.ok) {
    const h = r.health;
    $('providerState').textContent = `Answered in ${h.ms} ms via ${h.endpoint}${h.model ? ` (${h.model})` : ''}.`;
  } else {
    $('providerState').textContent = r?.error ?? 'No answer.';
  }
});

$('saveKey').addEventListener('click', async () => {
  const apiKey = $<HTMLInputElement>('apiKey').value.trim();
  if (!apiKey) return;
  await send({ type: 'set-settings', settings: { apiKey } });
  $<HTMLInputElement>('apiKey').value = '';
  load();
});
$<HTMLInputElement>('apiKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('saveKey').click();
});

$<HTMLInputElement>('autoSkip').addEventListener('change', (e) =>
  send({ type: 'set-settings', settings: { autoSkip: (e.target as HTMLInputElement).checked } })
);
$<HTMLInputElement>('threshold').addEventListener('input', (e) => {
  $('thresholdOut').textContent = `${Math.round(Number((e.target as HTMLInputElement).value) * 100)}%`;
});
$<HTMLInputElement>('threshold').addEventListener('change', (e) =>
  send({ type: 'set-settings', settings: { threshold: Number((e.target as HTMLInputElement).value) } })
);
$<HTMLInputElement>('price').addEventListener('change', (e) =>
  send({ type: 'set-settings', settings: { pricePerMillionInput: Number((e.target as HTMLInputElement).value) || 0 } }).then(load)
);

for (const id of ['maxParallelLocal', 'maxParallelHosted']) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    const value = Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1));
    send({ type: 'set-settings', settings: { [id]: value } }).then(load);
  });
}

for (const id of ['engineFound', 'engineMaybe', 'engineKeep']) {
  $(id).addEventListener('change', async () => {
    const engine = {
      found: Number($<HTMLInputElement>('engineFound').value),
      maybe: Number($<HTMLInputElement>('engineMaybe').value),
      keepContent: Number($<HTMLInputElement>('engineKeep').value)
    };
    await send({ type: 'set-settings', settings: { engine } });
    load();
  });
}

for (const id of ['boundaryStrategy', 'cut']) {
  $<HTMLSelectElement>(id).addEventListener('change', (e) => {
    send({ type: 'set-settings', settings: { [id]: (e.target as HTMLSelectElement).value } }).then(load);
  });
}

$('resetEngine').addEventListener('click', () => send({ type: 'set-settings', settings: { engine: null } }).then(load));
$('resetStats').addEventListener('click', () => send({ type: 'reset-stats' }).then(load));
$('clearCache').addEventListener('click', () => send({ type: 'clear-cache' }).then(load));

function stamp(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

load();
