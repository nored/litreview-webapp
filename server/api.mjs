import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PROTOCOL_FILES, DATA_FILES, SYNTHESIS_FILES,
  PROTOCOL_DIR, DATA_DIR, PDFS_DIR, NOTES_DIR, SYNTHESIS_DIR,
} from './paths.mjs';
import { ensureDir, readText, writeText, fileExists } from './storage.mjs';
import {
  TOPIC_DEFAULT, SEARCH_QUERIES_DEFAULT, INCLUSION_CRITERIA_DEFAULT,
} from './templates.mjs';
import { parseTopic } from './lib/topic_md.mjs';
import { runSearch } from './lib/search_runner.mjs';
import { parse as parseQueries, serialize as serializeQueries } from './lib/queries_md.mjs';
import { readSearchJob, clearSearchJob, writeSearchJob } from './lib/jobs.mjs';
import { read as readCredentials, write as writeCredentials, preview as credentialPreview } from './lib/credentials.mjs';
import * as triage from './lib/triage.mjs';
import * as downloadDaemon from './lib/download_daemon.mjs';
import { callLlm, probeOpenAi } from './lib/llm_proxy.mjs';
import * as notes from './lib/notes.mjs';
import * as aggregator from './lib/notes_aggregator.mjs';
import * as synthesis from './lib/synthesis.mjs';
import * as positioning from './lib/positioning.mjs';
import * as catalogue from './lib/catalogue.mjs';
import * as catalogueGrounded from './lib/catalogue_grounded.mjs';
import * as remediation from './lib/remediation.mjs';
import * as conveyor from './lib/conveyor.mjs';
import * as vectors from './lib/vectors.mjs';
import * as embedder from './lib/embedder.mjs';
import * as embedDaemon from './lib/embed_daemon.mjs';
import * as prefilter from './lib/triage_prefilter.mjs';
import * as searchQuality from './lib/search_quality.mjs';
import { invalidateSyntheticCache } from './lib/synthetic_prototypes.mjs';
import * as activeLearning from './lib/active_learning.mjs';
import * as gapDetection from './lib/gap_detection.mjs';
import * as snowballDaemon from './lib/snowball_daemon.mjs';

// Which credential fields are SECRETS (masked when GET'd) vs config (raw).
const CREDENTIAL_FIELDS = [
  { key: 'semantic_scholar_api_key', secret: true },
  // OpenAI-compatible provider (OpenAI, Ollama, OpenRouter, Groq,
  // Together, vLLM, LM Studio, llama.cpp server, etc).
  { key: 'openai_base_url', secret: false },
  { key: 'openai_api_key', secret: true },
  { key: 'openai_model', secret: false },
  // Anthropic Claude (separate API shape).
  { key: 'anthropic_api_key', secret: true },
  { key: 'anthropic_model', secret: false },
];
const CREDENTIAL_KEYS = CREDENTIAL_FIELDS.map((f) => f.key);

export const router = express.Router();

router.use(express.json({ limit: '10mb' }));

const PROTOCOL_DEFAULTS = {
  topic: TOPIC_DEFAULT,
  search_queries: SEARCH_QUERIES_DEFAULT,
  inclusion_criteria: INCLUSION_CRITERIA_DEFAULT,
};

router.get('/api/protocol/:name', async (req, res) => {
  const file = PROTOCOL_FILES[req.params.name];
  if (!file) return res.status(404).json({ error: 'unknown protocol file' });
  const content = await readText(file, PROTOCOL_DEFAULTS[req.params.name] ?? '');
  res.json({ name: req.params.name, content });
});

router.put('/api/protocol/:name', async (req, res) => {
  const file = PROTOCOL_FILES[req.params.name];
  if (!file) return res.status(404).json({ error: 'unknown protocol file' });
  if (typeof req.body?.content !== 'string') {
    return res.status(400).json({ error: 'content (string) required' });
  }
  await ensureDir(PROTOCOL_DIR);
  await writeText(file, req.body.content);
  // Topic edits invalidate the cached topic embedding so the next drift
  // score uses the fresh text. Same for the inclusion-criteria text used
  // to bootstrap the pre-filter's synthetic prototypes.
  if (req.params.name === 'topic') searchQuality.invalidateTopicCache();
  if (req.params.name === 'topic' || req.params.name === 'inclusion_criteria') {
    invalidateSyntheticCache();
  }
  res.json({ ok: true, name: req.params.name });
});

// Form-friendly queries endpoints. Read parses the markdown; write serializes
// back. The markdown remains the source of truth on disk.
router.get('/api/queries', async (_req, res) => {
  const md = await readText(PROTOCOL_FILES.search_queries, SEARCH_QUERIES_DEFAULT);
  const data = parseQueries(md);
  res.json(data);
});

router.put('/api/queries', async (req, res) => {
  const queries = Array.isArray(req.body?.queries) ? req.body.queries : [];
  const manual_additions = Array.isArray(req.body?.manual_additions) ? req.body.manual_additions : [];
  const md = serializeQueries({ queries, manual_additions });
  await ensureDir(PROTOCOL_DIR);
  await writeText(PROTOCOL_FILES.search_queries, md);
  res.json({ ok: true, queries: queries.length, manual_additions: manual_additions.length });
});

// Stage 1 search. Streams progress as SSE.
// State that survives across requests:
//   - in-memory abortController for the live run (if any)
//   - the search job manifest on disk (for cross-restart visibility)
let searchAbort = null;
let searchPromise = null;
let searchDiscarding = false;
// Buffer of recent events for late-joining SSE clients (for reconnection)
let eventBuffer = [];
let eventListeners = new Set();

