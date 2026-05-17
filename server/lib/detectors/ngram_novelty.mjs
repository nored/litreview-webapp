// detectors/ngram_novelty.mjs
//
// N-gram-based novelty. Different signal from LOF — measures lexical
// novelty: a paper that uses bi/tri-grams which are rare across the
// rest of the corpus is using uncommon vocabulary. That doesn't always
// mean "intellectually novel" — could just be domain-specific jargon —
// but combined with LOF it's a useful second axis.
//
// Algorithm:
//
//   1. Tokenize each paper's title + abstract.
//   2. Build all bi-grams and tri-grams per paper. Filter stopword-only
//      n-grams (typical for raw text).
//   3. Document-frequency per n-gram across the corpus.
//   4. Per paper, average rarity = mean(1 / df) over the paper's unique
//      n-grams, weighted by n-gram length (tri-grams count more than
//      bi-grams).
//   5. Rank by average rarity; flag papers above a percentile cutoff
//      (default top 10%).

import * as store from '../store.mjs';
import { pickThresholds } from './_scale.mjs';

const DEFAULT_PERCENTILE = 0.90;
const DEFAULT_MIN_PAPER_LEN_TOKENS = 50;

// Stopwords shared with bm25.mjs; copied locally to keep the modules
// independent.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
  'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'as', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do',
  'does', 'did', 'this', 'that', 'these', 'those', 'it', 'its', 'we',
  'our', 'i', 'you', 'they', 'their', 'from', 'into', 'over', 'under',
  'than', 'so', 'such', 'no', 'not', 'only', 'own', 'same', 'just',
  'also', 'very', 'can', 'will', 'would', 'should', 'could', 'may',
  'might', 'must', 'between', 'about', 'against', 'because', 'while',
  'where', 'how', 'why', 'what', 'which', 'who', 'whom',
]);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9_\-./]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^[-./]+|[-./]+$/g, ''))
    .filter((t) => t.length >= 2 && t.length <= 60);
}

function buildNgrams(tokens, n) {
  const out = new Set();
  for (let i = 0; i + n <= tokens.length; i++) {
    const slice = tokens.slice(i, i + n);
    // Drop ngrams that are entirely stopwords / numbers.
    let allStop = true, allNum = true;
    for (const t of slice) {
      if (!STOPWORDS.has(t)) allStop = false;
      if (!/^\d+$/.test(t)) allNum = false;
    }
    if (allStop || allNum) continue;
    out.add(slice.join(' '));
  }
  return out;
}

export async function detectNgramNovelty(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const percentile = opts.percentile ?? DEFAULT_PERCENTILE;
  const maxCandidates = opts.maxCandidates ?? Math.min(20, t.topK);
  const minLen = opts.minLen ?? DEFAULT_MIN_PAPER_LEN_TOKENS;

  const papers = store.query(`
    SELECT paper_id, title, abstract, year
      FROM papers
     WHERE (abstract IS NOT NULL AND abstract <> '')
        OR (title IS NOT NULL AND title <> '')
  `);
  if (papers.length < 3) {
    return { candidates: [], total_candidates: 0, reason: 'too_few_papers' };
  }

  // Step 1: tokenize + ngrams per paper.
  const perPaper = new Map();
  for (const p of papers) {
    const tokens = tokenize((p.title || '') + ' ' + (p.abstract || ''));
    if (tokens.length < minLen) continue;
    const bi = buildNgrams(tokens, 2);
    const tri = buildNgrams(tokens, 3);
    perPaper.set(p.paper_id, { tokens, bi, tri, title: p.title, year: p.year });
  }
  if (perPaper.size < 3) {
    return { candidates: [], total_candidates: 0, reason: 'too_few_papers_with_enough_text' };
  }

  // Step 2: document frequency per ngram.
  const dfBi = new Map();
  const dfTri = new Map();
  for (const { bi, tri } of perPaper.values()) {
    for (const g of bi)  dfBi.set(g,  (dfBi.get(g)  || 0) + 1);
    for (const g of tri) dfTri.set(g, (dfTri.get(g) || 0) + 1);
  }

  // Step 3: per-paper rarity score.
  // rarity = (mean(1/df_bi) + 1.5 * mean(1/df_tri)) — tri-grams weighted higher
  const scored = [];
  for (const [pid, info] of perPaper) {
    let biSum = 0, biCount = 0;
    for (const g of info.bi) { biSum += 1 / (dfBi.get(g) || 1); biCount++; }
    let triSum = 0, triCount = 0;
    for (const g of info.tri) { triSum += 1 / (dfTri.get(g) || 1); triCount++; }
    const biMean = biCount > 0 ? biSum / biCount : 0;
    const triMean = triCount > 0 ? triSum / triCount : 0;
    const rarity = biMean + 1.5 * triMean;
    scored.push({ paper_id: pid, rarity, title: info.title, year: info.year, biCount, triCount });
  }
  scored.sort((a, b) => b.rarity - a.rarity);

  // Cutoff at percentile.
  const cutoffIndex = Math.floor(scored.length * (1 - percentile));
  const cutoffRarity = scored[cutoffIndex]?.rarity ?? 0;

  const candidates = [];
  for (const s of scored) {
    if (s.rarity < cutoffRarity) break;
    if (candidates.length >= maxCandidates) break;
    candidates.push({
      cell: { paper_id: s.paper_id },
      statistic: {
        rarity: Number(s.rarity.toFixed(4)),
        bi_ngram_count: s.biCount,
        tri_ngram_count: s.triCount,
        percentile_threshold: percentile,
      },
      contributing_papers: [s.paper_id],
      description: `Lexically novel paper (rarity ${s.rarity.toFixed(3)}): "${(s.title || s.paper_id).slice(0, 80)}" — uses n-grams that are rare across the rest of the corpus.`,
      salience: s.rarity * 100,
    });
  }

  return {
    candidates,
    total_candidates: candidates.length,
    diagnostics: { n_papers: scored.length, cutoff_rarity: cutoffRarity },
  };
}

export const TYPE = 'ngram_novelty';
