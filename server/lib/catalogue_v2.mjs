// catalogue_v2.mjs
//
// v2-native catalogue. The legacy catalogue (`catalogue.mjs` +
// `catalogue_grounded.mjs`) generates prose chapters via LLM over note
// frontmatter + retrieved note text. The result is a paraphrased
// chapter that the user must then audit for fidelity.
//
// The v2 catalogue does no LLM generation. It aggregates the structured
// store directly: verbatim quoted_spans grouped by category × body
// section, plus claims grouped by type, plus paper rosters per category.
// Every entry is a quote with page + paper_id provenance. The "LLM as
// finder, never writer" rule applies recursively: the catalogue is a
// view over what's already grounded, not a fresh prose pass.
//
// Output shape (one chapter per topic category from topic.md, ordered
// by include-count desc):
//
//   {
//     generated_at: ISO date,
//     chapters: [
//       {
//         category, paper_count, papers: [{paper_id, title, year, authors}],
//         sections: {
//           problem_statement: [{paper_id, page, text}, ...],
//           method_summary: [...],
//           ground_truth_and_evaluation: [...],
//           stated_limitations: [...],
//           gaps_this_paper_opens: [...],
//         },
//         claims_by_type: {
//           contribution: [{paper_id, page, text, stance}],
//           limitation: [...],
//           finding: [...],
//           future_work: [...],
//         },
//       },
//     ],
//     uncategorised_papers: [...],  // papers with no category match
//   }
//
// Caller (UI) renders this however it wants. Markdown export is a
// separate function.

import * as store from './store.mjs';
import * as embedder from './embedder.mjs';
import { cosSim } from './sbert_utils.mjs';
import { readText } from '../storage.mjs';
import { PROTOCOL_FILES } from '../paths.mjs';
import { parseTopic } from './topic_md.mjs';

const SECTION_ORDER = [
  'problem_statement',
  'method_summary',
  'ground_truth_and_evaluation',
  'stated_limitations',
  'gaps_this_paper_opens',
  'relevance_to_the_thesis_topic',
];

// Per-section prototype text for embedding-similarity ranking. Quotes
// closer to the prototype come first; this surfaces the strongest quote
// from each paper without us having to read every one.
const SECTION_PROTOTYPES = {
  problem_statement:             'The research problem this paper addresses and the motivation behind the work.',
  method_summary:                'The paper\'s methodology, approach, technique, or algorithm.',
  ground_truth_and_evaluation:   'How the paper evaluates its work, the benchmark or ground truth used, and the metrics reported.',
  stated_limitations:            'Limitations the authors explicitly acknowledge in their own work.',
  gaps_this_paper_opens:         'Future research directions, open problems, or follow-up work the paper suggests.',
  relevance_to_the_thesis_topic: 'How this paper connects to the review\'s research question and why it belongs in the corpus.',
};

const QUOTES_PER_SECTION_CAP = 8;     // top-N per section per chapter
const PAPERS_PER_CHAPTER_CAP = 50;    // safety; rarely hit

/**
 * Build the structured catalogue. Pure DB reads; no model calls.
 *
 * opts:
 *   onlyCategories — array of category names to restrict to; default all
 *   quotesPerSection — override per-section cap
 */
// Build per-section prototypes. Topic.md hint is only applied to the
// sections that are inherently domain-anchored — problem_statement and
// relevance_to_the_thesis_topic. The other sections (method_summary,
// stated_limitations, ground_truth_and_evaluation, gaps) are
// domain-agnostic by nature; prepending the topic biases ranking
// toward quotes that name the domain rather than describe the section.
const DOMAIN_ANCHORED_SECTIONS = new Set(['problem_statement', 'relevance_to_the_thesis_topic']);

async function buildSectionPrototypes() {
  let topicHint = '';
  try {
    const md = await readText(PROTOCOL_FILES.topic, '');
    const t = parseTopic(md) || {};
    const title = String(t.title || '').trim();
    const desc = String(t.description || '').trim();
    if (title || desc) {
      const sentence = desc ? desc.split(/[.!?]\s+/)[0] : '';
      topicHint = [title, sentence].filter(Boolean).join('. ');
    }
  } catch { /* no topic.md or parse error — use generic prototypes */ }
  const out = {};
  for (const [sec, base] of Object.entries(SECTION_PROTOTYPES)) {
    out[sec] = (topicHint && DOMAIN_ANCHORED_SECTIONS.has(sec)) ? `${topicHint}. ${base}` : base;
  }
  return out;
}

