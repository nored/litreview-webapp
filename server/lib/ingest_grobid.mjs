// ingest_grobid.mjs
//
// Phase 1 ingest: PDF → grobid-js → postprocess → SQLite (v4 schema).
// Replaces pdf_chunks.mjs (text extraction + slugified-heading sections)
// and section_classifier.mjs (regex/cosine bucketing) and most of
// citation_context.mjs (`[N]` regex marker linking).
//
// Per paper:
//   1. Verify the PDF exists on disk.
//   2. Run grobid-js processPdf with teiCoordinates for provenance.
//   3. Postprocess: section-type canonicalisation, paragraph-section
//      attribution, reference normalisation, citation marker linking.
//   4. Write everything to the v4 tables in a single transaction.
//
// Idempotent per paper_id: re-running clears the paper's old rows from
// the v4 tables before writing fresh ones. Old v3 tables (chunks,
// chunk_section, name_usage, paper_field, paper_category) are NOT
// touched — they remain readable for whatever still depends on them,
// until Phase 2 swaps consumers over.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as store from './store.mjs';
import { Grobid } from 'grobid-js/node';
import { PDFS_DIR } from '../paths.mjs';
import { postprocessParsedPaper } from './grobid_postprocess.mjs';
import { parseTeiToParsedDocument } from './parse_tei.mjs';

// teiCoordinates: which TEI elements should grobid annotate with bbox+
// page provenance. We ask for the spans we actually use downstream —
// section headings, paragraphs, sentences, citation markers, bibliographic
// references, figures/tables, and persons (for author affiliation).
const TEI_COORDINATES = ['head', 's', 'p', 'ref', 'biblStruct', 'figure', 'persName', 'note', 'title'];

let _grobidInstance = null;
let _initPromise = null;

/** Lazy-init the Grobid processor. First call downloads models + lexicon
 *  + pdfalto into ~/.cache/grobid-js/ (one-time, ~75 MB). The current
 *  grobid-js API surface is just `Grobid.processPdf(path) → TEI-XML
 *  string`; engine + model loading happens internally on first use. */
async function getGrobid() {
  if (_grobidInstance) return _grobidInstance;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const g = new Grobid({
      onAssetProgress: (p) => {
        if (p && p.status === 'downloading' && p.index === 1) {
          console.log(`[grobid] downloading ${p.repo}/${p.file}`);
        }
      },
      // Default config builder mirrors upstream defaults; we override
      // teiCoordinates so downstream provenance has page+bbox.
      generateTeiCoordinates: TEI_COORDINATES,
    });
    _grobidInstance = g;
    return g;
  })();
  return _initPromise;
}

/** Pre-warm grobid (download all assets if missing). */
export async function preload() {
  await getGrobid();
}

function pdfPathFor(paperId) {
  return path.join(PDFS_DIR, `paper_${paperId}.pdf`);
}

/**
 * Ingest a single paper through grobid + postprocess. Returns a report:
 *   { paper_id, n_sections, n_paragraphs, n_references, n_citation_markers,
 *     n_tables, n_figures, elapsed_ms }
 *
 * Idempotent: wipes the paper's existing v4 rows before writing.
 */
