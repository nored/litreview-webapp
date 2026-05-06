// Background download daemon. One singleton per process. Auto-fetches PDFs
// for papers labelled include or maybe in stage 2 triage. Runs in parallel
// with triage work so by the time the student finishes labelling, most
// PDFs are already on disk.
//
// Sequential within the daemon (one paper at a time, with politeness sleeps).
// Pause/resume/discard via the API.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_FILES, PDFS_DIR, PROTOCOL_FILES,
} from '../paths.mjs';
import { ensureDir, readText, fileExists } from '../storage.mjs';
import { writeCsv, parseCsv } from './csv.mjs';
import { parseTopic } from './topic_md.mjs';
import { tryDownload, resolveCandidates, isValidPdf } from './download.mjs';
import {
  readDownloadJob, writeDownloadJob, clearDownloadJob, newDownloadJob,
} from './jobs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG_FIELDS = ['paper_id', 'attempted_url', 'status', 'file_size_bytes', 'error_message'];

const state = {
  job: null,                      // current job manifest (in memory)
  queue: new Map(),               // paper_id -> row (pending downloads)
  attempted: new Set(),           // paper_ids already done (success or fail)
  inflight: null,                 // current paper_id being downloaded
  loop: null,                     // active runner promise
  paused: false,                  // user-requested pause
  discarding: false,              // discard in progress; loop should bail
  listeners: new Set(),
  eventBuffer: [],                // recent events for late-joining SSE clients
  emailCache: null,
  triageRowsCache: null,
  triageCacheStamp: 0,
};

function broadcast(event) {
  state.eventBuffer.push({ ...event, ts: Date.now() });
  if (state.eventBuffer.length > 500) state.eventBuffer.shift();
  for (const fn of state.listeners) {
    try { fn(event); } catch (e) { /* ignore */ }
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
    queue_size: state.queue.size,
    attempted: state.attempted.size,
    inflight: state.inflight,
    job: state.job ? {
      id: state.job.id,
      status: state.job.status,
      started_at: state.job.started_at,
      finished_at: state.job.finished_at,
      interrupted_at: state.job.interrupted_at,
      completed_count: state.job.completed.length,
      failed_count: state.job.failed.length,
      success_count: state.job.completed.filter(
        (e) => e.status === 'success' || e.status === 'already_present',
      ).length,
    } : null,
  };
}

async function loadJob() {
  let job = await readDownloadJob();
  if (!job) {
    job = newDownloadJob();
    await writeDownloadJob(job);
  }
  state.job = job;
  state.attempted = new Set([
    ...job.completed.map((e) => e.paper_id),
    ...job.failed.map((e) => e.paper_id),
  ]);
}

async function readTriageRows() {
  const exists = await fileExists(DATA_FILES.candidates_triaged);
  if (!exists) return [];
  const stat = await fs.stat(DATA_FILES.candidates_triaged);
  if (state.triageRowsCache && stat.mtimeMs <= state.triageCacheStamp) {
    return state.triageRowsCache;
  }
  const text = await readText(DATA_FILES.candidates_triaged, '');
  const { rows } = parseCsv(text);
  state.triageRowsCache = rows;
  state.triageCacheStamp = stat.mtimeMs;
  return rows;
}

function shouldDownload(row) {
  if (!row?.paper_id) return false;
  return row.triage_label === 'include' || row.triage_label === 'maybe';
}

// Public API: pull include/maybe rows from triage CSV into the queue. Called
// at boot and any time decisions change in bulk.
export async function syncFromTriage() {
  const rows = await readTriageRows();
  let added = 0;
  for (const row of rows) {
    if (!shouldDownload(row)) continue;
    if (state.attempted.has(row.paper_id)) continue;
    if (state.queue.has(row.paper_id)) continue;
    state.queue.set(row.paper_id, row);
    added++;
  }
  if (added > 0) broadcast({ type: 'queue_sync', added, queue_size: state.queue.size });
  // Kick the loop if there's now work to do
  if (state.queue.size > 0 && !state.paused && !state.loop) {
    runLoop();
  }
}

// Public API: enqueue a single paper from a specific decision update.
export function enqueue(row) {
  if (!shouldDownload(row)) return;
  if (state.attempted.has(row.paper_id)) return;
  if (state.queue.has(row.paper_id)) return;
  // Don't re-enqueue something currently being downloaded; the loop will
  // mark it attempted as soon as the in-flight call returns.
  if (state.inflight === row.paper_id) return;
  state.queue.set(row.paper_id, row);
  broadcast({ type: 'enqueued', paper_id: row.paper_id, queue_size: state.queue.size });
  if (!state.paused && !state.loop) runLoop();
}

// Clear in-process caches. Called by the reset endpoint so the daemon
// re-reads protocol files after they're rewritten.
export function clearCaches() {
  state.emailCache = null;
  state.triageRowsCache = null;
  state.triageCacheStamp = 0;
}

export function listFailures() {
  return state.job ? state.job.failed.slice() : [];
}

