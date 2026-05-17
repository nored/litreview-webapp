// Server-side LLM proxy. Browser hits /api/llm/chat; we dispatch to the
// configured provider so API keys never leave the user's machine.
//
// Providers:
//   webllm    — Node-side llama.cpp (Metal/CUDA/CPU). Resident model;
//               user picks which model from the browser, server loads it.
//               The 'webllm' label is kept for backwards compatibility
//               with the five-way per-stage AI switch.
//   openai    — OpenAI-compatible (OpenAI, Ollama, OpenRouter, Groq, vLLM,
//               Together, LM Studio, llama.cpp server, …)
//   anthropic — Anthropic Claude (different message shape)
//
// All providers stream tokens via SSE-style chunked responses; we forward
// each delta to our caller as a JSON event.

import { read as readCredentials } from './credentials.mjs';
import * as llmLocal from './llm_local.mjs';

/**
 * Dispatch a chat call. Optional `fallback` is an array of provider names
 * to try in order if the primary fails with no tokens streamed. Mid-stream
 * failures (after onToken has fired) are NOT retried on a different
 * provider — restarting would corrupt the caller's output stream.
 *
 * Default behaviour (no fallback configured): same as before — single
 * provider, throws on failure.
 */
export async function callLlm({ provider, system, user, temperature = 0.7, onToken, onComplete, fallback, jsonSchema, gbnf }) {
  const creds = await readCredentials();
  const chain = [provider, ...(Array.isArray(fallback) ? fallback : resolveDefaultFallback(creds, provider))].filter(Boolean);
  // Dedup while preserving order.
  const seen = new Set();
  const ordered = chain.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));

  let lastErr = null;
  // Track which providers were tried + the one that actually served the
  // response so the caller can surface "served by fallback X" in the UI.
  const attempted = [];
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    if (!providerHasCredentials(creds, p)) {
      // Silently skip a fallback that isn't configured.
      if (i === 0) {
        // The primary itself isn't configured — fail with a clear message.
        throw new Error(`provider "${p}" has no credentials configured (set them in Setup)`);
      }
      attempted.push({ provider: p, status: 'skipped_no_credentials' });
      continue;
    }
    let streamed = 0;
    const wrappedOnToken = onToken
      ? (delta, total) => { if (delta) streamed += delta.length; onToken(delta, total); }
      : null;
    try {
      const result = await dispatch(p, { creds, system, user, temperature, onToken: wrappedOnToken, jsonSchema, gbnf });
      attempted.push({ provider: p, status: 'served' });
      const trace = { provider_used: p, attempts: attempted };
      if (typeof onComplete === 'function') {
        try { onComplete(trace); } catch { /* user callback */ }
      }
      return result;
    } catch (e) {
      lastErr = e;
      attempted.push({ provider: p, status: 'failed', error: e.message });
      if (streamed > 0) {
        const trace = { provider_used: p, attempts: attempted, mid_stream_failure: true };
        if (typeof onComplete === 'function') { try { onComplete(trace); } catch { /* */ } }
        throw e;
      }
      if (i < ordered.length - 1) {
        console.warn(`llm_proxy: provider "${p}" failed (${e.message}); trying fallback "${ordered[i + 1]}"`);
        continue;
      }
    }
  }
  const trace = { provider_used: null, attempts: attempted, all_failed: true };
  if (typeof onComplete === 'function') { try { onComplete(trace); } catch { /* */ } }
  throw lastErr || new Error('all providers failed');
}

// Backwards compatibility: getLastTrace() existed in a previous round.
// Now stateless — returns null. Callers should use onComplete instead.
export function getLastTrace() { return null; }

function dispatch(provider, args) {
  // jsonSchema + gbnf are honoured only by webllm (node-llama-cpp
  // grammar). Cloud providers ignore them.
  if (provider === 'webllm') return llmLocal.call(args);
  if (provider === 'openai') return callOpenAi(args);
  if (provider === 'anthropic') return callAnthropic(args);
  throw new Error(`unknown provider: ${provider}`);
}

/**
 * Pick the strongest provider the user has configured. Returns one of
 * 'anthropic' | 'openai' | null. Used by stages that want to know
 * "should we try AI here?" without having to dispatch a real call.
 *
 * opts.provider can force a specific provider (or null for off/webllm/
 * share-to-chat, which all return null — those aren't server-side
 * providers).
 */
export async function pickAvailableProvider(opts = {}) {
  if (opts.provider && opts.provider !== 'auto') {
    if (opts.provider === 'off' || opts.provider === 'share-to-chat') return null;
    if (opts.provider === 'webllm') {
      // 'webllm' is now a real server-side provider (Node llama.cpp).
      // We accept it whether or not the model is currently resident —
      // the call will load it lazily on first use.
      return 'webllm';
    }
    return opts.provider;
  }
  const creds = await readCredentials();
  // Prefer the always-available local model when it's resident; fall
  // back to remote providers if the user configured keys.
  if (llmLocal.isReady()) return 'webllm';
  if (providerHasCredentials(creds, 'anthropic')) return 'anthropic';
  if (providerHasCredentials(creds, 'openai')) return 'openai';
  // Last-resort: still return webllm so the caller can lazy-load. The
  // caller is free to short-circuit if it does not want to block on a
  // multi-GB download.
  if (llmLocal.getCurrentModelId()) return 'webllm';
  return null;
}