export async function buildCatalogue(opts = {}) {
  await store.init();
  const sectionCap = opts.quotesPerSection ?? QUOTES_PER_SECTION_CAP;
  const prototypes = await buildSectionPrototypes();

  // 1. Roster: all include/maybe papers with topic categories joined.
  const papers = store.query(
    `SELECT p.paper_id, p.title, p.year, p.doi, p.arxiv_id,
            (SELECT GROUP_CONCAT(author_name, ', ') FROM paper_authors WHERE paper_id = p.paper_id) AS authors
       FROM papers p
      WHERE p.triage_label IN ('include','maybe')
      ORDER BY p.year DESC, p.paper_id`,
  );

  const paperById = new Map(papers.map((p) => [p.paper_id, p]));
  if (papers.length === 0) {
    return { generated_at: new Date().toISOString(), chapters: [], uncategorised_papers: [] };
  }

  // 2. Category index from paper_category.
  const catRows = store.query(
    `SELECT paper_id, category
       FROM paper_category
      WHERE paper_id IN (SELECT paper_id FROM papers WHERE triage_label IN ('include','maybe'))`,
  );
  const papersByCategory = new Map();
  const papersWithCategory = new Set();
  for (const r of catRows) {
    if (!papersByCategory.has(r.category)) papersByCategory.set(r.category, []);
    papersByCategory.get(r.category).push(r.paper_id);
    papersWithCategory.add(r.paper_id);
  }

  let categories = [...papersByCategory.entries()]
    .map(([category, paperIds]) => ({ category, paperIds: [...new Set(paperIds)] }));
  // Chapter ordering. Default is by_count (highest paper count first).
  const order = opts.order || 'by_count';
  if (order === 'alpha') {
    categories.sort((a, b) => a.category.localeCompare(b.category));
  } else if (order === 'topic_order') {
    // Order matches the sequence categories appear in topic.md (caller
    // passes that as opts.topicOrder).
    if (Array.isArray(opts.topicOrder) && opts.topicOrder.length) {
      const idx = new Map(opts.topicOrder.map((c, i) => [c, i]));
      categories.sort((a, b) => (idx.get(a.category) ?? 999) - (idx.get(b.category) ?? 999));
    }
  } else {
    // by_count (default)
    categories.sort((a, b) => b.paperIds.length - a.paperIds.length);
  }
  if (opts.onlyCategories) {
    const allow = new Set(opts.onlyCategories);
    categories = categories.filter((c) => allow.has(c.category));
  }

  // 3. Build chapters.
  const chapters = [];
  for (const { category, paperIds } of categories) {
    const chapterPaperIds = paperIds.slice(0, PAPERS_PER_CHAPTER_CAP);
    const chapterPapers = chapterPaperIds.map((id) => paperById.get(id)).filter(Boolean);

    // Quoted spans for this chapter's papers, grouped by section, ranked
    // by embedding similarity to the section prototype so the most-on-
    // topic quote from each paper surfaces first.
    const placeholders = chapterPaperIds.map(() => '?').join(',');
    const sections = {};
    for (const sec of SECTION_ORDER) {
      const rows = chapterPaperIds.length === 0 ? [] : store.query(
        `SELECT paper_id, page, text, position
           FROM quoted_spans
          WHERE section = ? AND paper_id IN (${placeholders})
          ORDER BY paper_id, position`,
        [sec, ...chapterPaperIds],
      );
      sections[sec] = await rankAndPick(rows, prototypes[sec], sectionCap);
    }

    // Claims grouped by type, top stance-confident first.
    const claimsRows = chapterPaperIds.length === 0 ? [] : store.query(
      `SELECT c.paper_id, c.page, c.text, c.stance, c.claim_type
         FROM claims c
        WHERE c.paper_id IN (${placeholders})
        ORDER BY c.paper_id, c.claim_id`,
      chapterPaperIds,
    );
    const claimsByType = {};
    for (const r of claimsRows) {
      const t = r.claim_type || 'other';
      if (!claimsByType[t]) claimsByType[t] = [];
      claimsByType[t].push({ paper_id: r.paper_id, page: r.page, text: r.text, stance: r.stance });
    }
    for (const t of Object.keys(claimsByType)) {
      claimsByType[t] = roundRobin(claimsByType[t], sectionCap);
    }

    chapters.push({
      category,
      paper_count: chapterPapers.length,
      papers: chapterPapers.map((p) => ({
        paper_id: p.paper_id,
        title: p.title,
        year: p.year,
        authors: p.authors,
      })),
      sections,
      claims_by_type: claimsByType,
    });
  }

  // Papers with no category match.
  const uncategorisedPapers = papers
    .filter((p) => !papersWithCategory.has(p.paper_id))
    .map((p) => ({ paper_id: p.paper_id, title: p.title, year: p.year, authors: p.authors }));

  return {
    generated_at: new Date().toISOString(),
    chapters,
    uncategorised_papers: uncategorisedPapers,
  };
}

