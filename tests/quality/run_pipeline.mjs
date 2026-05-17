#!/usr/bin/env node
// Drive the pipeline (grobid → extract-phase2) over every paper_id in
// tests/quality/sample.txt against the local Qwen LLM. Sequential per
// paper to avoid GPU contention. Embed + cluster + detect run once at
// the end. Logs to tests/quality/_pipeline_log.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(__dirname, 'sample.txt');
const LOG = path.join(__dirname, '_pipeline_log.jsonl');
const BASE = process.env.LR_BASE || 'http://localhost:4174';

const ids = fs.readFileSync(SAMPLE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
if (ids.length === 0) { console.error('sample.txt empty'); process.exit(1); }

function log(rec) {
  rec.t = new Date().toISOString();
  console.log(JSON.stringify(rec));
  fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
}

async function postJson(url, body, timeoutMs = 30 * 60_000) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: j };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e.message } };
  } finally {
    clearTimeout(tm);
  }
}

async function run() {
  log({ event: 'start', papers: ids.length });
  // Skip papers that already have Phase 2 claims in the store —
  // re-runs after a crash should pick up where the previous one left off.
  const skipIds = new Set();
  for (const id of ids) {
    const ck = await fetch(`${BASE}/api/v2/papers/${id}/phase2-structured`).then((r) => r.ok ? r.json() : null).catch(() => null);
    const claimCount = ck?.claims ? Object.values(ck.claims.by_type || {}).reduce((a, b) => a + (Array.isArray(b) ? b.length : 0), 0) : 0;
    if (claimCount > 0) skipIds.add(id);
  }
  log({ event: 'resume-skip', already_extracted: [...skipIds] });
  for (const id of ids) {
    if (skipIds.has(id)) continue;
    const t0 = Date.now();
    const grobid = await postJson(`${BASE}/api/v2/papers/${id}/grobid-ingest`, {});
    log({ event: 'grobid', id, ok: grobid.ok, status: grobid.status, ms: Date.now() - t0 });
    if (!grobid.ok) continue;
    const t1 = Date.now();
    const p2 = await postJson(`${BASE}/api/v2/papers/${id}/extract-phase2`, {});
    const steps = p2.body?.steps || {};
    log({ event: 'phase2', id, ok: p2.ok, status: p2.status, ms: Date.now() - t1,
          summary: {
            entities: steps.entities?.n_spans,
            claims: steps.claims?.total_accepted,
            numerical: steps.numerical?.total_accepted,
            stance: steps.stance?.classified,
          } });
  }
  const t0 = Date.now();
  const embed = await postJson(`${BASE}/api/v2/embed-phase3`, {});
  log({ event: 'embed-phase3', ok: embed.ok, ms: Date.now() - t0 });
  const t1 = Date.now();
  const cluster = await postJson(`${BASE}/api/v2/cluster-phase3`, {});
  log({ event: 'cluster-phase3', ok: cluster.ok, ms: Date.now() - t1 });
  const t2 = Date.now();
  const detect = await postJson(`${BASE}/api/v2/detect-phase4`, {});
  log({ event: 'detect-phase4', ok: detect.ok, ms: Date.now() - t2, summary: detect.body?.summary });
  log({ event: 'done' });
}
run().catch((e) => { log({ event: 'error', error: e.message }); process.exit(1); });
