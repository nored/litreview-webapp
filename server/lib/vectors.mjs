// vectors.mjs
//
// Persistence + retrieval layer over sbert_utils. Stores embeddings for each
// "kind" (papers, chunks, notes, external, …) in its own jsonl file under
// project/data/_vectors/. The on-disk format is intentionally simple so the
// CLI tooling and the user can both inspect and clobber it.
//
// File format (one record per line):
//   {"id":"paper_001","hash":"sha256:…","dim":384,"v":"<base64 float32>","meta":{…}}
//
// In memory each kind lives in a Map<id, {hash, meta, embedding: Float32Array}>.
// Mutations go through a per-kind serial lock so concurrent upserts can't
// corrupt the file. Writes are atomic via tmp-then-rename.
//
// At thesis scale (10k–40k vectors) we just keep the whole store hot in
// memory; load is O(N) and re-write on every commit is in the tens of ms.
// If/when scale forces it, drop in usearch-wasm by replacing loadMatrix +
// search; everything else stays.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DATA_DIR } from '../paths.mjs';
import * as U from './sbert_utils.mjs';

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------

const VECTORS_DIR = path.join(DATA_DIR, '_vectors');

function fileFor(kind) {
  if (!/^[a-z][a-z0-9_]*$/.test(kind)) {
    throw new Error(`vectors: invalid kind '${kind}' (use snake_case)`);
  }
  return path.join(VECTORS_DIR, `${kind}.jsonl`);
}

// ---------------------------------------------------------------------------
// In-memory caches and per-kind write lock
// ---------------------------------------------------------------------------

// kind → { records: Map<id, {hash, meta, embedding}>, dim: number | null }
const stores = new Map();
// kind → Promise tail (each mutation chains onto the previous one)
const locks = new Map();

function withLock(kind, fn) {
  const prev = locks.get(kind) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Replace tail with a settled-no-matter-what version so a rejected
  // mutation doesn't poison the chain for later callers.
  locks.set(kind, next.catch(() => {}));
  return next;
}

// ---------------------------------------------------------------------------
// Load / persist
// ---------------------------------------------------------------------------

async function loadStore(kind) {
  if (stores.has(kind)) return stores.get(kind);
  const records = new Map();
  let dim = null;
  let raw = '';
  try {
    raw = await fs.readFile(fileFor(kind), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (raw) {
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o.id || typeof o.v !== 'string') continue;
      // base64 → Float32Array. Copy so we don't share the Buffer's pool.
      const buf = Buffer.from(o.v, 'base64');
      const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const embedding = new Float32Array(view); // detach from Buffer pool
      if (dim === null) dim = embedding.length;
      else if (embedding.length !== dim) continue; // skip dim-mismatched stragglers
      records.set(o.id, {
        hash: o.hash || null,
        meta: o.meta || {},
        embedding,
      });
    }
  }
  const store = { records, dim };
  stores.set(kind, store);
  return store;
}

async function persistStore(kind) {
  const store = stores.get(kind);
  if (!store) return;
  await fs.mkdir(VECTORS_DIR, { recursive: true });
  const lines = new Array(store.records.size);
  let i = 0;
  for (const [id, rec] of store.records) {
    const e = rec.embedding;
    const b64 = Buffer.from(e.buffer, e.byteOffset, e.byteLength).toString('base64');
    lines[i++] = JSON.stringify({
      id,
      hash: rec.hash,
      dim: e.length,
      v: b64,
      meta: rec.meta,
    });
  }
  const file = fileFor(kind);
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, lines.length ? lines.join('\n') + '\n' : '');
  await fs.rename(tmp, file);
}

function asFloat32(embedding) {
  if (embedding instanceof Float32Array) return new Float32Array(embedding);
  return new Float32Array(embedding);
}

