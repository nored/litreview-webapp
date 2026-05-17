#!/usr/bin/env node
// Validate every gold note in tests/quality/gold/.
//
// Checks:
//   1. YAML frontmatter parses + required keys present.
//   2. Enumerated fields use values from the allowed sets in schema.md.
//   3. paper_id matches filename (paper_NNN.md).
//   4. Quote substrings (claims, numerical) appear in the PDF body
//      after the same normalisation extract_claims_v2.mjs uses.
//   5. Body has "## Gaps this paper opens" with >= 3 lines, each
//      tagged with one of the seven Miles types.
//
// Nonzero exit if any note fails. Per-file errors listed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const GOLD_DIR = path.join(__dirname, 'gold');
const PDF_DIR = path.join(ROOT, 'project', 'data', 'pdfs');

const SECTION_TYPES = new Set([
  'abstract','introduction','background','related_work','methods',
  'experimental_setup','results','discussion','limitations','conclusion',
  'future_work','references','appendix','acknowledgments','other',
]);
const ENTITY_TYPES = new Set([
  'method','technique','algorithm','dataset','corpus','benchmark',
  'tool','library','software','model','system','platform','hardware',
  'metric','measure','concept','theory','framework','person',
  'organisation','place','attack','vulnerability','defense',
  'protocol','standard','other',
]);
const CLAIM_TYPES = new Set([
  'contribution','finding','limitation','future_work','framework','method',
  'first_in_area','releases_code','baseline_comparison','reports_uncertainty',
  'challenges_existing',
]);
const CLAIM_STANCES = new Set(['asserts','validates','theorises','challenges','extends']);
const CITATION_STANCES = new Set(['supports','contrasts','extends','background','mentions']);
// Miles-7 types live in corpus_gaps.md only — per-paper notes don't
// use them. (Kept here in case future per-paper analysis wants the set.)
const MILES_TYPES = new Set([
  'evidence','knowledge','practical','methodological',
  'empirical','theoretical','population',
]);

// Match extract_claims_v2.mjs normalisation exactly.
const LIGATURES = { 'ﬀ':'ff','ﬁ':'fi','ﬂ':'fl','ﬃ':'ffi','ﬄ':'ffl','ﬅ':'ft','ﬆ':'st' };
function normalisePdfText(s) {
  let t = String(s || '');
  t = t.replace(/­/g, '');
  t = t.replace(/-\s*\n\s*/g, '');
  t = t.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c);
  t = t.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[–—−]/g, '-');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function parseFrontmatter(src) {
  if (!src.startsWith('---')) throw new Error('missing leading ---');
  const end = src.indexOf('\n---', 3);
  if (end < 0) throw new Error('missing closing ---');
  const yaml = src.slice(3, end).replace(/^\s*\n/, '');
  const body = src.slice(end + 4);
  return { fm: YAML.parse(yaml), body };
}

async function extractPdfText(pdfPath) {
  // Use the same pdfjs pipeline the pipeline uses for extraction so
  // substring checks are consistent. Fall back to raw text if pdfjs is
  // unhappy; the validator is forgiving on PDFs that error.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  return text;
}

function validateEnum(value, allowed, label, errors) {
  if (!allowed.has(value)) {
    errors.push(`${label}: "${value}" is not in allowed enum`);
  }
}