export async function ingestPaperGrobid(paperId, opts = {}) {
  await store.init();
  const startMs = Date.now();
  const pdfPath = pdfPathFor(paperId);
  try {
    await fs.access(pdfPath);
  } catch {
    return { paper_id: paperId, error: 'pdf_not_found', pdf_path: pdfPath };
  }
  // Confirm the paper row exists in the v2/v3 papers table. Ingest does
  // NOT create papers — that's syncPapersFromCsv's job.
  const paperRow = store.query('SELECT paper_id, title FROM papers WHERE paper_id = ?', [paperId])[0];
  if (!paperRow) {
    return { paper_id: paperId, error: 'paper_not_in_store' };
  }

  const grobid = await getGrobid();
  let teiXml;
  try {
    teiXml = await grobid.processPdf(pdfPath);
  } catch (e) {
    return { paper_id: paperId, error: `grobid_failed: ${e.message}` };
  }
  let parsed;
  try {
    parsed = parseTeiToParsedDocument(teiXml);
  } catch (e) {
    return { paper_id: paperId, error: `tei_parse_failed: ${e.message}` };
  }

  // Normalise + flatten.
  const { sections, paragraphs, references, citationMarkers, figures, tables } =
    await postprocessParsedPaper(parsed, paperId);

  // Single transaction: wipe + write.
  store.transaction(() => {
    // Wipe in FK-safe order: citation_markers → paragraphs → sections,
    // then doc_figures / doc_tables / reference_list.
    store.exec('DELETE FROM citation_markers WHERE paper_id = ?', [paperId]);
    store.exec('DELETE FROM paragraphs       WHERE paper_id = ?', [paperId]);
    store.exec('DELETE FROM sections         WHERE paper_id = ?', [paperId]);
    store.exec('DELETE FROM doc_figures      WHERE paper_id = ?', [paperId]);
    store.exec('DELETE FROM doc_tables       WHERE paper_id = ?', [paperId]);
    store.exec('DELETE FROM reference_list   WHERE paper_id = ?', [paperId]);

    for (const s of sections) {
      store.exec(
        `INSERT INTO sections (section_id, paper_id, section_idx, raw_heading, level, canonical_type, parent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [s.section_id, s.paper_id, s.section_idx, s.raw_heading, s.level, s.canonical_type, s.parent_id],
      );
    }
    for (const p of paragraphs) {
      store.exec(
        `INSERT INTO paragraphs (paragraph_id, paper_id, section_id, paragraph_idx, canonical_type, text, page_first, page_last, bbox_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.paragraph_id, p.paper_id, p.section_id, p.paragraph_idx,
         p.canonical_type, p.text, p.page_first, p.page_last, p.bbox_json],
      );
    }
    for (const r of references) {
      store.exec(
        `INSERT INTO reference_list
          (reference_id, paper_id, bib_ref_id, ref_label, authors_raw, parsed_authors_json,
           title, date_raw, date_year, date_month, date_day, journal, booktitle, publisher,
           pages, volume, doi, url, raw_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.reference_id, r.paper_id, r.bib_ref_id, r.ref_label, r.authors_raw, r.parsed_authors_json,
         r.title, r.date_raw, r.date_year, r.date_month, r.date_day, r.journal, r.booktitle, r.publisher,
         r.pages, r.volume, r.doi, r.url, r.raw_text],
      );
    }
    for (const m of citationMarkers) {
      store.exec(
        `INSERT INTO citation_markers
          (paper_id, paragraph_id, reference_id, surface_text, marker_idx, page, bbox_json, context_text, stance, stance_provenance_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.paper_id, m.paragraph_id, m.reference_id, m.surface_text, m.marker_idx,
         m.page, m.bbox_json, m.context_text, m.stance, m.stance_provenance_id],
      );
    }
    for (const f of figures) {
      store.exec(
        `INSERT INTO doc_figures (doc_figure_id, paper_id, figure_idx, label, caption, page, bbox_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [f.doc_figure_id, f.paper_id, f.figure_idx, f.label, f.caption, f.page, f.bbox_json],
      );
    }
    for (const t of tables) {
      store.exec(
        `INSERT INTO doc_tables (doc_table_id, paper_id, table_idx, label, caption, page, bbox_json, cells_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.doc_table_id, t.paper_id, t.table_idx, t.label, t.caption, t.page, t.bbox_json, t.cells_json],
      );
    }
  });
  await store.flush();

  const elapsedMs = Date.now() - startMs;
  return {
    paper_id: paperId,
    n_sections: sections.length,
    n_paragraphs: paragraphs.length,
    n_references: references.length,
    n_citation_markers: citationMarkers.length,
    n_tables: tables.length,
    n_figures: figures.length,
    elapsed_ms: elapsedMs,
    header: {
      title: parsed.header?.title || null,
      authors: (parsed.header?.authors || []).map((a) => ({
        name: a.name,
        affiliations: (a.affiliations || []).map((af) => ({
          institutions: af.institutions || [],
          country: af.country || null,
        })),
      })),
      abstract: parsed.header?.abstract || null,
      keywords: parsed.header?.keywords || [],
    },
  };
}

/**
 * Ingest every PDF on disk that has a row in `papers` with triage_label
 * in ('include', 'maybe'). Reports per-paper outcomes.
 */
export async function ingestCorpusGrobid(opts = {}) {
  await store.init();
  await preload();
  const eligible = store.query(
    `SELECT p.paper_id
       FROM papers p
      WHERE p.triage_label IN ('include', 'maybe')
      ORDER BY p.paper_id`,
  );
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const completed = [];
  const failed = [];
  let i = 0;
  for (const { paper_id } of eligible) {
    if (opts.signal?.aborted) break;
    i++;
    try {
      const r = await ingestPaperGrobid(paper_id, opts);
      if (r.error) failed.push(r);
      else completed.push(r);
      if (onProgress) await onProgress(r, i, eligible.length);
    } catch (e) {
      failed.push({ paper_id, error: e.message });
    }
  }
  return { total: eligible.length, completed, failed };
}
