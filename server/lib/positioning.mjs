// Stage 7 positioning helpers. PRISMA numbers are fully derived from on-disk
// logs and CSVs; the LLM only writes prose. Competitors for the positioning
// statement come from the accepted candidate's evidence list, padded by
// matrix neighbors if fewer than five.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_FILES, NOTES_DIR, SYNTHESIS_FILES } from '../paths.mjs';
import { ensureDir, readText, fileExists } from '../storage.mjs';
import { parseCsv } from './csv.mjs';

export async function computePrismaNumbers() {
  // 1. Records identified through searching
  let recordsIdentified = 0;
  let queriesRun = 0;
  if (await fileExists(DATA_FILES.search_log)) {
    const text = await readText(DATA_FILES.search_log, '');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        recordsIdentified += Number(obj.result_count) || 0;
        queriesRun++;
      } catch { /* skip malformed lines */ }
    }
  }

  // 2. After dedup (= rows in candidates_raw.csv)
  let afterDedup = 0;
  let manualAdditions = 0;
  if (await fileExists(DATA_FILES.candidates_raw)) {
    const { rows } = parseCsv(await readText(DATA_FILES.candidates_raw, ''));
    afterDedup = rows.length;
    manualAdditions = rows.filter((r) => r.source_database === 'manual_addition').length;
  }

  // 3. Triage outcome
  let included = 0, excluded = 0, maybeCount = 0;
  const exclusionReasons = {};
  if (await fileExists(DATA_FILES.candidates_triaged)) {
    const { rows } = parseCsv(await readText(DATA_FILES.candidates_triaged, ''));
    for (const r of rows) {
      const lab = r.triage_label || '';
      if (lab === 'include') included++;
      else if (lab === 'maybe') maybeCount++;
      else if (lab === 'exclude') {
        excluded++;
        const head = (r.triage_reason || 'unspecified')
          .split(/[.,;]/, 1)[0].trim().toLowerCase().slice(0, 80);
        exclusionReasons[head || 'unspecified'] = (exclusionReasons[head || 'unspecified'] || 0) + 1;
      }
    }
  }

  // 4. Download outcomes
  let downloaded = 0;
  let downloadFailed = 0;
  if (await fileExists(DATA_FILES.download_log)) {
    const { rows } = parseCsv(await readText(DATA_FILES.download_log, ''));
    for (const r of rows) {
      const s = r.status || '';
      if (s === 'success' || s === 'already_present' || s === 'manual_upload') downloaded++;
      else if (s === 'failed') downloadFailed++;
    }
  }

  // 5. Notes written = papers that have substantive structured
  // extraction. "Substantive" means ≥3 distinct field types beyond just
  // category / method_family (topic_enums alone is too weak to count as
  // synthesised). On fresh projects without v2 data, fall back to the
  // legacy markdown notes count.
  let notesWritten = 0;
  try {
    const store = await import('./store.mjs');
    await store.init();
    // For each eligible paper, count distinct paper_field.field_name
    // (excluding topic_enums) plus presence of named-entity / results
    // / claims rows. Count the paper as synthesised if ≥3 dimensions.
    const r = store.query(
      `SELECT p.paper_id,
              (SELECT COUNT(DISTINCT field_name) FROM paper_field
                WHERE paper_id = p.paper_id
                  AND field_name NOT IN ('category', 'method_family')) AS field_count,
              (SELECT COUNT(DISTINCT kind) FROM name_usage WHERE paper_id = p.paper_id) AS name_kinds,
              (SELECT COUNT(*) FROM results WHERE paper_id = p.paper_id) AS results_count,
              (SELECT COUNT(*) FROM claims  WHERE paper_id = p.paper_id) AS claims_count
         FROM papers p
        WHERE p.triage_label IN ('include','maybe')`,
    );
    for (const row of r) {
      const dimensions = (row.field_count > 0 ? 1 : 0)
        + (row.name_kinds   > 0 ? 1 : 0)
        + (row.results_count > 0 ? 1 : 0)
        + (row.claims_count  > 0 ? 1 : 0);
      // Two of {paper_field rows beyond topic enums, named entities,
      // results, claims} are enough — pragmatic threshold for "we got
      // something real out of this paper".
      if (dimensions >= 2 || row.field_count >= 3) notesWritten++;
    }
  } catch { /* store unavailable; fall back below */ }
  if (notesWritten === 0) {
    try {
      const files = await fs.readdir(NOTES_DIR);
      notesWritten = files.filter((f) => /^paper_\d+\.md$/.test(f)).length;
    } catch { /* dir missing */ }
  }

  // Top exclusion reasons by count, capped at 5
  const topExclusionReasons = Object.entries(exclusionReasons)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  // Studies included in qualitative synthesis: papers with notes that
  // contributed to the gap matrix. Same as notesWritten in practice
  // (the matrix uses every note's category/method fields).
  return {
    queries_run: queriesRun,
    records_identified: recordsIdentified,
    after_dedup: afterDedup,
    manual_additions: manualAdditions,
    screened: afterDedup,            // identical by definition (we don't pre-screen)
    excluded_at_screening: excluded,
    full_text_assessed: included + maybeCount,
    full_text_retrieved: downloaded,
    full_text_unavailable: downloadFailed,
    notes_written: notesWritten,
    studies_in_synthesis: notesWritten,
    top_exclusion_reasons: topExclusionReasons,
  };
}

