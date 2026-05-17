// grobid_postprocess.mjs
//
// Thin layer on top of grobid-js's ParsedDocument. Three jobs:
//
//   1. Normalize the verbatim heading text of each Section to one of a
//      canonical section_type vocabulary so cross-paper analysis can
//      reason about "all introductions" / "all methods" without string
//      matching on the heading. Grobid-js stays parity-faithful to
//      upstream GROBID; this normalisation is litreview-specific.
//
//   2. Propagate each section's canonical type forward to every
//      paragraph in that section. Grobid encodes section membership
//      structurally (paragraphs nested under div under head) so this
//      is a straightforward tree walk.
//
//   3. Stabilise IDs. Grobid assigns local section/figure/table ids
//      like "sec_3", "fig_1", "tab_2" — we prefix with paper_id so
//      they're globally unique across the corpus.
//
// Heading normalisation is intentionally conservative. We use keyword
// matching on the heading text (which we now reliably have from
// grobid's <head>) rather than embedding cosine to prototypes. Section
// names in scientific papers are extremely standardised; a 50-entry
// keyword map covers 95%+ of real headings and the rest fall into
// 'other' without affecting downstream analysis.

/** Canonical section types we care about for gap analysis. 'other' is
 * the explicit fallback when no canonical match applies. */
export const SECTION_TYPES = [
  'abstract',
  'introduction',
  'background',
  'related_work',
  'methods',
  'experimental_setup',
  'results',
  'discussion',
  'limitations',
  'conclusion',
  'future_work',
  'references',
  'appendix',
  'acknowledgments',
  'other',
];

// Heading keyword → canonical type. Order matters: more specific
// patterns first so 'experimental setup' matches before 'experiment'
// falls through to 'methods'. Lowercased + leading-numbering-stripped
// before matching.
const SECTION_KEYWORDS = [
  // Front matter
  { type: 'abstract',         patterns: [/^abstract$/, /^summary$/] },
  // Background / introduction family
  { type: 'related_work',     patterns: [/related\s*work/, /prior\s*work/, /literature\s*review/, /state\s*of\s*the\s*art/, /background\s+and\s+related/, /previous\s*work/] },
  { type: 'background',       patterns: [/^background$/, /preliminaries?/, /^fundamentals?$/, /threat\s*model/] },
  { type: 'introduction',     patterns: [/^introduction$/, /^intro$/, /^motivation$/, /^overview$/, /^background$/] },
  // Methodology family
  { type: 'experimental_setup', patterns: [/experimental?\s*setup/, /experimental?\s*design/, /^experiments?$/, /^evaluation\s*setup/, /^datasets?$/, /^data(?:\s*collection)?$/, /^materials?(?:\s*and\s*methods?)?$/, /participants?/, /^implementation$/, /^setup$/, /protocol/] },
  { type: 'methods',          patterns: [/^methods?$/, /methodology/, /^approach$/, /^proposed\s+method/, /^system\s+design/, /^architecture/, /^model$/, /^algorithm/, /^framework$/, /^technique/, /^our\s+/] },
  // Outcomes. The leading-word patterns catch combined headings like
  // "Results and Discussion" (→ results) without needing the entire
  // string to match a single bucket.
  { type: 'results',          patterns: [/^results?\b/, /^findings\b/, /^empirical\s*results/, /^performance\b/, /^outcomes?\b/, /^analysis\b/, /^empirical\s*analysis/, /^evaluation\b/] },
  { type: 'discussion',       patterns: [/^discussions?\b/, /^interpretation/, /^implications?\b/] },
  { type: 'limitations',      patterns: [/^limitations?$/, /threats?\s*to\s*validity/, /^caveats?$/, /^weakness/] },
  { type: 'future_work',      patterns: [/future\s*work/, /open\s*(?:problems?|questions?|directions?|challenges)/, /next\s*steps/, /^outlook$/] },
  { type: 'conclusion',       patterns: [/^conclusions?$/, /^concluding\s*remarks/, /^closing/, /^final\s*remarks/] },
  // End matter
  { type: 'references',       patterns: [/^references?$/, /^bibliography/, /^works\s*cited/, /^literature\s*cited/, /^citations?$/] },
  { type: 'acknowledgments',  patterns: [/^acknowledg(?:e)?ments?$/, /^thanks?$/] },
  { type: 'appendix',         patterns: [/^appendi(?:x|ces)/, /supplementary/, /^supplement/] },
];

