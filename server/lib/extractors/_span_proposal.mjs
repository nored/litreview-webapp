// extractors/_span_proposal.mjs
//
// Broad-recall span proposer for the type-prompted NER pipeline. Replaces
// the dictionary-first approach: we no longer rely on a static list of
// "things we know about". Spans are proposed by their linguistic shape
// and the type classifier downstream decides whether each span is one of
// the user's `entity_types`.
//
// Three independent proposal streams, deduplicated and merged:
//
//   1. NER spans (when available)
//        Existing CoNLL-NER catches well-known proper nouns. Reasonable
//        precision; very limited recall on scientific entities.
//
//   2. Acronym / capitalised-multi-word regex
//        Catches "MIMIC-III", "Prime+Probe", "Intel SGX", "Vector Database
//        Management Systems", "OpenSSL", "ScaNN", "Llama-3", etc.
//
//   3. Named-pattern regex
//        Surface patterns that indicate the head noun is a named entity:
//        "the X library", "the X dataset", "X (Y)", "called X", "named X".
//
// Each proposed span carries:
//   text        the verbatim span as it appears in the chunk
//   start, end  character offsets in the chunk
//   page        chunk page
//   source      'ner' | 'capitalised' | 'acronym' | 'hyphenated' | 'pattern:dataset' | ...
//   ner_score   when source='ner', the model's confidence
//
// Caller (named_entities.mjs) feeds these to the type classifier, which
// produces the final {kind, canonical, page, mechanism} rows.

import * as ner from '../ner.mjs';

// Minimum span length to consider (chars). Two-char "ML"-like acronyms
// are common, but we require uppercase or hyphenated context to avoid
// matching English bigrams.
const MIN_SPAN_LEN = 2;
const MAX_SPAN_LEN = 80;

// ─────────────────────────────────────────────────────────────────────────
// Regex bank
// ─────────────────────────────────────────────────────────────────────────

// Capitalised multi-word: ≥2 consecutive capitalised tokens. Captures
// names like "Vector Database Management Systems", "Trusted Execution
// Environment".
const CAPITALISED_MULTI = /(?<![A-Za-z])([A-Z][A-Za-z0-9]*(?:[\s-][A-Z][A-Za-z0-9]+){1,5})(?![A-Za-z])/g;

// "X of Y" / "X de Y" / "X von Y" — multi-word names connected by a
// lowercase preposition. Catches "Treaty of Versailles", "League of
// Nations", "Battle of Britain", "von Neumann architecture".
const CAPITALISED_WITH_PARTICLE = /(?<![A-Za-z])([A-Z][A-Za-z]+(?:\s+(?:of|de|del|della?|du|von|van|der|al-|el-|le|la|den|den|y|e)\s+[A-Z][A-Za-z]+){1,3})(?![A-Za-z])/g;

// CamelCase / PascalCase single word: ≥1 internal uppercase, length ≥ 4.
// Catches "OpenSSL", "PyTorch", "ScaNN", "NumPy", "JavaScript",
// "Salesforce", "iPhone". Excludes plain capitalised words like "Method"
// or "Section" which require ≥2 lowercase + 1 uppercase in the middle.
const CAMELCASE = /(?<![A-Za-z])([A-Z][a-z]{1,}[A-Z][A-Za-z0-9]*|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)(?![A-Za-z])/g;

// Acronym: 2-10 uppercase letters, may include digits or single hyphens.
// Excludes common English words via post-filter.
const ACRONYM = /(?<![A-Za-z])([A-Z]{2,10}(?:[-+][A-Za-z0-9]+)?)(?![A-Za-z])/g;

// Hyphenated tech-like name: includes a hyphen joining alnum tokens,
// with at least one uppercase or digit segment. Catches "Llama-3.2",
// "BERT-base", "Prime+Probe", "Flush+Reload", "F1-Score", "ECC-Curve25519".
const HYPHENATED_TECH = /(?<![A-Za-z])([A-Za-z][A-Za-z0-9]*(?:[-+][A-Za-z0-9.]+){1,3})(?![A-Za-z])/g;

// Version-suffixed name: "BERT-base", "GPT-4", "Llama-3.2", "MIMIC-III".
// Already covered by hyphenated above, but kept as a separate matcher
// so we can tag the source for provenance.
const VERSIONED = /(?<![A-Za-z])([A-Z][A-Za-z]{1,15}[-_]?(?:[0-9]+(?:\.[0-9]+)?|[IVX]{1,4}|base|large|small|tiny|xl|xxl)\b)/g;

