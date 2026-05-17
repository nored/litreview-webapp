#!/usr/bin/env node
// Pick the sample of papers to gold-label.
//
// Default: stratified one-per-paper_cluster + 3 outliers (highest
// distance-to-centroid across clusters). Override with --all to take
// every paper present in `papers` that also has a PDF on disk.
//
// Writes `tests/quality/sample.txt` — one paper_id per line.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../../server/lib/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PDF_DIR = path.join(ROOT, 'project', 'data', 'pdfs');
const OUT_PATH = path.join(__dirname, 'sample.txt');

function hasPdf(paperId) {
  return fs.existsSync(path.join(PDF_DIR, `paper_${paperId}.pdf`));
}

function pickStratified() {
  const clustered = store.query(
    `SELECT paper_cluster_id, paper_id FROM papers
       WHERE paper_cluster_id IS NOT NULL
       ORDER BY paper_cluster_id, paper_id`,
    [],
  );
  const byCluster = new Map();
  for (const row of clustered) {
    const cid = row.paper_cluster_id;
    if (!byCluster.has(cid)) byCluster.set(cid, []);
    byCluster.get(cid).push(row.paper_id);
  }
  const sample = new Set();
  // One representative per cluster.
  for (const ids of byCluster.values()) {
    const pick = ids.find(hasPdf);
    if (pick) sample.add(pick);
  }
  // Three outliers: papers that were embedded but not assigned to any
  // cluster (community_detection leaves singletons unassigned).
  const orphans = store.query(
    `SELECT paper_id FROM papers WHERE paper_cluster_id IS NULL ORDER BY paper_id`,
    [],
  );
  let added = 0;
  for (const row of orphans) {
    if (added >= 3) break;
    if (hasPdf(row.paper_id) && !sample.has(row.paper_id)) {
      sample.add(row.paper_id);
      added += 1;
    }
  }
  return [...sample].sort();
}

function pickAll() {
  const rows = store.query(
    `SELECT paper_id FROM papers ORDER BY paper_id`,
    [],
  );
  return rows.map((r) => r.paper_id).filter(hasPdf);
}

async function main() {
  const argv = process.argv.slice(2);
  const wantAll = argv.includes('--all');
  await store.init();
  const ids = wantAll ? pickAll() : pickStratified();
  fs.writeFileSync(OUT_PATH, ids.join('\n') + '\n');
  await store.close();
  console.log(`wrote ${ids.length} paper_ids to ${path.relative(ROOT, OUT_PATH)}`);
  if (!wantAll) {
    console.log('  (stratified by paper_cluster + 3 orphans; use --all to take every paper)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
