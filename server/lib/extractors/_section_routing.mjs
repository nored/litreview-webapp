// extractors/_section_routing.mjs
//
// Shared helper for every per-field extractor. Two responsibilities:
//
//   1. Pull chunks whose chunk_section.label is in the field's
//      eligible-section set, joined and ordered by chunk_idx.
//   2. Fall back to a wider scope when the eligible set comes up empty.
//      Previously every extractor wrote "unknown" / "false" the moment
//      section routing missed — which encodes "the section classifier
//      failed" as "the paper does not exhibit this signal". Now the
//      fallback runs and the provenance row records that it did so the
//      user can see the routing was loosened.
//
// Fallback tiers (in order):
//
//   a. eligible sections only          → mechanism prefix '' (best case)
//   b. eligible + 'other' (low-confidence section classification)
//                                       → mechanism suffix '+other'
//   c. every non-references chunk      → mechanism suffix '+whole_paper'
//
// Callers receive a tier identifier in the response so they can record it
// in provenance (e.g. mechanism='regex+nli' becomes 'regex+nli+whole_paper').

import * as store from '../store.mjs';

const REFERENCES_LIKE = new Set(['references', 'bibliography']);

// Detect chunks that are obviously front matter (title page / cover):
//   * Page-1 chunk with very few sentences relative to length
//   * Author list signature ("Lastname,? F.?M.?" repeated, or "and Lastname")
//   * "Page N/M" headers
//   * No closing-period sentence in first 200 chars
// These chunks tend to get misclassified as 'abstract' or 'methods' by the
// section classifier (their language is generic and contains review-y
// vocabulary). When routed into per-field extraction they pollute the
// inputs — every extractor ends up using the title-and-authors line as
// its "evidence". This filter sends them to the bottom of the eligible
// list so other chunks win.
const FRONT_MATTER_HINTS = [
  /\bpage\s+\d+\s*\/\s*\d+\b/i,
  /\bcorresponding\s+author\b/i,
  /\bemail:\s*[^\s@]+@[^\s@]+/i,
];
function looksLikeFrontMatter(row) {
  if (!row || row.chunk_idx == null) return false;
  if (row.chunk_idx !== 0) return false;   // only the very first chunk is suspect
  const text = String(row.text || '').slice(0, 1200);
  if (!text) return true;
  for (const re of FRONT_MATTER_HINTS) if (re.test(text)) return true;
  // No proper sentence in the first 200 chars (no '. ' followed by capital).
  const head = text.slice(0, 200);
  if (!/[.!?]\s+[A-Z]/.test(head)) {
    // Often a title + author list without sentences. Confirm via uppercase
    // density: front matter has many capital initials, body text doesn't.
    const upperCount = (head.match(/[A-Z]/g) || []).length;
    if (upperCount > 12) return true;
  }
  return false;
}

// Demote front-matter rows to the back of the list so they're only
// consumed if there's literally no other content.
function demoteFrontMatter(rows) {
  if (!Array.isArray(rows) || rows.length <= 1) return rows;
  const body = [];
  const front = [];
  for (const r of rows) {
    if (looksLikeFrontMatter(r)) front.push(r); else body.push(r);
  }
  return [...body, ...front];
}

/**
 * Pull chunks for a paper using a three-tier fallback. Returns
 *   { rows, tier: 'sections' | 'sections+other' | 'whole_paper' }
 *
 * opts:
 *   limit         optional row cap (per-tier)
 *   includeOther  default true; pulls chunks tagged 'other' alongside
 *                 the eligible set since 'other' is the section
 *                 classifier's "low confidence" bucket
 */
