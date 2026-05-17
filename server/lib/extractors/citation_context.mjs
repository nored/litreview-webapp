// extractors/citation_context.mjs
//
// For each citation edge whose from_paper is in the corpus AND whose
// to_paper is locatable in from_paper's chunks (by author-surname +
// year anchors), locate the surrounding ~300-char window and zero-shot-
// classify it into one of {support, contrast, extend, background}.
//
// Writes: citations.context_class, .context_page, .context_quote,
// .provenance_id. Idempotent on context_class IS NULL — re-running picks
// up only edges that haven't been classified yet.
//
// Edges with no locatable context are left with context_class NULL — the
// detectors that consume context_class treat NULL as "unknown" and ignore.

import * as store from '../store.mjs';
import * as nli from '../nli.mjs';

const LABELS = ['supports', 'contrasts with', 'extends', 'mentions as background to'];
const LABEL_TO_CLASS = {
  'supports': 'support',
  'contrasts with': 'contrast',
  'extends': 'extend',
  'mentions as background to': 'background',
};
const HYPOTHESIS = 'The citing paper {} the cited work.';
const CONTEXT_WINDOW = 240;          // chars on each side of the anchor match
const ACCEPT_THRESHOLD = 0.40;       // below this the classifier is too uncertain; leave context_class NULL

function surnameOf(authorName) {
  const trimmed = String(authorName || '').trim();
  if (!trimmed) return null;
  // "Last, First" → "Last"; otherwise take last token.
  if (trimmed.includes(',')) return trimmed.split(',')[0].trim();
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] || null;
}

function buildAnchors(toPaper) {
  const out = [];
  if (!toPaper) return out;
  const year = toPaper.year || null;
  const authors = (toPaper.authors_csv || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of authors.slice(0, 2)) {
    const sn = surnameOf(a);
    if (!sn || sn.length < 3) continue;
    if (year) {
      out.push(`${sn} et al., ${year}`);
      out.push(`${sn} et al. (${year})`);
      out.push(`${sn} (${year})`);
      out.push(`${sn}, ${year}`);
      out.push(`${sn} et al ${year}`);
    }
    out.push(`${sn} et al.`);
  }
  // De-dup, longest first so we prefer most specific anchor.
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

// Window the matched anchor with up to CONTEXT_WINDOW chars on each side.
// When the match lands near a chunk boundary, pull text from the previous
// or next chunk (same paper, non-references) — but only if those chunks
// are on the SAME page as the anchor's chunk. Crossing page boundaries
// would make the recorded `context_page` misleading (the quote spans
// multiple pages but provenance records only the anchor's page).
function windowAroundMatch(chunks, chunkIdx, matchIdx, matchLen) {
  const c = chunks[chunkIdx];
  const text = c.text || '';
  const anchorPage = c.page_first ?? null;

  // Left padding.
  let leftFromPrev = '';
  if (matchIdx < CONTEXT_WINDOW) {
    let need = CONTEXT_WINDOW - matchIdx;
    for (let i = chunkIdx - 1; i >= 0 && need > 0; i--) {
      const prev = chunks[i];
      if (prev.section === 'references') break;
      // Stop extending if previous chunk is on a different page —
      // provenance.page would no longer cover this content.
      if (anchorPage != null && prev.page_first != null && prev.page_first !== anchorPage) break;
      const t = prev.text || '';
      const take = Math.min(need, t.length);
      leftFromPrev = t.slice(t.length - take) + ' ' + leftFromPrev;
      need -= take;
    }
  }
  const leftSlice = text.slice(Math.max(0, matchIdx - CONTEXT_WINDOW), matchIdx);

  // Right padding.
  const rightStart = matchIdx + matchLen;
  const rightInChunk = text.length - rightStart;
  let rightFromNext = '';
  if (rightInChunk < CONTEXT_WINDOW) {
    let need = CONTEXT_WINDOW - rightInChunk;
    for (let i = chunkIdx + 1; i < chunks.length && need > 0; i++) {
      const nxt = chunks[i];
      if (nxt.section === 'references') break;
      if (anchorPage != null && nxt.page_first != null && nxt.page_first !== anchorPage) break;
      const t = nxt.text || '';
      const take = Math.min(need, t.length);
      rightFromNext += ' ' + t.slice(0, take);
      need -= take;
    }
  }
  const rightSlice = text.slice(rightStart, Math.min(text.length, rightStart + CONTEXT_WINDOW));

  return (leftFromPrev + leftSlice + text.slice(matchIdx, matchIdx + matchLen) + rightSlice + rightFromNext).trim();
}

function findContext(chunks, anchors) {
  for (const a of anchors) {
    const lower = a.toLowerCase();
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c.section === 'references') continue;
      const text = c.text || '';
      const idx = text.toLowerCase().indexOf(lower);
      if (idx < 0) continue;
      return {
        text: windowAroundMatch(chunks, i, idx, lower.length),
        chunk_id: c.chunk_id,
        page: c.page_first ?? null,
        anchor: a,
      };
    }
  }
  return null;
}

