// embed_phase3.mjs
//
// Generate the embeddings Phase 3 clustering consumes. Three new
// sidecars (JSONL, one record per line — same shape as the existing
// claims.jsonl):
//
//   _vectors/papers.jsonl          { paper_id, content_preview, embedding[] }
//   _vectors/methods.jsonl         { paper_id, content_preview, embedding[] }
//   _vectors/entity_contexts.jsonl { entity_span_id, paper_id, span_text, paragraph_id, content_preview, embedding[] }
//
// Claims embeddings already exist in _vectors/claims.jsonl, written by
// Phase 2 / earlier code. We don't rewrite them here.
//
// All embeddings via bge-small-en-v1.5 (384-dim, L2-normalised) — same
// model the rest of the project uses, so cluster centroids and the
// existing claim/chunk vector store live in the same geometry.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as store from './store.mjs';
import * as embedder from './embedder.mjs';
import { DATA_DIR } from '../paths.mjs';
import { ensureDir } from '../storage.mjs';

const VECTORS_DIR = path.join(DATA_DIR, '_vectors');
// Sidecar paths are Phase-3-specific (prefix 'phase3_') to avoid
// collision with the v1 chunk vector store at _vectors/papers.jsonl
// (which uses a different record schema: {id, hash, dim, v, meta}).
const PATHS = {
  papers:          path.join(VECTORS_DIR, 'phase3_papers.jsonl'),
  methods:         path.join(VECTORS_DIR, 'phase3_methods.jsonl'),
  entity_contexts: path.join(VECTORS_DIR, 'phase3_entity_contexts.jsonl'),
};

const PAPER_BUDGET    = 1500;   // chars for title + abstract
const METHOD_BUDGET   = 1800;   // chars for concatenated methods + experimental_setup paragraphs
const CONTEXT_BUDGET  = 400;    // chars around the entity span

// ─────────────────────────────────────────────────────────────────────────
// Sidecar helpers
// ─────────────────────────────────────────────────────────────────────────