export function eligibleChunksWithFallback(paperId, sectionLabels, opts = {}) {
  const includeOther = opts.includeOther !== false;
  const limit = opts.limit;

  // Tier A: strictly eligible sections.
  if (sectionLabels?.length) {
    const placeholders = sectionLabels.map(() => '?').join(',');
    const rowsA = store.query(
      `SELECT c.chunk_id, c.text, c.page_first, c.page_last, c.chunk_idx, cs.label
         FROM chunks c
         JOIN chunk_section cs ON cs.chunk_id = c.chunk_id
        WHERE c.paper_id = ? AND cs.label IN (${placeholders})
        ORDER BY c.chunk_idx
        ${limit ? 'LIMIT ?' : ''}`,
      limit ? [paperId, ...sectionLabels, limit] : [paperId, ...sectionLabels],
    );
    if (rowsA.length > 0) return { rows: demoteFrontMatter(rowsA), tier: 'sections' };
  }

  // Tier B: include 'other' so misclassified-but-relevant chunks get a chance.
  if (includeOther && sectionLabels?.length) {
    const labels = [...sectionLabels, 'other'];
    const placeholders = labels.map(() => '?').join(',');
    const rowsB = store.query(
      `SELECT c.chunk_id, c.text, c.page_first, c.page_last, c.chunk_idx, cs.label
         FROM chunks c
         JOIN chunk_section cs ON cs.chunk_id = c.chunk_id
        WHERE c.paper_id = ? AND cs.label IN (${placeholders})
        ORDER BY c.chunk_idx
        ${limit ? 'LIMIT ?' : ''}`,
      limit ? [paperId, ...labels, limit] : [paperId, ...labels],
    );
    if (rowsB.length > 0) return { rows: demoteFrontMatter(rowsB), tier: 'sections+other' };
  }

  // Tier C: every chunk except references / bibliography. Last resort.
  const rowsC = store.query(
    `SELECT c.chunk_id, c.text, c.page_first, c.page_last, c.chunk_idx,
            COALESCE(cs.label, 'other') AS label
       FROM chunks c
       LEFT JOIN chunk_section cs ON cs.chunk_id = c.chunk_id
      WHERE c.paper_id = ?
        AND (cs.label IS NULL OR cs.label NOT IN ('references', 'bibliography'))
      ORDER BY c.chunk_idx
      ${limit ? 'LIMIT ?' : ''}`,
    limit ? [paperId, limit] : [paperId],
  );
  return { rows: demoteFrontMatter(rowsC), tier: 'whole_paper' };
}

/**
 * Concatenate eligible chunks into a single text string under a character
 * budget, preserving page tracking. Used by extractors that hand a single
 * text blob to NLI classify rather than iterating chunks.
 *
 * Returns { text, chunkIds, pages, firstPage, tier }.
 */
export function eligibleTextWithFallback(paperId, sectionLabels, opts = {}) {
  const budget = opts.budget ?? 1500;
  const maxChunks = opts.maxChunks ?? 4;
  const { rows, tier } = eligibleChunksWithFallback(paperId, sectionLabels, {
    ...opts,
    limit: maxChunks * 2,   // sql.js LIMIT after JOIN
  });
  let total = 0;
  const parts = [];
  const chunkIds = [];
  const pages = [];
  let firstPage = null;
  let used = 0;
  for (const r of rows) {
    if (used >= maxChunks) break;
    const remaining = budget - total;
    if (remaining <= 0) break;
    const slice = (r.text || '').slice(0, remaining);
    if (!slice.trim()) continue;
    parts.push(slice);
    chunkIds.push(r.chunk_id);
    pages.push(r.page_first ?? null);
    total += slice.length;
    used++;
    if (firstPage == null) firstPage = r.page_first ?? null;
  }
  return { text: parts.join('\n\n'), chunkIds, pages, firstPage, tier };
}

/**
 * Suffix the tier marker onto a mechanism string so provenance carries
 * "we widened the search to keep going". Tier 'sections' is the clean
 * case and appends nothing.
 */
export function annotateMechanism(mechanism, tier) {
  if (tier === 'sections') return mechanism;
  return `${mechanism}+${tier}`;
}