// Parse the references section of a paper into a Map<number, refText>.
// Recognises "[N] ..." and "N. ..." styles. Robust to multi-line refs by
// splitting on the next number+separator.
//
// Fallback: if no chunk is tagged 'references' (section classifier
// missed it), scan the FULL text of all chunks for a "References" /
// "Bibliography" / "Works Cited" header and treat everything after the
// FIRST such header as the references section. Avoids the silent
// no-op when the chunk_section tag is wrong.
function buildReferenceMap(chunks) {
  const map = new Map();
  let refsText = chunks
    .filter((c) => c.section === 'references')
    .map((c) => c.text || '')
    .join('\n');

  if (!refsText.trim()) {
    // Fallback: find a standalone header line for the references section.
    // Accept variants that real PDFs produce:
    //   - leading whitespace, optional section number ("6. " / "6) ")
    //   - optional bullet/symbol prefix ("§ ", "* ")
    //   - case variations (REFERENCES / References / references)
    //   - optional trailing period or colon
    // Anchoring is still header-positional (own line, newline before
    // and after), which rejects body-text "see Reference 3" mentions.
    const HEADER_RE = /(?:^|\n)[ \t]*(?:[§*•·]\s+)?(?:\d+[.)\s]+)?(references|bibliography|works\s+cited|literature\s+cited)[.: ]*[ \t]*\n/i;
    const allText = chunks.map((c) => c.text || '').join('\n');
    const m = HEADER_RE.exec(allText);
    if (m) refsText = allText.slice(m.index + m[0].length);
  }
  if (!refsText.trim()) return map;

  // Pattern 1: "[1] ..." up to next "[N]" or end.
  const bracketRe = /\[(\d{1,3})\][\s ]+([^\[]{15,500}?)(?=\s*\[\d{1,3}\]|$)/gs;
  let m;
  while ((m = bracketRe.exec(refsText)) !== null) {
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 1 || n > 999) continue;
    if (!map.has(n)) map.set(n, m[2].replace(/\s+/g, ' ').trim());
  }

  // Pattern 2: "1. " or "1) " at line start — only if bracket pattern found
  // nothing (papers use one style or the other; mixing causes false matches).
  if (map.size === 0) {
    const numberedRe = /(?:^|\n)\s*(\d{1,3})[.\)]\s+([^\n]{15,500}(?:\n(?!\s*\d{1,3}[.\)])[^\n]+)*)/g;
    while ((m = numberedRe.exec(refsText)) !== null) {
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n) || n < 1 || n > 999) continue;
      if (!map.has(n)) map.set(n, m[2].replace(/\s+/g, ' ').trim());
    }
  }
  return map;
}

// Find the [N] in the body whose ref-text best matches toPaper. Returns
// { n, chunk_id, page, idx } or null. Falls back to author-surname match
// when no year info is available.
function findNumericCitation(toPaper, refMap, bodyChunks) {
  if (refMap.size === 0) return null;
  const surnames = (toPaper.authors_csv || '')
    .split(',')
    .map((s) => surnameOf(s.trim()))
    .filter((s) => s && s.length >= 3)
    .slice(0, 3);
  if (surnames.length === 0) return null;
  const year = toPaper.year ? String(toPaper.year) : null;

  // Score every ref entry. Strict acceptance: year + ≥1 surname OR ≥2
  // surnames (≥4 points). Fallback: a single surname-only match counts
  // only when that surname appears in EXACTLY one reference entry
  // (unambiguous identification).
  let best = null;
  const surnameOnlyMatches = new Map();   // n → count of surname hits
  for (const [n, refText] of refMap.entries()) {
    const lower = refText.toLowerCase();
    let score = 0;
    let surnameHits = 0;
    for (const sn of surnames) {
      if (lower.includes(sn.toLowerCase())) { score += 2; surnameHits++; }
    }
    if (year && lower.includes(year)) score += 3;
    if (score >= 4) {
      if (!best || score > best.score) best = { n, score };
    }
    if (surnameHits > 0) surnameOnlyMatches.set(n, surnameHits);
  }
  if (!best && surnameOnlyMatches.size === 1) {
    // Exactly one ref matches the surname(s) — unambiguous fallback.
    const [n] = surnameOnlyMatches.keys();
    best = { n, score: 2, unambiguous_surname: true };
  }
  if (!best) return null;

  // Locate [N] (or [N, …], [N-…]) in non-references chunks. The N must
  // be a whole number — searching for 2 should NOT match [12] or [25].
  // We allow N inside a list/range like [1, 2, 3] or [2-5] but bracket
  // N with non-digit boundaries.
  const numStr = String(best.n);
  const re = new RegExp(`\\[(?:[^\\]]*?[,\\s])?${numStr}(?![0-9])(?:\\s*[,\\-–]\\s*\\d+)?(?:[^\\]]*)\\]`);
  for (let i = 0; i < bodyChunks.length; i++) {
    const c = bodyChunks[i];
    if (c.section === 'references') continue;
    const text = c.text || '';
    const idx = text.search(re);
    if (idx < 0) continue;
    const matchLen = (text.match(re)?.[0] || `[${numStr}]`).length;
    return {
      text: windowAroundMatch(bodyChunks, i, idx, matchLen),
      chunk_id: c.chunk_id,
      page: c.page_first ?? null,
      anchor: `[${best.n}] (numeric)`,
    };
  }
  return null;
}

