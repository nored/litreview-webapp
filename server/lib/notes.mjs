// Stage 4 deep-read notes. Storage = notes/paper_NNN.md in the canonical
// schema format (CLI-compatible). Form data round-trips with the file.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { NOTES_DIR, DATA_FILES, PROTOCOL_FILES, PDFS_DIR } from '../paths.mjs';
import { ensureDir, readText, fileExists } from '../storage.mjs';
import { parseCsv } from './csv.mjs';
import { enrichByDoi } from './bibenrich.mjs';
import { patchRowByPaperId } from './triage.mjs';
import { parseTopic } from './topic_md.mjs';
import { deriveNovelty, relevanceBodyFromValues } from './note_drafter.mjs';

const BODY_SECTIONS = [
  'problem_statement',
  'method_summary',
  'ground_truth_and_evaluation',
  'stated_limitations',
  'gaps_this_paper_opens',
  'relevance_to_the_thesis_topic',
];

const BODY_SECTION_HEADINGS = {
  problem_statement: 'Problem statement',
  method_summary: 'Method summary',
  ground_truth_and_evaluation: 'Ground truth and evaluation',
  stated_limitations: 'Stated limitations',
  gaps_this_paper_opens: 'Gaps this paper opens',
  relevance_to_the_thesis_topic: 'Relevance to the thesis topic',
};

// Empty `extracted:` subtree for the v2 schema. Every populated field
// gets a provenance subtree at extraction time. Phase 1a places only the
// skeleton; Phase 1b populates the fields via the per-field extractors.
// Lives under a single namespaced key so CLI-template readers can ignore
// the whole subtree without touching v1 fields.
export function emptyExtracted() {
  return {
    section_index: null,        // { <label>: [chunk_id] }, built by section_classifier
    methodology_type: null,     // { value, provenance }
    population: {
      language: [],             // [{ value, provenance }]
      geography: [],            // [{ value, provenance }]
      system_domain: null,
      sample_type: null,
      time_period: null,
    },
    tech_stack: [],             // [{ canonical, raw, provenance }]
    datasets_used: [],          // [{ canonical, n, role, raw, provenance }]
    frameworks_cited: [],       // [{ canonical, raw, provenance }]
    sample_size: null,
    results: [],                // [{ metric, value, dataset, split, provenance }]
    claims_first_in_area: null,
    challenges_existing: null,
    baseline_compared: null,
    releases_code: null,
    reports_uncertainty: null,
    claims: [],                 // [{ text, page, stance, claim_type, topic_embedding?, provenance }]
    quoted_spans: Object.fromEntries(BODY_SECTIONS.map((s) => [s, []])),
    closest_related: {},        // { <body_section>: [{ text, page, chunk_id, similarity }] }
  };
}

export function emptyNote(paperRow = {}) {
  // Default arXiv preprints' venue to 'arXiv' so an arXiv ID is sufficient
  // identification without nagging the student for a journal name.
  let venue = paperRow.venue || '';
  if (!venue && (paperRow.arxiv_id || /arxiv/i.test(String(paperRow.source_database || '')))) {
    venue = 'arXiv';
  }
  return {
    frontmatter: {
      paper_id: paperRow.paper_id || '',
      title: paperRow.title || '',
      authors: parseAuthors(paperRow.authors),
      year: parseInt(paperRow.year, 10) || 0,
      venue,
      doi: paperRow.doi || '',
      arxiv_id: paperRow.arxiv_id || '',
      url: paperRow.url || '',
      pdf_path: `data/pdfs/paper_${paperRow.paper_id}.pdf`,
      read_date: new Date().toISOString().slice(0, 10),
      category: [],
      method: { family: '', specific: '', inputs: [] },
      ground_truth: { source: '', external: false, case_count: 0, reproducible: false },
      evaluation: { metrics: [], baseline_compared: false, has_uncertainty_quantification: false },
      claims: { primary_contribution: '', novelty_strength: '' },
      limitations_authors_state: [],
      quality_flags: {
        self_constructed_ground_truth: false,
        comparison_table_only: false,
        hobby_project_scale: false,
        predictable_outcome: false,
      },
      relevance: { relevance_to_topic: '', must_cite: false },
      // v2 additions — see emptyExtracted() above. Notes saved without
      // `schema_version` are treated as v1 implicitly; the structured
      // extracted subtree is empty until the new extractor populates it.
      schema_version: 2,
      extracted: emptyExtracted(),
    },
    body: Object.fromEntries(BODY_SECTIONS.map((s) => [s, ''])),
  };
}

