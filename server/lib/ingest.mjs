// ingest.mjs
//
// Bridge from the existing file-based state (candidates_triaged.csv, the
// snowball job state, the PDFs on disk) into the SQLite structured store.
// Additive — does not remove the file-based sources. The legacy modules
// (triage.mjs, search.mjs, notes.mjs) keep reading their CSV / JSON / md
// inputs; this module mirrors the canonical bits of that state into
// SQLite so M2 extractors and Stage 2 detectors have a coherent backing.
//
// Three entry points:
//
//   syncPapersFromCsv()         — read candidates_triaged.csv, upsert
//                                 every row into `papers` + `paper_authors`.
//                                 Idempotent: existing paper rows are
//                                 updated, not duplicated.
//
//   ingestChunksForPaper(id)    — run pdf_chunks → `chunks`, then run
//                                 the section classifier → `chunk_section`.
//                                 Idempotent: re-running for the same
//                                 paper deletes-then-reinserts its chunks
//                                 (chunk content can change if the PDF
//                                 was re-extracted with different params).
//
//   syncSnowballCitations()     — read the snowball job state and mirror
//                                 forward/backward edges into `citations`.
//                                 Idempotent via INSERT OR IGNORE on the
//                                 (from_paper, to_paper, source) tuple.
//
// Convention: every write goes through store.mjs (which schedules a
// debounced flush to disk).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as store from './store.mjs';
import * as triage from './triage.mjs';
import { chunksForPdf } from './pdf_chunks.mjs';
import { buildSectionIndex } from './section_classifier.mjs';
import { PDFS_DIR, DATA_DIR } from '../paths.mjs';
import { fileExists } from '../storage.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Papers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sync candidates_triaged.csv → papers + paper_authors. Returns a summary
 * of how many rows were inserted vs updated vs skipped (no paper_id yet).
 *
 * paper_id is assigned by triage.mjs only for rows labelled include/maybe;
 * pending/exclude rows have empty paper_id and are skipped (they don't
 * have a stable identity yet).
 */
