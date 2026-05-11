// vectors.mjs (browser)
//
// Thin HTTP client over the local Node server's /api/vectors/* routes.
// All embedding compute happens server-side (server/lib/embedder.mjs);
// the browser just sends text and receives Float32Array back. No worker,
// no Transformers.js download in this tab — the model lives once on disk
// in ~/.cache/huggingface/ and is shared by every browser session.
//
// Why this shape: same trust boundary (everything is on localhost), Node
// ORT is faster than browser WASM, the model only gets downloaded once
// across reboots, and tabs that close mid-embed don't lose work.
//
// API surface (unchanged from earlier worker-based version):
//   embed(texts)          → { data: Float32Array, rows, dim }
//   embedOne(text)        → Float32Array
//   preload()             → kicks off model load on the server
//   upsert / search / paraphrasePairs / communities / hasFresh / count /
//   deleteRecord / clear  → HTTP wrappers around server vectors store

// ---------------------------------------------------------------------------
// Helpers — base64 ↔ Float32Array
// ---------------------------------------------------------------------------

function _f32ToB64(v) {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function _b64ToF32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Copy to a fresh ArrayBuffer so the float view aligns and outlives `bytes`.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Float32Array(ab);
}

async function _api(method, path, body) {
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Embedding (server-side, called over HTTP)
// ---------------------------------------------------------------------------

/**
 * Embed a batch of texts via the local Node embedder.
 * Returns { data: Float32Array, rows, dim } — row-major flat layout matching
 * server/lib/sbert_utils.mjs Matrix shape.
 *
 * First call after server boot lazy-loads the model (~once per server start;
 * file cache makes subsequent boots fast). Use preload() to front-load that
 * latency at app open.
 */
export async function embed(texts) {
  if (!Array.isArray(texts)) texts = [texts];
  if (texts.length === 0) throw new Error('embed: texts must be non-empty');
  const r = await _api('POST', '/api/vectors/embed', { texts });
  return { data: _b64ToF32(r.data), rows: r.rows, dim: r.dim };
}

/** Convenience: embed one string and return its Float32Array row. */
export async function embedOne(text) {
  const m = await embed([text]);
  return m.data; // length === m.dim
}

/** Pre-warm the server-side model. Returns { ok, model, dim } when ready. */
export async function preload() {
  return _api('POST', '/api/vectors/preload');
}

// ---------------------------------------------------------------------------
// Server vectors store (HTTP)
// ---------------------------------------------------------------------------

/**
 * Upsert one or more records. items: [{id, embedding: Float32Array, meta?, hash?}]
 */
export async function upsert(kind, items) {
  if (!items?.length) return { ok: true, count: 0 };
  const body = {
    kind,
    items: items.map((it) => ({
      id: it.id,
      embedding: _f32ToB64(it.embedding),
      meta: it.meta ?? null,
      hash: it.hash ?? null,
    })),
  };
  return _api('POST', '/api/vectors/upsert', body);
}

export async function deleteRecord(kind, id) {
  return _api('POST', '/api/vectors/delete', { kind, id });
}

export async function clear(kind) {
  return _api('POST', '/api/vectors/clear', { kind });
}

export async function count(kind) {
  const r = await _api('GET', `/api/vectors/count?kind=${encodeURIComponent(kind)}`);
  return r.count;
}

export async function hasFresh(kind, id, hash) {
  const params = new URLSearchParams({ kind, id, hash });
  const r = await _api('GET', `/api/vectors/has-fresh?${params}`);
  return r.fresh === true;
}

/** Top-K semantic search. opts: { topK?, filter?, scoreFn?, excludeIds? } */
export async function search(kind, queryEmbedding, opts = {}) {
  return _api('POST', '/api/vectors/search', {
    kind,
    query: _f32ToB64(queryEmbedding),
    opts,
  });
}

/** Discover communities. opts pass through to communityDetection. */
export async function communities(kind, opts = {}) {
  return _api('POST', '/api/vectors/communities', { kind, opts });
}

/** Find similar pairs. opts pass through to paraphraseMining. */
export async function paraphrasePairs(kind, opts = {}) {
  return _api('POST', '/api/vectors/paraphrase-pairs', { kind, opts });
}