// Strip leading numbering like "3.2 ", "III. ", "A. " from a heading
// before keyword matching. The numbering is preserved separately in
// the section's `level` field for parent/child reconstruction.
function stripLeadingNumbering(heading) {
  if (!heading) return '';
  return String(heading)
    .replace(/^\s*\d+(?:\.\d+){0,4}\s*[.:\-]?\s*/, '')   // "3.2 " or "3.2. "
    .replace(/^\s*[IVX]{1,5}\.\s*/i, '')                  // "III. "
    .replace(/^\s*[A-Z]\.\s*/, '')                        // "A. "
    .trim();
}

/**
 * Normalise a raw heading to one of SECTION_TYPES via keyword regex.
 * Cheap and synchronous. Returns 'other' when no pattern matches —
 * callers can then fall through to `classifySectionSemantically` for a
 * second attempt.
 */
export function canonicaliseSectionHeading(rawHeading) {
  const stripped = stripLeadingNumbering(rawHeading).toLowerCase();
  if (!stripped) return 'other';
  for (const rule of SECTION_KEYWORDS) {
    for (const re of rule.patterns) {
      if (re.test(stripped)) return rule.type;
    }
  }
  return 'other';
}

// Descriptor phrases per canonical type. Embedded once and cached. The
// semantic fallback picks the cosine-nearest descriptor for any heading
// that the regex didn't classify, so domain-named sections like "Vector
// Database Management Systems", "Use-Cases in Cyber Security", or
// "Threat Model" land in a sensible bucket instead of falling through
// to 'other'.
const SECTION_DESCRIPTORS = {
  abstract:           ['Abstract: short paper summary at the start'],
  introduction:       ['Introduction motivation and overview of the paper'],
  background:         ['Background and fundamentals of the domain', 'Primer on the systems and concepts the paper builds on', 'Survey of foundational ideas'],
  related_work:       ['Related work and prior literature in this area', 'Comparison to existing approaches'],
  methods:            ['Methods and proposed approach', 'System design and architecture', 'Algorithm and technique description', 'Applications and use-cases of the proposed system', 'Authentication phishing detection anomaly detection traffic analysis pipelines'],
  experimental_setup: ['Experimental setup datasets participants protocol implementation'],
  results:            ['Results findings performance and empirical numbers'],
  discussion:         ['Discussion analysis interpretation and implications of results'],
  limitations:        ['Limitations threats to validity caveats and weaknesses'],
  conclusion:         ['Conclusion closing remarks and summary'],
  future_work:        ['Future work open questions and next research directions'],
  references:         ['References bibliography and works cited'],
  appendix:           ['Appendix and supplementary material'],
  acknowledgments:    ['Acknowledgments thanks and funding'],
};

let _descriptorCache = null;
async function ensureDescriptorEmbeddings() {
  if (_descriptorCache) return _descriptorCache;
  const { embed } = await import('./embedder.mjs');
  const types = [];
  const phrases = [];
  for (const [type, descs] of Object.entries(SECTION_DESCRIPTORS)) {
    for (const d of descs) { types.push(type); phrases.push(d); }
  }
  const { data, rows, dim } = await embed(phrases);
  _descriptorCache = { types, data, rows, dim, embed };
  return _descriptorCache;
}

function cosineRow(a, b, dim, ai = 0, bi = 0) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < dim; i += 1) {
    const av = a[ai * dim + i];
    const bv = b[bi * dim + i];
    dot += av * bv; na += av * av; nb += bv * bv;
  }
  return (na && nb) ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Semantic-similarity fallback for headings the regex classifier
 * couldn't tag. Embeds the heading via bge-small and returns the
 * canonical type whose descriptor is closest in cosine space, provided
 * the similarity crosses `threshold`. Below the threshold, returns
 * 'other' — an honest non-decision.
 *
 * Async because it loads the embedder on first call. The descriptor
 * embeddings are cached for the lifetime of the process.
 */
export async function classifySectionSemantically(rawHeading, threshold = 0.55) {
  const stripped = stripLeadingNumbering(rawHeading);
  if (!stripped) return 'other';
  try {
    const desc = await ensureDescriptorEmbeddings();
    const { data: hv } = await desc.embed([stripped]);
    let bestType = 'other';
    let bestSim = threshold;
    for (let r = 0; r < desc.rows; r += 1) {
      const sim = cosineRow(hv, desc.data, desc.dim, 0, r);
      if (sim > bestSim) { bestSim = sim; bestType = desc.types[r]; }
    }
    return bestType;
  } catch (e) {
    // Embedder unavailable (cold start, missing model). Keep 'other'.
    return 'other';
  }
}