function parseAuthors(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s;
  return String(s).split(/,\s*/).map((x) => x.trim()).filter(Boolean);
}

// Merge a parsed `extracted:` subtree with the empty skeleton so the rest
// of the codebase can assume the full shape without per-field defaulting.
// Preserves any populated fields verbatim — only fills missing keys.
function normalizeExtracted(parsed) {
  const skel = emptyExtracted();
  if (!parsed || typeof parsed !== 'object') return skel;
  const merged = { ...skel, ...parsed };
  // Population is a nested object — merge its fields too rather than
  // overwriting the whole subtree if the YAML only set one key.
  merged.population = { ...skel.population, ...(parsed.population || {}) };
  // quoted_spans is per-body-section; ensure every section key exists.
  const qs = { ...skel.quoted_spans, ...(parsed.quoted_spans || {}) };
  for (const k of BODY_SECTIONS) {
    if (!Array.isArray(qs[k])) qs[k] = [];
  }
  merged.quoted_spans = qs;
  merged.closest_related = parsed.closest_related && typeof parsed.closest_related === 'object'
    ? parsed.closest_related
    : {};
  // Array fields: ensure they're arrays even if the YAML had null.
  for (const k of ['tech_stack', 'datasets_used', 'frameworks_cited', 'results', 'claims']) {
    if (!Array.isArray(merged[k])) merged[k] = [];
  }
  return merged;
}

export function parseNoteMd(md) {
  const note = emptyNote();
  if (!md) return note;
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return note;
  try {
    const fm = parseYaml(m[1]) || {};
    note.frontmatter = { ...note.frontmatter, ...fm };
    if (typeof fm.authors === 'string') note.frontmatter.authors = parseAuthors(fm.authors);
    if (!Array.isArray(note.frontmatter.category)) note.frontmatter.category = [];
    if (!Array.isArray(note.frontmatter.limitations_authors_state)) note.frontmatter.limitations_authors_state = [];
    if (!note.frontmatter.method?.inputs) note.frontmatter.method.inputs = [];
    if (!note.frontmatter.evaluation?.metrics) note.frontmatter.evaluation.metrics = [];
    // v2 schema: notes saved before the extracted subtree existed are
    // treated as v1 — fill in the skeleton so downstream code can assume
    // the shape. Existing extracted fields from the YAML are kept; the
    // missing ones are filled with empty defaults. We check the parsed
    // YAML directly (`fm.schema_version`), not the merged frontmatter,
    // because emptyNote() always seeds schema_version=2 by default.
    if (typeof fm.schema_version === 'number') {
      note.frontmatter.schema_version = fm.schema_version;
    } else {
      note.frontmatter.schema_version = fm.extracted ? 2 : 1;
    }
    note.frontmatter.extracted = normalizeExtracted(fm.extracted);
  } catch (e) {
    /* keep default frontmatter on yaml errors */
  }

  const body = m[2];
  for (const key of BODY_SECTIONS) {
    const heading = BODY_SECTION_HEADINGS[key];
    const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'm');
    const match = body.match(re);
    note.body[key] = match ? match[1].trim() : '';
  }
  return note;
}

