// Node-side LLM runtime via node-llama-cpp. Replaces the browser
// WebLLM path entirely: the model loads in Node (Metal-accelerated on
// Apple Silicon, CUDA on Linux/NVIDIA, CPU elsewhere), and the
// browser is only the picker.
//
// Public surface:
//   - getRegistry()        → curated model list (display name, repo, size)
//   - getStatus()          → { current_model_id, state, progress, error }
//   - selectModel(id)      → start downloading/loading; idempotent
//   - call({ system, user, temperature, onToken }) → same shape as the
//                            other proxy backends so llm_proxy can
//                            dispatch to it uniformly.
//   - isReady()            → true if a model is loaded and serving
//   - getCurrentModelId()  → resolves the persisted preference if any
//
// Models are cached under project/data/_models/. The chosen model_id
// is persisted to project/data/_local_llm.json so it survives reboot.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..', '..', 'project');
const MODELS_DIR  = path.join(PROJECT_DIR, 'data', '_models');
const STATE_PATH  = path.join(PROJECT_DIR, 'data', '_local_llm.json');

// ─────────────────────────────────────────────────────────────────────────
// Model registry
// ─────────────────────────────────────────────────────────────────────────

const REGISTRY = [
  {
    id: 'qwen2.5-3b-instruct-q4',
    label: 'Qwen 2.5 3B Instruct (Q4_K_M)',
    description: 'Fast default. Good at structured JSON extraction. ~2 GB on disk.',
    uri: 'hf:bartowski/Qwen2.5-3B-Instruct-GGUF/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    size_gb: 2.0,
    speed: 'fast',
    chatWrapper: 'qwen',
  },
  {
    id: 'qwen2.5-7b-instruct-q4',
    label: 'Qwen 2.5 7B Instruct (Q4_K_M)',
    description: 'Slower but more careful with verbatim quotes. ~4.5 GB on disk.',
    uri: 'hf:bartowski/Qwen2.5-7B-Instruct-GGUF/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    size_gb: 4.5,
    speed: 'medium',
    chatWrapper: 'qwen',
  },
  {
    id: 'qwen2.5-14b-instruct-q4',
    label: 'Qwen 2.5 14B Instruct (Q4_K_M)',
    description: 'Slow, highest quality. Needs 16 GB+ RAM. ~9 GB on disk.',
    uri: 'hf:bartowski/Qwen2.5-14B-Instruct-GGUF/Qwen2.5-14B-Instruct-Q4_K_M.gguf',
    size_gb: 9.0,
    speed: 'slow',
    chatWrapper: 'qwen',
  },
  {
    id: 'llama3.2-3b-instruct-q4',
    label: 'Llama 3.2 3B Instruct (Q4_K_M)',
    description: 'Alternative 3B if you prefer Meta\'s tuning. ~2 GB on disk.',
    uri: 'hf:bartowski/Llama-3.2-3B-Instruct-GGUF/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    size_gb: 2.0,
    speed: 'fast',
    chatWrapper: 'llama3.2',
  },
  {
    id: 'phi3.5-mini-instruct-q4',
    label: 'Phi 3.5 Mini Instruct (Q4_K_M)',
    description: 'Microsoft\'s 3.8B; strong at instruction-following. ~2.2 GB on disk.',
    uri: 'hf:bartowski/Phi-3.5-mini-instruct-GGUF/Phi-3.5-mini-instruct-Q4_K_M.gguf',
    size_gb: 2.2,
    speed: 'fast',
    chatWrapper: 'general',
  },
];

const DEFAULT_MODEL_ID = 'qwen2.5-3b-instruct-q4';

// ─────────────────────────────────────────────────────────────────────────
// State (singleton)
// ─────────────────────────────────────────────────────────────────────────

const state = {
  current_model_id: null,
  loaded_model_id:  null,      // what's actually resident in memory right now
  state:            'idle',    // 'idle' | 'downloading' | 'loading' | 'ready' | 'error'
  progress:         null,      // { bytes_done, bytes_total } or { token: 'loading model' }
  error:            null,
  // Held instances (not exported):
  _llama:   null,
  _model:   null,
  _context: null,
  _session: null,
};

function getRegistry() {
  return REGISTRY.map((m) => ({ ...m }));
}

function getStatus() {
  return {
    current_model_id: state.current_model_id,
    loaded_model_id:  state.loaded_model_id,
    state:            state.state,
    progress:         state.progress,
    error:            state.error,
  };
}

function isReady() {
  return state.state === 'ready' && state._session != null;
}

function getCurrentModelId() {
  return state.current_model_id;
}

// ─────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────

async function loadPersistedSelection() {
  try {
    const buf = await fsp.readFile(STATE_PATH, 'utf8');
    const j = JSON.parse(buf);
    if (j.model_id) return j.model_id;
  } catch { /* first boot */ }
  return null;
}

