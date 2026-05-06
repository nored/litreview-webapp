// Read every notes/paper_*.md and produce a compact aggregate. Stages 5-7
// operate on this aggregate, never on the raw notes corpus, so the LLM
// stays well under context budget and re-renders are fast.

import fs from 'node:fs/promises';
import path from 'node:path';
import { NOTES_DIR } from '../paths.mjs';
import { parseNoteMd } from './notes.mjs';

export async function aggregate() {
  let files;
  try {
    files = await fs.readdir(NOTES_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return emptyAggregate();
    throw err;
  }
  files = files.filter((f) => /^paper_\d+\.md$/.test(f)).sort();

  const byPaper = {};
  const byCategory = {};
  const byMethod = {};
  const matrix = {};       // key: `${cat}|${method}` -> [paper_id]
  const flagCounts = {
    self_constructed_ground_truth: 0,
    comparison_table_only: 0,
    hobby_project_scale: 0,
    predictable_outcome: 0,
  };
  const relDistribution = { core: 0, adjacent: 0, peripheral: 0, unknown: 0 };
  const noveltyDistribution = { strong: 0, moderate: 0, incremental: 0, unclear: 0, unknown: 0 };
  let mustCiteCount = 0;
  let externalGroundTruthCount = 0;
  const allCategories = new Set();
  const allMethods = new Set();

  for (const f of files) {
    const md = await fs.readFile(path.join(NOTES_DIR, f), 'utf8');
    const note = parseNoteMd(md);
    const fm = note.frontmatter;
    const id = fm.paper_id || f.match(/paper_(\d+)/)?.[1] || '';
    if (!id) continue;

    const categories = Array.isArray(fm.category) && fm.category.length ? fm.category : ['other'];
    const methodFamily = fm.method?.family || 'other';
    const novelty = fm.claims?.novelty_strength || 'unknown';
    const relevance = fm.relevance?.relevance_to_topic || 'unknown';

    const compact = {
      paper_id: id,
      title: fm.title || '',
      authors: Array.isArray(fm.authors) ? fm.authors : [],
      year: fm.year || 0,
      venue: fm.venue || '',
      doi: fm.doi || '',
      arxiv_id: fm.arxiv_id || '',
      url: fm.url || '',
      category: categories,
      method_family: methodFamily,
      method_specific: fm.method?.specific || '',
      ground_truth_source: fm.ground_truth?.source || '',
      ground_truth_external: !!fm.ground_truth?.external,
      ground_truth_case_count: fm.ground_truth?.case_count || 0,
      ground_truth_reproducible: !!fm.ground_truth?.reproducible,
      novelty_strength: novelty,
      relevance_to_topic: relevance,
      must_cite: !!fm.relevance?.must_cite,
      primary_contribution: fm.claims?.primary_contribution || '',
      quality_flags: { ...fm.quality_flags },
      // Body sections we'll feed to the LLM during synthesis
      gaps_opened: note.body.gaps_this_paper_opens || '',
      relevance_to_thesis_topic: note.body.relevance_to_the_thesis_topic || '',
    };
    byPaper[id] = compact;

    for (const cat of categories) {
      allCategories.add(cat);
      (byCategory[cat] ??= []).push(id);
      const key = `${cat}|${methodFamily}`;
      (matrix[key] ??= []).push(id);
    }
    allMethods.add(methodFamily);
    (byMethod[methodFamily] ??= []).push(id);

    for (const flag of Object.keys(flagCounts)) {
      if (compact.quality_flags?.[flag]) flagCounts[flag]++;
    }
    if (compact.must_cite) mustCiteCount++;
    if (compact.ground_truth_external) externalGroundTruthCount++;
    relDistribution[relevance] = (relDistribution[relevance] || 0) + 1;
    noveltyDistribution[novelty] = (noveltyDistribution[novelty] || 0) + 1;
  }

  return {
    count: Object.keys(byPaper).length,
    by_paper: byPaper,
    categories: [...allCategories].sort(),
    methods: [...allMethods].sort(),
    by_category: byCategory,
    by_method: byMethod,
    matrix,
    flag_counts: flagCounts,
    must_cite_count: mustCiteCount,
    external_ground_truth_count: externalGroundTruthCount,
    relevance_distribution: relDistribution,
    novelty_distribution: noveltyDistribution,
  };
}

function emptyAggregate() {
  return {
    count: 0,
    by_paper: {},
    categories: [],
    methods: [],
    by_category: {},
    by_method: {},
    matrix: {},
    flag_counts: { self_constructed_ground_truth: 0, comparison_table_only: 0, hobby_project_scale: 0, predictable_outcome: 0 },
    must_cite_count: 0,
    external_ground_truth_count: 0,
    relevance_distribution: { core: 0, adjacent: 0, peripheral: 0, unknown: 0 },
    novelty_distribution: { strong: 0, moderate: 0, incremental: 0, unclear: 0, unknown: 0 },
  };
}

// Compact view for the LLM: JUST the structured frontmatter fields plus the
// gaps_opened section, dropped to a token-efficient shape. ~1-2 KB per paper
// instead of the full ~3-5 KB note.
export function llmSummary(agg) {
  const papers = Object.values(agg.by_paper).map((p) => ({
    id: p.paper_id,
    yr: p.year,
    cat: p.category,
    method: p.method_family,
    spec: p.method_specific,
    nov: p.novelty_strength,
    rel: p.relevance_to_topic,
    gt_ext: p.ground_truth_external,
    gt_src: p.ground_truth_source,
    flags: Object.entries(p.quality_flags || {})
      .filter(([, v]) => v).map(([k]) => k),
    contrib: p.primary_contribution.slice(0, 200),
    gaps: (p.gaps_opened || '').slice(0, 600),
  }));
  return {
    count: agg.count,
    categories: agg.categories,
    methods: agg.methods,
    flag_counts: agg.flag_counts,
    relevance_distribution: agg.relevance_distribution,
    matrix_counts: Object.fromEntries(
      Object.entries(agg.matrix).map(([k, v]) => [k, v.length])
    ),
    papers,
  };
}