// Pattern-anchored: "the X library", "X dataset", "called X", "named X",
// "X benchmark", "X framework". Captures the X token. Multi-word phrases
// are captured greedily but capped at 5 tokens.
const PATTERN_ANCHORS = [
  { source: 'pattern:library',   re: /\b(?:the\s+)?([A-Z][A-Za-z0-9-+.]{1,30}(?:\s+[A-Z][A-Za-z0-9-+.]{1,30}){0,3})\s+(?:library|toolkit|package|framework)\b/g },
  { source: 'pattern:dataset',   re: /\b(?:the\s+)?([A-Z][A-Za-z0-9-+.]{1,30}(?:\s+[A-Z][A-Za-z0-9-+.]{1,30}){0,3})\s+(?:dataset|corpus|benchmark|test\s?set|collection)\b/g },
  { source: 'pattern:attack',    re: /\b(?:[Tt]he\s+)?([A-Z][A-Za-z0-9-+.]{1,30}(?:[\s-][A-Z][A-Za-z0-9-+.]{1,30}){0,2})\s+(?:[Aa]ttack|[Ee]xploit|[Ss]ide[- ][Cc]hannel|[Cc]overt\s+[Cc]hannel|[Ff]ault\s+[Ii]njection)\b/g },
  { source: 'pattern:model',     re: /\b(?:the\s+)?([A-Z][A-Za-z0-9-+.]{1,30}(?:\s+[A-Z][A-Za-z0-9-+.]{1,30}){0,3})\s+(?:model|encoder|decoder|transformer|classifier)\b/g },
  { source: 'pattern:called',    re: /\b(?:called|named|known\s+as|termed)\s+["']?([A-Z][A-Za-z0-9-+.]{1,30}(?:\s+[A-Z][A-Za-z0-9-+.]{1,30}){0,3})["']?/g },
  { source: 'pattern:paren_abbr', re: /\b([A-Z][A-Za-z0-9-+.\s]{3,60})\s*\(([A-Z]{2,10})\)/g },
];

// Common English words that look like acronyms but aren't. Conservative
// filter — leave anything ambiguous in (the type classifier will reject
// non-entities).
const ACRONYM_STOPLIST = new Set([
  'THE','AND','FOR','BUT','NOT','ALL','ANY','SOME','THIS','THAT','THESE','THOSE',
  'WE','OUR','THEIR','ITS','ITS','HIS','HER','HIM','SHE','HE','IT',
  'IS','ARE','WAS','WERE','BE','BEEN','BEING','HAS','HAVE','HAD',
  'DO','DOES','DID','DONE',
  'WILL','WOULD','SHALL','SHOULD','CAN','COULD','MAY','MIGHT','MUST',
  'IN','ON','AT','TO','OF','BY','UP','DOWN','OUT','OFF',
  'A','AN','AS','IF','OR','SO','NO','YES',
  'I','II','III','IV','V','VI','VII','VIII','IX','X', // roman numerals alone aren't entities
  'FIG','FIG.','TBL','TABLE','EQ','EQS','SEC','SECT','REF','REFS','APP','APPX',
  'ETC','EG','IE','VS','VIZ','CF','PER',
]);

// Stoplist for capitalised multi-word: catches "We Show That", "In Conclusion",
// "Section Two" etc. Single-word phrases survive (handled by acronym path).
const PHRASE_HEAD_STOPLIST = new Set([
  'we','our','this','these','those','the','their','its','an','a','from','to','in','on',
  'section','sect','chapter','figure','fig','table','tbl','example','for','also','however',
  'furthermore','moreover','meanwhile','therefore','hence','thus','indeed','additionally',
  'first','second','third','fourth','last','recent','previous','prior','related',
]);

// ─────────────────────────────────────────────────────────────────────────
// Per-chunk span extraction
// ─────────────────────────────────────────────────────────────────────────

// Leading determiners + connectives that capitalised-multi-word patterns
// can swallow. We strip them off the front of the span instead of
// rejecting the whole match — "The Intel SGX TEE" should yield
// "Intel SGX TEE", not nothing.
const LEADING_DETERMINERS = new Set(['the', 'a', 'an', 'this', 'these', 'those', 'our', 'we']);

function pushSpan(out, dedup, chunk, text, start, end, source, extra = {}) {
  if (!text || text.length < MIN_SPAN_LEN || text.length > MAX_SPAN_LEN) return;
  // Strip surrounding punctuation/whitespace.
  let trimmed = text;
  let leftTrim = 0;
  while (leftTrim < trimmed.length && /[\s,.;:!?(){}\[\]"'`]/.test(trimmed[leftTrim])) leftTrim++;
  let rightTrim = trimmed.length;
  while (rightTrim > leftTrim && /[\s,.;:!?(){}\[\]"'`]/.test(trimmed[rightTrim - 1])) rightTrim--;
  if (rightTrim - leftTrim < MIN_SPAN_LEN) return;
  let adjStart = start + leftTrim;
  let adjEnd = start + rightTrim;
  let finalText = trimmed.slice(leftTrim, rightTrim);
  // Strip leading determiner ("The Intel SGX TEE" → "Intel SGX TEE").
  // Done iteratively in case of stacked determiners.
  while (true) {
    const sp = finalText.indexOf(' ');
    if (sp <= 0) break;
    const head = finalText.slice(0, sp).toLowerCase();
    if (!LEADING_DETERMINERS.has(head)) break;
    finalText = finalText.slice(sp + 1);
    adjStart += sp + 1;
  }
  if (finalText.length < MIN_SPAN_LEN) return;
  // Stopword filters
  if (source === 'acronym' && ACRONYM_STOPLIST.has(finalText.toUpperCase())) return;
  const firstWord = finalText.split(/[\s-]/)[0]?.toLowerCase();
  if (source === 'capitalised' && PHRASE_HEAD_STOPLIST.has(firstWord)) return;
  // Dedup by (text, start) so the same phrase from different sources collapses.
  const key = `${finalText.toLowerCase()}|${adjStart}`;
  if (dedup.has(key)) {
    // Merge sources so provenance shows ALL the ways we found it.
    const existing = dedup.get(key);
    existing.sources = [...new Set([...existing.sources, source])];
    return;
  }
  const span = {
    text: finalText,
    start: adjStart,
    end: adjEnd,
    chunk_id: chunk.chunk_id,
    page: chunk.page_first ?? null,
    sources: [source],
    ...extra,
  };
  dedup.set(key, span);
  out.push(span);
}

function extractRegexSpans(out, dedup, chunk) {
  const text = String(chunk.text || '');
  if (!text) return;
  // Capitalised multi-word.
  for (const m of text.matchAll(CAPITALISED_MULTI)) {
    pushSpan(out, dedup, chunk, m[1], m.index, m.index + m[1].length, 'capitalised');
  }
  // X-of-Y patterns.
  for (const m of text.matchAll(CAPITALISED_WITH_PARTICLE)) {
    pushSpan(out, dedup, chunk, m[1], m.index, m.index + m[1].length, 'capitalised_particle');
  }
  // CamelCase / PascalCase.
  for (const m of text.matchAll(CAMELCASE)) {
    pushSpan(out, dedup, chunk, m[1], m.index, m.index + m[1].length, 'camelcase');
  }
  // Acronyms.
  for (const m of text.matchAll(ACRONYM)) {
    pushSpan(out, dedup, chunk, m[1], m.index, m.index + m[1].length, 'acronym');
  }
  // Hyphenated tech.
  for (const m of text.matchAll(HYPHENATED_TECH)) {
    pushSpan(out, dedup, chunk, m[1], m.index, m.index + m[1].length, 'hyphenated');
  }
  // Versioned.
  for (const m of text.matchAll(VERSIONED)) {
    pushSpan(out, dedup, chunk, m[1], m.index, m.index + m[1].length, 'versioned');
  }
  // Pattern-anchored.
  for (const { source, re } of PATTERN_ANCHORS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // Patterns capture the entity name in group 1. paren_abbr also has
      // group 2 (the abbreviation); push both.
      pushSpan(out, dedup, chunk, m[1], m.index, m.index + m[1].length, source);
      if (m[2] && source === 'pattern:paren_abbr') {
        const idx = text.indexOf(m[2], m.index);
        if (idx >= 0) pushSpan(out, dedup, chunk, m[2], idx, idx + m[2].length, 'acronym');
      }
    }
  }
}

async function extractNerSpans(out, dedup, chunk) {
  if (ner.isUnavailable && ner.isUnavailable()) return;
  let spans = [];
  try {
    spans = await ner.extractNamedThings(chunk.text || '', { minScore: 0.5 });
  } catch { return; }
  for (const s of spans) {
    if (!s.word || s.start == null || s.end == null) continue;
    pushSpan(out, dedup, chunk, s.word, s.start, s.end, 'ner', { ner_score: s.score });
  }
}

// Pull the sentence containing a span (for the type classifier's context).
const SENT_BOUNDARY = /[.!?](?=\s+[A-Z(])/;
export function sentenceContext(text, start, end, padding = 60) {
  if (!text || start == null || end == null) return text || '';
  const head = Math.max(0, start - padding);
  const back = text.slice(head, start);
  const backBoundary = back.lastIndexOf('. ');
  const sStart = backBoundary >= 0 ? head + backBoundary + 2 : head;
  const tail = text.slice(end, Math.min(text.length, end + padding));
  const tailBoundary = tail.search(SENT_BOUNDARY);
  const sEnd = tailBoundary >= 0 ? end + tailBoundary + 1 : Math.min(text.length, end + padding);
  return text.slice(sStart, sEnd).trim();
}

/**
 * Extract every candidate entity span from a set of chunks. Returns a
 * deduped list of { text, start, end, chunk_id, page, sources[], ner_score? }
 * objects in document order.
 *
 * opts:
 *   skipNer   — skip the NER pass (faster, lower recall). Default false.
 */
export async function proposeSpans(chunks, opts = {}) {
  const out = [];
  const dedup = new Map();   // global dedup across all chunks
  for (const chunk of chunks) {
    extractRegexSpans(out, dedup, chunk);
    if (!opts.skipNer) await extractNerSpans(out, dedup, chunk);
  }
  // Stable order: by (chunk_idx, start).
  out.sort((a, b) => {
    if (a.chunk_id !== b.chunk_id) return String(a.chunk_id).localeCompare(String(b.chunk_id));
    return a.start - b.start;
  });
  return out;
}

export const _STOP = { ACRONYM_STOPLIST, PHRASE_HEAD_STOPLIST };
