// Stage 7 catalogue generation. Builds the data bundle the catalogue
// generator (in browser) feeds to the LLM, and serializes the deterministic
// pieces (references list, mermaid diagram for the matrix) so the LLM only
// writes prose.

import fs from 'node:fs/promises';
import path from 'node:path';
import { SYNTHESIS_DIR } from '../paths.mjs';
import { ensureDir, readText } from '../storage.mjs';

const CATALOGUE_FILE_NAME = 'catalogue.md';
export const CATALOGUE_PATH = path.join(SYNTHESIS_DIR, CATALOGUE_FILE_NAME);

// Build the master prompt + data bundle the generator works from. The
// bundle is JSON-serializable so it can be (a) sent to the configured
// provider in pieces, (b) shipped as part of a ZIP export to be pasted
// into Claude.ai or ChatGPT directly.
export function buildBundle({ topic, agg, synthState, prismaNumbers }) {
  const eligible = (synthState.candidates || []).filter(
    (c) => c.overall === 'accept' || c.overall === 'refine',
  );
  const papers = Object.values(agg.by_paper).map((p) => ({
    id: p.paper_id,
    citation: shortAuthorYear(p),
    title: p.title,
    year: p.year,
    venue: p.venue,
    doi: p.doi,
    arxiv_id: p.arxiv_id,
    url: p.url,
    category: p.category,
    method_family: p.method_family,
    method_specific: p.method_specific,
    novelty: p.novelty_strength,
    relevance: p.relevance_to_topic,
    must_cite: p.must_cite,
    ground_truth: {
      source: p.ground_truth_source,
      external: p.ground_truth_external,
      case_count: p.ground_truth_case_count,
      reproducible: p.ground_truth_reproducible,
    },
    quality_flags: p.quality_flags,
    primary_contribution: p.primary_contribution,
    gaps_opened: p.gaps_opened,
  }));
  return {
    topic,
    corpus_summary: {
      total_papers: agg.count,
      categories: agg.categories,
      methods: agg.methods,
      matrix_counts: Object.fromEntries(
        Object.entries(agg.matrix).map(([k, v]) => [k, v.length])
      ),
      flag_counts: agg.flag_counts,
      relevance_distribution: agg.relevance_distribution,
      novelty_distribution: agg.novelty_distribution,
      must_cite_count: agg.must_cite_count,
      external_ground_truth_count: agg.external_ground_truth_count,
    },
    prisma: prismaNumbers,
    papers,
    candidates: eligible.map((c) => ({
      title: c.title,
      statement: c.statement,
      research_question: c.research_question,
      external_validation_source: c.external_validation_source,
      methodology_fit: c.methodology_fit,
      hobby_project_test: c.hobby_project_test,
      evidence: c.evidence,
      indicators: c.indicators,
      overall: c.overall,
    })),
  };
}

// Deterministic references list built from note frontmatter, sorted
// numerically by paper_id. Output matches the catalogue PDF's references
// shape: [NNN] author, title, venue, year, DOI/URL.
export function serializeReferences(papers) {
  const sorted = papers.slice().sort((a, b) => Number(a.id) - Number(b.id));
  const lines = ['## References', ''];
  for (const p of sorted) {
    const authors = Array.isArray(p.authors) ? p.authors.join(', ') : (p.authors || '');
    const venue = p.venue ? `${p.venue}` : '';
    const year = p.year ? `${p.year}` : 'n.d.';
    const link = p.doi ? `https://doi.org/${p.doi}` : (p.arxiv_id ? `https://arxiv.org/abs/${p.arxiv_id}` : (p.url || ''));
    const ref = [
      `[paper_${p.id}]`,
      authors || '(unknown authors)',
      `*${p.title || '(untitled)'}*.`,
      venue,
      year,
      link ? `<${link}>` : '',
    ].filter(Boolean).join(' ');
    lines.push(`- ${ref}`);
  }
  return lines.join('\n') + '\n';
}

export async function persistCatalogue(md) {
  await ensureDir(SYNTHESIS_DIR);
  await fs.writeFile(CATALOGUE_PATH, md, 'utf8');
}

export async function readCatalogue() {
  return readText(CATALOGUE_PATH, '');
}

function shortAuthorYear(p) {
  const authors = Array.isArray(p.authors) ? p.authors : [];
  const first = authors[0] || '';
  const lastname = (first.match(/(\S+)\s*$/) || [, first])[1] || first;
  const ext = authors.length > 1 ? ' et al.' : '';
  const year = p.year ? ` (${p.year})` : '';
  return `${lastname}${ext}${year}`;
}

// The system prompt establishes the academic tone observed in the target
// PDF. Used by every chapter LLM call.
export const SYSTEM_PROMPT = `You are an academic writer drafting a thesis-topic catalogue chapter. The voice is confident, declarative, and faithful to the supplied evidence. Cite papers as [paper_NNN] inline. Use plain consecutive sentences. No bullet lists in body paragraphs. No markdown headings except those explicitly requested. Quantify everything you can. Name specific papers, methods, and datasets. Avoid AI voice patterns like "this paper", "in conclusion", "it is worth noting".`;
