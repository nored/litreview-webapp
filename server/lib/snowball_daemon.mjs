// snowball_daemon.mjs
//
// Background daemon for citation snowballing. Iterates through every
// include-labeled paper in the corpus, fetches its referenced works via
// OpenAlex (optionally its forward citations too), dedupes against the
// existing triage CSV, and appends survivors as new pending rows. The
// embed daemon picks up the new rows automatically; the Stage 2 wizard
// handles their triage with the cluster-propagation flow already in place.
//
// Patterned after download_daemon: singleton state, broadcast/subscribe
// for SSE, runLoop with pause/resume/discard, manifest persisted at
// _jobs/snowball.json so an interrupted run reports as such on next boot.

import fs from 'node:fs/promises';
import { DATA_FILES, PROTOCOL_FILES } from '../paths.mjs';
import { ensureDir, readText, fileExists } from '../storage.mjs';
import { writeCsv, parseCsv } from './csv.mjs';
import { parseTopic } from './topic_md.mjs';
import {
  resolveToOpenalexId,
  fetchBackwardCitations,
  fetchForwardCitations,
  workToCandidate,
  buildExistingIndex,
  isDuplicate,
  POLITE_DELAY_MS,
} from './snowball.mjs';
import {
  readSnowballJob, writeSnowballJob, clearSnowballJob, newSnowballJob,
} from './jobs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRIAGED_FIELDS = [
  'paper_id', 'title', 'authors', 'year', 'venue', 'abstract',
  'doi', 'arxiv_id', 'url', 'pdf_url',
  'source_database', 'source_query',
  'triage_label', 'triage_reason',
];

const state = {
  job: null,
  loop: null,
  paused: false,
  discarding: false,
  cancelled: false,
  abortCtrl: null,
  listeners: new Set(),
  eventBuffer: [],
};

