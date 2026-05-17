// Persistent job manifest. Survives server restart so the UI can detect
// interrupted runs and offer to resume.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../paths.mjs';
import { ensureDir } from '../storage.mjs';

const JOBS_DIR = path.join(DATA_DIR, '_jobs');
const SEARCH_JOB_FILE = path.join(JOBS_DIR, 'search.json');
const DOWNLOAD_JOB_FILE = path.join(JOBS_DIR, 'download.json');
const EMBED_JOB_FILE = path.join(JOBS_DIR, 'embed.json');
const SNOWBALL_JOB_FILE = path.join(JOBS_DIR, 'snowball.json');

// Job files can be left in a zero-byte / partially-written state after a
// crash or kill. A SyntaxError reading them must not crash boot — just
// treat the file as absent and let the daemon start fresh.
async function readJobFile(path) {
  let text;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    console.warn(`jobs: ${path} corrupted (${err.message}), treating as empty`);
    return null;
  }
}

export async function readSearchJob() {
  return readJobFile(SEARCH_JOB_FILE);
}

export async function writeSearchJob(job) {
  await ensureDir(JOBS_DIR);
  await fs.writeFile(SEARCH_JOB_FILE, JSON.stringify(job, null, 2), 'utf8');
}

export async function clearSearchJob() {
  try {
    await fs.unlink(SEARCH_JOB_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export async function readDownloadJob() {
  return readJobFile(DOWNLOAD_JOB_FILE);
}

export async function writeDownloadJob(job) {
  await ensureDir(JOBS_DIR);
  await fs.writeFile(DOWNLOAD_JOB_FILE, JSON.stringify(job, null, 2), 'utf8');
}

export async function clearDownloadJob() {
  try {
    await fs.unlink(DOWNLOAD_JOB_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export async function readEmbedJob() {
  return readJobFile(EMBED_JOB_FILE);
}

export async function writeEmbedJob(job) {
  await ensureDir(JOBS_DIR);
  await fs.writeFile(EMBED_JOB_FILE, JSON.stringify(job, null, 2), 'utf8');
}

export async function clearEmbedJob() {
  try {
    await fs.unlink(EMBED_JOB_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export async function readSnowballJob() {
  return readJobFile(SNOWBALL_JOB_FILE);
}

export async function writeSnowballJob(job) {
  await ensureDir(JOBS_DIR);
  await fs.writeFile(SNOWBALL_JOB_FILE, JSON.stringify(job, null, 2), 'utf8');
}

export async function clearSnowballJob() {
  try {
    await fs.unlink(SNOWBALL_JOB_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export function newSnowballJob({ direction = 'backward', sources_total = 0 } = {}) {
  return {
    id: 'sb_' + Date.now().toString(36),
    status: 'running',
    direction,
    started_at: new Date().toISOString(),
    finished_at: null,
    interrupted_at: null,
    interrupted_reason: null,
    sources_total,
    sources_done: 0,
    candidates_fetched: 0,
    new_added: 0,
    dropped_dup: 0,
    include_forward: direction === 'forward' || direction === 'both',
    last_error: null,
  };
}

export function newEmbedJob() {
  return {
    id: 'e_' + Date.now().toString(36),
    status: 'idle',         // 'idle' | 'running' | 'paused' | 'completed' | 'interrupted'
    started_at: new Date().toISOString(),
    finished_at: null,
    interrupted_at: null,
    interrupted_reason: null,
    papers_embedded: 0,
    notes_embedded: 0,
    chunks_embedded: 0,
    last_error: null,
  };
}

export function newDownloadJob() {
  return {
    id: 'd_' + Date.now().toString(36),
    status: 'idle',           // 'idle' | 'running' | 'paused' | 'completed' | 'interrupted'
    started_at: new Date().toISOString(),
    finished_at: null,
    interrupted_at: null,
    completed: [],            // [{ paper_id, status: 'success'|'already_present', size, url, ts }]
    failed: [],               // [{ paper_id, error, attempted_urls, title, authors, year, venue, doi, url, ts }]
  };
}

// Called at server startup. Any job left in 'running' state must have died
// with the previous process. Mark it interrupted so the UI knows to ask.
export async function reconcileJobsOnStartup() {
  const sj = await readSearchJob();
  if (sj?.status === 'running') {
    sj.status = 'interrupted';
    sj.interrupted_at = new Date().toISOString();
    sj.interrupted_reason = 'server restarted before search completed';
    await writeSearchJob(sj);
    console.log('reconciled interrupted search job');
  }
  const dj = await readDownloadJob();
  if (dj?.status === 'running') {
    dj.status = 'interrupted';
    dj.interrupted_at = new Date().toISOString();
    dj.interrupted_reason = 'server restarted before download completed';
    await writeDownloadJob(dj);
    console.log('reconciled interrupted download job');
  }
  const ej = await readEmbedJob();
  if (ej?.status === 'running') {
    ej.status = 'interrupted';
    ej.interrupted_at = new Date().toISOString();
    ej.interrupted_reason = 'server restarted before embedding completed';
    await writeEmbedJob(ej);
    console.log('reconciled interrupted embed job');
  }
  const sbj = await readSnowballJob();
  if (sbj?.status === 'running') {
    sbj.status = 'interrupted';
    sbj.interrupted_at = new Date().toISOString();
    sbj.interrupted_reason = 'server restarted before snowballing completed';
    await writeSnowballJob(sbj);
    console.log('reconciled interrupted snowball job');
  }
}

export function newSearchJob({ queries, email }) {
  return {
    id: 's_' + Date.now().toString(36),
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    interrupted_at: null,
    interrupted_reason: null,
    email,
    total_queries: queries.length,
    queries,
    completed: [],          // [{ query, source, count, ts }]
    errors: [],             // [{ query, source, error, ts }]
    partial_candidate_count: 0,
    final_candidate_count: null,
  };
}

// Helper: was a (query, source) pair already attempted in this job?
export function alreadyDone(job, query, source) {
  return job.completed.some((c) => c.query === query && c.source === source) ||
         job.errors.some((e) => e.query === query && e.source === source);
}
