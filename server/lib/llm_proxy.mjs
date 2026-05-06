// Server-side LLM proxy. Browser hits /api/llm/chat; we dispatch to the
// configured provider so API keys never leave the user's machine.
//
// Providers:
//   openai  — OpenAI-compatible (OpenAI, Ollama, OpenRouter, Groq, vLLM,
//             Together, LM Studio, llama.cpp server, …)
//   anthropic — Anthropic Claude (different message shape)
//
// All providers stream tokens via SSE-style chunked responses; we forward
// each delta to our caller as a JSON event.

import { read as readCredentials } from './credentials.mjs';

export async function callLlm({ provider, system, user, temperature = 0.7, onToken }) {
  const creds = await readCredentials();
  if (provider === 'openai') {
    return callOpenAi({ creds, system, user, temperature, onToken });
  }
  if (provider === 'anthropic') {
    return callAnthropic({ creds, system, user, temperature, onToken });
  }
  throw new Error(`unknown provider: ${provider}`);
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

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature,
      stream: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`openai API ${res.status}: ${text.slice(0, 400)}`);
  }

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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`anthropic API ${res.status}: ${text.slice(0, 400)}`);
  }

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