async function persistSelection(model_id) {
  await fsp.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fsp.writeFile(STATE_PATH, JSON.stringify({ model_id }, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────
// Load + swap
// ─────────────────────────────────────────────────────────────────────────

async function ensureLlama() {
  if (state._llama) return state._llama;
  const { getLlama } = await import('node-llama-cpp');
  state._llama = await getLlama();
  return state._llama;
}

async function disposeCurrent() {
  if (state._session)  { try { await state._session.dispose?.(); } catch {} state._session = null; }
  if (state._context)  { try { await state._context.dispose?.(); } catch {} state._context = null; }
  if (state._model)    { try { await state._model.dispose?.(); }   catch {} state._model = null; }
  state.loaded_model_id = null;
}

async function downloadAndLoad(spec) {
  await fsp.mkdir(MODELS_DIR, { recursive: true });
  const { resolveModelFile, LlamaChatSession } = await import('node-llama-cpp');
  const llama = await ensureLlama();

  state.state = 'downloading';
  state.progress = { bytes_done: 0, bytes_total: 0 };
  state.error = null;

  // node-llama-cpp's resolveModelFile downloads with progress callbacks
  // and caches under the directory we give it. It accepts hf:owner/repo/file.gguf
  // URIs and ordinary HTTP URLs.
  const modelPath = await resolveModelFile(spec.uri, {
    directory: MODELS_DIR,
    onProgress: ({ totalSize, downloadedSize }) => {
      state.progress = { bytes_done: downloadedSize, bytes_total: totalSize };
    },
  });

  state.state = 'loading';
  state.progress = { token: 'loading_into_memory' };

  await disposeCurrent();
  state._model   = await llama.loadModel({ modelPath });
  // 16k context: large enough for Phase 2's 30k-char paragraph batches
  // (~7-8k tokens of prompt + room for JSON-array output). Qwen 2.5
  // supports up to 32k; we keep it at 16k for KV-cache memory budget.
  state._context = await state._model.createContext({ contextSize: 16384 });
  state._session = new LlamaChatSession({ contextSequence: state._context.getSequence() });

  state.loaded_model_id  = spec.id;
  state.current_model_id = spec.id;
  state.state            = 'ready';
  state.progress         = null;
  state.error            = null;
  await persistSelection(spec.id);
}

// Mutex so concurrent /select calls don't race the GPU.
let _swapInFlight = null;

async function selectModel(model_id) {
  const spec = REGISTRY.find((m) => m.id === model_id);
  if (!spec) throw new Error(`unknown model: ${model_id}`);
  if (state.loaded_model_id === model_id && state.state === 'ready') return getStatus();
  if (_swapInFlight) await _swapInFlight.catch(() => {});
  _swapInFlight = (async () => {
    try {
      await downloadAndLoad(spec);
    } catch (e) {
      state.state = 'error';
      state.error = e?.message || String(e);
      console.warn(`llm_local: load failed for ${model_id}: ${state.error}`);
      throw e;
    } finally {
      _swapInFlight = null;
    }
  })();
  await _swapInFlight;
  return getStatus();
}

async function ensureReady() {
  if (isReady()) return;
  if (_swapInFlight) { await _swapInFlight; return; }
  const persisted = state.current_model_id || (await loadPersistedSelection()) || DEFAULT_MODEL_ID;
  await selectModel(persisted);
}

// ─────────────────────────────────────────────────────────────────────────
// Inference — same shape as the other proxy backends
// ─────────────────────────────────────────────────────────────────────────

// Single mutex around the resident session — node-llama-cpp's chat
// session is not safe to reuse concurrently from multiple awaits
// (KV-cache + sequence are shared). Phase 2 calls one paper at a time,
// so a simple serial queue is sufficient.
let _callChain = Promise.resolve();
async function call({ system, user, temperature = 0.7, onToken, jsonSchema, gbnf }) {
  await ensureReady();
  if (!state._session) throw new Error('llm_local: session not initialised');
  // Chain serially.
  const myTurn = _callChain.then(() => runOne({ system, user, temperature, onToken, jsonSchema, gbnf }));
  _callChain = myTurn.catch(() => {});  // don't let a failure poison the chain
  return myTurn;
}

async function runOne({ system, user, temperature, onToken, jsonSchema, gbnf }) {
  // Reuse the resident session; reset history per call so each
  // request is stateless (matches OpenAI/Anthropic semantics callers
  // expect). resetChatHistory keeps the system prompt slot intact if
  // one was passed.
  const sess = state._session;
  try { sess.resetChatHistory(); } catch { /* older API */ }
  if (system) {
    try {
      // setChatHistory wipes any prior history including a stale system msg
      sess.setChatHistory([{ type: 'system', text: system }]);
    } catch { /* fall through */ }
  }
  // Optional grammar: when the caller passes a JSON schema, build a
  // GBNF grammar that constrains every sampled token so the partial
  // output stays a valid instance. Removes the need for "no prose, no
  // markdown" system instructions and lets the model focus probability
  // mass on the actual extraction task.
  let grammar;
  if (jsonSchema) {
    try {
      grammar = await state._llama.createGrammarForJsonSchema(jsonSchema);
    } catch (e) {
      console.warn('llm_local: grammar build failed, falling back to free decoding:', e?.message || e);
      grammar = undefined;
    }
  } else if (typeof gbnf === 'string' && gbnf.trim().length > 0) {
    try {
      const { LlamaGrammar } = await import('node-llama-cpp');
      grammar = new LlamaGrammar({ llama: state._llama, grammar: gbnf });
    } catch (e) {
      console.warn('llm_local: gbnf build failed, falling back to free decoding:', e?.message || e);
      grammar = undefined;
    }
  }
  let full = '';
  const result = await sess.prompt(user, {
    temperature,
    grammar,
    onTextChunk: typeof onToken === 'function'
      ? (chunk) => { full += chunk; try { onToken(chunk); } catch {} }
      : (chunk) => { full += chunk; },
  });
  return result ?? full;
}

// ─────────────────────────────────────────────────────────────────────────
// Boot: lazily restore the user's last selection in the background so the
// first /api/v2/local-llm/* call doesn't block.
// ─────────────────────────────────────────────────────────────────────────

async function bootRestore() {
  const persisted = await loadPersistedSelection();
  if (persisted) {
    state.current_model_id = persisted;
    selectModel(persisted).catch((e) => {
      console.warn(`llm_local: background restore failed: ${e?.message || e}`);
    });
  }
}

export { getRegistry, getStatus, isReady, getCurrentModelId, selectModel, call, ensureReady, bootRestore, DEFAULT_MODEL_ID };