/**
 * Walk the section tree, normalising each section's heading and
 * attributing the canonical type forward to children. Children inherit
 * their parent's canonical type unless their own heading classifies to
 * something different (a subsection of "Methods" titled "Datasets" gets
 * tagged 'experimental_setup' on its own merits, not inheriting).
 *
 * Grobid-js's section list is FLAT but each section has a `level`
 * indicating nesting. We rebuild parent_id by tracking the most recent
 * section at each level lower than the current.
 */
export async function postprocessSections(grobidSections, paperId) {
  const out = [];
  const stack = [];    // stack[i] = last section_id at level i+1
  for (let i = 0; i < (grobidSections || []).length; i++) {
    const sec = grobidSections[i];
    const rawHeading = String(sec.title || '');
    const level = Number.isFinite(sec.level) ? sec.level : 1;
    // Stack management: pop anything ≥ this level so we re-parent.
    while (stack.length >= level) stack.pop();
    const parent = stack[stack.length - 1] || null;
    const sectionId = `${paperId}:sec:${String(i).padStart(3, '0')}`;
    let canonicalType = canonicaliseSectionHeading(rawHeading);
    // Fallback 1: semantic similarity via bge-small. Handles
    // domain-named headings like "Vector Database Management Systems"
    // that the keyword regex can't catch.
    if (canonicalType === 'other') {
      canonicalType = await classifySectionSemantically(rawHeading);
    }
    // Fallback 2: inherit from parent. Subsections of 'methods' titled
    // something domain-specific like "Cache Priming" inherit 'methods'.
    if (canonicalType === 'other' && parent) {
      const parentEntry = out.find((s) => s.section_id === parent);
      if (parentEntry && parentEntry.canonical_type && parentEntry.canonical_type !== 'other') {
        canonicalType = parentEntry.canonical_type;
      }
    }
    out.push({
      section_id: sectionId,
      paper_id: paperId,
      section_idx: i,
      raw_heading: rawHeading,
      level,
      canonical_type: canonicalType,
      parent_id: parent,
    });
    stack[level - 1] = sectionId;
  }
  return out;
}

/**
 * Given the normalised section list and grobid's flat paragraph list,
 * produce paragraph rows with section_id + inherited canonical_type +
 * stable per-paper paragraph_id. Each grobid paragraph already knows
 * (via its container reference) which section it lives in; for the
 * paragraph list we just attribute the type forward.
 *
 * Grobid-js's ParsedDocument exposes paragraphs nested inside sections
 * (`section.paragraphs[]`). We flatten that structure here, keeping
 * the section_id mapping.
 */
export function postprocessParagraphs(grobidSections, normalisedSections, paperId) {
  const out = [];
  let paragraphIdx = 0;
  for (let i = 0; i < (grobidSections || []).length; i++) {
    const sec = grobidSections[i];
    const normalised = normalisedSections[i];
    const paras = Array.isArray(sec.paragraphs) ? sec.paragraphs : [];
    for (let pi = 0; pi < paras.length; pi++) {
      const p = paras[pi];
      // Page numbers come from the parser's `page` field (first page of
      // the paragraph) and `bbox` array (per-line coords with page).
      // Fall back to the old `tokens` shape for resilience if any
      // upstream branch still emits it.
      const pageFirst = p.page ?? p.tokens?.[0]?.page ?? p.bbox?.[0]?.page ?? null;
      const lastBboxPage = Array.isArray(p.bbox) && p.bbox.length
        ? p.bbox[p.bbox.length - 1].page
        : null;
      const pageLast = lastBboxPage ?? p.tokens?.[p.tokens.length - 1]?.page ?? pageFirst;
      // bbox_json: store the per-line page+coords from the parser. The
      // older code path serialised per-token coords; both shapes use
      // {p, b} keys downstream.
      let bboxJson = null;
      if (Array.isArray(p.bbox) && p.bbox.length) {
        bboxJson = JSON.stringify(p.bbox.slice(0, 200).map((b) => ({ p: b.page, b: { x: b.x, y: b.y, w: b.w, h: b.h } })));
      } else if (Array.isArray(p.tokens) && p.tokens.length && p.tokens[0].bbox) {
        bboxJson = JSON.stringify(p.tokens.slice(0, 200).map((t) => ({ p: t.page, b: t.bbox, t: t.text })));
      }
      out.push({
        paragraph_id: `${paperId}:p:${String(paragraphIdx).padStart(4, '0')}`,
        paper_id: paperId,
        section_id: normalised.section_id,
        paragraph_idx: paragraphIdx,
        canonical_type: normalised.canonical_type,
        text: String(p.text || ''),
        page_first: pageFirst,
        page_last: pageLast,
        bbox_json: bboxJson,
        // Inline citation markers (kept here so the ingester can iterate
        // without re-walking grobid's structure).
        _citations: Array.isArray(p.citations) ? p.citations : [],
        _figureMarkers: Array.isArray(p.figureMarkers) ? p.figureMarkers : [],
      });
      paragraphIdx++;
    }
  }
  return out;
}

