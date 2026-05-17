#!/usr/bin/env node
// Trigger the pipeline's Phase 4 detector against the current SQLite
// store and persist the result so the comparator can read it.
//
// Idiomatic alternative to running the server and POSTing to
// /api/v2/detect-phase4. Both paths produce the same JSON.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../../server/lib/store.mjs';
import { detectAllPhase4 } from '../../server/lib/detect_phase4.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', '..', 'project', 'data', '_phase4_last.json');

async function main() {
  await store.init();
  const r = await detectAllPhase4({});
  fs.writeFileSync(OUT, JSON.stringify(r, null, 2));
  await store.close();
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`elapsed=${r.elapsed_ms}ms total=${r.summary.total}`);
  for (const [t, n] of Object.entries(r.summary.per_type)) console.log(`  ${t.padEnd(15)} ${n}`);
  if (r.preconditions?.length) {
    console.log('\npreconditions:');
    for (const p of r.preconditions) console.log(`  - ${p}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