function broadcast(event) {
  eventBuffer.push(event);
  if (eventBuffer.length > 500) eventBuffer.shift();
  for (const fn of eventListeners) {
    try { fn(event); } catch {}
  }
}

router.get('/api/search/job', async (_req, res) => {
  const job = await readSearchJob();
  if (!job) return res.json({ status: 'none' });
  // Sanity: a 'running' job with no live abort controller means the process
  // died and reconciliation didn't happen yet (shouldn't, but safety).
  if (job.status === 'running' && !searchAbort) {
    job.status = 'interrupted';
    job.interrupted_at = new Date().toISOString();
    job.interrupted_reason = 'process restart';
    await writeSearchJob(job);
  }
  res.json(job);
});

router.delete('/api/search/job', async (_req, res) => {
  // If a runner is live, abort it AND mark as discarding so any final
  // writes (e.g., the "aborted by user" manifest update) are skipped.
  // Then await the runner's full unwind before deleting files. Without the
  // await, the runner can still race a write through after our unlink.
  searchDiscarding = true;
  if (searchAbort) {
    searchAbort.abort();
  }
  if (searchPromise) {
    try { await searchPromise; } catch {}
  }
  searchAbort = null;
  searchPromise = null;
  await clearSearchJob();
  await fs.unlink(DATA_FILES.search_log).catch(() => {});
  await fs.unlink(DATA_FILES.candidates_raw).catch(() => {});
  // Belt-and-suspenders: clear once more in case of any straggler write.
  await clearSearchJob();
  eventBuffer = [];
  searchDiscarding = false;
  res.json({ ok: true });
});

router.post('/api/search/run', async (req, res) => {
  if (searchAbort) {
    return res.status(409).json({
      error: 'a search is already running',
      hint: 'cancel it first or wait for it to finish',
    });
  }
  const mode = req.body?.mode === 'resume' ? 'resume' : 'fresh';
  const ac = new AbortController();
  searchAbort = ac;
  searchDiscarding = false;
  eventBuffer = [];

  // Run in background; events flow into the broadcaster so any number of
  // SSE clients (including reconnects after reload) can attach.
  searchPromise = (async () => {
    try {
      for await (const event of runSearch({
        signal: ac.signal,
        mode,
        isDiscarded: () => searchDiscarding,
      })) {
        if (searchDiscarding) break;
        broadcast(event);
      }
    } catch (err) {
      if (!searchDiscarding) broadcast({ type: 'fatal', error: err.message });
    } finally {
      if (!searchDiscarding) broadcast({ type: 'end' });
      searchAbort = null;
      searchPromise = null;
    }
  })();

  res.json({ ok: true, mode });
});

router.post('/api/search/cancel', async (_req, res) => {
  if (searchAbort) {
    searchAbort.abort();
    // Await the runner so a subsequent POST /api/search/run can't race the
    // old runner's final manifest writes against the new one's.
    if (searchPromise) {
      try { await searchPromise; } catch {}
    }
    searchAbort = null;
    searchPromise = null;
    res.json({ ok: true });
  } else {
    res.json({ ok: false, error: 'no search running' });
  }
});

router.get('/api/search/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Replay buffered events so a reload mid-run sees the prior progress.
  for (const event of eventBuffer) send(event);
  // If no run is active, close the stream cleanly.
  if (!searchAbort) {
    res.end();
    return;
  }

  const listener = (event) => send(event);
  eventListeners.add(listener);
  req.on('close', () => {
    eventListeners.delete(listener);
  });
});