function providerHasCredentials(creds, provider) {
  // 'webllm' (local llama.cpp) needs no credentials; the model is
  // resident or being downloaded.
  if (provider === 'webllm') return true;
  if (provider === 'openai') {
    // Local OpenAI-compatible servers (Ollama, etc.) often don't need a key,
    // but they DO need a base_url override that differs from the default.
    // We accept "has a key" OR "has a non-default base_url" as configured.
    const hasKey = !!(creds.openai_api_key && creds.openai_api_key.trim());
    const hasUrl = !!(creds.openai_base_url && creds.openai_base_url.trim() && creds.openai_base_url.trim() !== 'https://api.openai.com/v1');
    return hasKey || hasUrl;
  }
  if (provider === 'anthropic') {
    return !!(creds.anthropic_api_key && creds.anthropic_api_key.trim());
  }
  return false;
}

// If the caller didn't specify a fallback explicitly, look at credentials
// for a configured provider_fallback (CSV string or array). Returns an
// array of provider names (without the primary) — primary handles its own
// position in the chain. Default: empty (no fallback).
function resolveDefaultFallback(creds, primary) {
  const raw = creds.provider_fallback;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return arr.filter((p) => p !== primary);
}

// ─────────────────────────────────────────────────────────────────────
// Rate-limit + transient-error retry helper. Retries on:
//   - HTTP 429 (rate limited) — honours Retry-After if set
//   - HTTP 502/503/504 (gateway / overloaded)
//   - network errors (fetch throws)
// Up to 3 attempts with exponential backoff (1s, 3s, 7s).
// ─────────────────────────────────────────────────────────────────────
async function fetchWithRetry(url, init, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      // Decide if we should retry.
      const transient = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (!transient || attempt === maxAttempts) return res;
      // Honour Retry-After (seconds or HTTP date); fall back to backoff.
      const retryAfter = res.headers.get('retry-after');
      let waitMs = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
      if (retryAfter) {
        const asInt = parseInt(retryAfter, 10);
        if (Number.isFinite(asInt) && asInt > 0) waitMs = Math.min(asInt * 1000, 30_000);
      }
      console.warn(`llm_proxy: ${url} HTTP ${res.status} — retrying in ${Math.round(waitMs)}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts) throw e;
      const waitMs = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
      console.warn(`llm_proxy: ${url} network error "${e.message}" — retrying in ${Math.round(waitMs)}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  if (lastErr) throw lastErr;
  // Unreachable in practice; fetched res handled above.
  throw new Error('fetchWithRetry: exhausted retries');
}

// Human-readable wrapper for a non-OK HTTP response — picks the right
// "this provider error means..." message based on status.
async function formatProviderError(provider, res) {
  const text = await res.text().catch(() => '');
  const snippet = text.slice(0, 300);
  if (res.status === 401 || res.status === 403) {
    return `${provider} authentication failed (HTTP ${res.status}). Check the API key in Setup.`;
  }
  if (res.status === 429) {
    return `${provider} rate-limited (HTTP 429) after retries. Wait a minute and try again, or switch providers in the topbar AI pill.`;
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return `${provider} provider unavailable (HTTP ${res.status}) after retries. Try again shortly or switch providers.`;
  }
  if (res.status >= 500) {
    return `${provider} server error (HTTP ${res.status}): ${snippet}`;
  }
  return `${provider} API ${res.status}: ${snippet}`;
}

async function callOpenAi({ creds, system, user, temperature, onToken }) {
  const baseUrl = (creds.openai_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = creds.openai_api_key || '';
  const model = creds.openai_model || 'gpt-4o-mini';
  const url = `${baseUrl}/chat/completions`;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature,
      stream: true,
    }),
  });

  if (!res.ok) throw new Error(await formatProviderError('OpenAI-compatible', res));

  let full = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          full += delta;
          onToken?.(delta, full);
        }
      } catch {
        /* tolerant of partial frames; keep going */
      }
    }
  }
  return full;
}

async function callAnthropic({ creds, system, user, temperature, onToken }) {
  const apiKey = creds.anthropic_api_key || '';
  const model = creds.anthropic_model || 'claude-haiku-4-5';
  if (!apiKey) throw new Error('anthropic_api_key not set in credentials');

  const url = 'https://api.anthropic.com/v1/messages';
  const body = {
    model,
    max_tokens: 4096,
    temperature,
    stream: true,
    messages: [{ role: 'user', content: user }],
  };
  if (system) body.system = system;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(await formatProviderError('Anthropic', res));

  let full = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      try {
        const json = JSON.parse(payload);
        // Anthropic events: content_block_delta carries text deltas.
        if (json.type === 'content_block_delta') {
          const delta = json.delta?.text ?? '';
          if (delta) {
            full += delta;
            onToken?.(delta, full);
          }
        }
      } catch {
        /* tolerant */
      }
    }
  }
  return full;
}

// Probe an OpenAI-compatible endpoint by listing models. Lets the UI tell
// the student "Ollama at localhost:11434 looks healthy" without spending
// a chat call.
export async function probeOpenAi() {
  const creds = await readCredentials();
  const baseUrl = (creds.openai_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = creds.openai_api_key || '';
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${baseUrl}/models`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Try to extract a useful one-liner from common error shapes
      let hint = '';
      try {
        const parsed = JSON.parse(body);
        hint = parsed?.error?.message || parsed?.message || '';
      } catch { hint = body.slice(0, 160); }
      return {
        ok: false,
        error: `HTTP ${res.status}${hint ? ` — ${hint.slice(0, 200)}` : ''}`,
        url: baseUrl,
      };
    }
    const data = await res.json();
    const models = (data.data || []).map((m) => m.id || m.name).filter(Boolean);
    return { ok: true, models, url: baseUrl };
  } catch (err) {
    return { ok: false, error: err.message, url: baseUrl };
  }
}
