// section_classifier.mjs
//
// Phase 1a of the structured-data pivot. Maps every PDF chunk to one of a
// fixed set of canonical scientific-paper section labels so per-field
// extractors can filter "eligible sections" before any regex / NER / NLI
// runs.
//
// Two tiers, in order:
//
//   1. **Heading-pattern match** (deterministic regex). `pdf_chunks.mjs`
//      already records each chunk's section as a slugified verbatim
//      heading string, e.g. `"3_2_system_architecture"` or `"introduction"`.
//      We try to match the slug against a curated table of canonical
//      label patterns. Cheap, ~100% precision when it fires.
//
//   2. **Embedding cosine to label prototypes** (deterministic given the
//      embedder). Only used when tier 1 returns no match. Embed
//      `<chunk_heading>. <first ~700 chars of chunk text>`; cosine to
//      a small set of per-label prototype embeddings; argmax = label.
//      Output carries the full per-label score distribution so it lands
//      in the provenance subtree.
//
// Both tiers produce deterministic outputs: same chunk → same label every
// run. No LLM, no fabrication, no inference in the LLM-generation sense.
// Failure mode is misclassification (cosine picks the wrong label for an
// ambiguous chunk), which is observable via the distribution and bounded
// to the fixed label set.

import * as embedder from './embedder.mjs';
import { makeMatrix, normalize, semanticSearch } from './sbert_utils.mjs';

// Canonical section labels. The per-field eligible-section tables in the
// extractors reference these. Order is informational only; the index is
// keyed by label.
export const SECTION_LABELS = [
  'abstract',
  'introduction',
  'related_work',
  'background',
  'methods',
  'experimental_setup',
  'results',
  'discussion',
  'limitations',
  'conclusion',
  'future_work',
  'references',
  'appendix',
  'other',
];

// ---------------------------------------------------------------------------
// Tier 1: heading-pattern match
// ---------------------------------------------------------------------------
//
// pdf_chunks.mjs slugifies headings as lowercase underscore-separated text
// (numbers like "3.2" become "3_2", letters lowered). The patterns below
// match the most common ways each canonical section is labelled in real
// scientific papers across CS / health / social-science genres. They're
// curated, not exhaustive — uncommon labels fall through to tier 2.

const HEADING_RULES = [
  { label: 'abstract', patterns: [
    /^abstract$/,
    /^\d+(?:_\d+)*_abstract$/,
  ] },
  { label: 'introduction', patterns: [
    /^(?:\d+(?:_\d+)*_)?(?:introduction|intro)$/,
    /^(?:\d+(?:_\d+)*_)?motivation$/,
  ] },
  { label: 'related_work', patterns: [
    /related[_ ]?work/,
    /prior[_ ]?work/,
    /literature[_ ]?review/,
    /^(?:\d+(?:_\d+)*_)?(?:related|state[_ ]?of[_ ]?the[_ ]?art|sota)/,
  ] },
  { label: 'background', patterns: [
    /^(?:\d+(?:_\d+)*_)?background/,
    /preliminaries?/,
    /^(?:\d+(?:_\d+)*_)?fundamentals?/,
  ] },
  { label: 'methods', patterns: [
    // Use (?:_|$) instead of \b — slugs are letter+underscore, where \b
    // doesn't fire (both are word chars). End-of-string or underscore is
    // the right "keyword ends here" signal for slugified headings.
    /^(?:\d+(?:_\d+)*_)?(?:methods?|methodology|approach|system|design|architecture|model|algorithm|framework|technique|proposed)(?:_|$)/,
    /^(?:\d+(?:_\d+)*_)?our_/,
  ] },
  { label: 'experimental_setup', patterns: [
    /^(?:\d+(?:_\d+)*_)?(?:experimental[_ ]?setup|experiment[s]?|setup|implementation|evaluation[_ ]?setup|materials)/,
    /^(?:\d+(?:_\d+)*_)?datasets?$/,
    /^(?:\d+(?:_\d+)*_)?data(?:_collection)?$/,
    /^(?:\d+(?:_\d+)*_)?participants?/,
  ] },
  { label: 'results', patterns: [
    /^(?:\d+(?:_\d+)*_)?(?:results?|findings|empirical[_ ]?results?|performance|outcomes?)$/,
    /^(?:\d+(?:_\d+)*_)?analysis$/,
    /^(?:\d+(?:_\d+)*_)?evaluation$/,
  ] },
  { label: 'discussion', patterns: [
    /^(?:\d+(?:_\d+)*_)?discussion/,
    /implications/,
    /interpretation/,
  ] },
  { label: 'limitations', patterns: [
    /limitations?$/,
    /threats?[_ ]?to[_ ]?validity/,
    /^caveats?$/,
  ] },
  { label: 'conclusion', patterns: [
    /^(?:\d+(?:_\d+)*_)?(?:conclusion|conclusions|concluding[_ ]?remarks|summary|closing)/,
  ] },
  { label: 'future_work', patterns: [
    /future[_ ]?work/,
    /open[_ ]?(?:problems?|questions?|directions?)/,
    /next[_ ]?steps?/,
  ] },
  { label: 'references', patterns: [
    /^references?$/,
    /^bibliography/,
  ] },
  { label: 'appendix', patterns: [
    /^appendi(?:x|ces)/,
    /^(?:\d+(?:_\d+)*_)?appendix/,
    /supplementary/,
  ] },
];

