// pdf_chunks.mjs
//
// PDF text extraction + section-aware chunking for the embedding pipeline.
// Pure-JS via pdfjs-dist — same library that powers your in-browser PDF
// viewer, no native deps, no Chromium.
//
// What we produce: an array of chunks, each
//   { id: 'paperId:NNN', text: string, meta: { paper_id, section, page_first,
//                                                page_last, chunk_idx, n_chunks } }
//
// Strategy:
//   1. Extract text per page; preserve newlines between text runs that look
//      like line breaks. We don't try to reconstruct multi-column layouts
//      perfectly — the embedder is robust to gentle word-order noise.
//   2. Walk the per-page text and find section headings using a curated
//      regex. Section boundaries are where a heading-shaped line starts.
//      Pages that have no heading just continue the previous section.
//   3. Within each section, split into ~chunkTokens token chunks with
//      chunkOverlap-token overlap. Token estimate is words×1.3 — good
//      enough to stay under bge-small's 512-token cap.
//
// We don't try to handle scanned (no-text) PDFs here; if pdfjs returns no
// text items, the chunk list is empty and the daemon moves on.

import { promises as fs } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// pdfjs-dist tries to load fonts and CMaps relative to its own files. We
// don't need fancy font rendering — just text — so disable those paths.
const PDFJS_OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  // Keep verbosity quiet so the daemon's own logs aren't drowned out.
  verbosity: 0,
};

// Structural heading detection. We do NOT try to categorize headings into
// semantic buckets ('method' vs 'experiments' vs 'evaluation') — that
// approach is brittle because real papers use idiosyncratic headings like
// "3. System Architecture" or "Empirical Validation" that don't match a
// curated keyword list. Instead we just split where a heading-shaped line
// occurs and keep the actual heading text (slugified) as the section
// label. Downstream retrieval is embedding-based, so the label is only
// informational metadata, not a filter.
//
// A heading-shaped line is one of:
//   - Numbered section: "1.", "3.2", "IV.", possibly followed by title text
//   - Markdown-style: "## Heading"
//   - Short Title Case or ALL CAPS line that stands alone (≤ ~80 chars,
//     surrounded by blank lines or paragraph breaks)
const HEADING_PATTERNS = [
  // Numbered (Arabic): "1.", "1.2", "3.4.5 Title"
  /^\s*(\d{1,2}(?:\.\d{1,3}){0,3})\.?\s+([A-Z][^\n]{0,80})\s*$/,
  // Numbered (Roman): "IV. Title", "III Title"
  /^\s*([IVX]{1,5})\.?\s+([A-Z][^\n]{0,80})\s*$/,
  // Markdown heading: "## Title" / "### Title"
  /^\s*(#{1,4})\s+([^\n]{1,80})\s*$/,
  // ALL CAPS heading line (3-80 chars, mostly letters, standalone)
  /^\s*([A-Z][A-Z\s]{2,79})\s*$/,
  // Title Case heading: standalone short line where most words capitalized
  // e.g. "Empirical Validation", "System Architecture"
  /^\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,6})\s*$/,
];

const HEADING_MIN_LEN = 3;
const HEADING_MAX_LEN = 80;

// Section labels we drop entirely because they're noise for note drafting:
//   - references / bibliography: 50–200 formatted bib entries pollute retrieval
//   - acknowledgments: not informative for note content
// Detected by heading text content (substring match, case-insensitive).
const DROP_LABEL_PATTERNS = [
  /references?$/i,
  /bibliography/i,
  /acknowledgments?/i,
  /acknowledgements?/i,
];

function detectHeading(line) {
  const trimmed = line.trim();
  if (trimmed.length < HEADING_MIN_LEN || trimmed.length > HEADING_MAX_LEN) return null;
  // Skip lines that contain too many lowercase words to be a heading
  const words = trimmed.split(/\s+/);
  if (words.length > 12) return null;
  // Skip lines ending in . , ; (typical sentence) — heading-like text
  // typically doesn't end in punctuation, except possibly the section
  // number's period.
  if (/[.,;!?]$/.test(trimmed) && !/^\d/.test(trimmed)) return null;
  for (const re of HEADING_PATTERNS) {
    const m = trimmed.match(re);
    if (!m) continue;
    // Build a verbatim section label from the heading itself.
    const headingText = m.length >= 3 ? `${m[1]} ${m[2]}` : m[1] || m[0];
    return slugifyHeading(headingText);
  }
  return null;
}

function slugifyHeading(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s.]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'section';
}

function shouldDropSection(label) {
  return DROP_LABEL_PATTERNS.some((re) => re.test(label));
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

async function extractPages(buffer) {
  const data = new Uint8Array(buffer);
  const loadingTask = getDocument({ ...PDFJS_OPTIONS, data });
  const pdf = await loadingTask.promise;
  const pages = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent({ includeMarkedContent: false });
      pages.push(textFromContent(content));
    }
  } finally {
    await pdf.destroy().catch(() => {});
  }
  return pages;
}

