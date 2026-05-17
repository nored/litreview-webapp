// Triage state management.
// candidates_triaged.csv is the canonical artifact. We initialize it from
// candidates_raw.csv on first access, then update rows in place as the
// student decides. paper_id is re-assigned on every save to keep it stable
// across include/maybe rows in CSV order.
//
// AI suggestions are stored separately in data/_triage_meta.json so they
// don't pollute the CSV that the CLI reads at stage 3.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, DATA_FILES } from '../paths.mjs';
import { ensureDir, readText, fileExists } from '../storage.mjs';
import { writeCsv, parseCsv } from './csv.mjs';

const META_FILE = path.join(DATA_DIR, '_triage_meta.json');

const TRIAGED_FIELDS = [
  'paper_id', 'title', 'authors', 'year', 'venue', 'abstract',
  'doi', 'arxiv_id', 'url', 'pdf_url',
  'source_database', 'source_query',
  'triage_label', 'triage_reason',
];

const VALID_LABELS = new Set(['', 'include', 'exclude', 'maybe']);

// Single-writer mutex so rapid saves can't interleave reads/writes on the
// same file.
let writeChain = Promise.resolve();
function serialize(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}
// Exported so other modules that mutate the same CSV (snowball,
// import, reset) can share the lock. Concurrent writes to
// candidates_triaged.csv would race: snowball's append + trainer's
// setDecision both do read-modify-write, and the loser truncates the
// winner's changes.
export const csvLock = serialize;

