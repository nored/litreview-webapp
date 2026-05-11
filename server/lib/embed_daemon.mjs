// Background embedding daemon. Third sibling to search_runner and
// download_daemon. Watches the data directory for things that need
// embedding and feeds them to the Node-side encoder, persisting vectors
// via lib/vectors.mjs so downstream features (semantic dedup, gap matrix,
// triage pre-filter, …) just see a fresh store.
//
// Tracked "kinds":
//   papers — one record per row in candidates_triaged.csv, embedding
//            built from `title\n\nabstract`. Used for triage pre-filter,
//            semantic dedup, snowball ranking.
//   notes  — one record per notes/paper_NNN.md, embedding built from the
//            concatenated body. Used for cross-paper context, theme
//            discovery, contradiction surfacing.
//   chunks — many records per pdfs/paper_NNN.pdf (added in a follow-up
//            once pdf_chunks.mjs lands). Per-section retrieval.
//
// Idempotent by content hash: hasFresh(kind, id, hash) skips work when
// nothing changed. The vectors store is the source of truth for
// completion; the manifest only records session-level progress for the
// status pill.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_FILES, NOTES_DIR, PDFS_DIR,
} from '../paths.mjs';
import { readText, fileExists } from '../storage.mjs';
import { parseCsv } from './csv.mjs';
import { parseNoteMd } from './notes.mjs';
import { chunksForPdf } from './pdf_chunks.mjs';
import * as vectors from './vectors.mjs';
import * as embedder from './embedder.mjs';
import {
  readEmbedJob, writeEmbedJob, clearEmbedJob, newEmbedJob,
} from './jobs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Re-embed-on-save debounce window. Multiple saves within this window
// collapse into a single embed call. 5s matches the project decision.
const NOTE_DEBOUNCE_MS = 5000;

const state = {
  job: null,                    // current job manifest (in memory)
  queue: [],                    // pending work items: { kind, id, text, meta }
  attempted: new Set(),         // session-level "kind:id" already done
  inflight: null,               // current item being embedded
  loop: null,                   // active runner promise
  paused: false,
  discarding: false,
  listeners: new Set(),
  eventBuffer: [],              // recent events for late-joining SSE clients
  noteDebounceTimers: new Map(),// paperId -> Timeout
};

// ---------------------------------------------------------------------------
// Pub/sub
// ---------------------------------------------------------------------------

function broadcast(event) {
  state.eventBuffer.push({ ...event, ts: Date.now() });
  if (state.eventBuffer.length > 500) state.eventBuffer.shift();
  for (const fn of state.listeners) {
    try { fn(event); } catch { /* listener errors shouldn't kill the daemon */ }
  }
}

