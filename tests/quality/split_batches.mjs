#!/usr/bin/env node
// Split sample.txt into N parallel-subagent batches.
//
// `node tests/quality/split_batches.mjs [--num-batches=12]`
//
// Writes one file per batch at `tests/quality/batches/batch_NN.txt`.
// Hard cap: 15 paper_ids per batch (matches the litreview-template
// anti-context-fatigue rule). If --num-batches would exceed that, we
// bump the batch count.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(__dirname, 'sample.txt');
const OUT_DIR = path.join(__dirname, 'batches');

function parseArgs() {
  let num = 12;
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--num-batches=(\d+)$/);
    if (m) num = parseInt(m[1], 10);
  }
  return { num };
}

function main() {
  if (!fs.existsSync(SAMPLE_PATH)) {
    console.error(`sample.txt not found — run pick_sample.mjs first`);
    process.exit(1);
  }
  const ids = fs.readFileSync(SAMPLE_PATH, 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    console.error('sample.txt is empty');
    process.exit(1);
  }
  let { num } = parseArgs();
  // Hard cap: 15 papers per batch.
  const minBatches = Math.ceil(ids.length / 15);
  if (num < minBatches) {
    console.log(`bumping batches ${num} -> ${minBatches} (15-paper-per-subagent cap)`);
    num = minBatches;
  }
  if (num > ids.length) num = ids.length;

  // Clear stale batches.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (/^batch_\d+\.txt$/.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  // Round-robin so batches stay balanced.
  const batches = Array.from({ length: num }, () => []);
  ids.forEach((id, i) => batches[i % num].push(id));

  for (let i = 0; i < num; i += 1) {
    const fname = `batch_${String(i + 1).padStart(2, '0')}.txt`;
    fs.writeFileSync(path.join(OUT_DIR, fname), batches[i].join('\n') + '\n');
  }
  console.log(`wrote ${num} batches × up to ${Math.ceil(ids.length / num)} papers to ${path.relative(process.cwd(), OUT_DIR)}/`);
}

main();