/**
 * Normalise grobid's references list. Adds globally-unique reference_id
 * and lifts normalisedDate into date_year/month/day columns.
 */
export function postprocessReferences(grobidReferences, paperId) {
  const out = [];
  for (let i = 0; i < (grobidReferences || []).length; i++) {
    const r = grobidReferences[i];
    const bibRefId = r.id || `b${i}`;
    const d = r.normalizedDate || {};
    out.push({
      reference_id: `${paperId}:ref:${bibRefId}`,
      paper_id: paperId,
      bib_ref_id: bibRefId,
      ref_label: r.label || null,
      authors_raw: r.authors || null,
      parsed_authors_json: r.parsedAuthors ? JSON.stringify(r.parsedAuthors) : null,
      title: r.title || null,
      date_raw: r.date || null,
      date_year:  d.year  ? parseInt(d.year, 10)  : null,
      date_month: d.month ? parseInt(d.month, 10) : null,
      date_day:   d.day   ? parseInt(d.day, 10)   : null,
      journal: r.journal || null,
      booktitle: r.booktitle || null,
      publisher: r.publisher || null,
      pages: r.pages || null,
      volume: r.volume || null,
      doi: r.doi || null,
      url: r.url || null,
      raw_text: r.rawText || null,
    });
  }
  return out;
}

// Common abbreviations whose trailing period must NOT count as a
// sentence boundary. The check is "does the text just before the
// period end with one of these (case-insensitive, allowing a leading
// non-letter)". Catches "et al.", "e.g.", "i.e.", "cf.", "Fig.",
// "Eq.", "No.", "vol.", "vs.", "Dr.", "Mr.", "Mrs.", "Prof.", "Jr.",
// "Sr.", "etc.", "Ref.".
const ABBREVIATIONS = [
  'et al', 'e.g', 'i.e', 'cf', 'etc', 'vs', 'fig', 'eq', 'no', 'vol',
  'dr', 'mr', 'mrs', 'ms', 'prof', 'jr', 'sr', 'ref', 'sec', 'al',
  'pp', 'p', 'inc', 'ltd', 'co',
];

// Is the period at index `i` a real sentence boundary? Real if the
// next non-space character is uppercase (or end-of-text) AND the
// period is not preceded by a known abbreviation. This avoids
// breaking sentences at "et al.", "e.g.", "Fig. 3", etc.
function isSentenceEnd(text, i) {
  const ch = text[i];
  if (ch !== '.' && ch !== '!' && ch !== '?') return false;
  // Require whitespace or end-of-text after the punctuation.
  if (i + 1 >= text.length) return true;
  if (!/\s/.test(text[i + 1])) return false;
  // Find the next non-space character.
  let j = i + 2;
  while (j < text.length && /\s/.test(text[j])) j += 1;
  if (j >= text.length) return true;
  // Sentences start with an uppercase letter, a digit, or an open
  // paren / quote. If the next char is lowercase, this isn't a
  // sentence boundary.
  const next = text[j];
  if (/[a-z]/.test(next)) return false;
  // If the period is preceded by a known abbreviation, skip.
  // Look at up to 8 characters before the period (enough for the
  // longest abbreviation in the list).
  const lookback = text.slice(Math.max(0, i - 8), i).toLowerCase();
  for (const abbr of ABBREVIATIONS) {
    // Match either as a whole word ("vs") or trailing the lookback
    // (lookback ends with the abbrev).
    if (lookback.endsWith(abbr)) {
      // Avoid false matches like "etal" — require the abbreviation to
      // sit on a word boundary (preceded by non-letter or start).
      const before = i - abbr.length - 1;
      if (before < 0 || !/[a-z]/i.test(text[before])) return false;
    }
  }
  return true;
}

