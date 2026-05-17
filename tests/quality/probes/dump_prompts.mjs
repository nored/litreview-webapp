#!/usr/bin/env node
// Dump every LLM request the pipeline would send for one paper.
// Writes one .txt file per request to tests/quality/probes/paper<id>/
// so each prompt is independently inspectable + replayable.
//
// IMPORTANT: this reads from the live SQLite store (project/data/store.sqlite)
// using the same logic as the extractors. It does NOT call the LLM.
//
// Usage:
//   node tests/quality/probes/dump_prompts.mjs            # paper 012
//   node tests/quality/probes/dump_prompts.mjs 014        # any id
//   PAPER_ID=034 node tests/quality/probes/dump_prompts.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from '../../../server/lib/store.mjs';
import { CLAIM_TYPES, buildPrompt, CLAIM_JSON_SCHEMA } from '../../../server/lib/extract_claims_v2.mjs';
import { NUMERICAL_PROMPT_HEADER, NUMERICAL_JSON_SCHEMA } from '../../../server/lib/extract_numerical_v2.mjs';
import { STANCE_PROMPT, BATCH_SIZE, buildStanceSchema, buildStanceSourceText } from '../../../server/lib/extract_stance_v2.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAPER_ID = process.env.PAPER_ID || process.argv[2] || '012';

const OUT = path.join(__dirname, `paper${PAPER_ID}`);
fs.mkdirSync(OUT, { recursive: true });

await store.init();

const manifest = [];

function writeRequest(name, user, schema) {
  const userPath = path.join(OUT, `${name}_user.txt`);
  const schemaPath = path.join(OUT, `${name}_schema.json`);
  fs.writeFileSync(userPath, user);
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  manifest.push({ name, user_file: path.relative(__dirname, userPath), schema_file: path.relative(__dirname, schemaPath), user_chars: user.length });
}

// ─────────────────────────────────────────────────────────────────────
// CLAIMS — one request per claim_type
// ─────────────────────────────────────────────────────────────────────
const allParagraphs = store.query(
  `SELECT paragraph_id, canonical_type, text, page_first, paragraph_idx
     FROM paragraphs WHERE paper_id = ? AND length(text) >= 80
    ORDER BY paragraph_idx`,
  [PAPER_ID],
);

const TRIM = 30_000;
for (const [claimType, cfg] of Object.entries(CLAIM_TYPES)) {
  const eligible = allParagraphs.filter((p) => cfg.sections.includes(p.canonical_type) || p.canonical_type === 'other');
  if (eligible.length === 0) {
    fs.writeFileSync(path.join(OUT, `claims_${claimType}_user.txt`), `# claim_type "${claimType}" has no eligible paragraphs in this paper.\n# Eligible sections: ${cfg.sections.join(', ')}\n`);
    manifest.push({ name: `claims_${claimType}`, skipped: 'no_eligible_paragraphs' });
    continue;
  }
  let totalChars = 0;
  const trimmed = [];
  for (const p of eligible) {
    if (totalChars + p.text.length > TRIM) break;
    trimmed.push(p);
    totalChars += p.text.length;
  }
  const prompt = buildPrompt(claimType, cfg, trimmed);
  writeRequest(`claims_${claimType}`, prompt, CLAIM_JSON_SCHEMA);
}