function classifyByHeading(slug) {
  if (!slug) return null;
  const s = String(slug).toLowerCase();
  for (const rule of HEADING_RULES) {
    for (const re of rule.patterns) {
      if (re.test(s)) return rule.label;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 2: prototype embeddings
// ---------------------------------------------------------------------------
//
// One short prototype sentence per label that describes "what this kind of
// section is about". Embedded once per process and cached. Adding more
// per-label prototypes generally improves accuracy at marginal cost; we
// keep one each here to start.

// Multi-prototype: 3-5 phrasings per label. Cosine match = max over
// prototypes for that label. Single-prototype was missing too many
// legitimate sections that phrased themselves differently from the
// canonical wording (e.g. "Approach" instead of "Methods", "Empirical
// Study" instead of "Experiments").
const SECTION_PROTOTYPES = {
  abstract: [
    'Abstract summarising the paper at the very beginning of the document.',
    'A brief summary stating the problem, approach, and main results.',
    'Background and objective; methods; results; conclusions of the study.',
  ],
  introduction: [
    'The introductory section motivating the problem and stating the contributions.',
    'In this paper, we address the following research question and propose a new approach.',
    'Motivation for the work, problem statement, and overview of contributions.',
  ],
  related_work: [
    'A discussion of prior literature, related research, and the state of the art.',
    'Previous studies have approached this problem from several angles.',
    'In this section we review existing methods and compare them to our approach.',
  ],
  background: [
    'Background, preliminaries, and foundational theory needed to understand the rest of the paper.',
    'Notation and key definitions used throughout the paper.',
    'We briefly introduce the technical concepts our work builds upon.',
  ],
  methods: [
    'The methodology, system architecture, model, algorithm, or technique that the authors propose.',
    'We describe our proposed approach and explain how it works step by step.',
    'The architecture of our model and the training procedure are detailed below.',
    'Our framework consists of the following components and processing pipeline.',
    'The approach we take is to first do X and then do Y to produce Z.',
  ],
  experimental_setup: [
    'Experimental setup, datasets used, implementation details, participants, evaluation protocol.',
    'We evaluate our approach on the following datasets and use these baselines for comparison.',
    'Implementation details: training hyperparameters, hardware, and protocol.',
    'Participants were recruited and randomly assigned to conditions.',
  ],
  results: [
    'Empirical results, performance numbers, quantitative findings, and analysis of experiment outcomes.',
    'Table 1 reports the performance of our method against the baselines.',
    'Our model achieves an F1 score of 0.84 on the test set, outperforming prior work.',
    'The findings are summarised in Figure 3 and discussed below.',
  ],
  discussion: [
    'Discussion of the results, interpretation of the findings, implications and meaning.',
    'These results suggest that the proposed approach generalises across settings.',
    'We discuss the implications of these findings for theory and practice.',
  ],
  limitations: [
    'Limitations of the work, threats to validity, caveats and weaknesses the authors acknowledge.',
    'Our study has several limitations that we acknowledge below.',
    'Threats to validity include sample bias and the choice of evaluation metric.',
  ],
  conclusion: [
    'Concluding remarks summarising the contributions and closing the paper.',
    'In conclusion, this paper has introduced a new approach to the problem.',
    'We have shown that our method outperforms baselines on three datasets.',
  ],
  future_work: [
    'Future work, open questions, and directions left for further research.',
    'In future work we plan to extend this analysis to a larger corpus.',
    'Open problems and directions for further research are listed below.',
  ],
  references: [
    'Bibliography and list of cited references.',
    'List of references cited in the paper.',
  ],
  appendix: [
    'Appendix, supplementary material, additional proofs or tables.',
    'Additional details and supporting material are provided in the appendix.',
  ],
  other: [
    'Front matter, acknowledgments, author affiliations, or other section that does not fit the main paper sections.',
    'Acknowledgments of funding sources and contributors.',
  ],
};

let _protoMatrix = null;
let _protoIndexToLabel = null;   // row index → canonical label (many rows per label)
let _protoLabelOrder = null;     // canonical labels in declared order
let _protoPromise = null;

async function getPrototypeMatrix() {
  if (_protoMatrix) return { mat: _protoMatrix, indexToLabel: _protoIndexToLabel, labels: _protoLabelOrder };
  if (_protoPromise) return _protoPromise;
  _protoPromise = (async () => {
    const labels = SECTION_LABELS.slice();
    const texts = [];
    const indexToLabel = [];
    for (const l of labels) {
      const prototypes = SECTION_PROTOTYPES[l];
      if (Array.isArray(prototypes)) {
        for (const p of prototypes) { texts.push(p); indexToLabel.push(l); }
      } else if (typeof prototypes === 'string') {
        texts.push(prototypes); indexToLabel.push(l);
      } else {
        texts.push(l); indexToLabel.push(l);
      }
    }
    const emb = await embedder.embed(texts);
    const mat = makeMatrix(texts.length, emb.dim, new Float32Array(emb.data));
    normalize(mat);
    _protoMatrix = mat;
    _protoIndexToLabel = indexToLabel;
    _protoLabelOrder = labels;
    return { mat, indexToLabel, labels };
  })();
  return _protoPromise;
}

function softmax(values) {
  if (values.length === 0) return [];
  const m = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - m));
  const z = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / z);
}

