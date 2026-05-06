// Storage for stage 5-7 artifacts. JSON sidecar at data/_synthesis.json
// holds the structured data (gap candidates, indicator assessments). On
// every save we ALSO regenerate the canonical markdown files in
// synthesis/ so the CLI repo can read the same project.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, SYNTHESIS_DIR, SYNTHESIS_FILES } from '../paths.mjs';
import { ensureDir, readText } from '../storage.mjs';

const STATE_FILE = path.join(DATA_DIR, '_synthesis.json');

const INDICATOR_ORDER = [
  { id: 1, key: 'demonstrated_gap',         label: 'Demonstrated gap' },
  { id: 2, key: 'literature_volume',        label: 'Literature volume' },
  { id: 3, key: 'scientific_value',         label: 'Scientific value' },
  { id: 4, key: 'external_validation',      label: 'External validation' },
  { id: 5, key: 'falsifiability_reproducibility', label: 'Falsifiability and reproducibility' },
  { id: 6, key: 'methodology_fit',          label: 'Methodology fit' },
  { id: 7, key: 'hobby_project_test',       label: 'Hobby project test' },
];

export const INDICATORS = INDICATOR_ORDER;

export function emptyCandidate(idx = 1) {
  return {
    id: 'c' + Math.random().toString(36).slice(2, 9),
    title: `Gap candidate ${idx}`,
    statement: '',
    evidence: [],          // [{ paper_id, note }]
    research_question: '',
    external_validation_source: '',
    methodology_fit: '',
    hobby_project_test: '',
    indicators: Object.fromEntries(
      INDICATOR_ORDER.map((i) => [i.key, { verdict: '', justification: '' }])
    ),
    overall: '',           // 'accept' | 'refine' | 'reject' | ''
  };
}

export async function readState() {
  try {
    const text = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return { candidates: [], shortlist_id: null };
    throw err;
  }
}

export async function writeState(state) {
  await ensureDir(DATA_DIR);
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// Compute the overall verdict per the rubric: accept = all PASS,
// reject = any FAIL or 4+ PARTIAL, refine = otherwise (and at least one
// non-empty verdict so we don't auto-mark blank candidates).
export function computeOverall(candidate) {
  const verdicts = INDICATOR_ORDER.map((i) => candidate.indicators[i.key]?.verdict || '');
  const hasFail = verdicts.some((v) => v === 'FAIL');
  const partialCount = verdicts.filter((v) => v === 'PARTIAL').length;
  const passCount = verdicts.filter((v) => v === 'PASS').length;
  if (hasFail) return 'reject';
  if (partialCount >= 4) return 'reject';
  if (passCount === 7) return 'accept';
  if (passCount + partialCount >= 1) return 'refine';
  return '';
}

// ==== Markdown serializers (CLI compatibility) ====

export function serializeGapMatrix(agg) {
  const cats = agg.categories.length ? agg.categories : ['other'];
  const methods = agg.methods.length ? agg.methods : ['other'];
  const lines = [];
  lines.push('# Gap matrix\n');
  lines.push(`Built from ${agg.count} notes. Rows = topic categories. Columns = method families.\n`);
  lines.push('Each cell shows the count and the comma-separated paper IDs.\n');

  // Header
  lines.push('| | ' + methods.join(' | ') + ' | total |');
  lines.push('|' + ' --- |'.repeat(methods.length + 2));

  for (const cat of cats) {
    const row = [cat];
    let rowTotal = 0;
    for (const method of methods) {
      const ids = agg.matrix[`${cat}|${method}`] || [];
      rowTotal += ids.length;
      row.push(ids.length === 0 ? '—' : `${ids.length} (${ids.map((id) => `paper_${id}`).join(', ')})`);
    }
    row.push(String(rowTotal));
    lines.push('| ' + row.join(' | ') + ' |');
  }

  // Column totals
  const colTotals = methods.map((m) => (agg.by_method[m] || []).length);
  const grand = Object.values(agg.by_paper).length;
  lines.push('| **total** | ' + colTotals.join(' | ') + ` | ${grand} |`);

  // Quality-flag callout
  lines.push('\n## Methodological flags across the corpus\n');
  for (const [flag, count] of Object.entries(agg.flag_counts)) {
    lines.push(`- ${flag}: ${count} paper${count === 1 ? '' : 's'}`);
  }

  return lines.join('\n') + '\n';
}

export function serializeGapCandidates(state) {
  const lines = ['# Gap candidates\n'];
  if (!state.candidates?.length) {
    lines.push('_(none yet)_\n');
    return lines.join('\n');
  }
  state.candidates.forEach((c, i) => {
    lines.push(`### Gap candidate ${i + 1}. ${c.title || '(untitled)'}\n`);
    lines.push(`Statement. ${c.statement || ''}\n`);
    lines.push('Evidence.');
    for (const e of c.evidence || []) {
      lines.push(`- paper_${e.paper_id}: ${e.note || ''}`);
    }
    lines.push('');
    lines.push(`Research question. ${c.research_question || ''}\n`);
    lines.push(`External validation source. ${c.external_validation_source || ''}\n`);
    lines.push(`Methodology fit. ${c.methodology_fit || ''}\n`);
    lines.push(`Hobby project test. ${c.hobby_project_test || ''}\n`);
  });
  return lines.join('\n') + '\n';
}

export function serializeIndicatorAssessment(state) {
  const lines = ['# Indicator assessment\n'];
  if (!state.candidates?.length) {
    lines.push('_(no candidates yet)_\n');
    return lines.join('\n');
  }
  state.candidates.forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.title || '(untitled)'}\n`);
    lines.push('| Indicator | Verdict | Justification |');
    lines.push('| --- | --- | --- |');
    for (const ind of INDICATOR_ORDER) {
      const v = c.indicators[ind.key] || { verdict: '', justification: '' };
      lines.push(`| ${ind.id}. ${ind.label} | ${v.verdict || '—'} | ${(v.justification || '').replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
    lines.push(`**Overall**: ${c.overall || '_pending_'}\n`);
  });
  return lines.join('\n') + '\n';
}

