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

router.get('/api/status', async (_req, res) => {
  const [
    topicSet, queriesSet, criteriaSet,
    rawCsv, triagedCsv, downloadLog, gapMatrix, positioning,
  ] = await Promise.all([
    fileExists(PROTOCOL_FILES.topic),
    fileExists(PROTOCOL_FILES.search_queries),
    fileExists(PROTOCOL_FILES.inclusion_criteria),
    fileExists(DATA_FILES.candidates_raw),
    fileExists(DATA_FILES.candidates_triaged),
    fileExists(DATA_FILES.download_log),
    fileExists(SYNTHESIS_FILES.gap_matrix),
    fileExists(SYNTHESIS_FILES.positioning_statement),
  ]);
  res.json({
    setup: { topic: topicSet, queries: queriesSet, criteria: criteriaSet },
    stage1: { done: rawCsv, running: !!searchAbort },
    stage2: { done: triagedCsv },
    stage3: { done: downloadLog },
    stage5: { done: gapMatrix },
    stage7: { done: positioning },
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

router.put('/api/notes/:paper_id', async (req, res) => {
  try {
    const note = req.body?.note;
    if (!note?.frontmatter || !note?.body) {
      return res.status(400).json({ error: 'note must have frontmatter and body' });
    }
    const result = await notes.saveNote(req.params.paper_id, note);
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

router.get('/api/health', (_req, res) => res.json({ ok: true }));