// Classify a single chunk by embedding the heading + leading text and
// running cosine against the prototype matrix. Each canonical label has
// 1-5 prototype sentences; we take max-over-prototypes per label, then
// argmax across labels. Returns the argmax label, its top score, the
// per-label score map, and a softmax distribution for provenance.
export async function classifyByEmbedding(chunkText, chunkHeading = '') {
  const heading = String(chunkHeading || '').replace(/_/g, ' ').trim();
  const body = String(chunkText || '').slice(0, 700);
  const query = (heading ? heading + '. ' : '') + body;
  if (!query.trim()) {
    return { label: 'other', score: 0, scores: {}, distribution: {} };
  }
  const emb = await embedder.embed([query]);
  const qMat = makeMatrix(1, emb.dim, new Float32Array(emb.data));
  normalize(qMat);
  const { mat: protoMat, indexToLabel, labels } = await getPrototypeMatrix();
  // Take all prototype scores (semanticSearch with topK = full size).
  const hits = semanticSearch(qMat, protoMat, {
    topK: indexToLabel.length,
    scoreFn: 'dot_score',
  });
  // Max-over-prototypes per canonical label.
  const labelMax = new Map(labels.map((l) => [l, -Infinity]));
  for (const h of hits[0]) {
    const lab = indexToLabel[h.corpus_id];
    if (h.score > labelMax.get(lab)) labelMax.set(lab, h.score);
  }
  const orderedLabels = labels.slice().sort((a, b) => labelMax.get(b) - labelMax.get(a));
  const orderedScores = orderedLabels.map((l) => labelMax.get(l));
  const scores = {};
  for (const l of labels) scores[l] = labelMax.get(l);
  const probs = softmax(orderedScores);
  const distribution = {};
  for (let i = 0; i < orderedLabels.length; i++) {
    distribution[orderedLabels[i]] = probs[i];
  }
  return {
    label: orderedLabels[0],
    score: orderedScores[0],
    scores,
    distribution,
  };
}