// Locate the sentence containing a character offset. Walks back and
// forward over real sentence boundaries (via isSentenceEnd) so
// abbreviations like "et al." don't truncate the result.
function sentenceContaining(text, offset) {
  if (offset < 0 || offset >= text.length) return null;
  // Walk back: find the previous real sentence boundary.
  let start = 0;
  for (let i = offset - 1; i > 0; i -= 1) {
    if (isSentenceEnd(text, i)) {
      // The boundary punctuation is at i; the next sentence starts
      // after the trailing whitespace.
      let s = i + 1;
      while (s < text.length && /\s/.test(text[s])) s += 1;
      start = s;
      break;
    }
  }
  // Walk forward: find the next real sentence boundary at or after
  // the offset.
  let end = text.length;
  for (let i = offset; i < text.length; i += 1) {
    if (isSentenceEnd(text, i)) {
      end = i + 1;
      break;
    }
  }
  return text.slice(start, end).trim();
}

/**
 * Build citation_marker rows from paragraph.citations[]. Grobid pre-
 * resolves each marker to a reference id (or leaves target undefined
 * when matching failed). We carry both forward so unmatched markers
 * remain visible for audit.
 *
 * context_text now captures the SENTENCE containing the citation, not
 * a fixed character window. This avoids mid-word truncation. When
 * several citations sit in the same sentence (clusters like
 * "(Wang, 2021) (Taipalus, 2024)"), every marker in that cluster
 * receives the same sentence as context — downstream consumers (e.g.
 * stance extraction) can group-by context_text to avoid asking the
 * model the same question multiple times.
 */
export function postprocessCitationMarkers(paragraphs, paperId) {
  const out = [];
  for (const p of paragraphs) {
    const cites = p._citations || [];
    const text = p.text;
    let searchFrom = 0;   // ensure repeated surface_texts find later occurrences
    for (let ci = 0; ci < cites.length; ci++) {
      const c = cites[ci];
      const surfaceText = c.text || '';
      const target = c.target ? `${paperId}:ref:${c.target}` : null;
      const page = c.tokens?.[0]?.page ?? p.page_first ?? null;
      let contextText = null;
      if (surfaceText) {
        // Resume indexOf from where the previous marker ended so two
        // markers with identical surface_text don't both collapse to
        // the first match.
        const idx = text.indexOf(surfaceText, searchFrom);
        if (idx >= 0) {
          contextText = sentenceContaining(text, idx + Math.floor(surfaceText.length / 2));
          searchFrom = idx + surfaceText.length;
        }
      }
      out.push({
        paper_id: paperId,
        paragraph_id: p.paragraph_id,
        reference_id: target,
        surface_text: surfaceText,
        marker_idx: ci,
        page,
        bbox_json: null,
        context_text: contextText,
        stance: null,
        stance_provenance_id: null,
      });
    }
  }
  return out;
}

/**
 * Normalise figures + tables.
 */
export function postprocessFiguresTables(parsed, paperId) {
  const figures = (parsed.body?.figures || []).map((f, i) => ({
    doc_figure_id: `${paperId}:fig:${String(i).padStart(3, '0')}`,
    paper_id: paperId,
    figure_idx: i,
    label: f.label || null,
    caption: f.caption || null,
    page: f.page ?? null,
    bbox_json: null,
  }));
  const tables = (parsed.body?.tables || []).map((t, i) => ({
    doc_table_id: `${paperId}:tbl:${String(i).padStart(3, '0')}`,
    paper_id: paperId,
    table_idx: i,
    label: t.label || null,
    caption: t.caption || null,
    page: t.page ?? null,
    bbox_json: null,
    cells_json: null,    // Phase 2: parse table structure when grobid emits it
  }));
  return { figures, tables };
}

/**
 * Convenience wrapper: run all postprocess steps on a parsed paper.
 * Returns an object ready to be written to the v4 schema in one
 * transaction.
 */
export async function postprocessParsedPaper(parsed, paperId) {
  const grobidSections = parsed.body?.sections || [];
  const sections = await postprocessSections(grobidSections, paperId);
  const paragraphs = postprocessParagraphs(grobidSections, sections, paperId);
  const references = postprocessReferences(parsed.references || [], paperId);
  const citationMarkers = postprocessCitationMarkers(paragraphs, paperId);
  const { figures, tables } = postprocessFiguresTables(parsed, paperId);
  return { sections, paragraphs, references, citationMarkers, figures, tables };
}