// Manual upload: a student downloaded the PDF in their browser (because
// the publisher's bot protection blocks our fetch) and is now handing
// us the bytes. Validate, save, move from failed to completed.
export async function recordManualUpload({ paperId, buffer }) {
  const validation = isValidPdf(buffer);
  if (!validation.ok) {
    throw new Error(`uploaded file is not a valid PDF: ${validation.reason}`);
  }
  await ensureDir(PDFS_DIR);
  const outPath = path.join(PDFS_DIR, `paper_${paperId}.pdf`);
  await fs.writeFile(outPath, buffer);

  if (!state.job) await loadJob();
  // Drop any failed entry for this paper
  state.job.failed = state.job.failed.filter((e) => e.paper_id !== paperId);
  // Remove duplicate completed entries (in case of re-upload)
  state.job.completed = state.job.completed.filter((e) => e.paper_id !== paperId);
  state.job.completed.push({
    paper_id: paperId,
    status: 'manual_upload',
    size: buffer.length,
    url: 'manual upload',
    ts: new Date().toISOString(),
  });
  state.attempted.add(paperId);
  state.queue.delete(paperId);
  await writeDownloadJob(state.job);
  await persistLogs();
  broadcast({ type: 'paper_uploaded', paper_id: paperId, size: buffer.length });
  return { size: buffer.length };
}

export function pause() {
  state.paused = true;
  broadcast({ type: 'paused' });
  if (state.job) {
    state.job.status = 'paused';
  }
}

export function resume() {
  if (!state.paused) return;
  state.paused = false;
  broadcast({ type: 'resumed' });
  if (state.job && state.job.status === 'paused') {
    state.job.status = 'idle';
  }
  if (state.queue.size > 0 && !state.loop) runLoop();
  else syncFromTriage();
}

export async function discard() {
  state.discarding = true;
  state.paused = true;
  if (state.loop) {
    try { await state.loop; } catch {}
  }
  state.queue.clear();
  state.attempted.clear();
  state.inflight = null;
  state.eventBuffer = [];
  await clearDownloadJob();
  await fs.unlink(DATA_FILES.download_log).catch(() => {});
  await fs.unlink(DATA_FILES.manual_retrieval_list).catch(() => {});
  // Optional: delete downloaded PDFs? Keep them for safety. Student can
  // wipe data/pdfs/ manually if they want a true clean slate.
  state.job = null;
  state.discarding = false;
  state.paused = false;
  broadcast({ type: 'discarded' });
}

async function getEmail() {
  if (state.emailCache) return state.emailCache;
  const md = await readText(PROTOCOL_FILES.topic, '');
  const topic = parseTopic(md);
  if (!topic.contact_email) return null;
  state.emailCache = topic.contact_email;
  return topic.contact_email;
}

async function persistLogs() {
  if (state.discarding || !state.job) return;
  const allRows = [
    ...state.job.completed.map((e) => ({
      paper_id: e.paper_id,
      attempted_url: e.url || '',
      status: e.status,
      file_size_bytes: e.size || 0,
      error_message: '',
    })),
    ...state.job.failed.map((e) => ({
      paper_id: e.paper_id,
      attempted_url: (e.attempted_urls || []).join(', ') || '(none resolved)',
      status: 'failed',
      file_size_bytes: 0,
      error_message: e.error || 'no candidate yielded a valid PDF',
    })),
  ];
  await fs.writeFile(DATA_FILES.download_log, writeCsv(allRows, LOG_FIELDS), 'utf8');

  if (state.job.failed.length > 0) {
    let md = '# Manual Retrieval List\n\n';
    md += 'Papers that could not be downloaded automatically. Retrieve through institutional access or direct author contact.\n\n';
    for (const f of state.job.failed) {
      md += `## paper_${f.paper_id}\n\n`;
      md += `Title. ${f.title || ''}\n\n`;
      md += `Authors. ${f.authors || ''}\n\n`;
      md += `Year. ${f.year || ''}\n\n`;
      md += `Venue. ${f.venue || ''}\n\n`;
      md += `DOI. ${f.doi || ''}\n\n`;
      md += `URL. ${f.url || ''}\n\n`;
      md += 'Suggested retrieval. Try institutional VPN, ResearchGate, or direct author email.\n\n';
    }
    await fs.writeFile(DATA_FILES.manual_retrieval_list, md, 'utf8');
  } else {
    // No failures, ensure any stale list is removed
    await fs.unlink(DATA_FILES.manual_retrieval_list).catch(() => {});
  }
}