async function readMeta() {
  try {
    const text = await fs.readFile(META_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeMeta(meta) {
  await ensureDir(DATA_DIR);
  await fs.writeFile(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

async function loadTriagedRows() {
  // Prefer the triaged CSV if it exists, otherwise initialize from raw.
  const triagedExists = await fileExists(DATA_FILES.candidates_triaged);
  if (triagedExists) {
    const text = await readText(DATA_FILES.candidates_triaged, '');
    const { rows } = parseCsv(text);
    return rows.map((r, i) => ({ row_index: i, ...r }));
  }
  const rawExists = await fileExists(DATA_FILES.candidates_raw);
  if (!rawExists) {
    throw new Error('candidates_raw.csv does not exist. Run stage 1 search first.');
  }
  const text = await readText(DATA_FILES.candidates_raw, '');
  const { rows } = parseCsv(text);
  // Initialize: all triage fields empty
  return rows.map((r, i) => ({
    row_index: i,
    paper_id: '',
    triage_label: '',
    triage_reason: '',
    ...Object.fromEntries(
      TRIAGED_FIELDS.filter((f) => f !== 'paper_id' && f !== 'triage_label' && f !== 'triage_reason')
        .map((f) => [f, r[f] ?? ''])
    ),
  }));
}

async function persistTriagedRows(rowsWithIndex) {
  // Assign paper_id ONCE per row and never renumber. The download
  // daemon names PDFs `paper_NNN.pdf` at download time; if paper_ids
  // shuffled on every save (the old behaviour, which renumbered all
  // include+maybe rows sequentially), file `paper_001.pdf` would drift
  // to point at a different row over time and the Deep Read PDF viewer
  // would show the wrong document.
  //
  // Rules:
  //   - Existing paper_id stays. Even if the row is later excluded —
  //     its PDF on disk keeps its name; the row is just hidden from
  //     include/maybe filters.
  //   - A row gets a new paper_id only when first transitioning to
  //     include or maybe AND it doesn't have one already.
  //   - Next id picks the smallest unused 3-digit number.
  const used = new Set();
  for (const r of rowsWithIndex) {
    if (r.paper_id) used.add(String(r.paper_id));
  }
  let nextId = 1;
  function takeNextId() {
    while (used.has(String(nextId).padStart(3, '0'))) nextId++;
    const id = String(nextId).padStart(3, '0');
    used.add(id);
    nextId++;
    return id;
  }
  for (const r of rowsWithIndex) {
    const wantsId = r.triage_label === 'include' || r.triage_label === 'maybe';
    if (wantsId && !r.paper_id) {
      r.paper_id = takeNextId();
    }
    // Never clear an existing paper_id. The PDF on disk would orphan.
  }
  // Strip row_index for CSV output.
  const csvRows = rowsWithIndex.map(({ row_index: _, ...rest }) => rest);
  await ensureDir(DATA_DIR);
  await fs.writeFile(
    DATA_FILES.candidates_triaged,
    writeCsv(csvRows, TRIAGED_FIELDS),
    'utf8',
  );
}

export async function getAll() {
  const rows = await loadTriagedRows();
  const meta = await readMeta();
  return rows.map((r) => ({
    ...r,
    ai_suggestion: meta[String(r.row_index)] ?? null,
  }));
}

// Bulk-apply multiple decisions in a single CSV read+write cycle.
// setDecision rewrites the whole CSV on every call; a 500-decision
// auto-apply pass over a 2400-row CSV would otherwise rewrite ~1M rows
// of disk I/O. This batches them: one read, in-memory mutations, one
// write. Skips rows that already have a non-empty label (caller already
// decided manually). Returns { applied, skipped, errors, paper_ids }
// where paper_ids is the list of paper_ids that were assigned/preserved
// for the applied include/maybe rows (so the caller can enqueue them
// for download in one pass).
export async function setDecisionsBatch(decisions) {
  return serialize(async () => {
    const rows = await loadTriagedRows();
    const byIndex = new Map(rows.map((r, i) => [i, r]));
    let applied = 0;
    let skipped = 0;
    const errors = [];
    const paperIds = [];
    for (const d of decisions) {
      const idx = Number(d.row_index);
      const row = byIndex.get(idx);
      if (!row) { errors.push({ row_index: idx, error: 'row not found' }); continue; }
      if (!VALID_LABELS.has(d.label)) { errors.push({ row_index: idx, error: `invalid label: ${d.label}` }); continue; }
      if (row.triage_label && row.triage_label !== '') { skipped++; continue; }
      row.triage_label = d.label;
      row.triage_reason = d.reason ?? '';
      applied++;
    }
    // persistTriagedRows assigns paper_ids for new include/maybe rows.
    await persistTriagedRows(rows);
    // Re-collect paper_ids after persist (assignment may have happened).
    for (const d of decisions) {
      const row = byIndex.get(Number(d.row_index));
      if (row && row.paper_id && (d.label === 'include' || d.label === 'maybe')) {
        paperIds.push(row.paper_id);
      }
    }
    return { applied, skipped, errors, paper_ids: paperIds };
  });
}

export async function setDecision({ row_index, label, reason }) {
  if (!VALID_LABELS.has(label)) {
    throw new Error(`invalid label: ${label}`);
  }
  return serialize(async () => {
    const rows = await loadTriagedRows();
    const idx = Number(row_index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) {
      // Soft-fail: the row is gone (likely the CSV was rewritten by a
      // racing snowball append, or the picker's metadata is stale).
      // Return a no-op result instead of throwing so a single bad
      // row_index doesn't break the whole training step. Caller can
      // log the skip and re-pick a fresh paper.
      return { row_index: idx, skipped: true, reason: `row_index ${idx} out of range (csv has ${rows.length} rows)` };
    }
    rows[idx].triage_label = label;
    rows[idx].triage_reason = reason ?? '';
    await persistTriagedRows(rows);
    return { row_index: idx, paper_id: rows[idx].paper_id, label, reason };
  });
}

export async function setAiSuggestion({ row_index, label, reason }) {
  if (!VALID_LABELS.has(label)) {
    throw new Error(`invalid label: ${label}`);
  }
  return serialize(async () => {
    const meta = await readMeta();
    meta[String(row_index)] = {
      label,
      reason: reason ?? '',
      ts: new Date().toISOString(),
    };
    await writeMeta(meta);
    return meta[String(row_index)];
  });
}

// Patch identification fields on a row identified by paper_id. Used by
// lazy enrichment when opening a note: never overwrites non-empty values,
// never changes triage_label, so paper_id assignment stays stable.
export async function patchRowByPaperId(paperId, partial) {
  return serialize(async () => {
    const rows = await loadTriagedRows();
    const row = rows.find((r) => r.paper_id === paperId);
    if (!row) return null;
    let changed = false;
    for (const [k, v] of Object.entries(partial || {})) {
      if (k === 'paper_id' || k === 'triage_label' || k === 'triage_reason') continue;
      const cur = String(row[k] ?? '').trim();
      const incoming = String(v ?? '').trim();
      if (!cur && incoming) {
        row[k] = v;
        changed = true;
      }
    }
    if (changed) await persistTriagedRows(rows);
    return changed ? row : null;
  });
}

export async function summary() {
  const rows = await loadTriagedRows();
  const counts = { total: rows.length, include: 0, exclude: 0, maybe: 0, pending: 0 };
  for (const r of rows) {
    const k = r.triage_label || 'pending';
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}