function broadcast(event) {
  state.eventBuffer.push({ ...event, ts: Date.now() });
  if (state.eventBuffer.length > 500) state.eventBuffer.shift();
  for (const fn of state.listeners) {
    try { fn(event); } catch { /* listener errors shouldn't break the daemon */ }
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
    job: state.job ? {
      id: state.job.id,
      status: state.job.status,
      started_at: state.job.started_at,
      finished_at: state.job.finished_at,
      interrupted_at: state.job.interrupted_at,
      sources_total: state.job.sources_total,
      sources_done: state.job.sources_done,
      candidates_fetched: state.job.candidates_fetched,
      new_added: state.job.new_added,
      dropped_dup: state.job.dropped_dup,
      include_forward: state.job.include_forward,
      last_error: state.job.last_error,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// CSV io
// ---------------------------------------------------------------------------

async function loadTriagedRows() {
  if (!await fileExists(DATA_FILES.candidates_triaged)) return [];
  const text = await readText(DATA_FILES.candidates_triaged, '');
  const { rows } = parseCsv(text);
  return rows;
}

async function appendCandidates(newRows) {
  if (newRows.length === 0) return 0;
  const existing = await loadTriagedRows();
  // Snowballed rows go in as pending (empty triage_label). paper_id stays
  // empty until the student decides them — keeps id assignment stable.
  const merged = existing.concat(newRows.map((r) => ({
    paper_id: '',
    title: r.title || '',
    authors: r.authors || '',
    year: r.year || '',
    venue: r.venue || '',
    abstract: r.abstract || '',
    doi: r.doi || '',
    arxiv_id: r.arxiv_id || '',
    url: r.url || '',
    pdf_url: r.pdf_url || '',
    source_database: r.source_database || 'openalex',
    source_query: r.source_query || 'snowball',
    triage_label: '',
    triage_reason: '',
  })));
  await fs.writeFile(DATA_FILES.candidates_triaged, writeCsv(merged, TRIAGED_FIELDS), 'utf8');
  return newRows.length;
}

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

async function listIncludeSources() {
  const rows = await loadTriagedRows();
  return rows.filter((r) => r.triage_label === 'include');
}

async function getEmail() {
  const md = await readText(PROTOCOL_FILES.topic, '');
  const topic = parseTopic(md);
  return topic.contact_email || '';
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
  if (state.job && state.job.status !== 'completed' && !state.loop) {
    runLoop({ resume: true });
  }
}

export async function discard() {
  state.discarding = true;
  state.cancelled = true;
  state.paused = true;
  if (state.abortCtrl) {
    try { state.abortCtrl.abort(); } catch {}
  }
  if (state.loop) {
    try { await state.loop; } catch {}
  }
  state.eventBuffer.length = 0;
  await clearSnowballJob();
  state.job = null;
  state.discarding = false;
  state.cancelled = false;
  state.paused = false;
  broadcast({ type: 'discarded' });
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export async function start({ direction = 'backward' } = {}) {
  if (state.loop) return { ok: false, reason: 'already running' };
  const email = await getEmail();
  if (!email) return { ok: false, reason: 'contact_email is required in Setup before snowballing' };
  const sources = await listIncludeSources();
  if (sources.length === 0) {
    return { ok: false, reason: 'no include-labeled papers to snowball from' };
  }
  state.job = newSnowballJob({ direction, sources_total: sources.length });
  await writeSnowballJob(state.job);
  state.paused = false;
  state.cancelled = false;
  state.discarding = false;
  runLoop({ email, sources, direction });
  return { ok: true, status: status() };
}

async function runLoop({ email, sources, direction = 'backward', resume = false } = {}) {
  if (state.loop) return;
  if (state.paused || state.discarding) return;

  if (!email) email = await getEmail();
  if (!sources) sources = await listIncludeSources();
  if (!state.job) {
    state.job = newSnowballJob({ direction, sources_total: sources.length });
    await writeSnowballJob(state.job);
  }

  state.job.status = 'running';
  state.job.include_forward = direction === 'both' || direction === 'forward';
  await writeSnowballJob(state.job);
  broadcast({ type: 'started', sources_total: sources.length, direction });

  state.abortCtrl = new AbortController();
  state.loop = (async () => {
    try {
      const existing = await loadTriagedRows();
      const dedupIndex = buildExistingIndex(existing);
      // Track in-batch IDs too so two consecutive includes that cite the
      // same paper don't both try to add it.
      const sessionAdded = { dois: new Set(), arxivs: new Set(), oaIds: new Set(), titles: [] };

      for (let i = state.job.sources_done; i < sources.length; i++) {
        if (state.paused || state.discarding) break;
        const src = sources[i];
        broadcast({
          type: 'source_start',
          paper_id: src.paper_id,
          title: src.title,
          index: i + 1,
          total: sources.length,
        });

        let oaId = '';
        try {
          oaId = await resolveToOpenalexId(src, { email, signal: state.abortCtrl.signal });
        } catch (err) {
          if (state.abortCtrl.signal.aborted) break;
          broadcast({ type: 'source_resolve_error', paper_id: src.paper_id, error: err.message });
        }
        if (!oaId) {
          broadcast({ type: 'source_skip', paper_id: src.paper_id, reason: 'could not resolve to OpenAlex' });
          state.job.sources_done = i + 1;
          await writeSnowballJob(state.job);
          continue;
        }

        // Backward citations (always).
        let works = [];
        try {
          works = await fetchBackwardCitations(oaId, { email, signal: state.abortCtrl.signal });
        } catch (err) {
          if (state.abortCtrl.signal.aborted) break;
          broadcast({ type: 'source_fetch_error', paper_id: src.paper_id, error: err.message });
        }

        // Forward citations if requested.
        if (state.job.include_forward) {
          try {
            const fwd = await fetchForwardCitations(oaId, { email, signal: state.abortCtrl.signal });
            works = works.concat(fwd);
          } catch (err) {
            if (state.abortCtrl.signal.aborted) break;
            broadcast({ type: 'source_fetch_error', paper_id: src.paper_id, error: err.message, direction: 'forward' });
          }
        }

        state.job.candidates_fetched += works.length;
        const newRows = [];
        for (const w of works) {
          const cand = workToCandidate(w, `snowball:from_paper_${src.paper_id}`);
          if (!cand || !cand.title) continue;
          if (isDuplicate(cand, dedupIndex) || isDuplicate(cand, sessionAdded)) {
            state.job.dropped_dup++;
            continue;
          }
          newRows.push(cand);
          // Update both indexes so subsequent sources see this row as known.
          if (cand.doi) sessionAdded.dois.add(cand.doi.toLowerCase().trim());
          if (cand.arxiv_id) sessionAdded.arxivs.add(cand.arxiv_id);
          if (cand.url) {
            const m = cand.url.match(/(?:openalex\.org\/|^)(W\d+)/i);
            if (m) sessionAdded.oaIds.add(m[1]);
          }
          if (cand.title) sessionAdded.titles.push(
            cand.title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(),
          );
        }

        if (newRows.length > 0) {
          await appendCandidates(newRows);
          state.job.new_added += newRows.length;
          // Refresh dedup index with what we just wrote so the next source
          // sees these rows.
          for (const r of newRows) {
            if (r.doi) dedupIndex.dois.add(r.doi.toLowerCase().trim());
            if (r.arxiv_id) dedupIndex.arxivs.add(r.arxiv_id);
            const m = (r.url || '').match(/(?:openalex\.org\/|^)(W\d+)/i);
            if (m) dedupIndex.oaIds.add(m[1]);
            if (r.title) dedupIndex.titles.push(
              r.title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(),
            );
          }
        }

        state.job.sources_done = i + 1;
        await writeSnowballJob(state.job);
        broadcast({
          type: 'source_done',
          paper_id: src.paper_id,
          fetched: works.length,
          added: newRows.length,
          index: i + 1,
          total: sources.length,
        });
        if (!state.paused && !state.discarding) await sleep(POLITE_DELAY_MS);
      }

      if (state.discarding) {
        // handled by discard()
      } else if (state.paused) {
        state.job.status = 'paused';
        await writeSnowballJob(state.job);
        broadcast({ type: 'paused_idle' });
      } else {
        state.job.status = 'completed';
        state.job.finished_at = new Date().toISOString();
        await writeSnowballJob(state.job);
        broadcast({
          type: 'idle',
          new_added: state.job.new_added,
          dropped_dup: state.job.dropped_dup,
        });
      }
    } catch (err) {
      state.job.status = 'interrupted';
      state.job.last_error = err.message;
      await writeSnowballJob(state.job);
      broadcast({ type: 'error', error: err.message });
    }
  })();

  try { await state.loop; }
  finally { state.loop = null; state.abortCtrl = null; }
}

// Boot. Picks up an interrupted job and waits for the user to decide
// whether to resume — same convention as the other daemons.
export async function init() {
  const job = await readSnowballJob();
  if (!job) return;
  state.job = job;
  if (job.status === 'interrupted' || job.status === 'running') {
    job.status = 'interrupted';
    job.interrupted_at = job.interrupted_at || new Date().toISOString();
    job.interrupted_reason = 'server restarted before snowballing completed';
    await writeSnowballJob(job);
    state.paused = true;
    broadcast({ type: 'paused' });
  }
}