// Stable, schema-ordered YAML output. Avoids the yaml package's key ordering
// surprises so the file format matches the CLI repo's note_schema.md exactly.
function serializeFrontmatter(fm) {
  const lines = [];
  const push = (k, v) => lines.push(`${k}: ${stringifyScalar(v)}`);
  const pushList = (k, arr) => {
    if (!arr || !arr.length) { lines.push(`${k}: []`); return; }
    lines.push(`${k}:`);
    for (const v of arr) lines.push(`  - ${stringifyScalar(v)}`);
  };

  push('paper_id', fm.paper_id);
  push('title', fm.title);
  pushList('authors', fm.authors || []);
  lines.push(`year: ${Number(fm.year) || 0}`);
  push('venue', fm.venue);
  push('doi', fm.doi);
  push('arxiv_id', fm.arxiv_id);
  push('url', fm.url);
  push('pdf_path', fm.pdf_path);
  push('read_date', fm.read_date);
  lines.push('');
  pushList('category', fm.category || []);
  lines.push('');
  lines.push('method:');
  lines.push(`  family: ${stringifyScalar(fm.method?.family || '')}`);
  lines.push(`  specific: ${stringifyScalar(fm.method?.specific || '')}`);
  if (!fm.method?.inputs?.length) lines.push(`  inputs: []`);
  else {
    lines.push(`  inputs:`);
    for (const v of fm.method.inputs) lines.push(`    - ${stringifyScalar(v)}`);
  }
  lines.push('');
  lines.push('ground_truth:');
  lines.push(`  source: ${stringifyScalar(fm.ground_truth?.source || '')}`);
  lines.push(`  external: ${!!fm.ground_truth?.external}`);
  lines.push(`  case_count: ${Number(fm.ground_truth?.case_count) || 0}`);
  lines.push(`  reproducible: ${!!fm.ground_truth?.reproducible}`);
  lines.push('');
  lines.push('evaluation:');
  if (!fm.evaluation?.metrics?.length) lines.push(`  metrics: []`);
  else {
    lines.push(`  metrics:`);
    for (const v of fm.evaluation.metrics) lines.push(`    - ${stringifyScalar(v)}`);
  }
  lines.push(`  baseline_compared: ${!!fm.evaluation?.baseline_compared}`);
  lines.push(`  has_uncertainty_quantification: ${!!fm.evaluation?.has_uncertainty_quantification}`);
  lines.push('');
  lines.push('claims:');
  lines.push(`  primary_contribution: ${stringifyScalar(fm.claims?.primary_contribution || '')}`);
  lines.push(`  novelty_strength: ${stringifyScalar(fm.claims?.novelty_strength || '')}`);
  lines.push('');
  pushList('limitations_authors_state', fm.limitations_authors_state || []);
  lines.push('');
  lines.push('quality_flags:');
  for (const k of [
    'self_constructed_ground_truth', 'comparison_table_only',
    'hobby_project_scale', 'predictable_outcome',
  ]) {
    lines.push(`  ${k}: ${!!fm.quality_flags?.[k]}`);
  }
  lines.push('');
  lines.push('relevance:');
  lines.push(`  relevance_to_topic: ${stringifyScalar(fm.relevance?.relevance_to_topic || '')}`);
  lines.push(`  must_cite: ${!!fm.relevance?.must_cite}`);

  // v2 schema additions live at the end so v1-aware readers (the CLI
  // template) can skip everything below without parsing it. The whole
  // subtree is serialized via stringifyYaml since the field layout is
  // shape-rich (provenance subtrees, varied types) and the CLI doesn't
  // need byte-stable output for this section.
  if (typeof fm.schema_version === 'number' && fm.schema_version >= 2) {
    lines.push('');
    lines.push(`schema_version: ${fm.schema_version}`);
    const extracted = fm.extracted || emptyExtracted();
    // Only emit `extracted:` if at least one field is populated, to
    // keep notes that haven't been re-extracted yet from carrying a
    // wall of empty defaults.
    if (extractedHasContent(extracted)) {
      // lineWidth: 0 disables auto-wrapping of long strings. We don't
      // set defaultStringType — the yaml library picks the safest form
      // per value (unquoted for short safe strings, quoted when needed)
      // and crucially leaves keys unquoted, so `extracted:` stays
      // readable rather than `"extracted":`.
      const yamlBlock = stringifyYaml({ extracted }, { lineWidth: 0 })
        .replace(/\n+$/, '');
      lines.push(yamlBlock);
    }
  }
  return lines.join('\n');
}

