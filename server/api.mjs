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
import { callLlm, probeOpenAi, getLastTrace as getLastLlmTrace } from './lib/llm_proxy.mjs';
import * as llmLocal from './lib/llm_local.mjs';
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
// v2 — structured-data pivot (M1-M4 backend)
import * as v2Store from './lib/store.mjs';
import * as v2Ingest from './lib/ingest.mjs';
import * as v2Orchestrator from './lib/extract_orchestrator.mjs';
import { extractFullPipelineCorpus } from './lib/extract_phase2.mjs';
import * as v2Detectors from './lib/detectors/index.mjs';
import { runQuery as v2RunQuery } from './lib/query.mjs';
import { recommendCandidates as v2Recommend } from './lib/recommend.mjs';
import { extractClaims as v2ExtractClaims, prepareClaimsExtraction as v2PrepareClaims, processClaimsResponses as v2ProcessClaims } from './lib/extractors/claims.mjs';
import { classifyCitationContexts as v2ClassifyCitationContexts } from './lib/extractors/citation_context.mjs';
import { runExternalComparison as v2RunExternalComparison } from './lib/external_comparison.mjs';
import { buildCatalogue as v2BuildCatalogue, catalogueToMarkdown as v2CatalogueMd } from './lib/catalogue_v2.mjs';
import * as hfPreload from './lib/hf_preload.mjs';
import { computeCoverage as v2ComputeCoverage } from './lib/coverage.mjs';
import * as v2AutoSeed from './lib/auto_seed.mjs';
import * as platformInfo from './lib/platform.mjs';
import * as ingestGrobid from './lib/ingest_grobid.mjs';
import * as extractPhase2 from './lib/extract_phase2.mjs';
import * as embedPhase3 from './lib/embed_phase3.mjs';
import * as clusterPhase3 from './lib/cluster_phase3.mjs';
import * as detectPhase4 from './lib/detect_phase4.mjs';

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
  // Comma-separated provider chain to fall back to if the primary fails
  // BEFORE any tokens stream (mid-stream failures are never retried on a
  // different provider). Example: "anthropic,openai".
  { key: 'provider_fallback', secret: false },
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
      if (!searchDiscarding) {
        broadcast({ type: 'end' });
        // Auto-kick the embed daemon: embeddings are needed everywhere
        // downstream (triage, deep-read, corpus-shape). Better to start
        // indexing the moment search finishes than to make the user
        // wait at every later stage.
        //
        // CRITICAL: syncPapers reads candidates_triaged.csv, which only
        // exists once triage starts. After a fresh search only the raw
        // CSV is on disk. We poke triage.getAll() first — it initialises
        // candidates_triaged.csv from raw — so syncPapers actually has
        // rows to queue. Without this the daemon idled at 0 forever.
        (async () => {
          try {
            await triage.getAll();             // initialise candidates_triaged.csv from raw
            await embedDaemon.syncPapers?.();  // queue every paper for embedding
            embedDaemon.startNow?.();          // wake the daemon
          } catch (e) {
            console.warn('post-search embed kick failed:', e?.message || e);
          }
        })();
        // Mark near-duplicate scan pending: when the embed daemon goes
        // idle, the auto near-dup scan fires over the refreshed papers
        // vector store.
        nearDupAutoState.pending = true;
        nearDupAutoState.pending_since = new Date().toISOString();
      }
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

// Embedding-profile: data-driven look at the corpus's pairwise cosine
// distribution + community structure. Returns histogram buckets and
// percentile cuts so the user (or a downstream tuner) can REASON about
// thresholds before any are committed. No hard constants — the
// suggested propagation threshold is the 99th percentile of the actual
// pairwise cosines on this corpus.
// Pre-download the AI model files via @huggingface/hub. Works around
// the case where transformers.js's inline fetch trips HF's anonymous
// gating but @huggingface/hub downloads cleanly. Idempotent: files
// already present are skipped.
const hfPreloadState = { running: false, last: null };
router.post('/api/models/preload', async (_req, res) => {
  if (hfPreloadState.running) {
    return res.status(409).json({ error: 'preload already running' });
  }
  hfPreloadState.running = true;
  hfPreloadState.last = { started_at: new Date().toISOString(), progress: null, result: null, error: null };
  res.status(202).json({ started: true });
  (async () => {
    try {
      const r = await hfPreload.preloadAll((p) => {
        hfPreloadState.last.progress = p;
      });
      hfPreloadState.last.result = r;
    } catch (err) {
      hfPreloadState.last.error = err.message;
    } finally {
      hfPreloadState.last.finished_at = new Date().toISOString();
      hfPreloadState.running = false;
    }
  })();
});