export function serializeShortlist(state) {
  const accepted = state.candidates.filter((c) => c.overall === 'accept');
  const refinable = state.candidates.filter((c) => c.overall === 'refine');
  const rejected = state.candidates.filter((c) => c.overall === 'reject');
  const lines = ['# Shortlist\n'];
  if (accepted.length === 0 && refinable.length === 0 && rejected.length === 0) {
    lines.push('_(no assessments yet)_\n');
    return lines.join('\n');
  }
  if (accepted.length) {
    lines.push('## Accepted (all indicators PASS)\n');
    accepted.forEach((c, i) => lines.push(`${i + 1}. **${c.title}** — ${c.research_question || c.statement || ''}`));
    lines.push('');
  }
  if (refinable.length) {
    lines.push('## Refinable (no FAIL, at most 3 PARTIAL)\n');
    refinable.forEach((c, i) => lines.push(`${i + 1}. **${c.title}** — ${c.research_question || c.statement || ''}`));
    lines.push('');
  }
  if (rejected.length) {
    lines.push('## Rejected\n');
    rejected.forEach((c, i) => {
      const failed = INDICATOR_ORDER
        .filter((ind) => c.indicators[ind.key]?.verdict === 'FAIL')
        .map((ind) => ind.label)
        .join(', ');
      lines.push(`${i + 1}. ${c.title} — ${failed ? `FAIL on: ${failed}` : 'too many PARTIAL'}`);
    });
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

export async function persistMarkdown(state, agg) {
  await ensureDir(SYNTHESIS_DIR);
  await fs.writeFile(SYNTHESIS_FILES.gap_matrix, serializeGapMatrix(agg), 'utf8');
  await fs.writeFile(SYNTHESIS_FILES.gap_candidates, serializeGapCandidates(state), 'utf8');
  await fs.writeFile(SYNTHESIS_FILES.indicator_assessment, serializeIndicatorAssessment(state), 'utf8');
  await fs.writeFile(SYNTHESIS_FILES.shortlist, serializeShortlist(state), 'utf8');
}