// Session-scoped prototype embedding cache. Catalogue calls usually
// happen back-to-back (Thesis mode renders + Markdown download); we
// cache the prototype vector so we don't re-embed the same 6 strings
// every time. Quotes themselves vary so we don't cache those.
const _protoCache = new Map();

async function rankAndPick(rows, prototype, cap) {
  if (rows.length === 0 || cap === 0) return [];
  // Skip embedding entirely when we'd take everything anyway — saves
  // dozens of model calls for sparse sections.
  if (rows.length <= cap) return rows;
  // Skip ranking on tiny over-caps too; embedding cost outweighs the
  // ordering benefit when we're already keeping ≥80% of the rows.
  if (rows.length <= cap * 1.5) return rows.slice(0, cap);

  let scored;
  try {
    // Embed prototype once per session.
    let protoVec = _protoCache.get(prototype);
    if (!protoVec) {
      const pe = await embedder.embed([prototype]);
      protoVec = new Float32Array(new Float32Array(pe.data).buffer, 0, pe.dim);
      _protoCache.set(prototype, protoVec);
    }
    // Batch-embed the quotes.
    const inputs = rows.map((r) => r.text || '');
    const emb = await embedder.embed(inputs);
    const dim = emb.dim;
    const data = new Float32Array(emb.data);
    scored = rows.map((r, i) => {
      const offset = i * dim;
      const vec = data.subarray(offset, offset + dim);
      return { row: r, score: cosSim(protoVec, vec) };
    });
  } catch {
    // Embedder unavailable — fall back to length-based ranking.
    scored = rows.map((r) => ({ row: r, score: Math.min(1, (r.text?.length || 0) / 400) }));
  }

  // Group scored quotes by paper, sorting each group desc by score.
  const byPaper = new Map();
  for (const s of scored) {
    if (!byPaper.has(s.row.paper_id)) byPaper.set(s.row.paper_id, []);
    byPaper.get(s.row.paper_id).push(s);
  }
  for (const arr of byPaper.values()) arr.sort((a, b) => b.score - a.score);

  // Round-robin highest-scoring quote from each paper, then next-best, etc.
  const out = [];
  let added = true;
  while (out.length < cap && added) {
    added = false;
    for (const arr of byPaper.values()) {
      if (out.length >= cap) break;
      const next = arr.shift();
      if (next) { out.push(next.row); added = true; }
    }
  }
  return out;
}

/**
 * Render the catalogue as a Markdown document. Pure transformation
 * of `buildCatalogue` output. Each chapter is a section; each body
 * section is a sub-section; each quote is a blockquote with paper +
 * page provenance.
 */
export function catalogueToMarkdown(cat) {
  const out = [];
  out.push(`# Catalogue\n`);
  out.push(`*Generated ${cat.generated_at} from ${cat.chapters.reduce((a, c) => a + c.paper_count, 0)} papers across ${cat.chapters.length} categories.*\n`);
  for (const ch of cat.chapters) {
    out.push(`\n## ${ch.category} (${ch.paper_count} papers)\n`);
    out.push(`\n### Papers in this chapter\n`);
    for (const p of ch.papers) {
      out.push(`- **${p.paper_id}** — ${p.title || '(untitled)'} (${p.year || 'n.d.'})`);
    }
    out.push('');
    for (const sec of SECTION_ORDER) {
      const quotes = ch.sections[sec] || [];
      if (quotes.length === 0) continue;
      out.push(`\n### ${sec.replace(/_/g, ' ')}\n`);
      for (const q of quotes) {
        const pageStr = q.page ? `, p. ${q.page}` : '';
        out.push(`> ${q.text}\n>\n> — *${q.paper_id}${pageStr}*\n`);
      }
    }
    if (Object.keys(ch.claims_by_type || {}).length) {
      out.push(`\n### Claims by type\n`);
      for (const [type, rows] of Object.entries(ch.claims_by_type)) {
        out.push(`\n**${type}** (${rows.length}):\n`);
        for (const c of rows) {
          const pageStr = c.page ? `, p. ${c.page}` : '';
          const stanceStr = c.stance ? ` (${c.stance})` : '';
          out.push(`- *${c.paper_id}${pageStr}${stanceStr}*: ${c.text}`);
        }
      }
    }
  }
  if (cat.uncategorised_papers.length) {
    out.push(`\n## Uncategorised papers\n`);
    for (const p of cat.uncategorised_papers) {
      out.push(`- **${p.paper_id}** — ${p.title || '(untitled)'} (${p.year || 'n.d.'})`);
    }
  }
  return out.join('\n');
}
