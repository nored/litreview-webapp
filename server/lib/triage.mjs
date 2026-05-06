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
  // Re-assign paper_id sequentially over include+maybe rows.
  let next = 1;
  for (const r of rowsWithIndex) {
    if (r.triage_label === 'include' || r.triage_label === 'maybe') {
      r.paper_id = String(next).padStart(3, '0');
      next++;
    } else {
      r.paper_id = '';
    }
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

export async function setDecision({ row_index, label, reason }) {
  if (!VALID_LABELS.has(label)) {
    throw new Error(`invalid label: ${label}`);
  }
  return serialize(async () => {
    const rows = await loadTriagedRows();
    const idx = Number(row_index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) {
      throw new Error(`row_index ${idx} out of range`);
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

export async function summary() {
  const rows = await loadTriagedRows();
  const counts = { total: rows.length, include: 0, exclude: 0, maybe: 0, pending: 0 };
  for (const r of rows) {
    const k = r.triage_label || 'pending';
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}
