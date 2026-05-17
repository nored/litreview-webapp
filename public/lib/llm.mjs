// Unified LLM client. Three providers:
//   'webllm'    Server-side llama.cpp via /api/llm/chat (no key, runs in
//               Node with Metal/CUDA/CPU). The model is loaded ON THE
//               SERVER; the browser just picks which model.
//   'openai'    OpenAI-compatible (Ollama, OpenAI, OpenRouter, vLLM, …)
//                proxied through our local server so API keys stay on disk
//   'anthropic' Claude API, also proxied
//
// Call sites just use chat({ system, user, onToken }) — same shape as
// before. The active provider determines where the call goes. All three
// providers stream from /api/llm/chat now; there is no more in-browser
// inference path.

const PROVIDER_KEY = 'litreview:llm:provider';

const state = {
  provider: 'webllm',
  // Server-side local LLM:
  localRegistry: [],         // fetched from /api/v2/local-llm/models
  localDefault:  null,
  localStatus:   { state: 'idle', current_model_id: null, loaded_model_id: null, progress: null, error: null },
  // Remote provider config snapshot (refreshed from /api/credentials):
  remoteConfig: { openai: { configured: false }, anthropic: { configured: false } },
  // Pub/sub for the AI status pill:
  listeners: new Set(),
  // Poll timer for server-side LLM status while a download/load is running.
  pollTimer: null,
};

function emit(event) {
  for (const fn of state.listeners) {
    try { fn(event); } catch { /* ignore */ }
  }
}

export function subscribe(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

export function getProvider() { return state.provider; }
export function setProvider(p) {
  if (!['webllm', 'openai', 'anthropic'].includes(p)) return;
  state.provider = p;
  try { localStorage.setItem(PROVIDER_KEY, p); } catch {}
  emit({ type: 'provider', provider: p });
}

function loadProviderPref() {
  try {
    const v = localStorage.getItem(PROVIDER_KEY);
    if (v === 'openai' || v === 'anthropic' || v === 'webllm') state.provider = v;
  } catch {}
}
loadProviderPref();

// ---- Status (used by the topbar pill) ----
export function status() {
  if (state.provider === 'webllm') {
    const s = state.localStatus;
    const cur = s.loaded_model_id || s.current_model_id;
    const entry = state.localRegistry.find((m) => m.id === cur);
    const loading = s.state === 'downloading' || s.state === 'loading';
    let progress = null;
    if (s.state === 'downloading' && s.progress) {
      const p = s.progress.bytes_total ? (s.progress.bytes_done / s.progress.bytes_total) : 0;
      progress = { progress: p, text: `downloading ${humanBytes(s.progress.bytes_done)} / ${humanBytes(s.progress.bytes_total)}` };
    } else if (s.state === 'loading') {
      progress = { progress: 0.99, text: 'loading into memory…' };
    }
    return {
      provider: 'webllm',
      available: true,
      loaded: s.state === 'ready',
      loading,
      modelId: cur,
      progress,
      error: s.error,
      displayName: entry?.label ?? cur ?? null,
    };
  }
  const cfg = state.remoteConfig[state.provider];
  return {
    provider: state.provider,
    available: true,
    loaded: !!cfg?.configured,
    loading: false,
    modelId: cfg?.model || null,
    error: cfg?.configured ? null : `${state.provider} not configured`,
    displayName: cfg?.model || (state.provider === 'openai' ? 'OpenAI-compatible' : 'Claude'),
  };
}

export function isLoaded() { return status().loaded; }
export function currentModel() { return status().modelId; }

function humanBytes(n) {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// ---- Server-side local LLM: registry + selection + status polling ----
export function getLocalRegistry() { return state.localRegistry.slice(); }
export function getLocalDefault()  { return state.localDefault; }

export async function refreshLocalRegistry() {
  try {
    const data = await fetch('/api/v2/local-llm/models').then((r) => r.json());
    state.localRegistry = Array.isArray(data.registry) ? data.registry : [];
    state.localDefault  = data.default_model_id || null;
    emit({ type: 'local-registry' });
  } catch { /* server may not be up yet */ }
}

export async function refreshLocalStatus() {
  try {
    state.localStatus = await fetch('/api/v2/local-llm/status').then((r) => r.json());
    emit({ type: 'local-status', status: state.localStatus });
    const busy = state.localStatus.state === 'downloading' || state.localStatus.state === 'loading';
    if (busy && !state.pollTimer) {
      state.pollTimer = setInterval(refreshLocalStatus, 1500);
    } else if (!busy && state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  } catch { /* server may not be up yet */ }
}

export async function selectLocalModel(model_id) {
  const r = await fetch('/api/v2/local-llm/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  state.localStatus = await r.json();
  emit({ type: 'local-status', status: state.localStatus });
  refreshLocalStatus();   // start the poll
}

// ---- Remote provider config ----
export async function refreshRemoteConfig() {
  try {
    const data = await fetch('/api/credentials').then((r) => r.json());
    state.remoteConfig = {
      openai: {
        base_url: data.openai_base_url?.value || '',
        model:    data.openai_model?.value || '',
        configured: !!(data.openai_api_key?.set || data.openai_base_url?.value),
      },
      anthropic: {
        model:      data.anthropic_model?.value || '',
        configured: !!data.anthropic_api_key?.set,
      },
    };
    emit({ type: 'remote-config', config: state.remoteConfig });
  } catch { /* ignore */ }
}

export function getRemoteConfig() { return state.remoteConfig; }

// ---- Unified chat ----
// All three providers now stream from /api/llm/chat. The server proxy
// routes 'webllm' to llm_local, the others to their respective backends.
export async function chat({ system, user, temperature = 0.7, onToken } = {}) {
  const provider = state.provider;
  const res = await fetch('/api/llm/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, system, user, temperature }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let event;
      try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (event.type === 'delta' && typeof event.delta === 'string') {
        full = event.total ?? (full + event.delta);
        onToken?.(event.delta, full);
      } else if (event.type === 'error') {
        throw new Error(event.error || 'llm error');
      }
    }
  }
  return full;
}

// ---- Backwards-compat shims for older call sites ----
// Callers that import `WEBLLM_MODELS` or `loadModel` from this file now
// get the server-side registry view. `loadModel` selects a server-side
// model (returns once the server has acknowledged; status updates
// stream via subscribe()).
export const WEBLLM_MODELS = new Proxy([], {
  get(_t, prop) {
    const arr = state.localRegistry.map((m) => ({
      id: m.id, label: m.label, size: `${m.size_gb} GB`, note: m.description,
    }));
    return arr[prop];
  },
});
export const MODELS = WEBLLM_MODELS;
export async function loadModel(modelId) { return selectLocalModel(modelId); }
export function isWebGPUAvailable() { return true; }   // server-side; always "available"
export function getAutoLoadPref() { return state.localStatus.current_model_id || ''; }
export function setAutoLoadPref(_id) { /* persisted server-side now */ }
export function clearAutoLoadPref() { /* persisted server-side now */ }