// True iff any extracted field is populated beyond the empty skeleton.
// Used to skip writing `extracted:` for unmigrated notes so the file
// stays minimal.
function extractedHasContent(extracted) {
  if (!extracted) return false;
  if (extracted.section_index) return true;
  if (extracted.methodology_type) return true;
  if (extracted.sample_size != null) return true;
  for (const k of ['tech_stack', 'datasets_used', 'frameworks_cited', 'results', 'claims']) {
    if (Array.isArray(extracted[k]) && extracted[k].length > 0) return true;
  }
  for (const k of ['claims_first_in_area', 'challenges_existing', 'baseline_compared',
                   'releases_code', 'reports_uncertainty']) {
    if (extracted[k] != null) return true;
  }
  const pop = extracted.population || {};
  if ((pop.language || []).length > 0) return true;
  if ((pop.geography || []).length > 0) return true;
  if (pop.system_domain || pop.sample_type || pop.time_period) return true;
  const qs = extracted.quoted_spans || {};
  for (const k of Object.keys(qs)) {
    if (Array.isArray(qs[k]) && qs[k].length > 0) return true;
  }
  return false;
}

function stringifyScalar(v) {
  if (v == null) return '""';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (/^[\s"'`{}\[\]&*!|>%@,#?]/.test(s) || /[:#]/.test(s) || /\n/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

export function serializeNoteMd(note) {
  const fm = note.frontmatter;
  const yamlBlock = serializeFrontmatter(fm);
  const bodyParts = [];
  for (const key of BODY_SECTIONS) {
    bodyParts.push(`## ${BODY_SECTION_HEADINGS[key]}\n\n${(note.body[key] || '').trim() || '_(not yet written)_'}`);
  }
  return `---\n${yamlBlock}\n---\n\n${bodyParts.join('\n\n')}\n`;
}

// ---- High-level API ----

async function loadTriageRows() {
  if (!await fileExists(DATA_FILES.candidates_triaged)) return [];
  const text = await readText(DATA_FILES.candidates_triaged, '');
  const { rows } = parseCsv(text);
  return rows;
}

function notePath(paperId) {
  return path.join(NOTES_DIR, `paper_${paperId}.md`);
}

function pdfPath(paperId) {
  return path.join(PDFS_DIR, `paper_${paperId}.pdf`);
}

export async function listEligible() {
  const rows = await loadTriageRows();
  // Read topic title once and reuse across every note we validate.
  const topicTitle = await readTopicTitle();
  const out = [];
  for (const row of rows) {
    if (!row.paper_id) continue;
    if (row.triage_label !== 'include' && row.triage_label !== 'maybe') continue;
    const hasPdf = await fileExists(pdfPath(row.paper_id));
    if (!hasPdf) continue; // can't deep-read without the PDF
    const exists = await fileExists(notePath(row.paper_id));
    let status = 'none';
    if (exists) {
      const md = await readText(notePath(row.paper_id), '');
      const note = parseNoteMd(md);
      // Same in-memory defaults getNote() uses, so the sidebar status
      // matches the form. Pulls enriched fields from the triage row so
      // a paper opened earlier (and enriched then) shows as valid here
      // without a re-fetch from OpenAlex per paper.
      applyInMemoryDefaults(note, row, topicTitle);
      const issues = validate(note);
      status = issues.length === 0 ? 'valid' : 'draft';
    }
    out.push({
      paper_id: row.paper_id,
      title: row.title,
      authors: row.authors,
      year: row.year,
      venue: row.venue,
      doi: row.doi,
      arxiv_id: row.arxiv_id,
      url: row.url,
      abstract: row.abstract,
      triage_label: row.triage_label,
      note_status: status,
    });
  }
  return out;
}

async function readContactEmail() {
  try {
    const md = await readText(PROTOCOL_FILES.topic, '');
    return parseTopic(md)?.contact_email || '';
  } catch {
    return '';
  }
}

async function readTopicTitle() {
  try {
    const md = await readText(PROTOCOL_FILES.topic, '');
    return parseTopic(md)?.title || '';
  } catch {
    return '';
  }
}

// Merge identification fields from the triage row into the note's
// frontmatter when the note's own field is empty. The triage row may
// have been enriched via OpenAlex on a prior `getNote()` open — pulling
// from it here means `listEligible()` sees the same validity as the
// form would, without re-running the network call per paper.
function mergeRowFieldsIntoNote(note, row) {
  if (!row) return;
  const fm = note.frontmatter;
  if (!String(fm.venue || '').trim() && row.venue) fm.venue = row.venue;
  if ((!Array.isArray(fm.authors) || fm.authors.length === 0) && row.authors) {
    fm.authors = parseAuthors(row.authors);
  }
  if (!(typeof fm.year === 'number' && fm.year > 0) && row.year) {
    fm.year = parseInt(row.year, 10) || 0;
  }
  if (!String(fm.arxiv_id || '').trim() && row.arxiv_id) fm.arxiv_id = row.arxiv_id;
  if (!String(fm.url || '').trim() && row.url) fm.url = row.url;
  if (!String(fm.doi || '').trim() && row.doi) fm.doi = row.doi;
  // arXiv preprints default to venue 'arXiv' once arxiv_id is present.
  if (!String(fm.venue || '').trim() && (fm.arxiv_id || /arxiv/i.test(String(row.source_database || '')))) {
    fm.venue = 'arXiv';
  }
}

// All the in-memory defaults that getNote and listEligible should both
// apply before running validate(). Keeps the form-validity and sidebar-
// status definitions identical.
function applyInMemoryDefaults(note, row, topicTitle) {
  mergeRowFieldsIntoNote(note, row);
  backfillDerivedDefaults(note, topicTitle);
}

// Backfill validation-blocking defaults that can be derived deterministically
// from what the note already carries. In-memory only — persistence happens
// when the student saves the form. Returns the same note for chaining.
function backfillDerivedDefaults(note, topicTitle) {
  const fm = note.frontmatter;
  // novelty_strength — derive from existing GT/baseline/UQ flags, or
  // default to 'unclear' (a valid enum) when signals are absent.
  const currentNovelty = String(fm.claims?.novelty_strength || '').toLowerCase();
  const validNovelty = ['strong', 'moderate', 'incremental', 'unclear'].includes(currentNovelty);
  if (!validNovelty) {
    if (!fm.claims) fm.claims = { primary_contribution: '', novelty_strength: '' };
    fm.claims.novelty_strength = deriveNovelty({
      external_ground_truth: fm.ground_truth?.external,
      self_constructed_ground_truth: fm.quality_flags?.self_constructed_ground_truth,
      baseline_compared: fm.evaluation?.baseline_compared,
      has_uncertainty_quantification: fm.evaluation?.has_uncertainty_quantification,
    });
  }
  // Relevance-to-thesis body — template from the already-stored
  // relevance bucket + must_cite when the body is empty. Match validate()'s
  // notion of "empty" (whitespace OR the "_(not yet written)_" placeholder
  // the serializer writes for never-drafted sections).
  const bodyText = (note.body?.relevance_to_the_thesis_topic || '').trim();
  const isEmptyBody = !bodyText || bodyText === '_(not yet written)_';
  if (isEmptyBody) {
    const body = relevanceBodyFromValues({
      relevance: fm.relevance?.relevance_to_topic,
      mustCite: fm.relevance?.must_cite,
      topicTitle,
    });
    if (body) {
      if (!note.body) note.body = {};
      note.body.relevance_to_the_thesis_topic = body;
    }
  }
  return note;
}

// Best-effort bibliographic enrichment for a row that's missing
// identification but has a DOI. Persists changes to candidates_triaged.csv
// so subsequent reads (and the CLI) see the canonical fields. Silent on
// any failure — the student can still fill the field manually.
async function maybeEnrichRow(row) {
  if (!row?.doi) return row;
  const needs = !String(row.venue || '').trim()
    || !String(row.authors || '').trim()
    || !String(row.year || '').trim();
  if (!needs) return row;
  const email = await readContactEmail();
  let data;
  try { data = await enrichByDoi(row.doi, email); } catch { data = null; }
  if (!data) return row;
  const patch = {};
  for (const k of ['venue', 'authors', 'year', 'arxiv_id', 'url', 'pdf_url']) {
    if (!String(row[k] || '').trim() && String(data[k] || '').trim()) {
      patch[k] = data[k];
    }
  }
  if (Object.keys(patch).length === 0) return row;
  try {
    const patched = await patchRowByPaperId(row.paper_id, patch);
    return patched || { ...row, ...patch };
  } catch {
    return { ...row, ...patch };
  }
}

export async function getNote(paperId) {
  const rows = await loadTriageRows();
  let row = rows.find((r) => r.paper_id === paperId);
  if (!row) throw new Error(`paper_id ${paperId} not found in triage`);
  const exists = await fileExists(notePath(paperId));
  if (!exists) {
    row = await maybeEnrichRow(row);
    const topicTitle = await readTopicTitle();
    const fresh = emptyNote(row);
    applyInMemoryDefaults(fresh, row, topicTitle);
    return {
      note: fresh,
      paper: row,
      exists: false,
      issues: [],
    };
  }
  const md = await readText(notePath(paperId), '');
  const note = parseNoteMd(md);
  // Enrich the triage row via OpenAlex when the note frontmatter is
  // missing identification fields and a DOI is available. This persists
  // to the triage CSV so listEligible (and the CLI) see the canonical
  // record without re-fetching.
  const fm = note.frontmatter;
  const fmNeeds = !String(fm.venue || '').trim()
    || !Array.isArray(fm.authors) || fm.authors.length === 0
    || !(typeof fm.year === 'number' && fm.year > 0);
  if (fmNeeds && fm.doi) {
    row = await maybeEnrichRow({ ...row, doi: fm.doi });
  }
  const topicTitle = await readTopicTitle();
  applyInMemoryDefaults(note, row, topicTitle);
  return {
    note,
    paper: row,
    exists: true,
    issues: validate(note),
  };
}

export async function saveNote(paperId, note) {
  const rows = await loadTriageRows();
  const row = rows.find((r) => r.paper_id === paperId);
  if (!row) throw new Error(`paper_id ${paperId} not found in triage`);
  // Force paper_id and pdf_path consistency
  note.frontmatter.paper_id = paperId;
  note.frontmatter.pdf_path = `data/pdfs/paper_${paperId}.pdf`;
  if (!note.frontmatter.read_date) note.frontmatter.read_date = new Date().toISOString().slice(0, 10);
  await ensureDir(NOTES_DIR);
  const md = serializeNoteMd(note);
  await fs.writeFile(notePath(paperId), md, 'utf8');
  return { issues: validate(note) };
}

export function validate(note) {
  const errors = [];
  const fm = note.frontmatter;
  // Identification — the v2 schema keeps the same identification
  // contract: every paper needs at least one stable identifier.
  const requiredScalars = ['paper_id', 'title', 'pdf_path', 'read_date'];
  for (const k of requiredScalars) {
    if (!fm[k] || String(fm[k]).trim() === '') errors.push(`empty: ${k}`);
  }
  const hasIdentifier = !!(String(fm.doi || '').trim()
    || String(fm.arxiv_id || '').trim()
    || String(fm.url || '').trim());
  if (!hasIdentifier) errors.push('empty: doi, arxiv_id, or url required');
  if (!Array.isArray(fm.authors) || fm.authors.length === 0) errors.push('empty: authors');
  if (typeof fm.year !== 'number' || fm.year < 1990 || fm.year > 2030) {
    errors.push(`year out of range: ${fm.year}`);
  }
  // Topic-defined enums (still meaningful; populated by topic_enums
  // extractor in v2).
  if (!Array.isArray(fm.category) || fm.category.length === 0) errors.push('empty: category');
  if (!fm.method?.family) errors.push('empty: method.family');
  // Relevance bucket stays — it's deterministically templated from
  // claim/topic cosine and still required for the catalogue / mode
  // renderers.
  if (!fm.relevance?.relevance_to_topic) errors.push('empty: relevance.relevance_to_topic');
  if (!['core', 'adjacent', 'peripheral'].includes(fm.relevance?.relevance_to_topic || '')) {
    errors.push('relevance.relevance_to_topic must be core/adjacent/peripheral');
  }

  // The v1 prose-drafter validation (novelty_strength enum, 400-word
  // body minimum, six "must-have body sections" check) is gone — those
  // were artefacts of the prose-drafting contract that no longer exists.
  // The v2 contract is: identification + topic enums + relevance bucket
  // + every populated extracted field carries provenance.

  // v2 schema: any populated field under `extracted` must carry a
  // `provenance` subtree with a `mechanism` field. Phase 1a doesn't yet
  // produce content here, so this check is dormant until the per-field
  // extractors ship in Phase 1b — but wiring it now means provenance is
  // enforced from day one, including for hand-edited YAML.
  const extracted = fm.extracted;
  if (extracted && typeof extracted === 'object') {
    errors.push(...validateExtractedProvenance(extracted));
  }
  return errors;
}

function hasProvenance(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj.provenance;
  return !!(p && typeof p === 'object' && typeof p.mechanism === 'string' && p.mechanism);
}

// Walk the `extracted:` subtree and flag any populated value missing
// provenance. Skips empty/null fields — only checks what's been claimed.
function validateExtractedProvenance(extracted) {
  const errors = [];
  // Scalar-with-provenance fields.
  const scalarKeys = [
    'methodology_type', 'sample_size',
    'claims_first_in_area', 'challenges_existing',
    'baseline_compared', 'releases_code', 'reports_uncertainty',
  ];
  for (const k of scalarKeys) {
    const v = extracted[k];
    if (v == null) continue;
    if (typeof v !== 'object' || !('value' in v)) {
      errors.push(`extracted.${k}: must be { value, provenance } when populated`);
    } else if (!hasProvenance(v)) {
      errors.push(`extracted.${k}: missing provenance`);
    }
  }
  // Array-of-records fields.
  const arrayKeys = ['tech_stack', 'datasets_used', 'frameworks_cited', 'results', 'claims'];
  for (const k of arrayKeys) {
    const arr = extracted[k];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    for (let i = 0; i < arr.length; i++) {
      if (!hasProvenance(arr[i])) {
        errors.push(`extracted.${k}[${i}]: missing provenance`);
      }
    }
  }
  // population.{language,geography} are arrays of { value, provenance }.
  const pop = extracted.population || {};
  for (const k of ['language', 'geography']) {
    const arr = pop[k];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    for (let i = 0; i < arr.length; i++) {
      if (!hasProvenance(arr[i])) {
        errors.push(`extracted.population.${k}[${i}]: missing provenance`);
      }
    }
  }
  // population scalars.
  for (const k of ['system_domain', 'sample_type', 'time_period']) {
    const v = pop[k];
    if (v == null) continue;
    if (typeof v !== 'object' || !('value' in v)) {
      errors.push(`extracted.population.${k}: must be { value, provenance } when populated`);
    } else if (!hasProvenance(v)) {
      errors.push(`extracted.population.${k}: missing provenance`);
    }
  }
  // quoted_spans: each populated span must carry provenance.
  const qs = extracted.quoted_spans || {};
  for (const section of Object.keys(qs)) {
    const arr = qs[section];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    for (let i = 0; i < arr.length; i++) {
      if (!hasProvenance(arr[i])) {
        errors.push(`extracted.quoted_spans.${section}[${i}]: missing provenance`);
      }
    }
  }
  return errors;
}

export function getPdfPath(paperId) {
  return pdfPath(paperId);
}
