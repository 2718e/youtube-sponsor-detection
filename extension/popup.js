const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

let provider = null;

async function load() {
  const r = await send({ type: 'get-state' });
  if (!r?.ok) return;
  const { settings, stats, cachedVideos, protocols, engine } = r;
  provider = r.provider;

  // Provider
  const select = $('protocol');
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
  $('modelUrl').value = settings.modelUrl;
  $('model').value = settings.model;
  keyState($('keyState'), settings.apiKey);
  providerState();

  // Skipping
  $('autoSkip').checked = settings.autoSkip;
  $('threshold').value = settings.threshold;
  $('thresholdOut').textContent = `${Math.round(settings.threshold * 100)}%`;

  // Advanced
  $('price').value = settings.pricePerMillionInput;
  $('engineFound').value = engine.found;
  $('engineMaybe').value = engine.maybe;
  $('engineKeep').value = engine.keepContent;

  // Usage
  const totalCost = stats.estimatedCost ?? 0;
  tiles([
    [stamp(stats.secondsSkipped ?? 0), 'time saved'],
    [String(stats.skips ?? 0), 'skips'],
    [`$${totalCost.toFixed(totalCost < 0.01 ? 4 : 2)}`, 'estimated spend']
  ]);
  const rows = [
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

function keyState(node, key) {
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

function tiles(items) {
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
function originPattern(raw) {
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
async function requestHost(url) {
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

$('protocol').addEventListener('change', (e) => {
  const option = e.target.selectedOptions[0];
  if (!option) return;
  $('modelUrl').value = option.dataset.url ?? '';
  $('model').value = option.dataset.model ?? '';
});

$('saveProvider').addEventListener('click', async () => {
  const modelUrl = $('modelUrl').value.trim();
  if (!(await requestHost(modelUrl))) {
    $('providerState').textContent = `The browser would not grant access to ${modelUrl}. The provider was not changed.`;
    return;
  }
  const r = await send({
    type: 'set-settings',
    settings: { protocol: $('protocol').value, modelUrl, model: $('model').value.trim() }
  });
  if (r?.ok) provider = r.provider;
  await load();
});

$('testProvider').addEventListener('click', async () => {
  const fields = { protocol: $('protocol').value, modelUrl: $('modelUrl').value.trim(), model: $('model').value.trim() };
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
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) return;
  await send({ type: 'set-settings', settings: { apiKey } });
  $('apiKey').value = '';
  load();
});
$('apiKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('saveKey').click();
});

$('autoSkip').addEventListener('change', (e) => send({ type: 'set-settings', settings: { autoSkip: e.target.checked } }));
$('threshold').addEventListener('input', (e) => {
  $('thresholdOut').textContent = `${Math.round(e.target.value * 100)}%`;
});
$('threshold').addEventListener('change', (e) => send({ type: 'set-settings', settings: { threshold: Number(e.target.value) } }));
$('price').addEventListener('change', (e) => send({ type: 'set-settings', settings: { pricePerMillionInput: Number(e.target.value) || 0 } }).then(load));

for (const id of ['engineFound', 'engineMaybe', 'engineKeep']) {
  $(id).addEventListener('change', async () => {
    const engine = {
      found: Number($('engineFound').value),
      maybe: Number($('engineMaybe').value),
      keepContent: Number($('engineKeep').value)
    };
    await send({ type: 'set-settings', settings: { engine } });
    load();
  });
}

$('resetEngine').addEventListener('click', () => send({ type: 'set-settings', settings: { engine: null } }).then(load));
$('resetStats').addEventListener('click', () => send({ type: 'reset-stats' }).then(load));
$('clearCache').addEventListener('click', () => send({ type: 'clear-cache' }).then(load));

function stamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

load();