// ─────────────────────────────────────────────────────────────────────
// NUMERICAL — one request per doc_table + one per paragraph-bucket
// ─────────────────────────────────────────────────────────────────────
const tables = store.query(
  `SELECT doc_table_id, label, caption, page, cells_json FROM doc_tables WHERE paper_id = ? ORDER BY table_idx`,
  [PAPER_ID],
);
let numCallIdx = 0;
for (const t of tables) {
  const sourceText = [
    t.label ? `[${t.label}]` : '',
    t.caption || '',
    t.cells_json ? `\nTable cells (JSON): ${t.cells_json.slice(0, 4000)}` : '',
  ].join(' ').trim();
  if (sourceText.length < 30) continue;
  numCallIdx += 1;
  const user = NUMERICAL_PROMPT_HEADER + '\n\nSOURCE:\n' + sourceText;
  writeRequest(`numerical_${String(numCallIdx).padStart(2, '0')}_table_${t.doc_table_id.replace(/[^\w-]/g, '_')}`, user, NUMERICAL_JSON_SCHEMA);
}
// Paragraph buckets (results/discussion/abstract/experimental_setup).
const numParagraphs = store.query(
  `SELECT paragraph_id, text, page_first, canonical_type FROM paragraphs
    WHERE paper_id = ?
      AND canonical_type IN ('results', 'discussion', 'abstract', 'experimental_setup')
      AND length(text) >= 80
    ORDER BY paragraph_idx`,
  [PAPER_ID],
);
const BUDGET = 25_000;
let bucket = [], bucketChars = 0;
const buckets = [];
for (const p of numParagraphs) {
  if (bucketChars + p.text.length > BUDGET && bucket.length > 0) {
    buckets.push(bucket); bucket = []; bucketChars = 0;
  }
  bucket.push(p); bucketChars += p.text.length;
}
if (bucket.length) buckets.push(bucket);
for (const b of buckets) {
  numCallIdx += 1;
  const sourceText = b.map((p) => `<paragraph id="${p.paragraph_id}" page="${p.page_first ?? '?'}">\n${p.text}\n</paragraph>`).join('\n\n');
  const user = NUMERICAL_PROMPT_HEADER + '\n\nSOURCE PARAGRAPHS:\n' + sourceText;
  writeRequest(`numerical_${String(numCallIdx).padStart(2, '0')}_bucket`, user, NUMERICAL_JSON_SCHEMA);
}
if (numCallIdx === 0) {
  fs.writeFileSync(path.join(OUT, 'numerical_README.txt'), `# This paper has no tables and no paragraphs in results/discussion/abstract/experimental_setup\n# of >= 80 chars. Numerical extractor would not fire.\n`);
}

// ─────────────────────────────────────────────────────────────────────
// STANCE — one request per BATCH_SIZE batch of citation_markers
// ─────────────────────────────────────────────────────────────────────
const markers = store.query(
  `SELECT marker_id, context_text, surface_text FROM citation_markers
    WHERE paper_id = ? AND context_text IS NOT NULL AND length(context_text) >= 30
    ORDER BY marker_id`,
  [PAPER_ID],
);
let stanceBatchIdx = 0;
for (let i = 0; i < markers.length; i += BATCH_SIZE) {
  const batch = markers.slice(i, i + BATCH_SIZE);
  // Use the same source-text builder the live extractor uses so the
  // dumped prompts match exactly. Wraps each context's target
  // citation in << >> markers for disambiguation.
  const sourceText = buildStanceSourceText(batch);
  stanceBatchIdx += 1;
  const user = STANCE_PROMPT + '\n\nCONTEXTS:\n' + sourceText;
  // Schema's minItems / maxItems / "n" upper bound are all sized to
  // the actual batch length, matching what the live extractor uses
  // (extract_stance_v2.mjs calls buildStanceSchema(batch.length) per
  // call). Dumping the same schema for every batch broke the tail
  // batch when it had fewer than BATCH_SIZE contexts.
  writeRequest(`stance_batch_${String(stanceBatchIdx).padStart(2, '0')}`, user, buildStanceSchema(batch.length));
}
if (stanceBatchIdx === 0) {
  fs.writeFileSync(path.join(OUT, 'stance_README.txt'), `# This paper has no citation_markers with context_text of >= 30 chars.\n# Stance extractor would not fire.\n`);
}

// ─────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify({
  paper_id: PAPER_ID,
  generated_at: new Date().toISOString(),
  requests: manifest,
}, null, 2));

console.log(`paper ${PAPER_ID}: ${manifest.filter((r) => !r.skipped).length} requests written to ${path.relative(process.cwd(), OUT)}/`);
console.log(`  claims:    ${manifest.filter((r) => r.name?.startsWith('claims_') && !r.skipped).length} / ${Object.keys(CLAIM_TYPES).length} claim_types`);
console.log(`  numerical: ${manifest.filter((r) => r.name?.startsWith('numerical_')).length} requests`);
console.log(`  stance:    ${manifest.filter((r) => r.name?.startsWith('stance_')).length} batches`);
console.log(`\nReplay any single request:`);
console.log(`  bash tests/quality/probes/replay.sh paper${PAPER_ID}/<name>`);
console.log(`Replay all:`);
console.log(`  bash tests/quality/probes/replay_all.sh paper${PAPER_ID}`);
process.exit(0);