router.get('/api/models/ready', async (_req, res) => {
  try {
    const r = await hfPreload.ready();
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/models/preload/status', async (_req, res) => {
  try {
    const status = await hfPreload.status();
    res.json({
      running: hfPreloadState.running,
      last: hfPreloadState.last,
      models: status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Local LLM (the 'webllm' provider): model registry + picker
// ─────────────────────────────────────────────────────────────────────────
router.get('/api/v2/local-llm/models', (_req, res) => {
  res.json({
    registry: llmLocal.getRegistry(),
    default_model_id: llmLocal.DEFAULT_MODEL_ID,
  });
});
router.get('/api/v2/local-llm/status', (_req, res) => {
  res.json(llmLocal.getStatus());
});
router.post('/api/v2/local-llm/select', async (req, res) => {
  const model_id = req.body?.model_id;
  if (!model_id) return res.status(400).json({ error: 'model_id required' });
  // Fire-and-forget — selection kicks off a download/load that may take
  // minutes; clients poll /status. We immediately return current state.
  llmLocal.selectModel(model_id).catch((e) => {
    console.warn(`local-llm select failed: ${e?.message || e}`);
  });
  res.json(llmLocal.getStatus());
});

// Phase 4: density-based gap detection over the emergent cluster +
// reference graph. Body: { only?: [types], topK?: int }.
let _phase4State = { running: false, last: null };
router.post('/api/v2/detect-phase4', async (req, res) => {
  if (_phase4State.running) {
    return res.status(409).json({ error: 'already_running' });
  }
  _phase4State.running = true;
  try {
    const r = await detectPhase4.detectAllPhase4(req.body || {});
    _phase4State.last = r;
    // Persist a copy so the quality harness can read it from disk
    // without the server running.
    try {
      await fs.writeFile(path.join(DATA_DIR, '_phase4_last.json'), JSON.stringify(r, null, 2));
    } catch { /* non-fatal */ }
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    _phase4State.running = false;
  }
});
router.get('/api/v2/detect-phase4/last', (_req, res) => {
  res.json({ running: _phase4State.running, last: _phase4State.last });
});

// Phase 3: emergent clustering + AI auto-labelling.
//
// Two endpoints:
//   POST /api/v2/embed-phase3          — generate paper/method/entity-context
//                                        embeddings (idempotent)
//   POST /api/v2/cluster-phase3        — community_detection + AI labelling
//                                        on every kind. Body: { provider?, only? }
router.post('/api/v2/embed-phase3', async (req, res) => {
  try {
    const r = await embedPhase3.generatePhase3Embeddings(req.body || {});
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/api/v2/cluster-phase3', async (req, res) => {
  try {
    const r = await clusterPhase3.runPhase3Clustering(req.body || {});
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read clusters by kind. ?kind=paper|claim|method|entity. Returns the
// cluster definitions + their sample members for the UI grid.
router.get('/api/v2/clusters/:kind', async (req, res) => {
  try {
    await v2Store.init();
    const kind = req.params.kind;
    const tableByKind = {
      paper:  'paper_clusters',
      claim:  'claim_clusters',
      method: 'method_clusters',
      entity: 'entity_clusters',
    };
    const tbl = tableByKind[kind];
    if (!tbl) return res.status(400).json({ error: 'unknown_kind' });
    const clusters = v2Store.query(`SELECT * FROM ${tbl} ORDER BY member_count DESC, cluster_id`);
    res.json({ kind, clusters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One paper's cluster context: which paper-cluster + method-cluster it
// belongs to, what its sibling papers look like, and the claim/entity
// cluster distribution within the paper. Backs the deep-read UI panel.
router.get('/api/v2/papers/:id/cluster-context', async (req, res) => {
  try {
    await v2Store.init();
    const id = req.params.id;
    const paper = v2Store.query(
      `SELECT paper_id, title, paper_cluster_id, method_cluster_id FROM papers WHERE paper_id = ?`,
      [id],
    )[0];
    if (!paper) return res.status(404).json({ error: 'paper_not_found' });
    const pc = paper.paper_cluster_id
      ? v2Store.query(`SELECT * FROM paper_clusters WHERE cluster_id = ?`, [paper.paper_cluster_id])[0] : null;
    const mc = paper.method_cluster_id
      ? v2Store.query(`SELECT * FROM method_clusters WHERE cluster_id = ?`, [paper.method_cluster_id])[0] : null;
    const siblings = paper.paper_cluster_id
      ? v2Store.query(
          `SELECT paper_id, title FROM papers WHERE paper_cluster_id = ? AND paper_id <> ?`,
          [paper.paper_cluster_id, id],
        ) : [];
    // Claim-cluster distribution within this paper.
    const claimClusters = v2Store.query(`
      SELECT cc.cluster_id, cc.auto_label, COUNT(*) AS n_in_paper
        FROM claims c
        INNER JOIN claim_clusters cc ON cc.cluster_id = c.cluster_id
       WHERE c.paper_id = ? AND c.cluster_id IS NOT NULL
       GROUP BY cc.cluster_id
       ORDER BY n_in_paper DESC`, [id]);
    const entityClusters = v2Store.query(`
      SELECT ec.cluster_id, ec.auto_label, COUNT(*) AS n_in_paper
        FROM entity_spans es
        INNER JOIN entity_clusters ec ON ec.cluster_id = es.cluster_id
       WHERE es.paper_id = ? AND es.cluster_id IS NOT NULL
       GROUP BY ec.cluster_id
       ORDER BY n_in_paper DESC`, [id]);
    res.json({
      paper,
      paper_cluster: pc,
      method_cluster: mc,
      sibling_papers: siblings,
      claim_clusters: claimClusters,
      entity_clusters: entityClusters,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 2: per-paper extraction on top of the grobid structure.
// Runs entities (GLiNER) + claims (LLM-as-finder) + numerical (tables +
// LLM fallback) + stance (LLM on citation contexts). Per-stage AI
// provider switch — body: { provider?: 'off' | 'auto' | 'openai' |
// 'anthropic', only?: [<claim_types>] }.
router.post('/api/v2/papers/:id/extract-phase2', async (req, res) => {
  try {
    const r = await extractPhase2.extractPhase2ForPaper(req.params.id, req.body || {});
    if (r.error) return res.status(422).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read the Phase 2 outputs for one paper. Returns:
//   entity_spans grouped by gliner_label, claims grouped by claim_type,
//   results, citation_markers with stance, plus counts.
router.get('/api/v2/papers/:id/phase2-structured', async (req, res) => {
  try {
    await v2Store.init();
    const id = req.params.id;
    const paper = v2Store.query('SELECT paper_id, title FROM papers WHERE paper_id = ?', [id])[0];
    if (!paper) return res.status(404).json({ error: 'paper_not_found' });

    const entitySpans = v2Store.query(
      `SELECT entity_span_id, paragraph_id, span_text, gliner_label, gliner_score, start_offset, end_offset
         FROM entity_spans WHERE paper_id = ? ORDER BY gliner_score DESC LIMIT 500`,
      [id],
    );
    const entityByLabel = {};
    for (const e of entitySpans) {
      if (!entityByLabel[e.gliner_label]) entityByLabel[e.gliner_label] = [];
      entityByLabel[e.gliner_label].push(e);
    }

    const claims = v2Store.query(
      `SELECT c.claim_id, c.text, c.page, c.stance, c.claim_type, c.chunk_id, c.mechanism,
              p.model AS provider
         FROM claims c
         LEFT JOIN provenance p ON p.prov_id = c.provenance_id
        WHERE c.paper_id = ? AND c.mechanism LIKE 'llm_finder%'
        ORDER BY c.claim_id`,
      [id],
    );
    const claimByType = {};
    for (const c of claims) {
      if (!claimByType[c.claim_type]) claimByType[c.claim_type] = [];
      claimByType[c.claim_type].push(c);
    }

    const results = v2Store.query(
      `SELECT result_id, metric, value, dataset, split, page, mechanism, raw_text
         FROM results WHERE paper_id = ? ORDER BY metric`,
      [id],
    );

    const stanceRows = v2Store.query(
      `SELECT stance, COUNT(*) AS n FROM citation_markers
        WHERE paper_id = ? AND stance IS NOT NULL
        GROUP BY stance ORDER BY n DESC`,
      [id],
    );
    const stanceSample = v2Store.query(
      `SELECT cm.surface_text, cm.stance, cm.context_text,
              rl.title AS cited_title, rl.authors_raw AS cited_authors,
              p.raw_text AS rationale
         FROM citation_markers cm
         LEFT JOIN reference_list rl ON rl.reference_id = cm.reference_id
         LEFT JOIN provenance p ON p.prov_id = cm.stance_provenance_id
        WHERE cm.paper_id = ? AND cm.stance IS NOT NULL
        ORDER BY cm.marker_id LIMIT 30`,
      [id],
    );

    res.json({
      paper,
      entities: { by_label: entityByLabel, total: entitySpans.length },
      claims:   { by_type: claimByType, total: claims.length },
      results,
      stance:   { by_stance: stanceRows, sample: stanceSample },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 1: grobid-js structured-parse ingest. Runs the new pipeline on
// one paper or the whole corpus, writes to the v4 schema tables
// (sections / paragraphs / reference_list / citation_markers / doc_tables
// / doc_figures). Idempotent per paper_id. The old per-field extractors
// stay in place and untouched until Phase 2 swaps consumers over.
router.post('/api/v2/papers/:id/grobid-ingest', async (req, res) => {
  try {
    const r = await ingestGrobid.ingestPaperGrobid(req.params.id, req.body || {});
    if (r.error) return res.status(422).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read the structured-parse output for one paper. Joins everything the
// grobid ingest wrote so the deep-read view can show parsed sections,
// references, citation markers, tables, figures without having to
// re-traverse grobid output.
router.get('/api/v2/papers/:id/grobid-structured', async (req, res) => {
  try {
    await v2Store.init();
    const id = req.params.id;
    const paper = v2Store.query('SELECT paper_id, title, year, doi, arxiv_id FROM papers WHERE paper_id = ?', [id])[0];
    if (!paper) return res.status(404).json({ error: 'paper_not_found' });
    const sections = v2Store.query(
      `SELECT section_id, section_idx, raw_heading, level, canonical_type, parent_id
         FROM sections WHERE paper_id = ? ORDER BY section_idx`,
      [id],
    );
    const paragraphCount = v2Store.query('SELECT COUNT(*) AS n FROM paragraphs WHERE paper_id = ?', [id])[0]?.n || 0;
    const references = v2Store.query(
      `SELECT reference_id, bib_ref_id, ref_label, title, authors_raw, date_year, journal, doi, url
         FROM reference_list WHERE paper_id = ? ORDER BY bib_ref_id`,
      [id],
    );
    const citationStats = v2Store.query(
      `SELECT COUNT(*) AS total_markers,
              SUM(CASE WHEN reference_id IS NOT NULL THEN 1 ELSE 0 END) AS linked,
              SUM(CASE WHEN reference_id IS NULL THEN 1 ELSE 0 END) AS unlinked
         FROM citation_markers WHERE paper_id = ?`,
      [id],
    )[0] || {};
    const tables = v2Store.query(
      `SELECT doc_table_id, table_idx, label, caption, page FROM doc_tables WHERE paper_id = ? ORDER BY table_idx`,
      [id],
    );
    const figures = v2Store.query(
      `SELECT doc_figure_id, figure_idx, label, caption, page FROM doc_figures WHERE paper_id = ? ORDER BY figure_idx`,
      [id],
    );
    // Sample paragraphs per section for the UI preview (cap to keep
    // the response small).
    const sectionsWithPreview = sections.map((s) => {
      const sample = v2Store.query(
        `SELECT paragraph_id, page_first, substr(text, 1, 240) AS preview, length(text) AS chars
           FROM paragraphs WHERE section_id = ? ORDER BY paragraph_idx LIMIT 2`,
        [s.section_id],
      );
      const nParas = v2Store.query(
        `SELECT COUNT(*) AS n FROM paragraphs WHERE section_id = ?`, [s.section_id],
      )[0]?.n || 0;
      return { ...s, n_paragraphs: nParas, sample_paragraphs: sample };
    });
    res.json({
      paper,
      sections: sectionsWithPreview,
      total_paragraphs: paragraphCount,
      references,
      citation_stats: {
        total: citationStats.total_markers || 0,
        linked: citationStats.linked || 0,
        unlinked: citationStats.unlinked || 0,
      },
      tables,
      figures,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hardware + ONNX execution-provider snapshot. Probed once at boot,
// cached for the process lifetime. Exposed so the Setup view can show
// users what their machine is running with (CoreML / CUDA / DirectML /
// CPU + which GPUs are detected). Override the auto-pick with
// LITREVIEW_ONNX_PROVIDER=<name>.
router.get('/api/platform', async (_req, res) => {
  try {
    const info = await platformInfo.detect();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/triage/embedding-profile', async (_req, res) => {
  try {
    const r = await activeLearning.profileEmbeddings();
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Embedding-readiness probe. Returns total candidates vs embedded
// papers vectors so the triage UI can decide whether to block the
// user with a setup modal. Also auto-kicks the daemon if it's idle
// but the corpus isn't fully embedded yet.
router.get('/api/triage/embed-readiness', async (_req, res) => {
  try {
    // triage.getAll() materialises candidates_triaged.csv from raw on
    // first call. Necessary because embedDaemon.syncPapers reads the
    // triaged CSV — without this, syncPapers queues nothing on a
    // freshly-searched corpus and the daemon idles at 0.
    const allRows = await triage.getAll().catch(() => []);
    const total = allRows.length;
    const embedded = await vectors.count('papers').catch(() => 0);
    const status = embedDaemon.status?.() || {};
    // If the daemon is idle but we have un-embedded papers, kick it.
    // No-op if it's already running. Fire-and-forget.
    if (total > 0 && embedded < total && !status.running && status.queue_size === 0) {
      embedDaemon.syncPapers?.().catch(() => {});
      embedDaemon.startNow?.();
    }
    res.json({
      total,
      embedded,
      ready: total > 0 && embedded >= total,
      running: !!status.running,
      queue_size: status.queue_size ?? 0,
    });
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

// Auto near-duplicate scan after search → embed-daemon idle. The scan
// runs over the papers vector store, so we have to wait for the daemon
// to embed the newly-searched papers before the scan is meaningful.
const nearDupAutoState = {
  pending: false,         // search just ended; waiting for embed-daemon idle
  pending_since: null,
  running: false,
  last: null,             // { ran_at, pair_count, error? }
};

embedDaemon.subscribe(async (event) => {
  if (event?.type !== 'idle') return;
  // Always recompute the corpus profile when the embedder goes idle.
  // This is the WHOLE point: communities + cosine percentiles are
  // computed ONCE per corpus state, then every help-me-triage pick
  // reuses the cache. No per-click recomputation.
  activeLearning.invalidateCorpusProfile();
  activeLearning.computeCorpusProfile().catch((e) => {
    console.warn('corpus profile compute failed:', e?.message || e);
  });
  // Near-duplicate scan runs only when the search runner flagged it.
  if (!nearDupAutoState.pending || nearDupAutoState.running) return;
  nearDupAutoState.running = true;
  nearDupAutoState.pending = false;
  try {
    const r = await searchQuality.findNearDuplicates();
    nearDupAutoState.last = {
      ran_at: new Date().toISOString(),
      pair_count: r.pairs?.length || 0,
      pairs: r.pairs || [],
    };
  } catch (err) {
    nearDupAutoState.last = { ran_at: new Date().toISOString(), error: err.message };
  } finally {
    nearDupAutoState.running = false;
  }
});

// Expose the auto-scan state so the UI can surface pending pairs
// without a manual button click.
router.get('/api/search/near-duplicates/auto', (_req, res) => {
  res.json({
    pending: nearDupAutoState.pending,
    pending_since: nearDupAutoState.pending_since,
    running: nearDupAutoState.running,
    last: nearDupAutoState.last,
  });
});

// On snowball completion, mirror the accumulated edges into the v2
// citations table. Best-effort; if v2 store isn't initialised yet
// (no v2 work happened in this session) we silently skip.
snowballDaemon.subscribe(async (event) => {
  if (event?.type !== 'idle') return;
  try {
    await v2Store.init();
    await v2Ingest.syncSnowballCitations();
  } catch (e) {
    console.warn('snowball→v2 citations sync failed:', e?.message || e);
  }
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

// Reset: wipe all stage artifacts back to a blank-slate project. Resets
// protocol files to the empty templates (so the next stage 1 run has
// somewhere to read from). Preserves the contact email and the API
// credentials by default. Requires an explicit `confirm: true` field so
// a no-body POST cannot accidentally trigger a wipe.
//
// Returns a full report of every file deleted, every directory wiped,
// every in-memory state cleared, and what was preserved — so the caller
// can verify the reset took effect.
router.post('/api/reset', async (req, res) => {
  const report = {
    ok: false,
    protocol_files_rewritten: [],
    data_files_deleted: [],
    data_files_missing: [],     // already absent (informational, not an error)
    directories_wiped: [],
    in_memory_state_cleared: [],
    daemons_stopped: [],
    preserved: { email: null, credentials: true },
  };
  try {
    const opts = req.body || {};
    if (opts.confirm !== true) {
      return res.status(400).json({
        error: 'confirm: true is required to perform a reset',
      });
    }
    // If an extraction is in flight, signal cancel and await it. The
    // orchestrator checks the abort signal between papers, so the wait
    // is bounded by one paper's per-paper time. Without this await the
    // in-flight paper would write ghost rows AFTER the disk wipe (the
    // bug that kept _extraction_log.jsonl reappearing post-reset).
    if (v2State.corpusJob && !v2State.corpusJob.finished_at) {
      report.daemons_stopped.push('corpus_extractor (awaited)');
      try { v2State.corpusAbort?.abort(); } catch {}
      if (v2State.corpusPromise) { try { await v2State.corpusPromise; } catch {} }
    }

    const keepEmail = opts.keep_email !== false;
    const keepCredentials = opts.keep_credentials !== false;
    report.preserved.credentials = keepCredentials;

    // 1. Capture the email BEFORE anything is touched so we have it even
    //    if a parallel write fails midway.
    let preservedEmail = '';
    if (keepEmail) {
      const md = await readText(PROTOCOL_FILES.topic, '');
      preservedEmail = parseTopic(md).contact_email || '';
      report.preserved.email = preservedEmail || null;
    }

    // 2. Rewrite protocol files with the EMPTY default templates so any
    //    reader (e.g., the daemon fetching contact_email) sees a valid
    //    file at all times AND so the next session has placeholders to
    //    edit instead of a missing file.
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
    report.protocol_files_rewritten.push(
      PROTOCOL_FILES.topic,
      PROTOCOL_FILES.search_queries,
      PROTOCOL_FILES.inclusion_criteria,
    );

    // 3. Stop the active search runner cleanly, if any.
    searchDiscarding = true;
    if (searchAbort) {
      searchAbort.abort();
      report.daemons_stopped.push('search');
    }
    if (searchPromise) { try { await searchPromise; } catch {} }
    searchAbort = null;
    searchPromise = null;
    eventBuffer = [];
    report.in_memory_state_cleared.push('eventBuffer');

    // 4. Stop EVERY background daemon cleanly. Without this, snowball's
    //    in-memory job state ("88/117 sources, 1213 candidates added")
    //    survives the reset and the UI shows progress from the previous
    //    corpus.
    try { await downloadDaemon.discard(); report.daemons_stopped.push('download'); } catch {}
    try { downloadDaemon.clearCaches?.(); } catch {}
    try { await snowballDaemon.discard?.(); report.daemons_stopped.push('snowball'); } catch {}
    try { await embedDaemon.discard?.(); report.daemons_stopped.push('embed'); } catch {}

    // 4b. DISCARD the v2 store BEFORE unlinking store.sqlite. close()
    //     flushes first, which would write the in-memory db back over
    //     the file we're about to delete — that's how 968 papers were
    //     surviving the reset. discard() drops in-memory state without
    //     flushing, so the unlink in step 5 actually clears the v2.
    try { v2Store.discard?.(); report.in_memory_state_cleared.push('v2Store'); } catch {}
    try { activeLearning.invalidateCorpusProfile?.(); report.in_memory_state_cleared.push('corpusProfile'); } catch {}

    // 4c. Clear EVERY transient in-memory job state in this module.
    //     These are what made `/api/v2/extract/corpus/status` keep
    //     reporting "414/414 done" after a reset — the state lived in
    //     module-level objects, not on disk.
    v2State.corpusJob = null;
    v2State.paperJobs.clear();
    report.in_memory_state_cleared.push('v2State.corpusJob', 'v2State.paperJobs');

    v2MigrateState.running = false;
    v2MigrateState.last = null;
    report.in_memory_state_cleared.push('v2MigrateState');

    v2CitationContextState.running = false;
    v2CitationContextState.last = null;
    report.in_memory_state_cleared.push('v2CitationContextState');

    nearDupAutoState.running = false;
    nearDupAutoState.pending = false;
    nearDupAutoState.pending_since = null;
    nearDupAutoState.last = null;
    report.in_memory_state_cleared.push('nearDupAutoState');

    // 5. Wipe data files (canonical artifacts of stages 1-4 + v2).
    const filesToDelete = [
      DATA_FILES.candidates_raw,
      DATA_FILES.candidates_triaged,
      DATA_FILES.search_log,
      DATA_FILES.triage_summary,
      DATA_FILES.download_log,
      DATA_FILES.manual_retrieval_list,
      DATA_FILES.deep_read_log,
      path.join(DATA_DIR, '_triage_meta.json'),
      path.join(DATA_DIR, '_synthesis.json'),
      path.join(DATA_DIR, '_extraction_log.jsonl'),
      path.join(DATA_DIR, 'store.sqlite'),
    ];
    for (const f of filesToDelete) {
      try {
        await fs.unlink(f);
        report.data_files_deleted.push(f);
      } catch (e) {
        if (e.code === 'ENOENT') report.data_files_missing.push(f);
        else throw e;
      }
    }

    // 6. Wipe directories: jobs, pdfs, notes, synthesis, vectors.
    //    Recreate the structural ones. _vectors is recreated lazily.
    const JOBS_DIR = path.join(DATA_DIR, '_jobs');
    const VECTORS_DIR = path.join(DATA_DIR, '_vectors');
    for (const dir of [JOBS_DIR, PDFS_DIR, NOTES_DIR, SYNTHESIS_DIR, VECTORS_DIR]) {
      await fs.rm(dir, { recursive: true, force: true });
      await ensureDir(dir);
      report.directories_wiped.push(dir);
    }

    // 7. Re-init the v2 store. The file is gone; init() creates a
    //    fresh empty database from schema.sql. v2Store.discard() in
    //    step 4b already dropped the in-memory state, so init starts
    //    clean.
    try { await v2Store.init?.(); } catch { /* will lazy-init on next request */ }

    // 8. Reset credentials unless we're preserving them.
    if (!keepCredentials) {
      const cred = path.join(DATA_DIR, '_credentials.json');
      try { await fs.unlink(cred); report.data_files_deleted.push(cred); }
      catch (e) { if (e.code === 'ENOENT') report.data_files_missing.push(cred); }
    }

    report.ok = true;
    res.json(report);
  } catch (err) {
    res.status(500).json({ ...report, error: err.message });
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
  const { provider, system, user, temperature, fallback, jsonSchema } = req.body || {};
  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'webllm') {
    return res.status(400).json({ error: 'provider must be openai, anthropic, or webllm' });
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

  let lastTrace = null;
  try {
    const full = await callLlm({
      provider,
      system,
      user,
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      fallback: Array.isArray(fallback) ? fallback : undefined,
      jsonSchema: jsonSchema && typeof jsonSchema === 'object' ? jsonSchema : undefined,
      onToken: (delta, total) => send({ type: 'delta', delta, total }),
      onComplete: (trace) => { lastTrace = trace; },
    });
    send({ type: 'done', full, provider_used: lastTrace?.provider_used || provider, attempts: lastTrace?.attempts });
  } catch (err) {
    send({ type: 'error', error: err.message, attempts: lastTrace?.attempts });
  } finally {
    res.end();
  }
});

router.get('/api/llm/probe/openai', async (_req, res) => {
  const result = await probeOpenAi();
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────
// OpenAI-compatible /v1/chat/completions endpoint backed by the local
// llama.cpp runtime. Same shape as llama-server / Ollama / OpenAI API,
// plus the llama.cpp grammar extensions: a top-level `grammar` field
// (GBNF source string) or a `response_format: { type: "json_schema",
// json_schema: { schema: <JSON Schema> } }` block. Both flow into
// llm_local.runOne and constrain decoding at the token level.
// ─────────────────────────────────────────────────────────────────────────
const chatCompletionsHandler = async (req, res) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages required', type: 'invalid_request_error' } });
  }
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content || '').join('\n').trim() || undefined;
  const userTurns = messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${m.content}`).join('\n\n');
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.7;
  const stream = body.stream === true;
  const gbnf = typeof body.grammar === 'string' ? body.grammar : undefined;
  let jsonSchema;
  if (body.response_format && body.response_format.type === 'json_schema') {
    jsonSchema = body.response_format.json_schema?.schema || body.response_format.json_schema;
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }

  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (delta, finishReason = null) => {
    const chunk = {
      id, object: 'chat.completion.chunk', created, model: llmLocal.getCurrentModelId() || 'webllm',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  try {
    if (stream) send({ role: 'assistant', content: '' });
    const full = await callLlm({
      provider: 'webllm',
      system,
      user: userTurns,
      temperature,
      jsonSchema,
      gbnf,
      onToken: stream ? (delta) => send({ content: delta }) : undefined,
    });
    if (stream) {
      send({}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({
        id, object: 'chat.completion', created, model: llmLocal.getCurrentModelId() || 'webllm',
        choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
      });
    }
  } catch (err) {
    if (stream) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
    }
  }
};
router.post('/v1/chat/completions', chatCompletionsHandler);
router.post('/chat/completions',     chatCompletionsHandler);

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

// Serve the PDF for a paper directly. Used by Deep Read's iframe.
// Streams the file if present; 404 with a clear message otherwise.
router.get('/api/notes/:paper_id/pdf', async (req, res) => {
  try {
    const paperId = String(req.params.paper_id);
    const fp = path.join(PDFS_DIR, `paper_${paperId}.pdf`);
    try {
      await fs.access(fp);
    } catch {
      return res.status(404).json({ error: 'pdf not found on disk', paper_id: paperId });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="paper_${paperId}.pdf"`);
    res.sendFile(fp);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// ─────────────────────────────────────────────────────────────────────────
// /api/v2 — structured-data pipeline (M1-M4 backend)
//
// v2 endpoints sit alongside the existing v1 ones. They read/write the
// SQLite store + extractor pipeline + Stage 2 detectors. v1 endpoints
// are unchanged and continue to serve the legacy prose-drafter flow
// until M5.b finishes the form rewrite.
// ─────────────────────────────────────────────────────────────────────────

// Background-extraction job state. Single in-flight corpus run at a time.
const v2State = {
  corpusJob: null,        // { id, started_at, completed: [], failed: [], total, finished_at? }
  paperJobs: new Map(),   // paper_id → last per-paper report
  corpusAbort: null,      // AbortController for the live corpus run (null when idle)
  corpusPromise: null,    // Promise of the in-flight corpus run; reset awaits it
};

// Sync papers + (optionally) ingest chunks for a single paper. Both
// operations are idempotent — safe to call repeatedly. Also mirrors
// snowball citation edges into the citations table (idempotent;
// no-ops if no snowball state file exists).
router.post('/api/v2/sync', async (req, res) => {
  try {
    await v2Store.init();
    const papers = await v2Ingest.syncPapersFromCsv();
    const citations = await v2Ingest.syncSnowballCitations();
    res.json({ papers, citations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ingest chunks for a single paper (runs pdf_chunks + section_classifier
// + writes to the chunks / chunk_section tables). Idempotent.
// Remove a paper from the corpus. Marks the triage row excluded
// (preserving row_index so paper_id assignment doesn't shift for the
// rest of the corpus), wipes the paper's rows from the v2 SQLite store,
// and deletes the PDF from disk. Used by Deep Read's per-row delete.
router.post('/api/v2/papers/:id/remove', async (req, res) => {
  try {
    const paperId = String(req.params.id);
    await v2Store.init();
    // 1. Update the triage CSV: find the row by paper_id, mark excluded.
    const allRows = await triage.getAll();
    const row = allRows.find((r) => String(r.paper_id) === paperId);
    if (row) {
      await triage.setDecision({
        row_index: row.row_index,
        label: 'exclude',
        reason: 'removed from deep read',
      });
    }
    // 2. Wipe v2 store rows for this paper. Order matters because of FK
    // dependencies (provenance referenced from many tables; clear those
    // first).
    const tables = [
      'name_usage', 'results', 'claims', 'quoted_spans',
      'paper_field', 'paper_category', 'paper_population', 'paper_authors',
      'chunk_section', 'chunks',
    ];
    v2Store.transaction(() => {
      for (const t of tables) {
        v2Store.exec(`DELETE FROM ${t} WHERE paper_id = ?`, [paperId]);
      }
      v2Store.exec('DELETE FROM citations WHERE from_paper = ? OR to_paper = ?', [paperId, paperId]);
      v2Store.exec('DELETE FROM papers WHERE paper_id = ?', [paperId]);
    });
    // 3. Delete the PDF on disk if it exists.
    const pdfFile = path.join(PDFS_DIR, `paper_${paperId}.pdf`);
    let pdfDeleted = false;
    try {
      await fs.unlink(pdfFile);
      pdfDeleted = true;
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('pdf delete failed:', e.message);
    }
    res.json({ ok: true, triage_updated: !!row, pdf_deleted: pdfDeleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/v2/papers/:id/ingest', async (req, res) => {
  try {
    const r = await v2Ingest.ingestChunksForPaper(req.params.id);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Run the M2 extraction pipeline for one paper. Synchronous — typical
// per-paper run is 15-20s on a current laptop. For longer corpus runs
// use POST /api/v2/extract/corpus.
//
// Body (optional):
//   { skipIngest?: bool, only?: ['bool', 'categorical', 'named_entities', 'numerical', 'topic_enums'] }
router.post('/api/v2/papers/:id/extract', async (req, res) => {
  try {
    const opts = req.body || {};
    const report = await v2Orchestrator.extractForPaper(req.params.id, opts);
    v2State.paperJobs.set(req.params.id, report);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start a corpus-wide extraction. Runs in the background; poll
// /api/v2/extract/corpus/status for progress.
router.post('/api/v2/extract/corpus', async (req, res) => {
  if (v2State.corpusJob && !v2State.corpusJob.finished_at) {
    return res.status(409).json({ error: 'corpus job already running', job: v2State.corpusJob });
  }
  // The deep-read extractor pipeline needs the local discriminative
  // models cached (embedder + NLI + NER + reranker). Force preload first
  // — without them the per-field extractors silently degrade.
  try {
    const r = await hfPreload.ready();
    if (!r.ready) {
      return res.status(412).json({
        error: 'AI models not ready',
        missing: r.missing,
        message: `The deep-read extractors need these local models cached: ${r.missing.join(', ')}. Run POST /api/models/preload to download them (~400MB one-time), then retry. The extraction pipeline is fully local — no API calls.`,
      });
    }
  } catch (e) {
    return res.status(500).json({ error: 'model readiness check failed: ' + e.message });
  }
  const jobId = 'corpus-' + Date.now();
  v2State.corpusJob = {
    id: jobId,
    started_at: new Date().toISOString(),
    completed: [],
    failed: [],
    total: null,
    progress_per_paper: null,
    // Step-level live state so the UI can show "now running categorical
    // on paper_037 — Smith et al. 2024" instead of just N/M.
    current: null,            // { paper_id, paper_title, step, step_started_at, paper_started_at }
    recent_elapsed_ms: [],    // rolling window of per-paper elapsed times for windowed ETA
    activity: [],             // last N step transitions for the activity log
  };
  // Per-run abort controller; reset (or an explicit cancel) calls
  // abort() which makes the orchestrator break out of its loop between
  // papers. We also stash the IIFE's promise so reset can await it.
  v2State.corpusAbort = new AbortController();
  // Fire and forget; orchestrator persists its own progress.
  // Repointed from the legacy v1 orchestrator (extractCorpus) to the
  // new v2 full pipeline (grobid → entities → claims → numerical →
  // stance per paper, then phase3-embed → phase3-cluster →
  // phase4-detect once across the corpus).
  v2State.corpusPromise = (async () => {
    try {
      const report = await extractFullPipelineCorpus({
        ...req.body,
        signal: v2State.corpusAbort.signal,
        onStart: ({ total }) => {
          const job = v2State.corpusJob;
          if (!job) return;
          job.total = total;
        },
        onStep: (step, paperId) => {
          const job = v2State.corpusJob;
          if (!job) return;
          const now = Date.now();
          // Lookup the title from v2 store (cheap; cached at sql.js level).
          let title = job.current?.paper_id === paperId ? job.current.paper_title : null;
          if (!title) {
            try {
              const row = v2Store.query('SELECT title FROM papers WHERE paper_id = ?', [paperId])[0];
              title = row?.title || '';
            } catch { title = ''; }
          }
          const sameTask = job.current && job.current.paper_id === paperId;
          job.current = {
            paper_id: paperId,
            paper_title: title,
            step,
            step_started_at: now,
            paper_started_at: sameTask ? job.current.paper_started_at : now,
          };
          // Append to a small activity log; keep last 12 entries.
          job.activity.push({ at: now, paper_id: paperId, paper_title: title, step });
          if (job.activity.length > 12) job.activity.shift();
        },
        onProgress: (r, done, total) => {
          const job = v2State.corpusJob;
          if (!job) return;
          job.progress_per_paper = { done, total, last_paper: r.paper_id, elapsed_ms: r.elapsed_ms };
          if (typeof r.elapsed_ms === 'number' && r.elapsed_ms > 0) {
            job.recent_elapsed_ms.push(r.elapsed_ms);
            if (job.recent_elapsed_ms.length > 8) job.recent_elapsed_ms.shift();
          }
        },
      });
      Object.assign(v2State.corpusJob, report, { finished_at: new Date().toISOString() });
    } catch (e) {
      v2State.corpusJob.error = e.message;
      v2State.corpusJob.finished_at = new Date().toISOString();
    } finally {
      v2State.corpusAbort = null;
      v2State.corpusPromise = null;
    }
  })();
  res.status(202).json({ job: v2State.corpusJob });
});

router.get('/api/v2/extract/corpus/status', (_req, res) => {
  res.json({ job: v2State.corpusJob || null });
});

// Probe whether topic.md needs auto-seeding (empty categories /
// method_families). Returns the current state + whether an AI provider
// is configured to do the labelling.
router.get('/api/v2/topic/seed-status', async (_req, res) => {
  try {
    const s = await v2AutoSeed.status();
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Run auto-seed. Clusters abstracts + methods chunks; labels via configured
// AI provider (or local bigram fallback). Writes to topic.md. Body:
//   { force?: bool, maxCategories?: int, maxMethods?: int }
router.post('/api/v2/topic/auto-seed', async (req, res) => {
  try {
    const r = await v2AutoSeed.runAutoSeed(req.body || {});
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel the running corpus extraction. The orchestrator checks the
// abort signal between papers; cancellation takes effect at the next
// paper boundary (typically within 30-300s depending on per-paper time).
// Returns immediately with 202; caller can poll status to confirm.
router.post('/api/v2/extract/corpus/cancel', async (_req, res) => {
  if (!v2State.corpusAbort || !v2State.corpusJob || v2State.corpusJob.finished_at) {
    return res.status(409).json({ error: 'no corpus job running' });
  }
  v2State.corpusAbort.abort();
  res.status(202).json({ ok: true, message: 'cancel signalled; will stop at the next paper boundary' });
});

// Read the full structured record for one paper. Joins everything M2
// wrote: paper row, categories, paper_field rows, name_usage rows,
// results, claims, chunks (count only).
router.get('/api/v2/papers/:id/structured', async (req, res) => {
  try {
    await v2Store.init();
    const id = req.params.id;
    const paper = v2Store.query('SELECT * FROM papers WHERE paper_id = ?', [id])[0];
    if (!paper) return res.status(404).json({ error: 'paper not found' });
    const authors = v2Store.query('SELECT author_name, position FROM paper_authors WHERE paper_id = ? ORDER BY position', [id]);
    const categories = v2Store.query('SELECT category FROM paper_category WHERE paper_id = ?', [id]).map((r) => r.category);
    const fields = v2Store.query(
      `SELECT pf.field_name, pf.field_value, pf.field_type, pf.provenance_id,
              p.mechanism, p.model, p.confidence, p.raw_text, p.chunk_id, p.page,
              p.classifier_scores_json
         FROM paper_field pf
         LEFT JOIN provenance p ON p.prov_id = pf.provenance_id
        WHERE pf.paper_id = ?`,
      [id],
    );
    const names = v2Store.query(
      `SELECT nu.canonical, nu.kind, nu.raw, nu.role, nu.n, nu.page, nu.mechanism, nu.score,
              cn.preferred_label
         FROM name_usage nu
         LEFT JOIN canonical_names cn ON cn.canonical = nu.canonical
        WHERE nu.paper_id = ?`,
      [id],
    );
    const results = v2Store.query('SELECT result_id, metric, value, dataset, split, page, raw_text FROM results WHERE paper_id = ?', [id]);
    const claims = v2Store.query('SELECT claim_id, text, page, stance, claim_type, chunk_id FROM claims WHERE paper_id = ?', [id]);
    const chunkCount = v2Store.query('SELECT COUNT(*) AS n FROM chunks WHERE paper_id = ?', [id])[0].n;
    res.json({
      paper,
      authors: authors.map((a) => a.author_name),
      categories,
      fields,
      names_by_kind: groupBy(names, (n) => n.kind),
      results,
      claims,
      chunk_count: chunkCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

// Run all detectors (or a subset via ?only=type1,type2,...). Returns
// the orchestrator's full report (byType + combined + summary).
router.get('/api/v2/detect', async (req, res) => {
  try {
    const opts = {};
    if (req.query.only) opts.only = String(req.query.only).split(',').filter(Boolean);
    if (req.query.topK) opts.topK = parseInt(req.query.topK, 10);
    if (req.query.rerank === '1') opts.rerankByCitations = true;
    const report = await v2Detectors.detectAll(opts);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Run a single detector by type.
router.get('/api/v2/detect/:type', async (req, res) => {
  try {
    const report = await v2Detectors.detectOne(req.params.type);
    res.json(report);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Dismiss a detector candidate so it stops surfacing on every detect
// run. Identified by { detector_type, signature } from the detect
// output. Reason is optional but recorded for audit.
router.post('/api/v2/dismiss-candidate', async (req, res) => {
  try {
    const { detector_type, signature, reason, content } = req.body || {};
    if (!detector_type || !signature) {
      return res.status(400).json({ error: 'detector_type and signature are required' });
    }
    await v2Store.init();
    // Optional content snapshot — caller passes the candidate object so
    // a future restore can show what was originally there even after the
    // gap has shifted.
    const contentJson = content !== undefined ? JSON.stringify(content) : null;
    v2Store.exec(
      `INSERT OR REPLACE INTO dismissed_candidates (detector_type, signature, dismissed_at, reason, content_json)
       VALUES (?, ?, ?, ?, ?)`,
      [detector_type, signature, new Date().toISOString(), reason || null, contentJson],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/v2/dismiss-candidate', async (req, res) => {
  try {
    const { detector_type, signature } = req.body || {};
    if (!detector_type || !signature) {
      return res.status(400).json({ error: 'detector_type and signature are required' });
    }
    await v2Store.init();
    v2Store.exec(
      `DELETE FROM dismissed_candidates WHERE detector_type = ? AND signature = ?`,
      [detector_type, signature],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-click migrate: syncs papers from CSV, runs chunk ingestion +
// structured extraction across the corpus. Fire-and-forget; status
// polled via /api/v2/extract/corpus/status (the existing endpoint —
// migrate is just a thin wrapper that runs sync first).
const v2MigrateState = { running: false, last: null };
router.post('/api/v2/migrate', async (_req, res) => {
  if (v2MigrateState.running) {
    return res.status(409).json({ error: 'migration already running' });
  }
  // Preflight: refuse on empty topic.md or empty triaged CSV — both
  // would silently succeed with 0 papers. Surface the issue early.
  try {
    const topicMd = await readText(PROTOCOL_FILES.topic, '');
    const topic = parseTopic(topicMd) || {};
    if (!topic.title?.trim()) {
      return res.status(400).json({ error: 'topic.md is empty — fill in a title (and ideally description, categories, method_families) on the Setup view before migrating.' });
    }
    // Triage CSV check via triage.summary().
    const sum = await triage.summary().catch(() => null);
    const includeMaybe = (sum?.include || 0) + (sum?.maybe || 0);
    if (!includeMaybe) {
      return res.status(400).json({ error: 'no include/maybe papers in candidates_triaged.csv — run triage first (Stage 2) before migrating.' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'preflight failed: ' + e.message });
  }

  v2MigrateState.running = true;
  v2MigrateState.last = { started_at: new Date().toISOString(), stage: 'sync', error: null };
  res.status(202).json({ started: true });
  (async () => {
    try {
      await v2Store.init();
      v2MigrateState.last.stage = 'sync:papers';
      const papers = await v2Ingest.syncPapersFromCsv();
      v2MigrateState.last.sync = { papers };
      v2MigrateState.last.stage = 'sync:citations';
      const citations = await v2Ingest.syncSnowballCitations();
      v2MigrateState.last.sync.citations = citations;
      v2MigrateState.last.stage = 'extract';
      const batch = await v2Orchestrator.extractCorpus({
        onProgress: (_r, i, n) => { v2MigrateState.last.progress = { current: i, total: n }; },
      });
      v2MigrateState.last.extract = {
        total: batch.total,
        completed: batch.completed?.length || 0,
        failed: batch.failed?.length || 0,
      };
      v2MigrateState.last.stage = 'done';
    } catch (e) {
      v2MigrateState.last.error = e?.message || String(e);
    } finally {
      v2MigrateState.last.finished_at = new Date().toISOString();
      v2MigrateState.running = false;
    }
  })();
});

router.get('/api/v2/migrate/status', (_req, res) => {
  res.json({ running: v2MigrateState.running, last: v2MigrateState.last });
});

// Category-validation probe. Compares paper_category values against
// the categories declared in topic.md. Surfaces typos like `nlp` vs
// `NLP` or stale categories that no longer match the topic.
router.get('/api/v2/category-validation', async (_req, res) => {
  try {
    const md = await readText(PROTOCOL_FILES.topic, '');
    const topic = parseTopic(md) || {};
    const declared = new Set((topic.categories || []).map((c) => String(c).trim().toLowerCase()));
    await v2Store.init();
    const inUse = v2Store.query(
      `SELECT category, COUNT(*) AS n FROM paper_category GROUP BY category ORDER BY n DESC`,
    );
    const unknown = inUse.filter((r) => !declared.has(String(r.category).trim().toLowerCase()));
    const declaredButUnused = (topic.categories || []).filter(
      (c) => !inUse.some((r) => String(r.category).trim().toLowerCase() === String(c).trim().toLowerCase()),
    );
    res.json({
      declared: [...declared],
      in_use: inUse,
      unknown,            // used in DB but not in topic.md
      unused: declaredButUnused, // declared in topic.md but never extracted
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Corpus-progress probe: where do we stand against the user's
// target_includes / minimum_includes? Drives the "X papers vs target T"
// widget on the conveyor. Pure metadata; cheap to fetch.
router.get('/api/v2/target-progress', async (_req, res) => {
  try {
    const md = await readText(PROTOCOL_FILES.topic, '');
    const topic = parseTopic(md) || {};
    const sum = await triage.summary().catch(() => ({ include: 0, maybe: 0 }));
    const included = (sum.include || 0);
    const includedOrMaybe = included + (sum.maybe || 0);
    res.json({
      target: topic.target_includes ?? null,
      minimum: topic.minimum_includes ?? null,
      included,
      included_or_maybe: includedOrMaybe,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v1 → v2 readiness probe. Detects projects that have legacy state
// (notes/*.md or a populated candidates_triaged.csv) but no v2
// extractions, and returns concrete next-step instructions so the user
// can migrate without guessing.
router.get('/api/v2/migration-status', async (_req, res) => {
  try {
    await v2Store.init();
    const csvRows = v2Store.query('SELECT COUNT(*) AS n FROM papers WHERE triage_label IN ("include","maybe")')[0]?.n || 0;
    const chunked = v2Store.query('SELECT COUNT(DISTINCT paper_id) AS n FROM chunks')[0]?.n || 0;
    const fieldsPapers = v2Store.query('SELECT COUNT(DISTINCT paper_id) AS n FROM paper_field')[0]?.n || 0;
    const claimsPapers = v2Store.query('SELECT COUNT(DISTINCT paper_id) AS n FROM claims')[0]?.n || 0;

    // Legacy file footprint.
    let legacyNotes = 0;
    try {
      const { NOTES_DIR } = await import('./paths.mjs');
      const { promises: fs } = await import('node:fs');
      const files = await fs.readdir(NOTES_DIR);
      legacyNotes = files.filter((f) => /^paper_\d+\.md$/.test(f)).length;
    } catch { /* dir missing */ }

    const steps = [];
    if (csvRows === 0 && legacyNotes === 0) {
      steps.push('Empty project — start by running Stage 1 (search) → Stage 2 (triage).');
    } else if (csvRows === 0 && legacyNotes > 0) {
      steps.push('Legacy v1 project detected (notes only, no v2 papers). Run POST /api/v2/migrate to sync + extract end-to-end.');
    }
    if (csvRows > 0 && (chunked < csvRows || fieldsPapers < csvRows)) {
      const need = Math.max(csvRows - chunked, csvRows - fieldsPapers);
      steps.push(`${need} paper(s) need chunk ingestion + structured extraction. Run POST /api/v2/migrate to run both end-to-end across the corpus. Per-paper alternative: POST /api/v2/papers/<id>/extract.`);
    }
    if (csvRows > 0 && claimsPapers < csvRows / 2) {
      steps.push(`Claims extraction is sparse (${claimsPapers}/${csvRows}). Run the claims-extractor per paper to populate them (browser-side WebLLM). Empirical-gap detector needs these to fire.`);
    }
    const ready = steps.length === 0;
    res.json({
      ready,
      counts: { triaged: csvRows, chunked, with_fields: fieldsPapers, with_claims: claimsPapers, legacy_notes: legacyNotes },
      next_steps: steps,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/v2/dismissed-candidates', async (_req, res) => {
  try {
    await v2Store.init();
    const rows = v2Store.query(
      `SELECT detector_type, signature, dismissed_at, reason, content_json FROM dismissed_candidates ORDER BY dismissed_at DESC`,
    );
    for (const r of rows) {
      if (r.content_json) {
        try { r.content = JSON.parse(r.content_json); } catch { /* ignore parse errors */ }
        delete r.content_json;
      }
    }
    res.json({ entries: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Citation context classification. Runs the NLI-per-edge classifier over
// every citations row with context_class IS NULL. Fire-and-forget; the
// snapshot endpoint exposes counts so the UI can poll.
const v2CitationContextState = { running: false, last: null };

router.post('/api/v2/citation-context/classify', async (req, res) => {
  if (v2CitationContextState.running) {
    return res.status(409).json({ error: 'classifier already running' });
  }
  const limit = req.body?.limit ? Math.max(1, parseInt(req.body.limit, 10)) : 500;
  v2CitationContextState.running = true;
  v2CitationContextState.last = { started_at: new Date().toISOString(), result: null, error: null };
  res.status(202).json({ started: true, limit });
  (async () => {
    try {
      const result = await v2ClassifyCitationContexts({ limit });
      v2CitationContextState.last.result = result;
    } catch (e) {
      v2CitationContextState.last.error = e?.message || String(e);
    } finally {
      v2CitationContextState.last.finished_at = new Date().toISOString();
      v2CitationContextState.running = false;
    }
  })();
});

// Tail of the per-paper extraction log. Each entry is a structured
// orchestrator report — paper_id, timestamps, errors, per-step results.
// Drives the "extraction failed for paper X" surface in the UI.
router.get('/api/v2/extraction-log', async (req, res) => {
  try {
    const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit, 10)) : 100;
    const onlyFailures = req.query.failures === '1';
    let log = await v2Orchestrator.readExtractionLog({ limit });
    if (onlyFailures) log = log.filter((r) => (r.errors || []).length > 0);
    res.json({ entries: log });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-field extraction coverage: populated / unknown / missing for every
// structured field, plus per-table coverage (chunks, claims, results,
// citations, named entities). Used to answer "how much of my corpus is
// actually populated?" without scrolling through the snapshot.
router.get('/api/v2/coverage', async (_req, res) => {
  try {
    const r = await v2ComputeCoverage();
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v2-native catalogue. Structured aggregation over quoted_spans + claims,
// grouped by topic category. No LLM generation — every entry is a
// verbatim quote with paper + page provenance.
router.get('/api/v2/catalogue', async (req, res) => {
  try {
    const opts = {};
    if (req.query.categories) {
      opts.onlyCategories = String(req.query.categories).split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (req.query.quotes_per_section) {
      opts.quotesPerSection = Math.max(1, parseInt(req.query.quotes_per_section, 10));
    }
    if (req.query.order && ['by_count', 'alpha', 'topic_order'].includes(req.query.order)) {
      opts.order = req.query.order;
    }
    if (opts.order === 'topic_order') {
      try {
        const md = await readText(PROTOCOL_FILES.topic, '');
        const topic = parseTopic(md) || {};
        opts.topicOrder = topic.categories || [];
      } catch { /* topic.md missing — order falls back to by_count */ }
    }
    const cat = await v2BuildCatalogue(opts);
    res.json(cat);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Same content as Markdown.
router.get('/api/v2/catalogue.md', async (req, res) => {
  try {
    const opts = {};
    if (req.query.categories) {
      opts.onlyCategories = String(req.query.categories).split(',').map((s) => s.trim()).filter(Boolean);
    }
    const cat = await v2BuildCatalogue(opts);
    res.set('Content-Type', 'text/markdown');
    res.send(v2CatalogueMd(cat));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/v2/citation-context/status', (_req, res) => {
  try {
    const totals = v2Store.query(
      `SELECT
         (SELECT COUNT(*) FROM citations)                                   AS total,
         (SELECT COUNT(*) FROM citations WHERE context_class IS NOT NULL)   AS classified,
         (SELECT COUNT(*) FROM citations WHERE context_class IS NULL)       AS unclassified`,
    );
    const dist = v2Store.query(
      `SELECT context_class, COUNT(*) AS n
         FROM citations
        WHERE context_class IS NOT NULL
        GROUP BY context_class
        ORDER BY n DESC`,
    );
    res.json({
      running: v2CitationContextState.running,
      last: v2CitationContextState.last,
      totals: totals[0] || { total: 0, classified: 0, unclassified: 0 },
      distribution: dist,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Structured query.
//   GET /api/v2/query?q=dataset:mimic-iii AND method_family:deep_learning
router.get('/api/v2/query', async (req, res) => {
  try {
    // Empty q is legitimate — it means "every paper". The structured
    // query parser turns it into `WHERE 1=1`. Deep Read uses this to
    // render its full paper list without imposing a synthetic filter.
    const q = String(req.query.q || '').trim();
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    const orderBy = req.query.order_by ? String(req.query.order_by) : undefined;
    const result = await v2RunQuery(q, { limit, orderBy });
    // `pdf_only=1` filters to papers whose PDF actually exists on disk.
    // The DB's pdf_path column can lie (downloader marks a row but the
    // file failed to land); Deep Read wants the on-disk truth.
    //
    // Read the PDFs directory ONCE and intersect with paper_ids, instead
    // of fileExists() per paper. For a 1000-paper corpus the sequential
    // fs.access() calls were the main reason Deep Read took seconds to
    // load and seconds-more on every nav-away+come-back.
    if (req.query.pdf_only === '1' && Array.isArray(result?.papers)) {
      let onDisk = new Set();
      try {
        const files = await fs.readdir(PDFS_DIR);
        for (const f of files) {
          const m = /^paper_(.+)\.pdf$/.exec(f);
          if (m) onDisk.add(m[1]);
        }
      } catch { /* dir missing == empty set */ }
      result.papers = result.papers.filter((p) => onDisk.has(String(p.paper_id)));
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Recommendation surface.
//   POST /api/v2/recommend  { shortlist: ['p1','p2',...], topK?, alpha?, beta? }
router.post('/api/v2/recommend', async (req, res) => {
  try {
    const body = req.body || {};
    const shortlist = Array.isArray(body.shortlist) ? body.shortlist : [];
    const opts = {};
    if (body.topK) opts.topK = body.topK;
    if (body.alpha != null) opts.alpha = body.alpha;
    if (body.beta != null)  opts.beta  = body.beta;
    const result = await v2Recommend(shortlist, opts);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Claims extraction prep + process — split because the LLM call lives
// in the browser via WebLLM. The client:
//   1. POST /api/v2/papers/:id/claims/prepare  → gets prompts
//   2. Runs WebLLM per prompt
//   3. POST /api/v2/papers/:id/claims/process { responses } → writes results
router.post('/api/v2/papers/:id/claims/prepare', async (req, res) => {
  try {
    const r = await v2PrepareClaims(req.params.id, req.body || {});
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/v2/papers/:id/claims/process', async (req, res) => {
  try {
    const responses = (req.body && req.body.responses) || [];
    const r = await v2ProcessClaims(req.params.id, responses, req.body || {});
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Snapshot of what's in the v2 store. Lightweight overview for the UI.
// Export the entire project/ directory as a .tar.gz blob (excluding
// _credentials.json — secrets stay local). Shells out to system `tar`
// rather than introducing a new dep; tar is universally available.
router.get('/api/v2/export', async (_req, res) => {
  try {
    const { spawn } = await import('node:child_process');
    const PROJECT_DIR = path.dirname(DATA_DIR);  // …/project
    const filename = `litreview-export-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // -C to step into the project dir's parent, then archive `project/`
    // (so the imported archive recreates the project layout).
    const tar = spawn('tar', [
      '-czf', '-',
      '-C', path.dirname(PROJECT_DIR),
      '--exclude=project/data/_credentials.json',
      path.basename(PROJECT_DIR),
    ]);
    tar.stdout.pipe(res);
    tar.stderr.on('data', (d) => console.warn('tar stderr:', String(d)));
    tar.on('error', (e) => {
      console.warn('tar spawn error:', e);
      if (!res.headersSent) res.status(500).end('export failed');
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import a .tar.gz produced by /api/v2/export. Body is the raw archive.
// We extract into a temp dir, sanity-check it has a `project/` root,
// then atomically swap with the live project dir.
//
// CAREFUL: this overwrites the active project directory. The caller is
// expected to have confirmed the destructive action client-side.
router.post('/api/v2/import', express.raw({ type: 'application/gzip', limit: '500mb' }), async (req, res) => {
  try {
    const { spawn } = await import('node:child_process');
    const os = await import('node:os');
    const PROJECT_DIR = path.dirname(DATA_DIR);
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'litreview-import-'));
    try {
      // Pipe the request body into `tar -xzf -` extracted into tmpRoot.
      const tar = spawn('tar', ['-xzf', '-', '-C', tmpRoot]);
      tar.stderr.on('data', (d) => console.warn('tar stderr:', String(d)));
      const tarFinished = new Promise((resolve, reject) => {
        tar.on('close', (code) => code === 0 ? resolve() : reject(new Error('tar exit ' + code)));
        tar.on('error', reject);
      });
      tar.stdin.write(req.body);
      tar.stdin.end();
      await tarFinished;

      // Sanity check: the archive should contain a top-level `project/`.
      const extracted = path.join(tmpRoot, 'project');
      try { await fs.access(extracted); }
      catch { throw new Error('archive does not contain a top-level `project/` directory'); }

      // Schema-version compatibility check. We open the extracted
      // store.sqlite (if present) and read its schema_meta.schema_version
      // against the schema_version this codebase ships. Mismatch =>
      // refuse import; the alternative is silent FK failures or worse.
      const incomingSqlite = path.join(extracted, 'data', 'store.sqlite');
      try {
        await fs.access(incomingSqlite);
        const initSqlJs = (await import('sql.js')).default;
        const wasmFile = path.join(
          path.dirname((await import('node:url')).fileURLToPath(import.meta.resolve('sql.js'))),
          'sql-wasm.wasm',
        );
        const SQL = await initSqlJs({ locateFile: () => wasmFile });
        const blob = await fs.readFile(incomingSqlite);
        const incomingDb = new SQL.Database(new Uint8Array(blob));
        let incomingVersion = null;
        try {
          const r = incomingDb.exec('SELECT value FROM schema_meta WHERE key = "schema_version"');
          incomingVersion = r?.[0]?.values?.[0]?.[0] ?? null;
        } catch { incomingVersion = null; }
        incomingDb.close();
        // Current codebase version: read our local store after init.
        await v2Store.init();
        const localR = v2Store.query('SELECT value FROM schema_meta WHERE key = "schema_version"');
        const localVersion = localR[0]?.value ?? null;
        if (incomingVersion && localVersion && String(incomingVersion) !== String(localVersion)) {
          throw new Error(
            `schema_version mismatch: archive is v${incomingVersion}, this build expects v${localVersion}. ` +
            `Upgrade the source side or downgrade this build before importing.`,
          );
        }
      } catch (e) {
        // ENOENT means archive had no v2 store yet — that's fine, treat
        // as a legacy archive. Any other error is fatal.
        if (e.code !== 'ENOENT') throw e;
      }

      // Preserve credentials.
      const credSrc = path.join(PROJECT_DIR, 'data', '_credentials.json');
      let credBuf = null;
      try { credBuf = await fs.readFile(credSrc); } catch { /* none */ }

      // Atomic-ish swap: move current project aside, move extracted in,
      // delete old. If something fails midway the user keeps something
      // workable (the .old dir).
      const oldPath = PROJECT_DIR + '.old-' + Date.now();
      await fs.rename(PROJECT_DIR, oldPath);
      await fs.rename(extracted, PROJECT_DIR);
      // Restore credentials if they were preserved.
      if (credBuf) {
        await ensureDir(path.join(PROJECT_DIR, 'data'));
        await fs.writeFile(path.join(PROJECT_DIR, 'data', '_credentials.json'), credBuf);
        await fs.chmod(path.join(PROJECT_DIR, 'data', '_credentials.json'), 0o600);
      }
      // Best-effort cleanup of old + tmp.
      fs.rm(oldPath, { recursive: true, force: true }).catch(() => {});
      fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

      // Re-init the v2 store so it picks up the new SQLite file.
      try { await v2Store.close(); } catch { /* ignore */ }
      await v2Store.init();

      res.json({ imported: true, credentials_preserved: !!credBuf });
    } catch (e) {
      // Cleanup tmp on error.
      fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a paper's category list. Replaces the existing set in
// paper_category for this paper. Provenance for manual edits is recorded
// with mechanism='user_edit' so the audit trail stays consistent.
router.put('/api/v2/papers/:id/categories', async (req, res) => {
  try {
    await v2Store.init();
    const id = req.params.id;
    const cats = Array.isArray(req.body?.categories) ? req.body.categories : [];
    const exists = v2Store.query('SELECT paper_id FROM papers WHERE paper_id = ?', [id]);
    if (exists.length === 0) return res.status(404).json({ error: 'paper not found' });
    const provId = v2Store.recordProvenance({
      mechanism: 'user_edit',
      raw_text: cats.join(','),
      confidence: 1.0,
    });
    v2Store.transaction(() => {
      v2Store.exec('DELETE FROM paper_category WHERE paper_id = ?', [id]);
      for (const c of cats) {
        const v = String(c || '').trim();
        if (!v) continue;
        v2Store.exec('INSERT INTO paper_category (paper_id, category) VALUES (?, ?)', [id, v]);
      }
      v2Store.exec('DELETE FROM paper_field WHERE paper_id = ? AND field_name = ?', [id, 'category']);
      v2Store.exec(
        `INSERT INTO paper_field (paper_id, field_name, field_value, field_type, provenance_id)
         VALUES (?, 'category', ?, 'string', ?)`,
        [id, cats.join(','), provId],
      );
    });
    res.json({ paper_id: id, categories: cats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a single paper_field value. Used by the v2 deep-read form's
// inline editors. The previous row is replaced and a fresh provenance
// row with mechanism='user_edit' is attached so the audit trail stays
// honest.
//
// Body: { value: <string|number|bool>, field_type?: 'string'|'enum'|'number'|'bool' }
router.put('/api/v2/papers/:id/fields/:fieldName', async (req, res) => {
  try {
    await v2Store.init();
    const id = req.params.id;
    const fieldName = req.params.fieldName;
    const body = req.body || {};
    const value = body.value == null ? '' : String(body.value);
    const fieldType = body.field_type || 'string';
    const exists = v2Store.query('SELECT paper_id FROM papers WHERE paper_id = ?', [id]);
    if (exists.length === 0) return res.status(404).json({ error: 'paper not found' });
    const provId = v2Store.recordProvenance({
      mechanism: 'user_edit',
      raw_text: value,
      confidence: 1.0,
    });
    v2Store.transaction(() => {
      v2Store.exec('DELETE FROM paper_field WHERE paper_id = ? AND field_name = ?', [id, fieldName]);
      v2Store.exec(
        `INSERT INTO paper_field (paper_id, field_name, field_value, field_type, provenance_id)
         VALUES (?, ?, ?, ?, ?)`,
        [id, fieldName, value, fieldType, provId],
      );
    });
    res.json({ paper_id: id, field_name: fieldName, value, field_type: fieldType });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mutate name_usage entries for a paper. Body shapes:
//   { action: 'add', kind: 'tech', canonical: 'pytorch', raw?: 'PyTorch', role?: null }
//   { action: 'remove', usage_id: 42 }
//   { action: 'remove_by_canonical', kind: 'tech', canonical: 'pytorch' }
router.post('/api/v2/papers/:id/name-usage', async (req, res) => {
  try {
    await v2Store.init();
    const id = req.params.id;
    const exists = v2Store.query('SELECT paper_id FROM papers WHERE paper_id = ?', [id]);
    if (exists.length === 0) return res.status(404).json({ error: 'paper not found' });
    const { action, kind, canonical, raw, role, usage_id } = req.body || {};
    if (action === 'add') {
      if (!kind || !canonical) return res.status(400).json({ error: 'kind + canonical required' });
      v2Store.exec(
        `INSERT OR IGNORE INTO canonical_names (canonical, kind, preferred_label)
         VALUES (?, ?, ?)`,
        [canonical, kind, raw || canonical],
      );
      const provId = v2Store.recordProvenance({
        mechanism: 'user_edit',
        raw_text: raw || canonical,
        confidence: 1.0,
      });
      v2Store.exec(
        `INSERT INTO name_usage (paper_id, canonical, kind, raw, role, mechanism, score, provenance_id)
         VALUES (?, ?, ?, ?, ?, 'user_edit', 1.0, ?)`,
        [id, canonical, kind, raw || null, role || null, provId],
      );
      return res.json({ added: true, paper_id: id, canonical, kind });
    }
    if (action === 'remove' && usage_id != null) {
      v2Store.exec('DELETE FROM name_usage WHERE paper_id = ? AND usage_id = ?', [id, usage_id]);
      return res.json({ removed: true, usage_id });
    }
    if (action === 'remove_by_canonical' && kind && canonical) {
      v2Store.exec(
        'DELETE FROM name_usage WHERE paper_id = ? AND kind = ? AND canonical = ?',
        [id, kind, canonical],
      );
      return res.json({ removed: true, kind, canonical });
    }
    res.status(400).json({ error: 'unknown action / missing params' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mutate the results table for a paper.
//   { action: 'add',    metric, value, dataset?, split? }
//   { action: 'remove', result_id }
//   { action: 'edit',   result_id, metric, value, dataset?, split? }
router.post('/api/v2/papers/:id/results', async (req, res) => {
  try {
    await v2Store.init();
    const id = req.params.id;
    const exists = v2Store.query('SELECT paper_id FROM papers WHERE paper_id = ?', [id]);
    if (exists.length === 0) return res.status(404).json({ error: 'paper not found' });
    const body = req.body || {};
    const { action, result_id, metric, value, dataset, split } = body;
    if (action === 'add') {
      if (!metric || value == null) return res.status(400).json({ error: 'metric + value required' });
      const provId = v2Store.recordProvenance({
        mechanism: 'user_edit',
        raw_text: `${metric}=${value}${dataset ? ' on ' + dataset : ''}`,
        confidence: 1.0,
      });
      const r = v2Store.exec(
        `INSERT INTO results (paper_id, metric, value, dataset, split, mechanism, provenance_id)
         VALUES (?, ?, ?, ?, ?, 'user_edit', ?)`,
        [id, metric, Number(value), dataset || null, split || null, provId],
      );
      return res.json({ added: true, result_id: r.lastInsertId });
    }
    if (action === 'remove' && result_id != null) {
      v2Store.exec('DELETE FROM results WHERE paper_id = ? AND result_id = ?', [id, result_id]);
      return res.json({ removed: true, result_id });
    }
    if (action === 'edit' && result_id != null) {
      const provId = v2Store.recordProvenance({
        mechanism: 'user_edit',
        raw_text: `${metric}=${value}`,
        confidence: 1.0,
      });
      v2Store.exec(
        `UPDATE results SET metric = ?, value = ?, dataset = ?, split = ?, mechanism = 'user_edit', provenance_id = ?
         WHERE paper_id = ? AND result_id = ?`,
        [metric, Number(value), dataset || null, split || null, provId, id, result_id],
      );
      return res.json({ edited: true, result_id });
    }
    res.status(400).json({ error: 'unknown action / missing params' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mutate quoted_spans for a paper section.
// Body shapes:
//   { action: 'add',    section: 'problem_statement', text: '…', page: 4, chunk_id?: '…' }
//   { action: 'remove', span_id: 42 }
//   { action: 'edit',   span_id: 42, text: '…', page: 4 }
router.post('/api/v2/papers/:id/spans', async (req, res) => {
  try {
    await v2Store.init();
    const id = req.params.id;
    const exists = v2Store.query('SELECT paper_id FROM papers WHERE paper_id = ?', [id]);
    if (exists.length === 0) return res.status(404).json({ error: 'paper not found' });
    const { action, section, text, page, chunk_id, span_id } = req.body || {};
    if (action === 'add') {
      if (!section || !text) return res.status(400).json({ error: 'section + text required' });
      // Compute the next position within the section.
      const max = v2Store.query(
        'SELECT MAX(position) AS p FROM quoted_spans WHERE paper_id = ? AND section = ?',
        [id, section],
      );
      const nextPos = ((max?.[0]?.p) || 0) + 1;
      const provId = v2Store.recordProvenance({
        mechanism: 'user_edit',
        chunk_id: chunk_id || null,
        page: page || null,
        raw_text: text,
        confidence: 1.0,
      });
      const r = v2Store.exec(
        `INSERT INTO quoted_spans (paper_id, section, position, text, page, chunk_id, mechanism, provenance_id)
         VALUES (?, ?, ?, ?, ?, ?, 'user_edit', ?)`,
        [id, section, nextPos, text, page || null, chunk_id || null, provId],
      );
      return res.json({ added: true, span_id: r.lastInsertId, paper_id: id, section });
    }
    if (action === 'remove' && span_id != null) {
      v2Store.exec('DELETE FROM quoted_spans WHERE paper_id = ? AND span_id = ?', [id, span_id]);
      return res.json({ removed: true, span_id });
    }
    if (action === 'edit' && span_id != null) {
      const existing = v2Store.query('SELECT * FROM quoted_spans WHERE paper_id = ? AND span_id = ?', [id, span_id]);
      if (existing.length === 0) return res.status(404).json({ error: 'span not found' });
      const provId = v2Store.recordProvenance({
        mechanism: 'user_edit',
        chunk_id: existing[0].chunk_id,
        page: page || existing[0].page,
        raw_text: text != null ? text : existing[0].text,
        confidence: 1.0,
      });
      v2Store.exec(
        `UPDATE quoted_spans SET text = ?, page = ?, mechanism = 'user_edit', provenance_id = ?
         WHERE paper_id = ? AND span_id = ?`,
        [text ?? existing[0].text, page ?? existing[0].page, provId, id, span_id],
      );
      return res.json({ edited: true, span_id });
    }
    res.status(400).json({ error: 'unknown action / missing params' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get the quoted_spans for a paper, grouped by section. Used by the
// v2 deep-read body editor.
router.get('/api/v2/papers/:id/spans', async (req, res) => {
  try {
    await v2Store.init();
    const id = req.params.id;
    const rows = v2Store.query(
      `SELECT span_id, section, position, text, page, chunk_id, mechanism
         FROM quoted_spans WHERE paper_id = ?
         ORDER BY section, position`,
      [id],
    );
    const bySection = {};
    for (const r of rows) {
      if (!bySection[r.section]) bySection[r.section] = [];
      bySection[r.section].push(r);
    }
    res.json({ paper_id: id, by_section: bySection });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// External-corpus comparison: pulls a same-topic OpenAlex sample,
// joint-cluster with the in-corpus papers, returns clusters dense in
// external but sparse in your corpus. Async via /api/v2/external-compare
// (fire-and-forget) + /api/v2/external-compare/status (polling).
const v2ExternalState = { last: null, running: false };

router.post('/api/v2/external-compare', async (req, res) => {
  if (v2ExternalState.running) {
    return res.status(409).json({ error: 'comparison already running', state: { running: true } });
  }
  v2ExternalState.running = true;
  v2ExternalState.last = { started_at: new Date().toISOString(), result: null, error: null };
  res.status(202).json({ started: true });
  // Fire and forget. Result becomes available via /status.
  (async () => {
    try {
      const result = await v2RunExternalComparison(req.body || {});
      v2ExternalState.last.result = result;
    } catch (e) {
      v2ExternalState.last.error = e?.message || String(e);
    } finally {
      v2ExternalState.last.finished_at = new Date().toISOString();
      v2ExternalState.running = false;
    }
  })();
});

router.get('/api/v2/external-compare/status', (_req, res) => {
  res.json({ running: v2ExternalState.running, last: v2ExternalState.last });
});

// Tabular corpus index for a given canonical-name kind. Returns each
// distinct canonical entity + its paper count + a few sample raw forms.
//   GET /api/v2/corpus-index?kind=dataset|tech|framework|metric
router.get('/api/v2/corpus-index', async (req, res) => {
  try {
    await v2Store.init();
    const kind = String(req.query.kind || '').toLowerCase();
    if (!kind) return res.status(400).json({ error: 'kind required' });
    const rows = v2Store.query(
      `SELECT nu.canonical,
              cn.preferred_label,
              COUNT(DISTINCT nu.paper_id) AS paper_count,
              group_concat(DISTINCT nu.paper_id) AS paper_ids,
              group_concat(DISTINCT nu.raw) AS sample_raws_joined
         FROM name_usage nu
         LEFT JOIN canonical_names cn ON cn.canonical = nu.canonical
        WHERE nu.kind = ?
        GROUP BY nu.canonical
        ORDER BY paper_count DESC, nu.canonical ASC`,
      [kind],
    );
    const items = rows.map((r) => ({
      canonical: r.canonical,
      preferred_label: r.preferred_label || null,
      paper_count: r.paper_count,
      paper_ids: (r.paper_ids || '').split(',').filter(Boolean),
      sample_raws: (r.sample_raws_joined || '').split(',').filter(Boolean).slice(0, 5),
    }));
    res.json({ kind, count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/v2/snapshot', async (_req, res) => {
  try {
    await v2Store.init();
    const counts = {
      papers:        v2Store.query('SELECT COUNT(*) AS n FROM papers')[0].n,
      chunks:        v2Store.query('SELECT COUNT(*) AS n FROM chunks')[0].n,
      chunk_section: v2Store.query('SELECT COUNT(*) AS n FROM chunk_section')[0].n,
      paper_field:   v2Store.query('SELECT COUNT(*) AS n FROM paper_field')[0].n,
      name_usage:    v2Store.query('SELECT COUNT(*) AS n FROM name_usage')[0].n,
      claims:        v2Store.query('SELECT COUNT(*) AS n FROM claims')[0].n,
      results:       v2Store.query('SELECT COUNT(*) AS n FROM results')[0].n,
      citations:     v2Store.query('SELECT COUNT(*) AS n FROM citations')[0].n,
      provenance:    v2Store.query('SELECT COUNT(*) AS n FROM provenance')[0].n,
    };
    const fieldCounts = v2Store.query(
      `SELECT field_name, COUNT(*) AS n FROM paper_field GROUP BY field_name ORDER BY n DESC`,
    );
    const kinds = v2Store.query(
      `SELECT kind, COUNT(*) AS n FROM name_usage GROUP BY kind ORDER BY n DESC`,
    );
    // Embedder identity check (warn on model/dtype drift between writes).
    let embedderCheck = null;
    try {
      const vectorsMod = await import('./lib/vectors.mjs');
      const embedderMod = await import('./lib/embedder.mjs');
      embedderCheck = await vectorsMod.checkEmbedderCompatibility(
        embedderMod.MODEL, embedderMod.DTYPE_IN_USE, embedderMod.DIMENSIONS,
      );
    } catch { /* best-effort */ }
    res.json({
      counts,
      paper_field_breakdown: fieldCounts,
      name_usage_by_kind: kinds,
      embedder_check: embedderCheck,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