async function readJsonl(p) {
  try {
    const txt = await fs.readFile(p, 'utf8');
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeJsonl(p, records) {
  await ensureDir(path.dirname(p));
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  await fs.writeFile(p, body + (records.length ? '\n' : ''), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────
// Paper-level embeddings (title + abstract)
// ─────────────────────────────────────────────────────────────────────────

async function embedPapers(opts = {}) {
  const force = !!opts.force;
  const existing = force ? [] : await readJsonl(PATHS.papers);
  const have = new Set(existing.map((r) => r.paper_id));
  // Build content from papers row + first paragraph fallback when
  // abstract is missing (grobid header CRF doesn't always extract one).
  const rows = store.query(`
    SELECT p.paper_id, p.title, p.abstract
      FROM papers p
     WHERE p.triage_label IN ('include', 'maybe')
     ORDER BY p.paper_id
  `);
  const todo = [];
  for (const r of rows) {
    if (have.has(r.paper_id)) continue;
    let content = '';
    if (r.title) content += r.title;
    if (r.abstract) content += '. ' + r.abstract;
    if (!content.trim()) {
      // Fallback: pull first non-references paragraph from grobid output.
      const fb = store.query(
        `SELECT text FROM paragraphs WHERE paper_id = ? AND canonical_type NOT IN ('references','appendix','other')
         ORDER BY paragraph_idx LIMIT 1`,
        [r.paper_id],
      )[0];
      if (fb) content = String(fb.text || '');
    }
    content = content.slice(0, PAPER_BUDGET);
    if (!content.trim()) continue;
    todo.push({ paper_id: r.paper_id, content });
  }
  if (todo.length === 0) return { written: 0, skipped: rows.length, total: existing.length };
  const emb = await embedder.embed(todo.map((t) => t.content));
  const dim = emb.dim;
  const records = existing.slice();
  for (let i = 0; i < todo.length; i++) {
    records.push({
      paper_id: todo[i].paper_id,
      content_preview: todo[i].content.slice(0, 240),
      embedding: Array.from(emb.data.slice(i * dim, (i + 1) * dim)),
    });
  }
  await writeJsonl(PATHS.papers, records);
  return { written: todo.length, skipped: rows.length - todo.length, total: records.length };
}

// ─────────────────────────────────────────────────────────────────────────
// Methods-section embeddings (one per paper)
// ─────────────────────────────────────────────────────────────────────────

async function embedMethods(opts = {}) {
  const force = !!opts.force;
  const existing = force ? [] : await readJsonl(PATHS.methods);
  const have = new Set(existing.map((r) => r.paper_id));
  const rows = store.query(`
    SELECT p.paper_id,
           group_concat(pg.text, '\n\n') AS methods_text
      FROM papers p
      INNER JOIN paragraphs pg ON pg.paper_id = p.paper_id
     WHERE p.triage_label IN ('include', 'maybe')
       AND pg.canonical_type IN ('methods', 'experimental_setup', 'background')
     GROUP BY p.paper_id
  `);
  const todo = [];
  for (const r of rows) {
    if (have.has(r.paper_id)) continue;
    const content = String(r.methods_text || '').slice(0, METHOD_BUDGET);
    if (content.length < 100) continue;     // not enough methods text to be meaningful
    todo.push({ paper_id: r.paper_id, content });
  }
  if (todo.length === 0) return { written: 0, skipped: rows.length, total: existing.length };
  const emb = await embedder.embed(todo.map((t) => t.content));
  const dim = emb.dim;
  const records = existing.slice();
  for (let i = 0; i < todo.length; i++) {
    records.push({
      paper_id: todo[i].paper_id,
      content_preview: todo[i].content.slice(0, 240),
      embedding: Array.from(emb.data.slice(i * dim, (i + 1) * dim)),
    });
  }
  await writeJsonl(PATHS.methods, records);
  return { written: todo.length, skipped: rows.length - todo.length, total: records.length };
}

// ─────────────────────────────────────────────────────────────────────────
// Entity-span context embeddings
// ─────────────────────────────────────────────────────────────────────────

async function embedEntityContexts(opts = {}) {
  const force = !!opts.force;
  const existing = force ? [] : await readJsonl(PATHS.entity_contexts);
  const have = new Set(existing.map((r) => r.entity_span_id));
  // Pull every entity span joined with its paragraph text for context.
  const rows = store.query(`
    SELECT es.entity_span_id, es.paper_id, es.paragraph_id, es.span_text,
           es.start_offset, es.end_offset, pg.text AS paragraph_text
      FROM entity_spans es
      INNER JOIN paragraphs pg ON pg.paragraph_id = es.paragraph_id
     ORDER BY es.entity_span_id
  `);
  const todo = [];
  for (const r of rows) {
    if (have.has(r.entity_span_id)) continue;
    // Build a context window: span text + ±200 chars surrounding text
    // from the paragraph. Falls back to whole paragraph if offsets
    // missing.
    let content;
    if (r.start_offset != null && r.end_offset != null && r.paragraph_text) {
      const pad = 200;
      const start = Math.max(0, r.start_offset - pad);
      const end = Math.min(r.paragraph_text.length, r.end_offset + pad);
      content = r.paragraph_text.slice(start, end);
    } else {
      content = String(r.paragraph_text || '').slice(0, CONTEXT_BUDGET);
    }
    content = content.slice(0, CONTEXT_BUDGET);
    if (!content.trim()) continue;
    todo.push({
      entity_span_id: r.entity_span_id,
      paper_id: r.paper_id,
      paragraph_id: r.paragraph_id,
      span_text: r.span_text,
      content,
    });
  }
  if (todo.length === 0) return { written: 0, skipped: rows.length, total: existing.length };
  // Embed in chunks of 256 to keep memory reasonable.
  const records = existing.slice();
  const BATCH = 256;
  for (let off = 0; off < todo.length; off += BATCH) {
    const batch = todo.slice(off, off + BATCH);
    const emb = await embedder.embed(batch.map((t) => t.content));
    const dim = emb.dim;
    for (let i = 0; i < batch.length; i++) {
      records.push({
        entity_span_id: batch[i].entity_span_id,
        paper_id: batch[i].paper_id,
        paragraph_id: batch[i].paragraph_id,
        span_text: batch[i].span_text,
        content_preview: batch[i].content.slice(0, 240),
        embedding: Array.from(emb.data.slice(i * dim, (i + 1) * dim)),
      });
    }
  }
  await writeJsonl(PATHS.entity_contexts, records);
  return { written: todo.length, skipped: rows.length - todo.length, total: records.length };
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Generate missing embeddings for papers / methods / entity contexts.
 * Idempotent: skips rows that already have an embedding in the sidecar.
 *
 * opts:
 *   force — rewrite all sidecars from scratch
 */
export async function generatePhase3Embeddings(opts = {}) {
  await store.init();
  const t0 = Date.now();
  const papers = await embedPapers(opts);
  const methods = await embedMethods(opts);
  const entities = await embedEntityContexts(opts);
  return {
    elapsed_ms: Date.now() - t0,
    papers, methods, entities,
  };
}

/** Load a sidecar as a matrix + metadata array. Returns null if empty. */
export async function loadSidecar(kind) {
  if (!(kind in PATHS)) throw new Error(`unknown sidecar kind: ${kind}`);
  const records = await readJsonl(PATHS[kind]);
  if (records.length === 0) return null;
  const dim = records[0].embedding?.length || 0;
  if (dim === 0) return null;
  const data = new Float32Array(records.length * dim);
  const meta = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    data.set(r.embedding, i * dim);
    meta[i] = { ...r, embedding: undefined };
  }
  return { matrix: { data, rows: records.length, dim }, meta };
}

export const SIDECAR_PATHS = PATHS;