export function subscribe(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

export function getEventBuffer() {
  return state.eventBuffer.slice();
}

export function status() {
  return {
    running: !!state.loop,
    paused: state.paused,
    queue_size: state.queue.length,
    inflight: state.inflight,
    attempted: state.attempted.size,
    job: state.job ? {
      id: state.job.id,
      status: state.job.status,
      started_at: state.job.started_at,
      finished_at: state.job.finished_at,
      interrupted_at: state.job.interrupted_at,
      papers_embedded: state.job.papers_embedded,
      notes_embedded: state.job.notes_embedded,
      chunks_embedded: state.job.chunks_embedded,
      last_error: state.job.last_error,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

async function loadJob() {
  let job = await readEmbedJob();
  if (!job) {
    job = newEmbedJob();
    await writeEmbedJob(job);
  }
  state.job = job;
}

// ---------------------------------------------------------------------------
// Hashing & item identity
// ---------------------------------------------------------------------------

function hash(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function itemKey(kind, id) {
  return `${kind}:${id}`;
}

// ---------------------------------------------------------------------------
// Sources — convert disk state into queue items
// ---------------------------------------------------------------------------

async function collectPaperItems() {
  if (!await fileExists(DATA_FILES.candidates_triaged)) return [];
  const text = await readText(DATA_FILES.candidates_triaged, '');
  const { rows } = parseCsv(text);
  const items = [];
  // We use row_index (0-based CSV row) as the stable id rather than
  // triage's reassigned-on-save paper_id, because pending rows have an
  // empty paper_id and we need them embedded too — the pre-triage filter
  // scores pending rows against include/exclude centroids.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const body = `${row.title || ''}\n\n${row.abstract || ''}`.trim();
    if (!body) continue;
    items.push({
      kind: 'papers',
      id: String(i),
      text: body,
      meta: {
        row_index: i,
        paper_id: row.paper_id || '',
        title: row.title || '',
        year: row.year || '',
        doi: row.doi || '',
        venue: row.venue || '',
        triage_label: row.triage_label || '',
      },
    });
  }
  return items;
}

async function collectNoteItems() {
  if (!await fileExists(NOTES_DIR)) return [];
  let entries;
  try {
    entries = await fs.readdir(NOTES_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const items = [];
  for (const name of entries) {
    const m = name.match(/^paper_(.+)\.md$/);
    if (!m) continue;
    const paperId = m[1];
    const md = await readText(path.join(NOTES_DIR, name), '');
    const note = parseNoteMd(md);
    const text = noteEmbedText(note);
    if (!text) continue;
    items.push({
      kind: 'notes',
      id: paperId,
      text,
      meta: {
        title: note.frontmatter?.title || '',
        category: note.frontmatter?.category || [],
        method_family: note.frontmatter?.method?.family || '',
      },
    });
  }
  return items;
}

// What text we feed the embedder for a note: title + body sections.
// Includes the title for retrieval anchoring; structured frontmatter is
// noisy in embedding space so we skip it.
function noteEmbedText(note) {
  const title = note.frontmatter?.title || '';
  const body = Object.values(note.body || {})
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join('\n\n');
  return `${title}\n\n${body}`.trim();
}

async function collectPdfChunkItems() {
  if (!await fileExists(PDFS_DIR)) return [];
  let entries;
  try {
    entries = await fs.readdir(PDFS_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const items = [];
  for (const name of entries) {
    const m = name.match(/^paper_(.+)\.pdf$/);
    if (!m) continue;
    const paperId = m[1];
    // Skip work cheaply when at least one chunk for this paper is fresh.
    // We content-hash the whole file once and use it as a "did this PDF
    // already get chunked" signal — chunkSection results are deterministic
    // for a given file so any single fresh chunk implies the rest are too.
    const pdfPath = path.join(PDFS_DIR, name);
    const fileHash = await fileContentHash(pdfPath);
    if (await vectors.hasFresh('chunks', `${paperId}:000`, fileHash)) continue;
    let chunks;
    try {
      chunks = await chunksForPdf(pdfPath, paperId);
    } catch (err) {
      broadcast({ type: 'error', error: `pdf chunk extract failed for paper_${paperId}: ${err.message}` });
      continue;
    }
    for (const c of chunks) {
      items.push({
        kind: 'chunks',
        id: c.id,
        text: c.text,
        // hash is the whole-file hash so all chunks share it; refresh logic
        // below treats "any chunk for this paper has the right hash" as
        // "no need to re-chunk".
        hash: fileHash,
        meta: c.meta,
      });
    }
  }
  return items;
}

async function fileContentHash(filePath) {
  const buf = await fs.readFile(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

async function enqueueIfStale(item) {
  const k = itemKey(item.kind, item.id);
  // Don't double-queue something already pending or currently being embedded.
  if (state.inflight === k) return false;
  if (state.queue.some((q) => itemKey(q.kind, q.id) === k)) return false;
  // The vectors store is the source of truth for "has fresh content for
  // this id". The in-memory `attempted` set is only used to suppress
  // duplicate work *within* a running loop iteration — never as a stale
  // check, because content edits would be missed.
  const h = item.hash || hash(item.text);
  if (await vectors.hasFresh(item.kind, item.id, h)) return false;
  state.queue.push({ ...item, hash: h });
  return true;
}

// Public API: rescan all sources and enqueue anything new or changed.
// Idempotent — vectors.hasFresh dedupes by content hash.
export async function syncAll() {
  let added = 0;
  const paperItems = await collectPaperItems();
  for (const it of paperItems) if (await enqueueIfStale(it)) added++;
  const noteItems = await collectNoteItems();
  for (const it of noteItems) if (await enqueueIfStale(it)) added++;
  const chunkItems = await collectPdfChunkItems();
  for (const it of chunkItems) if (await enqueueIfStale(it)) added++;
  if (added > 0) broadcast({ type: 'queue_sync', added, queue_size: state.queue.length });
  if (state.queue.length > 0 && !state.paused && !state.loop) runLoop();
  return added;
}

export async function syncPdfs() {
  let added = 0;
  for (const it of await collectPdfChunkItems()) if (await enqueueIfStale(it)) added++;
  if (added > 0) broadcast({ type: 'queue_sync', added, kind: 'chunks', queue_size: state.queue.length });
  if (state.queue.length > 0 && !state.paused && !state.loop) runLoop();
  return added;
}

export async function syncPapers() {
  let added = 0;
  for (const it of await collectPaperItems()) if (await enqueueIfStale(it)) added++;
  if (added > 0) broadcast({ type: 'queue_sync', added, kind: 'papers', queue_size: state.queue.length });
  if (state.queue.length > 0 && !state.paused && !state.loop) runLoop();
  return added;
}

export async function syncNotes() {
  let added = 0;
  for (const it of await collectNoteItems()) if (await enqueueIfStale(it)) added++;
  if (added > 0) broadcast({ type: 'queue_sync', added, kind: 'notes', queue_size: state.queue.length });
  if (state.queue.length > 0 && !state.paused && !state.loop) runLoop();
  return added;
}

// Re-embed a single note after edit. Debounced — saves within 5s collapse
// into one embed call so per-keystroke work doesn't hammer the encoder.
export function refreshNote(paperId) {
  if (state.discarding) return;
  const prev = state.noteDebounceTimers.get(paperId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(async () => {
    state.noteDebounceTimers.delete(paperId);
    try {
      const file = path.join(NOTES_DIR, `paper_${paperId}.md`);
      if (!await fileExists(file)) return;
      const md = await readText(file, '');
      const note = parseNoteMd(md);
      const text = noteEmbedText(note);
      if (!text) return;
      const h = hash(text);
      if (await vectors.hasFresh('notes', paperId, h)) return;
      // Drop any prior queued duplicate — last-write wins.
      state.queue = state.queue.filter((q) => !(q.kind === 'notes' && q.id === paperId));
      state.attempted.delete(itemKey('notes', paperId));
      state.queue.push({
        kind: 'notes',
        id: paperId,
        text,
        hash: h,
        meta: {
          title: note.frontmatter?.title || '',
          category: note.frontmatter?.category || [],
          method_family: note.frontmatter?.method?.family || '',
        },
      });
      broadcast({ type: 'note_refresh', paper_id: paperId, queue_size: state.queue.length });
      if (!state.paused && !state.loop) runLoop();
    } catch (err) {
      broadcast({ type: 'error', error: `note refresh failed for ${paperId}: ${err.message}` });
    }
  }, NOTE_DEBOUNCE_MS);
  state.noteDebounceTimers.set(paperId, t);
}

// Hook for the chunks producer (pdf_chunks.mjs lands later). Bulk-enqueue
// pre-computed chunk items: { id: 'paperId:N', text, meta: {paper_id, section, page, chunk_idx} }.
export async function enqueueChunks(items) {
  let added = 0;
  for (const raw of items) {
    if (!raw?.id || !raw?.text) continue;
    const it = { kind: 'chunks', id: raw.id, text: raw.text, meta: raw.meta || {} };
    if (await enqueueIfStale(it)) added++;
  }
  if (added > 0) broadcast({ type: 'queue_sync', added, kind: 'chunks', queue_size: state.queue.length });
  if (state.queue.length > 0 && !state.paused && !state.loop) runLoop();
  return added;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function pause() {
  state.paused = true;
  broadcast({ type: 'paused' });
  if (state.job) state.job.status = 'paused';
}

export function resume() {
  if (!state.paused) return;
  state.paused = false;
  broadcast({ type: 'resumed' });
  if (state.job?.status === 'paused') state.job.status = 'idle';
  if (state.queue.length > 0 && !state.loop) runLoop();
  else syncAll();
}

export async function discard() {
  state.discarding = true;
  state.paused = true;
  if (state.loop) {
    try { await state.loop; } catch {}
  }
  for (const t of state.noteDebounceTimers.values()) clearTimeout(t);
  state.noteDebounceTimers.clear();
  state.queue.length = 0;
  state.attempted.clear();
  state.inflight = null;
  state.eventBuffer.length = 0;
  await clearEmbedJob();
  state.job = null;
  state.discarding = false;
  state.paused = false;
  broadcast({ type: 'discarded' });
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

async function processOne(item) {
  const r = await embedder.embed([item.text]);
  await vectors.upsertBatch(item.kind, [{
    id: item.id,
    embedding: r.data,  // dim-length Float32Array, since rows = 1
    meta: item.meta,
    hash: item.hash,
  }]);
  if (state.job) {
    if (item.kind === 'papers') state.job.papers_embedded++;
    else if (item.kind === 'notes') state.job.notes_embedded++;
    else if (item.kind === 'chunks') state.job.chunks_embedded++;
  }
}

async function runLoop() {
  if (state.loop) return;
  if (state.paused || state.discarding) return;
  if (state.queue.length === 0) return;

  if (!state.job) await loadJob();
  state.job.status = 'running';
  state.job.last_error = null;
  await writeEmbedJob(state.job);
  broadcast({ type: 'started', queue_size: state.queue.length });

  state.loop = (async () => {
    while (!state.paused && !state.discarding && state.queue.length > 0) {
      const item = state.queue.shift();
      const key = itemKey(item.kind, item.id);
      if (state.attempted.has(key)) continue;
      state.inflight = key;
      broadcast({ type: 'item_start', kind: item.kind, id: item.id, queue_size: state.queue.length });
      try {
        await processOne(item);
        state.attempted.add(key);
        broadcast({ type: 'item_done', kind: item.kind, id: item.id, queue_size: state.queue.length });
      } catch (err) {
        state.job.last_error = `${item.kind}:${item.id} — ${err.message}`;
        broadcast({ type: 'item_error', kind: item.kind, id: item.id, error: err.message });
        // Don't add to attempted — let next syncAll retry.
      }
      // Periodic manifest flush so a crash doesn't lose progress counters.
      if (state.job.papers_embedded + state.job.notes_embedded + state.job.chunks_embedded > 0
          && (state.job.papers_embedded + state.job.notes_embedded + state.job.chunks_embedded) % 25 === 0) {
        await writeEmbedJob(state.job);
      }
      // Yield to other server work between items.
      await sleep(0);
    }

    state.inflight = null;
    if (state.discarding) {
      // discard() finishes resetting state.
    } else if (state.paused) {
      if (state.job) {
        state.job.status = 'paused';
        await writeEmbedJob(state.job);
      }
      broadcast({ type: 'paused_idle' });
    } else {
      if (state.job) {
        state.job.status = 'completed';
        state.job.finished_at = new Date().toISOString();
        await writeEmbedJob(state.job);
      }
      broadcast({ type: 'idle' });
    }
  })();

  try { await state.loop; }
  finally { state.loop = null; }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function init() {
  await loadJob();
  // Subscribe to the download daemon — when a PDF lands, kick a chunks
  // resync so the student doesn't wait for a manual trigger to get
  // semantic retrieval over fresh papers. Dynamic import keeps the module
  // load order clean (download_daemon.init() already ran).
  try {
    const dd = await import('./download_daemon.mjs');
    dd.subscribe((evt) => {
      if (evt.type === 'paper_done' && evt.status !== 'failed') syncPdfs().catch(() => {});
      if (evt.type === 'paper_uploaded') syncPdfs().catch(() => {});
    });
  } catch {
    /* download daemon optional */
  }
  // If the prior job was 'interrupted' (server died mid-run), don't auto-
  // resume — wait for the user to view a stage and decide. Search/download
  // daemons follow the same convention.
  if (state.job?.status === 'interrupted') {
    state.paused = true;
    broadcast({ type: 'paused' });
    return;
  }
  await syncAll();
}

// Force-start (resume after pause / interrupt)
export function startNow() {
  state.paused = false;
  if (state.queue.length > 0 && !state.loop) runLoop();
  else syncAll();
}