export function mermaidPrisma(n) {
  return `flowchart TD
  A["Identification<br/>${n.records_identified} records identified through ${n.queries_run} database queries"]
  B["After deduplication<br/>${n.after_dedup} records<br/>(+${n.manual_additions} manual additions)"]
  C["Screening<br/>${n.screened} records screened"]
  D["Excluded at title/abstract<br/>${n.excluded_at_screening} records"]
  E["Eligibility<br/>${n.full_text_assessed} full-text articles assessed"]
  F["Full-text unavailable<br/>${n.full_text_unavailable} records"]
  G["Included in qualitative synthesis<br/>${n.studies_in_synthesis} studies"]
  A --> B --> C
  C --> D
  C --> E
  E --> F
  E --> G`;
}

export function methodologyParagraphTemplate(n) {
  return `Literature was identified through ${n.queries_run} database queries across arXiv, OpenAlex, and Semantic Scholar, returning ${n.records_identified} records. After deduplication on DOI and title similarity, ${n.after_dedup} unique records remained, augmented by ${n.manual_additions} manual additions for known historical anchors. Title and abstract screening against pre-registered inclusion and exclusion criteria excluded ${n.excluded_at_screening} records, leaving ${n.full_text_assessed} for full-text assessment. ${n.full_text_unavailable} could not be retrieved automatically and were recorded for manual retrieval. ${n.notes_written} papers were read in full and structured notes were extracted into a uniform schema. The notes formed the basis of the gap matrix and the indicator assessment.`;
}

export async function findCompetitors(candidate, agg, n = 5) {
  // Start with the candidate's own evidence papers
  const evidence = (candidate?.evidence || []).map((e) => String(e.paper_id || '').replace(/^paper_/, ''));
  const seen = new Set();
  const competitors = [];

  function add(paperId) {
    const id = String(paperId || '').replace(/^paper_/, '');
    if (!id || seen.has(id)) return;
    const paper = agg.by_paper[id];
    if (!paper) return;
    seen.add(id);
    competitors.push(paper);
  }

  for (const id of evidence) add(id);

  // Pad from same-category cells (any method) until we hit n
  if (competitors.length < n) {
    const categories = new Set();
    for (const p of competitors) for (const c of p.category || []) categories.add(c);
    for (const cat of categories) {
      for (const id of (agg.by_category[cat] || [])) {
        if (competitors.length >= n) break;
        add(id);
      }
      if (competitors.length >= n) break;
    }
  }

  // Pad with must-cite + core papers
  if (competitors.length < n) {
    const ranked = Object.values(agg.by_paper)
      .filter((p) => p.must_cite || p.relevance_to_topic === 'core')
      .sort((a, b) => Number(b.must_cite) - Number(a.must_cite));
    for (const p of ranked) {
      if (competitors.length >= n) break;
      add(p.paper_id);
    }
  }
  return competitors.slice(0, n);
}

export function serializePrisma(numbers) {
  const lines = [];
  lines.push('# PRISMA flow\n');
  lines.push('Numbers derived from search log and CSVs. Drop into the thesis methodology section.\n');
  lines.push('## Numbers\n');
  lines.push(`- Records identified through database searching: ${numbers.records_identified} (${numbers.queries_run} queries × 3 sources)`);
  lines.push(`- After deduplication: ${numbers.after_dedup}`);
  lines.push(`- Manual additions: ${numbers.manual_additions}`);
  lines.push(`- Records screened: ${numbers.screened}`);
  lines.push(`- Excluded at title/abstract: ${numbers.excluded_at_screening}`);
  lines.push(`- Full-text assessed for eligibility: ${numbers.full_text_assessed}`);
  lines.push(`- Full-text unavailable: ${numbers.full_text_unavailable}`);
  lines.push(`- Studies included in qualitative synthesis: ${numbers.studies_in_synthesis}\n`);
  lines.push('## Top exclusion reasons\n');
  for (const r of numbers.top_exclusion_reasons || []) {
    lines.push(`- ${r.count}: ${r.reason}`);
  }
  lines.push('\n## Mermaid diagram\n');
  lines.push('```mermaid');
  lines.push(mermaidPrisma(numbers));
  lines.push('```\n');
  return lines.join('\n') + '\n';
}

export function withMethodology(prismaMd, methodologyMd) {
  if (!methodologyMd) return prismaMd;
  return prismaMd + `\n## Methodology paragraph (drop into thesis)\n\n${methodologyMd.trim()}\n`;
}

export async function persistPositioning({ statementMd, prismaMd }) {
  await ensureDir(path.dirname(SYNTHESIS_FILES.positioning_statement));
  if (statementMd != null) {
    await fs.writeFile(SYNTHESIS_FILES.positioning_statement, statementMd, 'utf8');
  }
  if (prismaMd != null) {
    await fs.writeFile(SYNTHESIS_FILES.prisma_flow, prismaMd, 'utf8');
  }
}