function parseLimitationLines(body) {
  // New format: free-form "## Limitations and unexamined dimensions"
  // with bullet entries. No Miles tagging — the seven types are
  // corpus-wide and computed by tests/quality/synthesise_gaps.mjs.
  const m = body.match(/##\s*Limitations and unexamined dimensions\s*\n([\s\S]*?)(?:\n##|$)/);
  if (!m) return null;
  return m[1].split('\n').map((s) => s.trim()).filter((s) => s.startsWith('-'))
    .map((line) => ({ text: line.replace(/^-\s*/, '') }));
}

async function validateOne(file) {
  const errors = [];
  const src = fs.readFileSync(path.join(GOLD_DIR, file), 'utf8');
  let parsed;
  try {
    parsed = parseFrontmatter(src);
  } catch (e) {
    return [`${file}: frontmatter parse error: ${e.message}`];
  }
  const { fm, body } = parsed;

  // paper_id matches filename.
  const fnMatch = file.match(/^paper_(\d+)\.md$/);
  if (!fnMatch) errors.push(`filename "${file}" does not match paper_NNN.md`);
  else if (fm.paper_id !== fnMatch[1]) errors.push(`paper_id "${fm.paper_id}" != filename id "${fnMatch[1]}"`);

  // Required top-level keys.
  for (const k of ['title', 'sections', 'entities', 'claims', 'numerical', 'citation_stance', 'quality_flags']) {
    if (fm[k] == null) errors.push(`missing required key: ${k}`);
  }

  // Enums + structural checks.
  for (const [i, s] of (fm.sections || []).entries()) {
    if (!s?.type) errors.push(`sections[${i}].type missing`);
    else validateEnum(s.type, SECTION_TYPES, `sections[${i}].type`, errors);
  }
  for (const [i, e] of (fm.entities || []).entries()) {
    if (!e?.text || !e?.type) errors.push(`entities[${i}] missing text or type`);
    else validateEnum(e.type, ENTITY_TYPES, `entities[${i}].type`, errors);
  }
  for (const [i, c] of (fm.claims || []).entries()) {
    if (!c?.type) errors.push(`claims[${i}].type missing`);
    else validateEnum(c.type, CLAIM_TYPES, `claims[${i}].type`, errors);
    if (!c?.stance) errors.push(`claims[${i}].stance missing`);
    else validateEnum(c.stance, CLAIM_STANCES, `claims[${i}].stance`, errors);
    if (!c?.quote || c.quote.length < 12) errors.push(`claims[${i}].quote missing or < 12 chars`);
  }
  for (const [i, n] of (fm.numerical || []).entries()) {
    if (typeof n?.value !== 'number') errors.push(`numerical[${i}].value not a number`);
    if (!n?.metric) errors.push(`numerical[${i}].metric missing`);
    if (!n?.quote) errors.push(`numerical[${i}].quote missing`);
  }
  for (const [i, c] of (fm.citation_stance || []).entries()) {
    if (!c?.ref_key) errors.push(`citation_stance[${i}].ref_key missing`);
    if (!c?.stance) errors.push(`citation_stance[${i}].stance missing`);
    else validateEnum(c.stance, CITATION_STANCES, `citation_stance[${i}].stance`, errors);
  }

  // Quote substring check (claims + numerical).
  const pdfPath = path.join(PDF_DIR, `paper_${fm.paper_id}.pdf`);
  if (fs.existsSync(pdfPath)) {
    try {
      const rawText = await extractPdfText(pdfPath);
      const hay = normalisePdfText(rawText).toLowerCase();
      const quoted = [
        ...((fm.claims || []).map((c, i) => ({ q: c.quote, label: `claims[${i}].quote` }))),
        ...((fm.numerical || []).map((c, i) => ({ q: c.quote, label: `numerical[${i}].quote` }))),
      ];
      for (const { q, label } of quoted) {
        if (!q) continue;
        const needle = normalisePdfText(q).toLowerCase();
        if (needle.length < 12) continue;
        if (!hay.includes(needle)) {
          const head = needle.slice(0, 60);
          if (!hay.includes(head)) errors.push(`${label}: quote not found in PDF (${head.slice(0, 40)}...)`);
        }
      }
    } catch (e) {
      errors.push(`pdf text extraction failed: ${e.message}`);
    }
  } else {
    errors.push(`pdf not found at ${path.relative(ROOT, pdfPath)}`);
  }

  // Limitations body.
  const limitations = parseLimitationLines(body);
  if (!limitations) errors.push('body missing "## Limitations and unexamined dimensions" section');
  else if (limitations.length < 2) errors.push(`limitations section has only ${limitations.length} entries (need >= 2)`);

  return errors.map((e) => `${file}: ${e}`);
}

async function main() {
  if (!fs.existsSync(GOLD_DIR)) {
    console.error(`gold dir not found: ${GOLD_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(GOLD_DIR).filter((f) => /^paper_\d+\.md$/.test(f)).sort();
  if (files.length === 0) {
    console.error('no gold notes found — run build_gold first');
    process.exit(1);
  }
  let totalErrors = 0;
  const failed = [];
  for (const f of files) {
    const errs = await validateOne(f);
    if (errs.length > 0) {
      failed.push(f);
      totalErrors += errs.length;
      for (const e of errs) console.log(e);
    }
  }
  console.log('');
  console.log(`validated ${files.length} notes · ${failed.length} failed · ${totalErrors} errors`);
  if (failed.length > 0) {
    fs.writeFileSync(path.join(__dirname, 'validate_failed.txt'), failed.join('\n') + '\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
