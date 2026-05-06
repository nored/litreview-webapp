// Unified LLM client. Three providers:
//   'webllm'    in-browser via WebLLM (no key needed, runs on WebGPU)
//   'openai'    OpenAI-compatible (Ollama, OpenAI, OpenRouter, vLLM, …)
//                proxied through our local server so API keys stay on disk
//   'anthropic' Claude API, also proxied
//
// Call sites just use chat({ system, user, onToken }) — same shape as
// before. The active provider determines where the call goes.

const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm';

export const WEBLLM_MODELS = [
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B', size: '~2 GB', note: 'recommended balance of size and quality' },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',   label: 'Qwen 2.5 3B',  size: '~2 GB', note: 'strong multilingual' },
  { id: 'Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC', label: 'Ministral 3B', size: '~2 GB', note: 'newest 3B-class option' },
  { id: 'gemma3-1b-it-q4f16_1-MLC',          label: 'Gemma 3 1B',   size: '~700 MB', note: 'fast small model' },
  { id: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC', label: 'SmolLM 2 1.7B', size: '~1 GB', note: 'compact' },
];
// Backwards-compat alias for callers still importing `MODELS`
export const MODELS = WEBLLM_MODELS;

const PROVIDER_KEY = 'litreview:llm:provider';
const AUTOLOAD_KEY = 'litreview:llm:autoload';

const state = {
  provider: 'webllm',
  // WebLLM-specific:
  webllm: null,
  engine: null,
  modelId: null,
  loadingPromise: null,
  loadingModelId: null,
  lastProgress: null,
  lastError: null,
  // Remote provider config snapshot (refreshed from /api/credentials):
  remoteConfig: { openai: { configured: false }, anthropic: { configured: false } },
  // Pub/sub for the AI status pill:
  listeners: new Set(),
};

function emit(event) {
  for (const fn of state.listeners) {
    try { fn(event); } catch (e) { /* ignore */ }
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

// ---- Auto-load (WebLLM only) ----
export function getAutoLoadPref() {
  try { return localStorage.getItem(AUTOLOAD_KEY) || ''; } catch { return ''; }
}
export function setAutoLoadPref(modelId) {
  try { localStorage.setItem(AUTOLOAD_KEY, modelId || ''); } catch {}
}
export function clearAutoLoadPref() {
  try { localStorage.removeItem(AUTOLOAD_KEY); } catch {}
}

// ---- WebGPU detection ----
export function isWebGPUAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

// ---- Status (used by the topbar pill) ----
export function status() {
  if (state.provider === 'webllm') {
    return {
      provider: 'webllm',
      available: isWebGPUAvailable(),
      loaded: state.engine != null,
      loading: state.loadingPromise != null,
      modelId: state.modelId,
      loadingModelId: state.loadingModelId,
      progress: state.lastProgress,
      error: state.lastError,
      displayName: state.modelId
        ? (WEBLLM_MODELS.find((m) => m.id === state.modelId)?.label ?? 'WebLLM')
        : null,
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

// ---- WebLLM model loading ----
async function ensureWebLLM() {
  if (state.webllm) return state.webllm;
  state.webllm = await import(WEBLLM_URL);
  return state.webllm;
}

export async function loadModel(modelId) {
  if (!isWebGPUAvailable()) {
    const err = new Error('WebGPU is not available in this browser.');
    state.lastError = err.message;
    emit({ type: 'error', error: err.message });
    throw err;
  }
  if (state.modelId === modelId && state.engine && !state.loadingPromise) return state.engine;
  if (state.loadingPromise && state.loadingModelId === modelId) return state.loadingPromise;
  state.loadingModelId = modelId;
  state.lastError = null;
  state.lastProgress = { progress: 0, text: 'starting…' };
  emit({ type: 'loading', progress: state.lastProgress, modelId });
  state.loadingPromise = (async () => {
    const webllm = await ensureWebLLM();
    const engine = new webllm.MLCEngine();
    engine.setInitProgressCallback((report) => {
      state.lastProgress = { progress: report.progress, text: report.text };
      emit({ type: 'progress', progress: state.lastProgress });
    });
    try {
      await engine.reload(modelId);
      state.engine = engine;
      state.modelId = modelId;
      state.lastProgress = { progress: 1, text: 'ready' };
      setAutoLoadPref(modelId);
      emit({ type: 'ready', modelId });
      return engine;
    } catch (err) {
      state.lastError = err?.message || String(err);
      emit({ type: 'error', error: state.lastError });
      throw err;
    } finally {
      state.loadingPromise = null;
      state.loadingModelId = null;
    }
  })();
  return state.loadingPromise;
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
  } catch (e) {
    /* ignore */
  }
}

export function getRemoteConfig() { return state.remoteConfig; }

// ---- Unified chat ----
export async function chat({ system, user, temperature = 0.7, onToken } = {}) {
  if (state.provider === 'webllm') return chatWebllm({ system, user, temperature, onToken });
  return chatRemote({ system, user, temperature, onToken });
}

async function chatWebllm({ system, user, temperature, onToken }) {
  if (!state.engine) throw new Error('no WebLLM model loaded');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  if (onToken) {
    const stream = await state.engine.chat.completions.create({ messages, temperature, stream: true });
    let full = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? '';
      if (delta) { full += delta; onToken(delta, full); }
    }
    return full;
  }
  const res = await state.engine.chat.completions.create({ messages, temperature });
  return res.choices[0].message.content;
}

async function chatRemote({ system, user, temperature, onToken }) {
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