// ---------------------------------------------------------------------------
// Public API: per-paper section index
// ---------------------------------------------------------------------------

/**
 * Build a section index for a paper's chunks.
 *
 * Input: chunks as produced by `pdf_chunks.chunksForPdf` —
 *   [{ id, text, meta: { paper_id, section, page_first, page_last, ... } }]
 *
 * Output:
 *   {
 *     sectionIndex: { <canonical_label>: [chunk_id, ...] },
 *     perChunk:     { <chunk_id>: {
 *                       label, mechanism, score, distribution,
 *                       raw_heading, page_first, page_last
 *                    } }
 *   }
 *
 * `mechanism` is one of:
 *   - 'heading_pattern' : tier 1 regex match against the slugified heading
 *   - 'cosine_prototype': tier 2 embedding cosine against the prototype matrix
 *
 * Deterministic given the same input chunks + same embedder model.
 */
export async function buildSectionIndex(chunks) {
  const sectionIndex = Object.fromEntries(SECTION_LABELS.map((l) => [l, []]));
  const perChunk = {};

  // First pass: tier 1 heading matches. Cheap, often catches most chunks.
  const tier2Pending = [];
  for (const chunk of chunks) {
    const id = chunk.id;
    const slug = chunk.meta?.section || '';
    const tier1Label = classifyByHeading(slug);
    if (tier1Label && SECTION_LABELS.includes(tier1Label)) {
      sectionIndex[tier1Label].push(id);
      perChunk[id] = {
        label: tier1Label,
        mechanism: 'heading_pattern',
        score: 1.0,
        distribution: null,
        raw_heading: slug,
        page_first: chunk.meta?.page_first || null,
        page_last: chunk.meta?.page_last || null,
      };
    } else {
      tier2Pending.push(chunk);
    }
  }

  // Second pass: tier 2 embedding classification for everything tier 1
  // didn't catch. Sequential calls — embedder is cheap per call (~20ms)
  // and queuing keeps memory bounded.
  for (const chunk of tier2Pending) {
    const slug = chunk.meta?.section || '';
    const cls = await classifyByEmbedding(chunk.text || '', slug);
    const label = SECTION_LABELS.includes(cls.label) ? cls.label : 'other';
    sectionIndex[label].push(chunk.id);
    perChunk[chunk.id] = {
      label,
      mechanism: 'cosine_prototype',
      score: cls.score,
      distribution: cls.distribution,
      raw_heading: slug,
      page_first: chunk.meta?.page_first || null,
      page_last: chunk.meta?.page_last || null,
    };
  }

  return { sectionIndex, perChunk };
}

/**
 * Convenience: project a section index to the chunks eligible for a
 * specific field. `field.eligible_sections` is an array of canonical
 * labels; returns the deduplicated union of chunk ids in those sections.
 */
export function chunkIdsForSections(sectionIndex, eligibleSections) {
  const seen = new Set();
  for (const label of eligibleSections) {
    const ids = sectionIndex[label];
    if (!ids) continue;
    for (const id of ids) seen.add(id);
  }
  return [...seen];
}