function checkDim(store, dim) {
  if (store.dim === null) {
    store.dim = dim;
  } else if (store.dim !== dim) {
    throw new Error(
      `vectors: embedding dim ${dim} doesn't match store dim ${store.dim}; ` +
        `clear the store before swapping embedding models`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API — single-record ops
// ---------------------------------------------------------------------------

export async function upsert(kind, id, embedding, meta = {}, hash = null) {
  return withLock(kind, async () => {
    const store = await loadStore(kind);
    const e = asFloat32(embedding);
    checkDim(store, e.length);
    store.records.set(id, { hash, meta, embedding: e });
    await persistStore(kind);
  });
}

// Bulk upsert — a single fsync for the whole batch. Use this for daemon work.
export async function upsertBatch(kind, items) {
  if (!items.length) return;
  return withLock(kind, async () => {
    const store = await loadStore(kind);
    for (const it of items) {
      const e = asFloat32(it.embedding);
      checkDim(store, e.length);
      store.records.set(it.id, {
        hash: it.hash ?? null,
        meta: it.meta ?? {},
        embedding: e,
      });
    }
    await persistStore(kind);
  });
}

export async function deleteRecord(kind, id) {
  return withLock(kind, async () => {
    const store = await loadStore(kind);
    if (store.records.delete(id)) await persistStore(kind);
  });
}

export async function clear(kind) {
  return withLock(kind, async () => {
    stores.delete(kind);
    try { await fs.unlink(fileFor(kind)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  });
}

// ---------------------------------------------------------------------------
// Public API — read-side
// ---------------------------------------------------------------------------

// Returns the stored record or null. Embedding is a fresh copy.
export async function getRecord(kind, id) {
  const store = await loadStore(kind);
  const rec = store.records.get(id);
  if (!rec) return null;
  return {
    id,
    hash: rec.hash,
    meta: rec.meta,
    embedding: new Float32Array(rec.embedding),
  };
}

// True if the store already has a record for `id` whose hash matches.
// The embed daemon uses this to skip work when content hasn't changed.
export async function hasFresh(kind, id, hash) {
  const store = await loadStore(kind);
  const rec = store.records.get(id);
  return Boolean(rec && rec.hash && rec.hash === hash);
}

export async function count(kind) {
  const store = await loadStore(kind);
  return store.records.size;
}

export async function listIds(kind) {
  const store = await loadStore(kind);
  return Array.from(store.records.keys());
}

// Loads everything into a flat sbert_utils Matrix plus parallel id/meta arrays.
// `filter(id, meta)` lets callers narrow the corpus (e.g. "only includes").
export async function loadMatrix(kind, filter = null) {
  const store = await loadStore(kind);
  if (store.dim === null || store.records.size === 0) {
    return { ids: [], meta: [], matrix: U.makeMatrix(0, store.dim || 0) };
  }
  const dim = store.dim;
  const ids = [];
  const meta = [];
  const embeddings = [];
  for (const [id, rec] of store.records) {
    if (filter && !filter(id, rec.meta)) continue;
    ids.push(id);
    meta.push(rec.meta);
    embeddings.push(rec.embedding);
  }
  if (embeddings.length === 0) {
    return { ids: [], meta: [], matrix: U.makeMatrix(0, dim) };
  }
  const data = new Float32Array(embeddings.length * dim);
  for (let i = 0; i < embeddings.length; i++) {
    data.set(embeddings[i], i * dim);
  }
  return { ids, meta, matrix: U.makeMatrix(embeddings.length, dim, data) };
}

// ---------------------------------------------------------------------------
// Public API — semantic ops (thin wrappers around sbert_utils)
// ---------------------------------------------------------------------------

// Top-K records most similar to a query embedding. Returns
// [{id, score, meta}, …] sorted descending. `filter` narrows the corpus
// before search; `excludeIds` drops specific ids (e.g. "find similar to me,
// but don't return me").
export async function search(kind, queryEmbedding, opts = {}) {
  const {
    topK = 10,
    filter = null,
    excludeIds = null,
    scoreFn = 'cos_sim',
  } = opts;
  const exclude = excludeIds ? new Set(excludeIds) : null;
  const combinedFilter = (id, meta) => {
    if (exclude && exclude.has(id)) return false;
    if (filter && !filter(id, meta)) return false;
    return true;
  };
  const { ids, meta, matrix } = await loadMatrix(kind, combinedFilter);
  if (matrix.rows === 0) return [];
  const q = asFloat32(queryEmbedding);
  if (q.length !== matrix.dim) {
    throw new Error(`vectors.search: query dim ${q.length} != store dim ${matrix.dim}`);
  }
  const Q = U.makeMatrix(1, matrix.dim, q);
  const hits = U.semanticSearch(Q, matrix, { topK, scoreFn })[0];
  return hits.map((h) => ({ id: ids[h.corpus_id], score: h.score, meta: meta[h.corpus_id] }));
}

// Centroid of a subset (mean of a list of embeddings, normalized to unit length).
// Used for include/exclude prototypes in the triage pre-filter.
export async function centroid(kind, ids) {
  const store = await loadStore(kind);
  if (!store.dim) return null;
  const acc = new Float32Array(store.dim);
  let n = 0;
  for (const id of ids) {
    const rec = store.records.get(id);
    if (!rec) continue;
    for (let k = 0; k < store.dim; k++) acc[k] += rec.embedding[k];
    n++;
  }
  if (n === 0) return null;
  for (let k = 0; k < store.dim; k++) acc[k] /= n;
  // Normalize so cosine via dot is correct downstream.
  let norm = 0;
  for (let k = 0; k < store.dim; k++) norm += acc[k] * acc[k];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let k = 0; k < store.dim; k++) acc[k] /= norm;
  return acc;
}

// High-similarity pairs across the kind (for semantic dedup, contradiction
// candidates, etc.). Returns [{a_id, b_id, score, a_meta, b_meta}, …].
export async function paraphrasePairs(kind, opts = {}) {
  const { ids, meta, matrix } = await loadMatrix(kind, opts.filter);
  if (matrix.rows < 2) return [];
  const pairs = U.paraphraseMining(matrix, opts);
  return pairs.map(([score, i, j]) => ({
    a_id: ids[i],
    b_id: ids[j],
    score,
    a_meta: meta[i],
    b_meta: meta[j],
  }));
}

// Discover communities (clusters) in the kind. Threshold + minCommunitySize
// are passed through to sbert_utils.communityDetection.
export async function communities(kind, opts = {}) {
  const { ids, meta, matrix } = await loadMatrix(kind, opts.filter);
  if (matrix.rows === 0) return [];
  const groups = U.communityDetection(matrix, opts);
  return groups.map((group) => ({
    central_id: ids[group[0]],
    ids: group.map((i) => ids[i]),
    meta: group.map((i) => meta[i]),
  }));
}

// ---------------------------------------------------------------------------
// Test hook (only used by smoke tests / future fixtures)
// ---------------------------------------------------------------------------

// Drops in-memory caches without touching disk. Lets tests force a reload.
export function _evictCache() {
  stores.clear();
  locks.clear();
}