// Reassemble page text from pdfjs text items. We insert a newline whenever
// the y-coordinate jumps significantly (line break) and a space otherwise.
function textFromContent(content) {
  let out = '';
  let lastY = null;
  let lastEndedWithSpace = true;
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    const y = Array.isArray(item.transform) ? item.transform[5] : null;
    if (lastY != null && y != null && Math.abs(lastY - y) > 4) {
      // New line.
      if (!out.endsWith('\n')) out += '\n';
      lastEndedWithSpace = true;
    } else if (!lastEndedWithSpace && !item.str.startsWith(' ')) {
      out += ' ';
    }
    out += item.str;
    lastEndedWithSpace = item.str.endsWith(' ');
    if (y != null) lastY = y;
    if (item.hasEOL) {
      out += '\n';
      lastEndedWithSpace = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section assignment
// ---------------------------------------------------------------------------

function detectSections(pages) {
  // Walk every line; whenever a heading-shaped line appears, start a new
  // section. Each section's label is the VERBATIM (slugified) heading
  // text, not a canonical bucket. This means the labels are imperfect for
  // browsing but doesn't matter for retrieval — the bundle composition
  // uses embedding similarity, not labels.
  const sections = [];
  let current = newSection('preamble', 1);
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p].split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        current.text += '\n';
        continue;
      }
      const heading = detectHeading(trimmed);
      if (heading) {
        if (current.text.trim().length === 0) {
          current.label = heading;
          current.page_first = p + 1;
        } else {
          current.page_last = p + 1;
          sections.push(current);
          current = newSection(heading, p + 1);
        }
      } else {
        current.text += trimmed + '\n';
      }
    }
    current.page_last = p + 1;
  }
  if (current.text.trim().length > 0) sections.push(current);
  // Drop sections that are pure noise for note drafting: bibliography,
  // acknowledgments, references.
  return sections.filter((s) => !shouldDropSection(s.label));
}

function newSection(label, page_first) {
  return { label, text: '', page_first, page_last: page_first };
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

// Roughly 1.3 tokens per word for English; bge-small caps at 512 tokens. We
// target 400 words ≈ 520 tokens to leave a tiny margin for the model's
// special tokens, with 50-word overlap (~65 tokens).
const DEFAULT_CHUNK_WORDS = 400;
const DEFAULT_OVERLAP_WORDS = 50;
const MIN_CHUNK_WORDS = 30;

function chunkSection(section, chunkWords, overlapWords) {
  const words = section.text.split(/\s+/).filter(Boolean);
  if (words.length < MIN_CHUNK_WORDS) {
    if (words.length === 0) return [];
    return [{
      text: words.join(' '),
      page_first: section.page_first,
      page_last: section.page_last,
      section: section.label,
    }];
  }
  const out = [];
  const step = chunkWords - overlapWords;
  for (let i = 0; i < words.length; i += step) {
    const chunk = words.slice(i, i + chunkWords);
    if (chunk.length < MIN_CHUNK_WORDS && out.length > 0) break;
    out.push({
      text: chunk.join(' '),
      page_first: section.page_first,
      page_last: section.page_last,
      section: section.label,
    });
    if (i + chunkWords >= words.length) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a PDF from disk, extract section-aware chunks ready for embedding.
 * Returns [{ id, text, meta }] in document order; meta includes paper_id,
 * section, page_first, page_last, chunk_idx, n_chunks.
 *
 * opts:
 *   chunkWords     (default 400) — target words per chunk
 *   overlapWords   (default 50)  — overlap between consecutive chunks
 */
export async function chunksForPdf(pdfPath, paperId, opts = {}) {
  const {
    chunkWords = DEFAULT_CHUNK_WORDS,
    overlapWords = DEFAULT_OVERLAP_WORDS,
  } = opts;
  const buffer = await fs.readFile(pdfPath);
  const pages = await extractPages(buffer);
  if (pages.length === 0) return [];
  const sections = detectSections(pages);
  const flat = [];
  for (const sec of sections) {
    for (const chunk of chunkSection(sec, chunkWords, overlapWords)) {
      flat.push(chunk);
    }
  }
  return flat.map((c, idx) => ({
    id: `${paperId}:${String(idx).padStart(3, '0')}`,
    text: c.text,
    meta: {
      paper_id: String(paperId),
      section: c.section,
      page_first: c.page_first,
      page_last: c.page_last,
      chunk_idx: idx,
      n_chunks: flat.length,
    },
  }));
}

/** Quick text-only path — useful when you want a single embedding per PDF. */
export async function fullTextForPdf(pdfPath) {
  const buffer = await fs.readFile(pdfPath);
  const pages = await extractPages(buffer);
  return pages.join('\n\n');
}