async function downloadOne(row, email) {
  const paperId = row.paper_id;
  const outPath = path.join(PDFS_DIR, `paper_${paperId}.pdf`);

  // Already on disk?
  if (await fileExists(outPath)) {
    const stat = await fs.stat(outPath);
    if (stat.size >= 100 * 1024) {
      return {
        paper_id: paperId,
        status: 'already_present',
        size: stat.size,
        url: outPath,
      };
    }
    // Stale tiny file from a previous failure; remove and re-fetch
    await fs.unlink(outPath).catch(() => {});
  }

  const candidates = await resolveCandidates(row, email);
  const attempts = [];
  for (const cand of candidates) {
    const result = await tryDownload(cand.url, email);
    if (result.error) {
      attempts.push({ url: cand.url, source: cand.source, error: result.error, status: result.status });
      continue;
    }
    const validation = isValidPdf(result.buffer);
    if (validation.ok) {
      await ensureDir(PDFS_DIR);
      await fs.writeFile(outPath, result.buffer);
      return {
        paper_id: paperId,
        status: 'success',
        size: result.buffer.length,
        url: cand.url,
      };
    }
    attempts.push({
      url: cand.url, source: cand.source,
      error: validation.reason,
      content_type: result.contentType,
    });
  }

  return {
    paper_id: paperId,
    status: 'failed',
    attempts,
    error: candidates.length === 0
      ? 'no candidate URLs available'
      : 'no candidate yielded a valid PDF (publisher likely behind bot protection)',
  };
}

async function runLoop() {
  if (state.loop) return;
  if (state.paused) return;
  if (state.discarding) return;
  if (state.queue.size === 0) return;

  const email = await getEmail();
  if (!email) {
    broadcast({
      type: 'error',
      error: 'contact_email is not set in protocol/topic.md. Configure it in Setup, then resume.',
    });
    state.paused = true;
    return;
  }

  if (!state.job) await loadJob();
  state.job.status = 'running';
  await writeDownloadJob(state.job);
  broadcast({ type: 'started', queue_size: state.queue.size });

  state.loop = (async () => {
    while (
      !state.paused && !state.discarding && state.queue.size > 0
    ) {
      // Drain one paper
      const [paperId, row] = state.queue.entries().next().value;
      state.queue.delete(paperId);
      if (state.attempted.has(paperId)) continue;
      state.inflight = paperId;
      broadcast({
        type: 'paper_start', paper_id: paperId, title: row.title,
        queue_size: state.queue.size,
      });

      try {
        const result = await downloadOne(row, email);
        if (state.discarding) break;
        state.attempted.add(paperId);
        if (result.status === 'failed') {
          state.job.failed.push({
            paper_id: paperId,
            error: result.error,
            attempts: result.attempts || [],
            title: row.title,
            authors: row.authors,
            year: row.year,
            venue: row.venue,
            doi: row.doi,
            url: row.url,
            ts: new Date().toISOString(),
          });
        } else {
          state.job.completed.push({
            paper_id: paperId,
            status: result.status,
            size: result.size,
            url: result.url,
            ts: new Date().toISOString(),
          });
        }
        await writeDownloadJob(state.job);
        await persistLogs();
        broadcast({
          type: 'paper_done',
          paper_id: paperId,
          status: result.status,
          size: result.size || 0,
          error: result.error,
          queue_size: state.queue.size,
        });
      } catch (err) {
        if (state.discarding) break;
        state.attempted.add(paperId);
        state.job.failed.push({
          paper_id: paperId,
          error: err.message,
          attempts: [],
          title: row.title,
          authors: row.authors,
          year: row.year,
          venue: row.venue,
          doi: row.doi,
          url: row.url,
          ts: new Date().toISOString(),
        });
        await writeDownloadJob(state.job);
        await persistLogs();
        broadcast({
          type: 'paper_error', paper_id: paperId, error: err.message,
          queue_size: state.queue.size,
        });
      }
      state.inflight = null;
      // Polite delay between papers
      if (!state.paused && !state.discarding) await sleep(1000);
    }

    state.inflight = null;
    if (state.discarding) {
      // Discarder will reset state
    } else if (state.paused) {
      if (state.job) {
        state.job.status = 'paused';
        await writeDownloadJob(state.job);
      }
      broadcast({ type: 'paused_idle' });
    } else {
      // Drained naturally
      if (state.job) {
        state.job.status = 'completed';
        state.job.finished_at = new Date().toISOString();
        await writeDownloadJob(state.job);
      }
      broadcast({ type: 'idle' });
    }
  })();

  try { await state.loop; }
  finally { state.loop = null; }
}

// Boot. Load any prior job state, sync queue from triage CSV, kick the
// loop if there's work and we're not paused.
export async function init() {
  await loadJob();
  // If the prior job was 'completed' but the student has since added more
  // include/maybe rows, transition back to a working job.
  await syncFromTriage();
  // Don't auto-start if the previous job ended interrupted; wait for the
  // user to view stage 3 and decide.
  if (state.job?.status === 'interrupted') {
    state.paused = true;
    broadcast({ type: 'paused' });
    return;
  }
  if (state.queue.size > 0 && !state.paused) runLoop();
}

// Force-start (resume after pause / interrupt)
export function startNow() {
  state.paused = false;
  if (state.queue.size > 0 && !state.loop) runLoop();
  else syncFromTriage();
}
