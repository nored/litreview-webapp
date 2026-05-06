// Persistent job manifest. Survives server restart so the UI can detect
// interrupted runs and offer to resume.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../paths.mjs';
import { ensureDir } from '../storage.mjs';

const JOBS_DIR = path.join(DATA_DIR, '_jobs');
const SEARCH_JOB_FILE = path.join(JOBS_DIR, 'search.json');
const DOWNLOAD_JOB_FILE = path.join(JOBS_DIR, 'download.json');

export async function readSearchJob() {
  try {
    const text = await fs.readFile(SEARCH_JOB_FILE, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
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
  try {
    const text = await fs.readFile(DOWNLOAD_JOB_FILE, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
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