// Stage 1 quality helpers: drift-guard scoring of search queries against
// the topic embedding, and semantic near-duplicate detection over the
// papers vector store.
router.post('/api/search/score-queries', async (req, res) => {
  try {
    const queries = Array.isArray(req.body?.queries) ? req.body.queries : null;
    if (!queries) return res.status(400).json({ error: 'queries (string[]) required' });
    res.json({ scored: await searchQuality.scoreQueriesAgainstTopic(queries) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/search/near-duplicates', async (req, res) => {
  try {
    const threshold = req.query.threshold ? Number(req.query.threshold) : 0.92;
    const maxPairs = req.query.maxPairs ? Math.max(1, Math.min(2000, Number(req.query.maxPairs))) : 500;
    res.json(await searchQuality.findNearDuplicates({ threshold, maxPairs }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/search/resolve-duplicate', async (req, res) => {
  try {
    const { keep_row_index, drop_row_index } = req.body || {};
    if (!Number.isInteger(keep_row_index) || !Number.isInteger(drop_row_index)) {
      return res.status(400).json({ error: 'keep_row_index and drop_row_index (integers) required' });
    }
    if (keep_row_index === drop_row_index) {
      return res.status(400).json({ error: 'keep and drop are the same row' });
    }
    const result = await searchQuality.resolveDuplicate({ keep_row_index, drop_row_index });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/status', async (_req, res) => {
  const [
    topicSet, queriesSet, criteriaSet,
    rawCsv, triagedCsv, downloadLog, gapMatrix, positioning, catalogueMd,
  ] = await Promise.all([
    fileExists(PROTOCOL_FILES.topic),
    fileExists(PROTOCOL_FILES.search_queries),
    fileExists(PROTOCOL_FILES.inclusion_criteria),
    fileExists(DATA_FILES.candidates_raw),
    fileExists(DATA_FILES.candidates_triaged),
    fileExists(DATA_FILES.download_log),
    fileExists(SYNTHESIS_FILES.gap_matrix),
    fileExists(SYNTHESIS_FILES.positioning_statement),
    fileExists(path.join(SYNTHESIS_DIR, 'catalogue.md')),
  ]);
  // Stage 4 done = at least one note exists in notes/
  let stage4Done = false;
  try {
    const files = await fs.readdir(NOTES_DIR);
    stage4Done = files.some((f) => /^paper_\d+\.md$/.test(f));
  } catch { /* dir missing */ }
  res.json({
    setup: { topic: topicSet, queries: queriesSet, criteria: criteriaSet },
    stage1: { done: rawCsv, running: !!searchAbort },
    stage2: { done: triagedCsv },
    stage3: { done: downloadLog },
    stage4: { done: stage4Done },
    stage5: { done: gapMatrix },
    stage7: { done: positioning || catalogueMd },
  });
});

// Credentials. GET returns set/unset + preview for each known key, never
// the full value. PUT accepts a partial update; empty string clears a key.
router.get('/api/credentials', async (_req, res) => {
  const data = await readCredentials();
  const out = {};
  for (const f of CREDENTIAL_FIELDS) {
    const v = data[f.key];
    if (f.secret) {
      out[f.key] = v ? { set: true, preview: credentialPreview(v) } : { set: false };
    } else {
      out[f.key] = { set: !!v, value: v || '' };
    }
  }
  res.json(out);
});

router.put('/api/credentials', async (req, res) => {
  const current = await readCredentials();
  const updates = req.body || {};
  for (const k of CREDENTIAL_KEYS) {
    if (k in updates) {
      const v = updates[k];
      if (typeof v !== 'string') continue;
      if (v.trim() === '') delete current[k];
      else current[k] = v.trim();
    }
  }
  await writeCredentials(current);
  res.json({ ok: true });
});

// Stage 2 triage. CSV is the source of truth; AI suggestions are sidecar.
router.get('/api/triage/papers', async (_req, res) => {
  try {
    const papers = await triage.getAll();
    res.json({ papers, total: papers.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/api/triage/decision', async (req, res) => {
  try {
    const { row_index, label, reason } = req.body || {};
    const result = await triage.setDecision({ row_index, label, reason });
    // Notify the download daemon. If the new label is include/maybe, the
    // paper gets enqueued for background download right away. If it
    // changed away from include/maybe, the daemon already has it as
    // attempted (or queued) and will skip it.
    if ((label === 'include' || label === 'maybe') && result.paper_id) {
      const papers = await triage.getAll();
      const row = papers.find((p) => p.paper_id === result.paper_id);
      if (row) downloadDaemon.enqueue(row);
    }
    // The triage_label is part of the papers vector meta — kick a resync so
    // it stays in lockstep. Idempotent; vectors.hasFresh dedupes by content
    // hash so unchanged title/abstract pairs are no-ops.
    embedDaemon.syncPapers().catch(() => { /* daemon logs its own errors */ });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/api/triage/suggestion', async (req, res) => {
  try {
    const { row_index, label, reason } = req.body || {};
    const result = await triage.setAiSuggestion({ row_index, label, reason });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stage 2 embedding pre-filter: score pending rows against include/exclude
// prototype centroids and auto-decide the confident ends. Only writes to
// rows the student hasn't labeled. See server/lib/triage_prefilter.mjs.
router.get('/api/triage/prefilter/preview', async (_req, res) => {
  try {
    res.json(await prefilter.previewDecisions());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/triage/prefilter/apply', async (req, res) => {
  try {
    const { decisions, run_auto } = req.body || {};
    if (run_auto) {
      res.json(await prefilter.runAutoTriage());
      return;
    }
    if (!Array.isArray(decisions)) {
      return res.status(400).json({ error: 'decisions (array) or run_auto=true required' });
    }
    res.json(await prefilter.applyDecisions(decisions));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Closer-side-wins finish: decide every remaining pending paper based on
// whichever side's prototype is closer, regardless of margin or floor.
// Use after substantial training when the prototypes are stable enough
// to trust on the borderline residue.
router.post('/api/triage/prefilter/finish', async (_req, res) => {
  try {
    res.json(await prefilter.finishRemaining());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/triage/prefilter/missed', async (req, res) => {
  try {
    const topK = Math.max(1, Math.min(200, Number(req.query.topK) || 20));
    const minScore = req.query.minScore ? Number(req.query.minScore) : undefined;
    res.json(await prefilter.findMissedIncludes({ topK, minScore }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/triage/prefilter/pending-ranked', async (_req, res) => {
  try {
    res.json(await prefilter.rankPendingByUncertainty());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Active-learning training loop: pick the next batch of papers for the
// student to decide blind. The classifier picks them based on prior
// decisions, but the response payload deliberately omits all scoring
// information — anchoring bias would defeat the point of training.
router.get('/api/triage/training/state', async (_req, res) => {
  try {
    res.json(await activeLearning.trainingState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/triage/training/next-batch', async (req, res) => {
  try {
    const n = Math.max(1, Math.min(50, Number(req.body?.n) || 10));
    const exclude = new Set(
      Array.isArray(req.body?.exclude) ? req.body.exclude.map(Number) : [],
    );
    const result = await activeLearning.pickTrainingBatch({ n, exclude });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Combined training-step endpoint. Records the student's decision,
// cascades pre-filter auto-apply (once unlocked), and picks the next
// paper — all in one round-trip. The UI just calls this on every click
// inside the training wizard.
router.post('/api/triage/training/step', async (req, res) => {
  try {
    const body = req.body || {};
    const exclude = new Set(
      Array.isArray(body.exclude) ? body.exclude.map(Number) : [],
    );
    const result = await activeLearning.stepTraining({
      row_index: Number.isInteger(body.row_index) ? body.row_index : null,
      label: body.label || null,
      reason: body.reason || '',
      cluster_members: Array.isArray(body.cluster_members)
        ? body.cluster_members.map(Number).filter(Number.isInteger)
        : [],
      exclude,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inspect the sub-prototype structure of the labeled sets: which mini-
// clusters formed inside your includes and excludes, what the densest
// member of each looks like. Useful for sanity-checking what the classifier
// is actually modelling about your decisions.
router.get('/api/triage/prefilter/communities', async (_req, res) => {
  try {
    res.json(await prefilter.describeCommunities());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/triage/thresholds', async (_req, res) => {
  try {
    res.json(await prefilter.readThresholds());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/api/triage/thresholds', async (req, res) => {
  try {
    res.json(await prefilter.writeThresholds(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/triage/summary', async (_req, res) => {
  try {
    const s = await triage.summary();
    res.json(s);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stage 3 download daemon controls and stream.
router.get('/api/download/status', async (_req, res) => {
  const s = downloadDaemon.status();
  res.json(s);
});

router.post('/api/download/start', async (_req, res) => {
  try {
    await downloadDaemon.syncFromTriage();
    downloadDaemon.startNow();
    res.json({ ok: true, status: downloadDaemon.status() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/download/pause', (_req, res) => {
  downloadDaemon.pause();
  res.json({ ok: true, status: downloadDaemon.status() });
});

router.post('/api/download/resume', (_req, res) => {
  downloadDaemon.resume();
  res.json({ ok: true, status: downloadDaemon.status() });
});

router.delete('/api/download/job', async (_req, res) => {
  try {
    await downloadDaemon.discard();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/download/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  // Replay recent events so a reload mid-run sees the prior progress.
  for (const event of downloadDaemon.getEventBuffer()) send(event);
  // Send current status as a synthetic 'status' event right away.
  send({ type: 'status', ...downloadDaemon.status() });
  const unsubscribe = downloadDaemon.subscribe((event) => send(event));
  req.on('close', () => {
    if (typeof unsubscribe === 'function') unsubscribe();
  });
});

// Read manual_retrieval_list.md if present so the UI can display it inline.
router.get('/api/download/manual-list', async (_req, res) => {
  const text = await readText(DATA_FILES.manual_retrieval_list, '');
  res.json({ content: text });
});

// ---------------------------------------------------------------------------
// Snowballing — backward+forward citation expansion from include-labeled
// papers via OpenAlex. Background daemon mirrors the download daemon shape;
// new candidates land in candidates_triaged.csv as pending so the embed
// daemon and triage wizard pick them up automatically.
// ---------------------------------------------------------------------------
router.get('/api/snowball/status', (_req, res) => {
  res.json(snowballDaemon.status());
});

router.post('/api/snowball/start', async (req, res) => {
  try {
    const direction = req.body?.direction || 'backward';
    const r = await snowballDaemon.start({ direction });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/snowball/pause', (_req, res) => {
  snowballDaemon.pause();
  res.json({ ok: true, ...snowballDaemon.status() });
});

router.post('/api/snowball/resume', (_req, res) => {
  snowballDaemon.resume();
  res.json({ ok: true, ...snowballDaemon.status() });
});

router.delete('/api/snowball/job', async (_req, res) => {
  try {
    await snowballDaemon.discard();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/snowball/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const e of snowballDaemon.getEventBuffer()) send(e);
  send({ type: 'status', ...snowballDaemon.status() });
  const unsubscribe = snowballDaemon.subscribe((e) => send(e));
  req.on('close', () => { if (typeof unsubscribe === 'function') unsubscribe(); });
});

// Embedding daemon — same control surface shape as the download daemon so
// the UI can reuse status/SSE patterns.
router.get('/api/embed/status', (_req, res) => {
  res.json(embedDaemon.status());
});

router.post('/api/embed/sync', async (_req, res) => {
  try {
    const added = await embedDaemon.syncAll();
    res.json({ ok: true, added });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/embed/start', async (_req, res) => {
  embedDaemon.startNow();
  res.json({ ok: true, ...embedDaemon.status() });
});

router.post('/api/embed/pause', (_req, res) => {
  embedDaemon.pause();
  res.json({ ok: true, ...embedDaemon.status() });
});

router.post('/api/embed/resume', (_req, res) => {
  embedDaemon.resume();
  res.json({ ok: true, ...embedDaemon.status() });
});

router.delete('/api/embed/job', async (_req, res) => {
  try {
    await embedDaemon.discard();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/embed/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  for (const event of embedDaemon.getEventBuffer()) send(event);
  send({ type: 'status', ...embedDaemon.status() });
  const unsubscribe = embedDaemon.subscribe((event) => send(event));
  req.on('close', () => {
    if (typeof unsubscribe === 'function') unsubscribe();
  });
});

// Structured failures so the UI can render upload boxes per paper.
router.get('/api/download/failures', (_req, res) => {
  res.json({ failures: downloadDaemon.listFailures() });
});

// Manual upload of a PDF for a paper that the daemon could not fetch (bot
// protection, paywalled OA URL, weird publisher, etc). The browser sends
// the raw PDF bytes; we validate magic bytes, save to data/pdfs/, and
// move the paper from failed to completed in the manifest.
//
// CORS: this endpoint is also called from a bookmarklet running on the
// publisher's site (mdpi.com, springer.com, etc), so we must allow cross
// origin POSTs. Chrome's Private Network Access additionally requires us
// to acknowledge the public→private hop in the preflight.
function uploadCors(_req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
  next();
}

router.options('/api/download/upload/:paper_id', uploadCors, (_req, res) => {
  res.status(204).end();
});

router.post(
  '/api/download/upload/:paper_id',
  uploadCors,
  express.raw({ type: 'application/pdf', limit: '60mb' }),
  async (req, res) => {
    try {
      const paperId = String(req.params.paper_id || '').replace(/[^0-9]/g, '');
      if (!paperId) return res.status(400).json({ error: 'invalid paper_id' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          error: 'no PDF body received. Send raw bytes with Content-Type: application/pdf.',
        });
      }
      const result = await downloadDaemon.recordManualUpload({
        paperId,
        buffer: req.body,
      });
      res.json({ ok: true, paper_id: paperId, size: result.size });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

// Reset: wipe all stage artifacts and reset protocol files to defaults so
// the student can start a new topic. Preserves the contact email and the
// API credentials by default. Requires an explicit `confirm: true` field
// so a no-body POST cannot accidentally trigger a wipe.
router.post('/api/reset', async (req, res) => {
  try {
    const opts = req.body || {};
    if (opts.confirm !== true) {
      return res.status(400).json({
        error: 'confirm: true is required to perform a reset',
      });
    }
    const keepEmail = opts.keep_email !== false;
    const keepCredentials = opts.keep_credentials !== false;

    // 1. Capture the email BEFORE anything is touched so we have it even
    //    if a parallel write fails midway.
    let preservedEmail = '';
    if (keepEmail) {
      const md = await readText(PROTOCOL_FILES.topic, '');
      preservedEmail = parseTopic(md).contact_email || '';
    }

    // 2. Rewrite protocol files FIRST so any reader (e.g., the daemon
    //    fetching contact_email) sees a valid file at all times.
    let topicContent = TOPIC_DEFAULT;
    if (preservedEmail) {
      topicContent = topicContent.replace(
        /contact_email:\s*\S+/,
        `contact_email: ${preservedEmail}`,
      );
    }
    await ensureDir(PROTOCOL_DIR);
    await writeText(PROTOCOL_FILES.topic, topicContent);
    await writeText(PROTOCOL_FILES.search_queries, SEARCH_QUERIES_DEFAULT);
    await writeText(PROTOCOL_FILES.inclusion_criteria, INCLUSION_CRITERIA_DEFAULT);

    // 3. Stop the active search runner cleanly, if any.
    searchDiscarding = true;
    if (searchAbort) searchAbort.abort();
    if (searchPromise) { try { await searchPromise; } catch {} }
    searchAbort = null;
    searchPromise = null;
    eventBuffer = [];

    // 4. Stop the download daemon cleanly and clear its in-process caches
    //    so a fresh start re-reads the new protocol files.
    await downloadDaemon.discard();
    downloadDaemon.clearCaches?.();

    // 5. Wipe data files (canonical artifacts of stages 1-4).
    const filesToDelete = [
      DATA_FILES.candidates_raw,
      DATA_FILES.candidates_triaged,
      DATA_FILES.search_log,
      DATA_FILES.triage_summary,
      DATA_FILES.download_log,
      DATA_FILES.manual_retrieval_list,
      DATA_FILES.deep_read_log,
      path.join(DATA_DIR, '_triage_meta.json'),
    ];
    for (const f of filesToDelete) {
      await fs.unlink(f).catch(() => {});
    }

    // 6. Wipe directories: jobs, pdfs, notes, synthesis. Recreate empty.
    const JOBS_DIR = path.join(DATA_DIR, '_jobs');
    for (const dir of [JOBS_DIR, PDFS_DIR, NOTES_DIR, SYNTHESIS_DIR]) {
      await fs.rm(dir, { recursive: true, force: true });
      await ensureDir(dir);
    }

    // 7. Reset credentials unless we're preserving them.
    if (!keepCredentials) {
      await fs.unlink(path.join(DATA_DIR, '_credentials.json')).catch(() => {});
    }

    res.json({
      ok: true,
      preserved: {
        email: preservedEmail || null,
        credentials: keepCredentials,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    searchDiscarding = false;
  }
});

// LLM proxy. Browser POSTs { provider, system, user, temperature } and we
// stream the model's tokens back as SSE. Provider is one of:
//   'openai'    OpenAI-compatible (Ollama, OpenRouter, vLLM, …)
//   'anthropic' Anthropic Claude API
// (For 'webllm' the browser does the call locally; this endpoint isn't
// involved.)
router.post('/api/llm/chat', async (req, res) => {
  const { provider, system, user, temperature } = req.body || {};
  if (provider !== 'openai' && provider !== 'anthropic') {
    return res.status(400).json({ error: 'provider must be openai or anthropic' });
  }
  if (typeof user !== 'string' || !user.trim()) {
    return res.status(400).json({ error: 'user prompt required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const full = await callLlm({
      provider,
      system,
      user,
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      onToken: (delta, total) => send({ type: 'delta', delta, total }),
    });
    send({ type: 'done', full });
  } catch (err) {
    send({ type: 'error', error: err.message });
  } finally {
    res.end();
  }
});

router.get('/api/llm/probe/openai', async (_req, res) => {
  const result = await probeOpenAi();
  res.json(result);
});

// Stage 4 deep read
router.get('/api/notes', async (_req, res) => {
  try {
    const papers = await notes.listEligible();
    res.json({ papers });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/notes/:paper_id', async (req, res) => {
  try {
    const result = await notes.getNote(req.params.paper_id);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Phase 4 — per-section RAG retrieval over the PDF chunks store. The
// client uses this before drafting so the LLM sees actual paper text
// (not just the abstract) per note section. Falls back gracefully when
// the paper has no chunks indexed yet.
router.get('/api/notes/:paper_id/drafting-context', async (req, res) => {
  try {
    const { getDraftingContextHydrated } = await import('./lib/note_drafter.mjs');
    const ctx = await getDraftingContextHydrated(req.params.paper_id);
    res.json(ctx);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 4 overhaul — full per-section bundles that the client uses to
// fire 7 parallel LLM calls (6 body sections + 1 frontmatter), each with
// the FULL content of the relevant PDF section as context. Replaces the
// abstract-only single-call drafter with something closer to what the
// CLI template specifies.
router.get('/api/notes/:paper_id/section-bundles', async (req, res) => {
  try {
    const { assembleSectionBundles } = await import('./lib/note_drafter.mjs');
    const papers = await triage.getAll();
    const row = papers.find((p) => p.paper_id === req.params.paper_id);
    const bundles = await assembleSectionBundles(req.params.paper_id, row);
    res.json(bundles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quote grounding pass — after the drafter writes a section, run this
// to get the same text back with "(pp. X)" page references appended
// per paragraph. Pure embedding, no LLM call. The caller may ignore
// failures (the grounding is best-effort polish, not load-bearing).
router.post('/api/notes/:paper_id/ground-section', async (req, res) => {
  try {
    const { field, text } = req.body || {};
    if (typeof field !== 'string' || !field) {
      return res.status(400).json({ error: 'field (string) required' });
    }
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'text (string) required' });
    }
    const { groundSection } = await import('./lib/note_drafter.mjs');
    const result = await groundSection(req.params.paper_id, field, text);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/notes/:paper_id', async (req, res) => {
  try {
    const note = req.body?.note;
    if (!note?.frontmatter || !note?.body) {
      return res.status(400).json({ error: 'note must have frontmatter and body' });
    }
    const result = await notes.saveNote(req.params.paper_id, note);
    // Schedule a debounced re-embed of this note. Saves within 5s collapse
    // into one embed call so the encoder isn't hammered while the student types.
    embedDaemon.refreshNote(req.params.paper_id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/pdfs/:paper_id', async (req, res) => {
  const paperId = String(req.params.paper_id || '').replace(/[^0-9]/g, '');
  if (!paperId) return res.status(400).end();
  res.sendFile(notes.getPdfPath(paperId), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Stage 5-6 synthesis. Aggregator is read-only (always recomputed from
// notes/). Candidates and indicator assessments are persisted in a JSON
// sidecar plus regenerated CLI markdown on every save.

router.get('/api/synthesis/aggregate', async (_req, res) => {
  try {
    const agg = await aggregator.aggregate();
    res.json(agg);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/synthesis/llm-summary', async (_req, res) => {
  try {
    const agg = await aggregator.aggregate();
    res.json(aggregator.llmSummary(agg));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/synthesis/state', async (_req, res) => {
  try {
    const state = await synthesis.readState();
    res.json(state);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/api/synthesis/state', async (req, res) => {
  try {
    const next = req.body || {};
    if (!Array.isArray(next.candidates)) {
      return res.status(400).json({ error: 'candidates array required' });
    }
    // Recompute overall on every save so it stays consistent
    for (const c of next.candidates) {
      c.overall = synthesis.computeOverall(c);
    }
    await synthesis.writeState(next);
    const agg = await aggregator.aggregate();
    await synthesis.persistMarkdown(next, agg);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/synthesis/indicators', (_req, res) => {
  res.json({ indicators: synthesis.INDICATORS });
});

// Phase 6 gap detection — embedding-derived gap signals layered on top of
// the existing frontmatter gap matrix and AI candidate generation.
router.get('/api/synthesis/themes', async (req, res) => {
  try {
    const scope = req.query.scope || 'include';
    res.json(await gapDetection.discoverThemes({ scope }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/synthesis/limitations', async (req, res) => {
  try {
    const scope = req.query.scope || 'include';
    res.json(await gapDetection.aggregateLimitations({ scope }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/synthesis/triangulate', async (req, res) => {
  try {
    const topK = Math.max(1, Math.min(100, Number(req.query.topK) || 30));
    const minCiting = Math.max(2, Number(req.query.minCiting) || 2);
    res.json(await gapDetection.triangulateCitations({ topK, minCiting }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/synthesis/contradictions', async (req, res) => {
  try {
    const minSimilarity = req.query.minSimilarity ? Number(req.query.minSimilarity) : 0.75;
    const maxPairs = Math.max(1, Math.min(100, Number(req.query.maxPairs) || 30));
    res.json(await gapDetection.surfaceContradictionCandidates({ minSimilarity, maxPairs }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build the prompt for a specific contradiction pair so the client can
// hand it to its currently-selected LLM provider via /api/llm/chat or
// in-browser WebLLM. We don't call the LLM server-side here because the
// student's provider choice lives in the topbar, not in server config.
router.post('/api/synthesis/contradiction-prompt', (req, res) => {
  try {
    const { pair } = req.body || {};
    if (!pair?.a || !pair?.b) return res.status(400).json({ error: 'pair { a, b } required' });
    res.json({ prompt: gapDetection.buildContradictionPrompt(pair) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/synthesis/outliers', async (req, res) => {
  try {
    const topK = Math.max(1, Math.min(50, Number(req.query.topK) || 10));
    const minDistance = req.query.minDistance ? Number(req.query.minDistance) : 0.20;
    res.json(await gapDetection.findOutliers({ topK, minDistance }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Promote a triangulation hit (or any external paper shape) into the
// pending pool of candidates_triaged.csv. The embed daemon will pick it
// up automatically.
router.post('/api/synthesis/promote-to-candidates', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'items (non-empty array) required' });
    }
    // Read current triage CSV.
    const existing = await (async () => {
      if (!await fileExists(DATA_FILES.candidates_triaged)) return [];
      const text = await readText(DATA_FILES.candidates_triaged, '');
      const { parseCsv } = await import('./lib/csv.mjs');
      return parseCsv(text).rows;
    })();
    const { buildExistingIndex, isDuplicate } = await import('./lib/snowball.mjs');
    const dedupIndex = buildExistingIndex(existing);
    const newRows = [];
    for (const it of items) {
      const cand = {
        title: it.title || '',
        authors: it.authors || '',
        year: it.year || '',
        venue: it.venue || '',
        abstract: it.abstract || '',
        doi: it.doi || '',
        arxiv_id: it.arxiv_id || '',
        url: it.url || it.openalex_id || '',
        pdf_url: it.pdf_url || '',
        source_database: 'openalex',
        source_query: it.source_query || 'citation-triangulation',
      };
      if (!cand.title) continue;
      if (isDuplicate(cand, dedupIndex)) continue;
      newRows.push(cand);
    }
    if (newRows.length === 0) {
      return res.json({ ok: true, added: 0, skipped: items.length });
    }
    const TRIAGED_FIELDS = [
      'paper_id', 'title', 'authors', 'year', 'venue', 'abstract',
      'doi', 'arxiv_id', 'url', 'pdf_url',
      'source_database', 'source_query',
      'triage_label', 'triage_reason',
    ];
    const { writeCsv } = await import('./lib/csv.mjs');
    const merged = existing.concat(newRows.map((r) => ({
      paper_id: '', triage_label: '', triage_reason: '', ...r,
    })));
    await fs.writeFile(DATA_FILES.candidates_triaged, writeCsv(merged, TRIAGED_FIELDS), 'utf8');
    res.json({ ok: true, added: newRows.length, skipped: items.length - newRows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/synthesis/density-void', async (req, res) => {
  try {
    const body = req.body || {};
    if (Array.isArray(body.texts)) {
      const r = await gapDetection.scoreDensityVoidsBatch(body.texts);
      return res.json({ scores: r });
    }
    if (typeof body.text === 'string') {
      const r = await gapDetection.scoreDensityVoid(body.text);
      return res.json(r);
    }
    res.status(400).json({ error: 'body.text (string) or body.texts (string[]) required' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stage 7 positioning. PRISMA numbers are deterministic; the LLM only
// drafts prose. Persisted at synthesis/positioning_statement.md and
// synthesis/prisma_flow.md.

router.get('/api/positioning/prisma', async (_req, res) => {
  try {
    const numbers = await positioning.computePrismaNumbers();
    res.json({
      numbers,
      mermaid: positioning.mermaidPrisma(numbers),
      methodology_template: positioning.methodologyParagraphTemplate(numbers),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/positioning/competitors/:candidate_id', async (req, res) => {
  try {
    const state = await synthesis.readState();
    const candidate = state.candidates.find((c) => c.id === req.params.candidate_id);
    if (!candidate) return res.status(404).json({ error: 'candidate not found' });
    const agg = await aggregator.aggregate();
    const competitors = await positioning.findCompetitors(candidate, agg, 5);
    res.json({ candidate, competitors });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/positioning/state', async (_req, res) => {
  try {
    const [statement, prisma] = await Promise.all([
      readText(SYNTHESIS_FILES.positioning_statement, ''),
      readText(SYNTHESIS_FILES.prisma_flow, ''),
    ]);
    res.json({ statement, prisma });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/api/positioning/state', async (req, res) => {
  try {
    const { statement, prisma } = req.body || {};
    await positioning.persistPositioning({
      statementMd: typeof statement === 'string' ? statement : null,
      prismaMd:    typeof prisma === 'string'    ? prisma    : null,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stage 7 catalogue. Bundle data is JSON; markdown is the artifact.
router.get('/api/catalogue/bundle', async (_req, res) => {
  try {
    const [topicMd, agg, synthState, prisma] = await Promise.all([
      readText(PROTOCOL_FILES.topic, ''),
      aggregator.aggregate(),
      synthesis.readState(),
      positioning.computePrismaNumbers(),
    ]);
    const topic = {
      title: (topicMd.match(/title:\s*(.+)/) || [])[1]?.trim() || '',
      description: ((topicMd.match(/description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/) || [])[1] || '')
        .split('\n').map((l) => l.replace(/^[ \t]{2}/, '')).join('\n').trim(),
    };
    const bundle = catalogue.buildBundle({ topic, agg, synthState, prismaNumbers: prisma });
    bundle.system_prompt = catalogue.SYSTEM_PROMPT;
    bundle.references_md = catalogue.serializeReferences(
      Object.values(agg.by_paper).map((p) => ({
        id: p.paper_id, title: p.title, authors: p.authors,
        year: p.year, venue: p.venue, doi: p.doi,
        arxiv_id: p.arxiv_id, url: p.url,
      }))
    );
    // Grounded retrieval over the notes vector store. The catalogue
    // prompts no longer paraphrase a JSON dump of paper metadata; they
    // see the actual note prose the student wrote, retrieved per
    // chapter sub-aspect.
    try {
      const [soaCtx, selectionCtx] = await Promise.all([
        catalogueGrounded.assembleSoaContext(),
        catalogueGrounded.assembleSelectionContext(bundle.candidates),
      ]);
      const topicCtxs = [];
      for (const c of bundle.candidates) {
        topicCtxs.push(await catalogueGrounded.assembleTopicContext(c));
      }
      bundle.note_context = {
        state_of_art: soaCtx,
        topics: topicCtxs,
        topic_selection: selectionCtx,
      };
    } catch (e) {
      // Retrieval is best-effort — if the embedder is cold or vectors
      // store is empty, fall back to the legacy frontmatter-only path.
      bundle.note_context = { error: e.message };
    }
    res.json(bundle);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/catalogue/state', async (_req, res) => {
  try {
    const md = await catalogue.readCatalogue();
    res.json({ markdown: md });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/api/catalogue/state', async (req, res) => {
  try {
    const md = req.body?.markdown;
    if (typeof md !== 'string') return res.status(400).json({ error: 'markdown (string) required' });
    await catalogue.persistCatalogue(md);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "The conveyor" — guided default UI. Walks the pipeline state and
// returns an ordered list of events the client renders as a thread:
// completed milestones above, the one current action prominent, hard
// gates that refuse to let the user proceed below specific thresholds
// (e.g. too few notes for synthesis).
router.get('/api/conveyor/next', async (_req, res) => {
  try {
    const result = await conveyor.pickNext();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 7 — closed-loop remediation. Aggregates signals from triage,
// notes, synthesis, and catalogue into a single prioritised action list.
router.get('/api/loop/signals', async (_req, res) => {
  try {
    const result = await remediation.collectSignals();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Coverage check — given catalogue markdown, report which include
// papers got cited as [paper_NNN] and which got silently dropped.
router.post('/api/catalogue/coverage', async (req, res) => {
  try {
    const md = req.body?.markdown;
    if (typeof md !== 'string') return res.status(400).json({ error: 'markdown (string) required' });
    const agg = await aggregator.aggregate();
    const papers = Object.values(agg.by_paper).map((p) => ({
      id: p.paper_id,
      title: p.title,
      novelty: p.novelty_strength,
      must_cite: p.must_cite,
    }));
    const report = await catalogueGrounded.coverageCheck(md, papers);
    res.json(report);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Vectors / embeddings store
// ---------------------------------------------------------------------------
// The browser produces embeddings in a Web Worker (Transformers.js +
// bge-small-en-v1.5) and POSTs them here for persistence. The server-side
// embedder uses the same model so vectors are interchangeable.
//
// Embeddings travel as base64-encoded float32 bytes to keep payloads compact
// without inflating to per-number JSON.

function _b64ToFloat32(b64) {
  const buf = Buffer.from(b64, 'base64');
  // Detach from the Buffer pool — we want the float view to outlive the buffer.
  const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return new Float32Array(view);
}

function _float32ToB64(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

// Embed text(s) with the local Node-side encoder. The browser's
// public/lib/vectors.mjs talks to this — there is no in-browser model load.
// First call lazy-loads bge-small-en-v1.5 (~130 MB → ~/.cache/huggingface/);
// subsequent calls reuse the in-process pipeline.
router.post('/api/vectors/embed', async (req, res) => {
  try {
    const { texts } = req.body || {};
    if (!Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({ error: 'texts (non-empty string[]) required' });
    }
    const r = await embedder.embed(texts);
    res.json({
      data: _float32ToB64(r.data),
      rows: r.rows,
      dim: r.dim,
      model: embedder.MODEL,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pre-warm the embedder. Useful for the UI to show "loading model…" once
// at startup instead of paying that latency on the first user click.
router.post('/api/vectors/preload', async (_req, res) => {
  try {
    await embedder.preload();
    res.json({ ok: true, model: embedder.MODEL, dim: embedder.DIMENSIONS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/vectors/upsert', async (req, res) => {
  try {
    const { kind, items } = req.body || {};
    if (!kind || !Array.isArray(items)) {
      return res.status(400).json({ error: 'kind (string) and items (array) required' });
    }
    const decoded = items.map((it) => ({
      id: it.id,
      embedding: _b64ToFloat32(it.embedding),
      meta: it.meta ?? {},
      hash: it.hash ?? null,
    }));
    await vectors.upsertBatch(kind, decoded);
    res.json({ ok: true, count: decoded.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/vectors/delete', async (req, res) => {
  try {
    const { kind, id } = req.body || {};
    if (!kind || !id) return res.status(400).json({ error: 'kind and id required' });
    await vectors.deleteRecord(kind, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/vectors/clear', async (req, res) => {
  try {
    const { kind } = req.body || {};
    if (!kind) return res.status(400).json({ error: 'kind required' });
    await vectors.clear(kind);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/vectors/count', async (req, res) => {
  try {
    const kind = String(req.query.kind || '');
    if (!kind) return res.status(400).json({ error: 'kind required' });
    res.json({ count: await vectors.count(kind) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/vectors/has-fresh', async (req, res) => {
  try {
    const kind = String(req.query.kind || '');
    const id = String(req.query.id || '');
    const hash = String(req.query.hash || '');
    if (!kind || !id || !hash) return res.status(400).json({ error: 'kind, id, hash required' });
    res.json({ fresh: await vectors.hasFresh(kind, id, hash) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/vectors/search', async (req, res) => {
  try {
    const { kind, query, opts = {} } = req.body || {};
    if (!kind || !query) return res.status(400).json({ error: 'kind and query required' });
    const q = _b64ToFloat32(query);
    const hits = await vectors.search(kind, q, opts);
    res.json({ hits });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/vectors/communities', async (req, res) => {
  try {
    const { kind, opts = {} } = req.body || {};
    if (!kind) return res.status(400).json({ error: 'kind required' });
    const groups = await vectors.communities(kind, opts);
    res.json({ communities: groups });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/vectors/paraphrase-pairs', async (req, res) => {
  try {
    const { kind, opts = {} } = req.body || {};
    if (!kind) return res.status(400).json({ error: 'kind required' });
    const pairs = await vectors.paraphrasePairs(kind, opts);
    res.json({ pairs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/health', (_req, res) => res.json({ ok: true }));