export async function syncPapersFromCsv() {
  await store.init();
  let rows;
  try {
    rows = await triage.getAll();
  } catch (e) {
    if (/does not exist/.test(e.message)) {
      return { inserted: 0, updated: 0, skipped: 0, reason: 'no triage csv yet' };
    }
    throw e;
  }

  let inserted = 0, updated = 0, skipped = 0;

  store.transaction(() => {
    for (const r of rows) {
      if (!r.paper_id) { skipped++; continue; }
      const existing = store.query(
        'SELECT paper_id FROM papers WHERE paper_id = ?',
        [r.paper_id],
      );
      const params = [
        r.paper_id,
        r.title || '',
        intOrNull(r.year),
        r.venue || null,
        r.doi || null,
        r.arxiv_id || null,
        r.url || null,
        // pdf_path is the canonical on-disk location, derived from paper_id
        path.join(PDFS_DIR, `paper_${r.paper_id}.pdf`),
        r.abstract || null,
        r.triage_label || null,
        r.triage_reason || null,
        r.source_database || null,
      ];
      if (existing.length === 0) {
        store.exec(
          `INSERT INTO papers
             (paper_id, title, year, venue, doi, arxiv_id, url, pdf_path,
              abstract, triage_label, triage_reason, source_database)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params,
        );
        inserted++;
      } else {
        store.exec(
          `UPDATE papers SET
             title = ?, year = ?, venue = ?, doi = ?, arxiv_id = ?,
             url = ?, pdf_path = ?, abstract = ?, triage_label = ?,
             triage_reason = ?, source_database = ?,
             updated_at = datetime('now')
           WHERE paper_id = ?`,
          [...params.slice(1), r.paper_id],
        );
        updated++;
      }
      // Authors: wipe + reinsert (cheap, keeps order canonical).
      store.exec('DELETE FROM paper_authors WHERE paper_id = ?', [r.paper_id]);
      const authors = String(r.authors || '').split(/,\s*/).filter(Boolean);
      for (let i = 0; i < authors.length; i++) {
        store.exec(
          'INSERT INTO paper_authors (paper_id, author_name, position) VALUES (?, ?, ?)',
          [r.paper_id, authors[i], i + 1],
        );
      }
    }
  });

  return { inserted, updated, skipped };
}

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Chunks + section index
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run pdf_chunks → `chunks` table, then run the section classifier →
 * `chunk_section`. Idempotent: deletes existing chunks for this paper
 * first so re-extracting against a re-downloaded PDF or different chunk
 * params produces a clean rewrite.
 *
 * Returns { paper_id, n_chunks, sections: { <label>: count } }.
 */
export async function ingestChunksForPaper(paperId) {
  await store.init();
  const pdfPath = path.join(PDFS_DIR, `paper_${paperId}.pdf`);
  if (!await fileExists(pdfPath)) {
    return { paper_id: paperId, n_chunks: 0, error: 'pdf not found' };
  }
  // The paper row must exist (FK constraint).
  const paperRow = store.query('SELECT paper_id FROM papers WHERE paper_id = ?', [paperId]);
  if (paperRow.length === 0) {
    return { paper_id: paperId, n_chunks: 0, error: 'paper row missing — syncPapersFromCsv first' };
  }

  const chunks = await chunksForPdf(pdfPath, paperId);
  if (chunks.length === 0) {
    return { paper_id: paperId, n_chunks: 0, error: 'no extractable text' };
  }

  // Section classification (uses the embedder; lazy-loads if first call).
  const { perChunk } = await buildSectionIndex(chunks);

  const sectionCounts = {};
  store.transaction(() => {
    // Wipe existing chunks (cascades to chunk_section).
    store.exec('DELETE FROM chunks WHERE paper_id = ?', [paperId]);

    for (const c of chunks) {
      store.exec(
        `INSERT INTO chunks
           (chunk_id, paper_id, raw_section, page_first, page_last, chunk_idx, text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id,
          c.meta?.paper_id ?? paperId,
          c.meta?.section ?? null,
          c.meta?.page_first ?? null,
          c.meta?.page_last ?? null,
          c.meta?.chunk_idx ?? 0,
          c.text || '',
        ],
      );
      const cls = perChunk[c.id];
      if (cls) {
        store.exec(
          `INSERT INTO chunk_section
             (chunk_id, label, mechanism, score, distribution_json)
           VALUES (?, ?, ?, ?, ?)`,
          [
            c.id,
            cls.label,
            cls.mechanism,
            cls.score,
            cls.distribution ? JSON.stringify(cls.distribution) : null,
          ],
        );
        sectionCounts[cls.label] = (sectionCounts[cls.label] || 0) + 1;
      }
    }
  });

  return { paper_id: paperId, n_chunks: chunks.length, sections: sectionCounts };
}

// ─────────────────────────────────────────────────────────────────────────
// Snowball citation edges
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mirror citation edges from the snowball job state into the `citations`
 * table. The snowball daemon writes its accumulated edges to
 * `project/data/_jobs/snowball.json` (or similar — we probe a few known
 * locations).
 *
 * Idempotent: uses INSERT OR IGNORE on (from_paper, to_paper, source).
 * Citation context classification (support / contrast / extend /
 * background) is left null at this stage — Phase 2 fills that via NLI.
 */
export async function syncSnowballCitations() {
  await store.init();
  const candidates = [
    path.join(DATA_DIR, '_jobs', 'snowball.json'),
    path.join(DATA_DIR, 'snowball.json'),
  ];
  let edges = null;
  for (const p of candidates) {
    if (await fileExists(p)) {
      try {
        const text = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(text);
        edges = extractEdges(parsed);
        if (edges) break;
      } catch (e) {
        console.warn('syncSnowballCitations: failed to parse', p, e.message);
      }
    }
  }
  if (!edges) return { inserted: 0, reason: 'no snowball state found or no edges' };

  // De-dupe via uniqueness (from, to, source) — INSERT OR IGNORE.
  // We don't have a UNIQUE constraint on the table to keep room for
  // intentional multi-source duplicate edges; instead we check existence.
  let inserted = 0, skipped = 0;
  store.transaction(() => {
    for (const e of edges) {
      const exists = store.query(
        'SELECT 1 FROM citations WHERE from_paper = ? AND to_paper = ? AND COALESCE(source, "") = COALESCE(?, "") LIMIT 1',
        [e.from_paper, e.to_paper, e.source || null],
      );
      if (exists.length > 0) { skipped++; continue; }
      store.exec(
        'INSERT INTO citations (from_paper, to_paper, source) VALUES (?, ?, ?)',
        [e.from_paper, e.to_paper, e.source || null],
      );
      inserted++;
    }
  });
  return { inserted, skipped, total: edges.length };
}

// Best-effort edge extraction from the snowball state file. The shape has
// evolved over time; this handles a few known forms.
function extractEdges(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const out = [];
  if (Array.isArray(parsed.edges)) {
    for (const e of parsed.edges) {
      if (e?.from_paper && e?.to_paper) out.push(e);
    }
    return out;
  }
  if (Array.isArray(parsed.expansions)) {
    for (const ex of parsed.expansions) {
      const from = ex?.seed_paper_id || ex?.seed;
      const tos = ex?.candidates || ex?.added || [];
      for (const t of tos) {
        const to = typeof t === 'string' ? t : (t?.paper_id || t?.target);
        if (from && to) out.push({ from_paper: from, to_paper: to, source: 'snowball' });
      }
    }
    return out;
  }
  return null;
}
