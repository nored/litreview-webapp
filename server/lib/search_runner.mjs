// Orchestrates a stage 1 search. Async generator that emits progress events
// AND keeps a persistent job manifest so an interrupted run can be resumed
// or summarized after the server restarts.
//
// Mode = 'fresh': start a brand-new job, ignore any prior manifest.
// Mode = 'resume': continue from an existing manifest, skipping pairs already
//                  attempted (success OR error).

import fs from 'node:fs/promises';
import { DATA_FILES, DATA_DIR, PROTOCOL_FILES } from '../paths.mjs';
import { ensureDir, readText } from '../storage.mjs';
import { writeCsv, parseCsv } from './csv.mjs';
import { searchArxiv, searchOpenalex, searchSemanticScholar, dedupe } from './search.mjs';
import { enrichByDoi, mergeEnrichment } from './bibenrich.mjs';
import { parseTopic } from './topic_md.mjs';
import { parse as parseQueries } from './queries_md.mjs';
import {
  readSearchJob, writeSearchJob, newSearchJob, alreadyDone,
} from './jobs.mjs';
import { read as readCredentials } from './credentials.mjs';

const FIELDS = [
  'paper_id', 'title', 'authors', 'year', 'venue', 'abstract',
  'doi', 'arxiv_id', 'url', 'pdf_url',
  'source_database', 'source_query',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function appendLog(entry) {
  await ensureDir(DATA_DIR);
  await fs.appendFile(DATA_FILES.search_log, JSON.stringify(entry) + '\n', 'utf8');
}

// Read existing partial CSV (from a previous interrupted run) so we can
// continue accumulating instead of losing what was already fetched.
async function readPartialRows() {
  const text = await readText(DATA_FILES.candidates_raw, null);
  if (!text) return [];
  try {
    const { rows } = parseCsv(text);
    return rows;
  } catch {
    return [];
  }
}

const noop = () => false;

export async function* runSearch({ signal, mode = 'fresh', isDiscarded = noop } = {}) {
  const topicMd = await readText(PROTOCOL_FILES.topic, '');
  const topic = parseTopic(topicMd);
  if (!topic.contact_email) {
    throw new Error('contact_email is not set in protocol/topic.md. Configure it in Setup first.');
  }

  const queriesMd = await readText(PROTOCOL_FILES.search_queries, '');
  const { queries, manual_additions } = parseQueries(queriesMd);
  if (queries.length === 0) {
    throw new Error('no queries configured. Add queries in stage 1 first.');
  }

  // Optional API keys. Falls back to env vars for headless / CI use.
  const credentials = await readCredentials();
  const semanticScholarKey = credentials.semantic_scholar_api_key
    || process.env.SEMANTIC_SCHOLAR_API_KEY
    || null;

  // Job setup
  let job;
  let accumulator = [];
  if (mode === 'resume') {
    job = await readSearchJob();
    if (!job) {
      mode = 'fresh';
    } else {
      // Resuming: restart status, keep completed/errors lists
      job.status = 'running';
      job.queries = queries; // refresh in case student edited them
      job.total_queries = queries.length;
      job.interrupted_at = null;
      job.interrupted_reason = null;
      accumulator = await readPartialRows();
    }
  }
  if (mode === 'fresh') {
    job = newSearchJob({ queries, email: topic.contact_email });
    // Wipe prior run's outputs
    await fs.unlink(DATA_FILES.search_log).catch(() => {});
    await fs.unlink(DATA_FILES.candidates_raw).catch(() => {});
  }
  await writeSearchJob(job);

  yield {
    type: 'start',
    job_id: job.id,
    total_queries: queries.length,
    email: topic.contact_email,
    resumed: mode === 'resume',
    completed_pairs: job.completed.length + job.errors.length,
  };

  const sources = [
    { name: 'arxiv', fn: searchArxiv, sleepAfter: 3000, opts: {} },
    { name: 'openalex', fn: searchOpenalex, sleepAfter: 100, opts: {} },
    {
      name: 'semantic_scholar',
      fn: searchSemanticScholar,
      // With an API key, Semantic Scholar allows ~1 req/sec. Without, the
      // public limit is much stricter, so we still pace conservatively.
      sleepAfter: semanticScholarKey ? 1000 : 1500,
      opts: { apiKey: semanticScholarKey },
    },
  ];

  for (let i = 0; i < queries.length; i++) {
    if (signal?.aborted) break;
    const q = queries[i];
    yield { type: 'query_start', i, total: queries.length, query: q };

    for (const src of sources) {
      if (signal?.aborted) break;
      if (alreadyDone(job, q, src.name)) {
        yield { type: 'source_skipped', source: src.name, query: q, i };
        continue;
      }
      yield { type: 'source_start', source: src.name, query: q, i };
      try {
        const results = await src.fn(q, topic.contact_email, { signal, ...src.opts });
        accumulator.push(...results);
        job.completed.push({
          query: q, source: src.name, count: results.length,
          ts: new Date().toISOString(),
        });
        job.partial_candidate_count = accumulator.length;
        if (!isDiscarded()) await writeSearchJob(job);
        await appendLog({
          timestamp: new Date().toISOString(),
          source: src.name,
          query: q,
          result_count: results.length,
          ids: results.map((r) => r.doi || r.arxiv_id || r.url),
        });
        yield { type: 'source_done', source: src.name, query: q, count: results.length, i };
      } catch (e) {
        job.errors.push({
          query: q, source: src.name, error: e.message,
          ts: new Date().toISOString(),
        });
        if (!isDiscarded()) await writeSearchJob(job);
        await appendLog({
          timestamp: new Date().toISOString(),
          source: src.name,
          query: q,
          result_count: 0,
          ids: [],
          error: e.message,
        });
        yield { type: 'source_error', source: src.name, query: q, error: e.message, i };
      }
      // Persist partial CSV after each pair so the file always reflects state
      if (!isDiscarded()) {
        await ensureDir(DATA_DIR);
        const partialFields = FIELDS.map((f) => f);
        const partialRows = accumulator.map((r) => ({ ...r, paper_id: '' }));
        await fs.writeFile(DATA_FILES.candidates_raw, writeCsv(partialRows, partialFields), 'utf8');
      }

      await sleep(src.sleepAfter);
    }
  }

  if (signal?.aborted) {
    job.status = 'interrupted';
    job.interrupted_at = new Date().toISOString();
    job.interrupted_reason = 'aborted by user';
    if (!isDiscarded()) await writeSearchJob(job);
    yield { type: 'aborted' };
    return;
  }

  yield { type: 'dedup_start', total_raw: accumulator.length };
  const deduped = dedupe(accumulator);
  yield { type: 'dedup_done', total_raw: accumulator.length, total_deduped: deduped.length };

  // Bibliographic enrichment: for rows that have a DOI but are missing
  // venue/authors/year, one OpenAlex lookup fills the canonical record.
  // Bounded concurrency, silent failure — never blocks the search.
  const needsEnrich = deduped.filter((r) =>
    r.doi && (!String(r.venue || '').trim() || !String(r.authors || '').trim() || !String(r.year || '').trim())
  );
  if (needsEnrich.length > 0) {
    yield { type: 'enrich_start', total: needsEnrich.length };
    const concurrency = 4;
    let enriched = 0;
    for (let i = 0; i < needsEnrich.length; i += concurrency) {
      if (signal?.aborted) break;
      const batch = needsEnrich.slice(i, i + concurrency);
      await Promise.all(batch.map(async (row) => {
        const data = await enrichByDoi(row.doi, topic.contact_email);
        const { changed } = mergeEnrichment(row, data);
        if (changed) enriched++;
      }));
      yield { type: 'enrich_progress', done: Math.min(i + concurrency, needsEnrich.length), total: needsEnrich.length };
    }
    yield { type: 'enrich_done', enriched, total: needsEnrich.length };
  }

  // arXiv preprints without an explicit venue: stamp 'arXiv' so triage
  // and stage 4 don't trip on an empty required field.
  for (const r of deduped) {
    if (!String(r.venue || '').trim() && (r.arxiv_id || /arxiv/i.test(String(r.source_database || '')))) {
      r.venue = 'arXiv';
    }
  }

  // Append manual additions
  let manualCount = 0;
  for (const m of manual_additions) {
    if (!m.title) continue;
    const dup = deduped.find((r) => r.title.trim().toLowerCase() === m.title.trim().toLowerCase());
    if (dup) continue;
    deduped.push({
      title: m.title,
      authors: m.authors ?? '',
      year: String(m.year ?? ''),
      venue: m.venue ?? '',
      abstract: '',
      doi: m.doi ?? '',
      arxiv_id: '',
      url: m.url ?? '',
      pdf_url: m.pdf_url ?? '',
      source_database: 'manual_addition',
      source_query: 'manual_addition: ' + (m.reason || ''),
    });
    manualCount++;
  }
  if (manualCount > 0) {
    yield { type: 'manual_additions_appended', count: manualCount };
  }

  for (const r of deduped) r.paper_id = '';

  await ensureDir(DATA_DIR);
  await fs.writeFile(DATA_FILES.candidates_raw, writeCsv(deduped, FIELDS), 'utf8');

  job.status = 'completed';
  job.finished_at = new Date().toISOString();
  job.final_candidate_count = deduped.length;
  await writeSearchJob(job);

  yield { type: 'done', total: deduped.length, csv: 'data/candidates_raw.csv' };
}
