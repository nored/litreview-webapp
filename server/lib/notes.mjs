// Stage 4 deep-read notes. Storage = notes/paper_NNN.md in the canonical
// schema format (CLI-compatible). Form data round-trips with the file.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { NOTES_DIR, DATA_FILES, PROTOCOL_FILES, PDFS_DIR } from '../paths.mjs';
import { ensureDir, readText, fileExists } from '../storage.mjs';
import { parseCsv } from './csv.mjs';

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

export function emptyNote(paperRow = {}) {
  return {
    frontmatter: {
      paper_id: paperRow.paper_id || '',
      title: paperRow.title || '',
      authors: parseAuthors(paperRow.authors),
      year: parseInt(paperRow.year, 10) || 0,
      venue: paperRow.venue || '',
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
    },
    body: Object.fromEntries(BODY_SECTIONS.map((s) => [s, ''])),
  };
}

function parseAuthors(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s;
  return String(s).split(/,\s*/).map((x) => x.trim()).filter(Boolean);
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
  return lines.join('\n');
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

export async function getNote(paperId) {
  const rows = await loadTriageRows();
  const row = rows.find((r) => r.paper_id === paperId);
  if (!row) throw new Error(`paper_id ${paperId} not found in triage`);
  const exists = await fileExists(notePath(paperId));
  if (!exists) {
    return {
      note: emptyNote(row),
      paper: row,
      exists: false,
      issues: [],
    };
  }
  const md = await readText(notePath(paperId), '');
  const note = parseNoteMd(md);
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
  const requiredScalars = ['paper_id', 'title', 'venue', 'pdf_path', 'read_date'];
  for (const k of requiredScalars) {
    if (!fm[k] || String(fm[k]).trim() === '') errors.push(`empty: ${k}`);
  }
  if (!Array.isArray(fm.authors) || fm.authors.length === 0) errors.push('empty: authors');
  if (typeof fm.year !== 'number' || fm.year < 1990 || fm.year > 2030) {
    errors.push(`year out of range: ${fm.year}`);
  }
  if (!Array.isArray(fm.category) || fm.category.length === 0) errors.push('empty: category');
  if (!fm.method?.family) errors.push('empty: method.family');
  if (!fm.claims?.novelty_strength) errors.push('empty: claims.novelty_strength');
  if (!['strong', 'moderate', 'incremental', 'unclear'].includes(fm.claims?.novelty_strength || '')) {
    errors.push('claims.novelty_strength must be strong/moderate/incremental/unclear');
  }
  if (!fm.relevance?.relevance_to_topic) errors.push('empty: relevance.relevance_to_topic');
  if (!['core', 'adjacent', 'peripheral'].includes(fm.relevance?.relevance_to_topic || '')) {
    errors.push('relevance.relevance_to_topic must be core/adjacent/peripheral');
  }
  // Body checks
  for (const key of BODY_SECTIONS) {
    const text = (note.body[key] || '').trim();
    if (!text || text === '_(not yet written)_') errors.push(`empty body: ${BODY_SECTION_HEADINGS[key]}`);
  }
  // Word count window for the body
  const bodyWords = BODY_SECTIONS.reduce((n, k) => n + (note.body[k] || '').split(/\s+/).filter(Boolean).length, 0);
  if (bodyWords < 400) errors.push(`body too short: ${bodyWords} words (min 400)`);
  if (bodyWords > 1500) errors.push(`body too long: ${bodyWords} words (max 1500)`);
  return errors;
}

export function getPdfPath(paperId) {
  return pdfPath(paperId);
}