/**
 * Classify all citation edges whose context_class IS NULL and whose
 * from_paper has chunks in the store. Returns
 *   { total, classified, unlocated, low_confidence }
 *
 * opts.limit — cap on edges classified per call (default 500).
 */
export async function classifyCitationContexts(opts = {}) {
  await store.init();
  const limit = Math.max(1, opts.limit ?? 500);

  const rows = store.query(
    `SELECT c.citation_id, c.from_paper, c.to_paper,
            tp.title AS to_title, tp.year AS to_year,
            (SELECT GROUP_CONCAT(author_name, ',') FROM paper_authors WHERE paper_id = c.to_paper) AS to_authors_csv
       FROM citations c
       JOIN papers fp ON fp.paper_id = c.from_paper
      WHERE c.context_class IS NULL
      LIMIT ?`,
    [limit],
  );

  let classified = 0;
  let unlocated = 0;
  let lowConfidence = 0;

  // Per-from_paper cache of (chunks, refMap) so we don't re-parse references
  // for every edge sharing the same citing paper.
  const cache = new Map();

  for (const row of rows) {
    const anchors = buildAnchors({
      year: row.to_year,
      authors_csv: row.to_authors_csv,
    });

    let entry = cache.get(row.from_paper);
    if (!entry) {
      const chunks = store.query(
        `SELECT c.chunk_id, c.text, c.page_first, COALESCE(cs.label, '') AS section
           FROM chunks c
           LEFT JOIN chunk_section cs ON cs.chunk_id = c.chunk_id
          WHERE c.paper_id = ?`,
        [row.from_paper],
      );
      entry = { chunks, refMap: buildReferenceMap(chunks) };
      cache.set(row.from_paper, entry);
    }
    if (entry.chunks.length === 0) { unlocated++; continue; }

    let ctx = anchors.length > 0 ? findContext(entry.chunks, anchors) : null;
    if (!ctx) {
      // Fall back to numeric-style citation lookup via parsed references.
      ctx = findNumericCitation(
        { year: row.to_year, authors_csv: row.to_authors_csv },
        entry.refMap,
        entry.chunks,
      );
    }
    if (!ctx) { unlocated++; continue; }

    let result;
    try {
      result = await nli.classify(ctx.text, LABELS, {
        hypothesisTemplate: HYPOTHESIS,
        multiLabel: false,
      });
    } catch (e) {
      console.warn('citation_context: NLI call failed:', e?.message || e);
      continue;
    }
    const top = result.label;
    const score = result.score ?? 0;
    if (!top || score < ACCEPT_THRESHOLD) {
      lowConfidence++;
      continue;
    }
    const cls = LABEL_TO_CLASS[top];
    if (!cls) { lowConfidence++; continue; }

    const provId = store.recordProvenance({
      mechanism: 'nli_zero_shot',
      model: nli.MODEL,
      chunk_id: ctx.chunk_id,
      page: ctx.page,
      raw_text: ctx.text,
      classifier_scores: result.scores,
      confidence: score,
    });

    store.exec(
      `UPDATE citations
          SET context_class = ?,
              context_page  = ?,
              context_quote = ?,
              provenance_id = ?
        WHERE citation_id = ?`,
      [cls, ctx.page, ctx.text, provId, row.citation_id],
    );
    classified++;
  }

  await store.flush();
  return { total: rows.length, classified, unlocated, low_confidence: lowConfidence };
}
