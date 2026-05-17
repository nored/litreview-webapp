// extractors/bool_signals.mjs
//
// Five boolean signals per paper, stored in `paper_field` as field_type='bool3'.
// Three-valued: confirmed | refuted | unknown. "Absence of evidence is not
// evidence of absence" — the old binary true/false silently encoded "we
// didn't find a regex hit" as "the paper doesn't do this", which produces
// systematically wrong gap reports.
//
// Signal list (unchanged from v1):
//   claims_first_in_area, challenges_existing, baseline_compared,
//   releases_code, reports_uncertainty.
//
// Pipeline per signal (every step emits a score we can render in the UI):
//
//   1. Pull eligible-section chunks via _section_routing with whole-paper
//      fallback. tier ∈ {sections, sections+other, whole_paper} is recorded
//      in provenance so the reader can see how broadly we searched.
//   2. Split chunks into sentences; embed all sentences.
//   3. Embed a small bank of POSITIVE prototype sentences (the signal
//      affirmed in different phrasings) and NEGATIVE prototypes (the
//      signal explicitly denied).
//   4. Per sentence: cosine to closest positive prototype, cosine to
//      closest negative prototype. Top-K positive candidates + top-K
//      negative candidates feed into NLI.
//   5. NLI-verify each top candidate against the corresponding hypothesis.
//   6. Decision:
//        - Top positive entailment ≥ POS_THRESHOLD       → confirmed
//        - Top negative entailment ≥ NEG_THRESHOLD       → refuted
//        - Both above threshold (paper says both)        → resolve by
//          which has higher P(entails) - P(contradicts)
//        - Neither above threshold                       → unknown
//
// Every accepted sentence is stored in provenance with: cosine score,
// NLI distribution (entail / neutral / contradict), the verbatim
// quote, the source chunk, the page. A reader can audit any cell.
//
// No regex pre-gate. Regex was acting as a hard filter — "did any of
// 5-10 curated patterns match a sentence" — and silently writing
// `false` when nothing matched. That meant a paper that releases code
// at a URL we didn't anticipate got marked "no code released".

import * as store from '../store.mjs';
import * as nli from '../nli.mjs';
import * as embedder from '../embedder.mjs';
import { makeMatrix, normalize, semanticSearch } from '../sbert_utils.mjs';
import { eligibleChunksWithFallback, annotateMechanism } from './_section_routing.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Signal definitions
// ─────────────────────────────────────────────────────────────────────────
//
// Each signal carries:
//   sections         — preferred section labels (eligibleChunksWithFallback
//                      will widen if these return empty)
//   positive         — array of prototype sentences for the signal AFFIRMED
//                      (used as a "match this kind of statement" query)
//   negative         — array of prototype sentences for the signal DENIED
//   hypothesisPos    — NLI hypothesis tested against top positive candidates
//   hypothesisNeg    — NLI hypothesis tested against top negative candidates
//   posThreshold     — minimum entailment to accept `confirmed`
//   negThreshold     — minimum entailment to accept `refuted`
//   topK             — how many sentences to feed NLI per side
//   needsExternalUrl — when true, also accept a URL match as confirming
//                      evidence (releases_code: a github URL IS the proof)

const SIGNALS = {
  claims_first_in_area: {
    sections: ['abstract', 'introduction', 'conclusion'],
    positive: [
      'To the best of our knowledge, this is the first work to address this problem.',
      'We are the first to study this question in this setting.',
      'No prior work has investigated this phenomenon.',
      'This paper introduces the first system of its kind.',
      'Our work is the first attempt to tackle this challenge.',
    ],
    negative: [
      'Prior work has extensively explored this problem.',
      'Many studies have investigated this question before us.',
      'We extend existing approaches with a new variant.',
    ],
    hypothesisPos: "This sentence claims that this paper is the first to address or accomplish something.",
    hypothesisNeg: "This sentence states that prior work has already addressed this topic.",
    posThreshold: 0.55,
    negThreshold: 0.60,
    topK: 4,
  },
  challenges_existing: {
    sections: ['abstract', 'introduction', 'related_work', 'discussion'],
    positive: [
      'In contrast to prior work, we show that existing approaches fail in this setting.',
      'We argue that the established findings do not hold under these conditions.',
      'Previous methods overlook a critical limitation that we address here.',
      'Our results contradict the widely accepted conclusion that X.',
      'We dispute the assumption underlying earlier studies.',
    ],
    negative: [
      'We build directly on prior work without contradicting its findings.',
      'Our approach is consistent with established results.',
      'This paper complements existing methods.',
    ],
    hypothesisPos: "This sentence claims the paper challenges, disputes, or contradicts existing work or assumptions.",
    hypothesisNeg: "This sentence states the paper agrees with or builds on prior work without challenging it.",
    posThreshold: 0.55,
    negThreshold: 0.60,
    topK: 4,
  },
  baseline_compared: {
    sections: ['methods', 'experimental_setup', 'results', 'discussion'],
    positive: [
      'We compare our method against several strong baselines.',
      'Our approach outperforms the state-of-the-art on this benchmark.',
      'We evaluate against prior work including method X and method Y.',
      'Table 1 reports results for our model and the baseline methods.',
      'Compared to the previous SOTA, our method achieves higher accuracy.',
    ],
    negative: [
      'We do not compare against existing methods.',
      'No baseline comparison is conducted.',
      'A comparison with prior work is out of scope.',
    ],
    hypothesisPos: "This sentence states that the paper compares its method against baselines or prior work.",
    hypothesisNeg: "This sentence states that no baseline comparison is performed.",
    posThreshold: 0.50,
    negThreshold: 0.65,
    topK: 4,
  },
  releases_code: {
    sections: ['abstract', 'introduction', 'methods', 'conclusion', 'appendix'],
    positive: [
      'Our code is publicly available at https://github.com/example/repo.',
      'We release our implementation as open source.',
      'The source code will be made available upon publication.',
      'Model weights and code are released on HuggingFace.',
      'We open-source our system to enable reproducibility.',
    ],
    negative: [
      'The code is not publicly available.',
      'We do not release our implementation.',
      'Source code is proprietary and not shared.',
    ],
    hypothesisPos: "This sentence states that the paper releases its source code, model weights, or implementation publicly.",
    hypothesisNeg: "This sentence states that the code or implementation is not released.",
    posThreshold: 0.50,
    negThreshold: 0.65,
    topK: 4,
    // A bare github URL anywhere in the paper is direct evidence — no NLI
    // step needed. Matches the long-tail of papers that drop a URL without
    // a natural-language sentence around it.
    urlPatterns: [
      /https?:\/\/github\.com\/[A-Za-z0-9_.\-/]+/i,
      /https?:\/\/gitlab\.com\/[A-Za-z0-9_.\-/]+/i,
      /https?:\/\/bitbucket\.org\/[A-Za-z0-9_.\-/]+/i,
      /https?:\/\/zenodo\.org\/[A-Za-z0-9_.\-/]+/i,
      /https?:\/\/huggingface\.co\/[A-Za-z0-9_.\-/]+/i,
    ],
  },
  reports_uncertainty: {
    sections: ['methods', 'results'],
    positive: [
      'We report 95% confidence intervals for all metrics.',
      'Standard errors are computed via bootstrap.',
      'Error bars indicate one standard deviation across runs.',
      'Results are reported with credible intervals from the posterior.',
      'p-values are computed using a paired t-test.',
    ],
    negative: [
      'We do not report uncertainty quantification.',
      'No confidence intervals are computed.',
      'Standard errors are not reported.',
    ],
    hypothesisPos: "This sentence reports a measure of statistical uncertainty such as a confidence interval, standard error, error bars, p-value, or bootstrap variance.",
    hypothesisNeg: "This sentence states that no uncertainty quantification is reported.",
    posThreshold: 0.50,
    negThreshold: 0.65,
    topK: 4,
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Sentence segmentation + embedding helpers
// ─────────────────────────────────────────────────────────────────────────

const SENT_SPLIT = /(?<=[.!?])\s+(?=[A-Z(])/g;
const MIN_SENT_LEN = 50;
const MAX_SENT_LEN = 600;

// A "real" sentence ends with proper punctuation, contains at least one
// verb-shaped word, and isn't a fragment caused by PDF line breaks (e.g.
// "In addition, it offers a review of the relevant identi" — truncated).
function looksLikeRealSentence(s) {
  if (!s || s.length < MIN_SENT_LEN) return false;
  if (!/[.!?]\s*$/.test(s)) return false;             // must end with terminal punctuation
  const last = s.replace(/[.!?]\s*$/, '').split(/\s+/).pop() || '';
  if (last.length < 3 || /^[a-z]{1,3}$/.test(last)) return false;   // truncated/stub last word
  // Citation-only fragments like "and software of the cloud [12]." — no real content.
  if (/^\s*(?:and|or|but|the|of|in|to|for|with|by|as)\b/i.test(s) && s.length < 80) return false;
  return true;
}

// "Boilerplate" sentences — rhetorical structure / paper-organisation
// glue. They share academic vocabulary with content-bearing claims so
// the cosine embedder routinely ranks them as top candidates, then NLI
// rejects them. Filtering at the sentence-split layer keeps the
// candidate pool clean and saves NLI calls. These patterns are well-
// known in scientific text-mining (rhetorical-structure sentences in
// AZ / CoreSC schemas).
const BOILERPLATE_PATTERNS = [
  /\bthe\s+(?:rest|remainder)\s+of\s+(?:this|the)\s+(?:paper|study|article|chapter|work|manuscript|thesis)\b/i,
  /\bstructured\s+as\s+follows\b/i,
  /\borganiz(?:ed?|ation)\s+of\s+(?:this|the)\s+(?:paper|study|article|chapter)\b/i,
  /\bsection\s+\d+(?:\.\d+)?\s+(?:reviews?|describes?|presents?|discusses?|introduces?|covers?|provides?|outlines?|details?|explains?|elaborates?|concludes?)\b/i,
  /\bproceeds?\s+as\s+follows\b/i,
  /\b(?:we|this\s+paper|the\s+paper|this\s+study)\s+(?:begin|start)s?\s+(?:by|with)\b/i,
  /\boutline\s+of\s+(?:this|the)\s+(?:paper|article|chapter|study)\b/i,
  /\bthis\s+paper\s+is\s+(?:organi[sz]ed|structured)\b/i,
  /\bsee\s+(?:section|figure|table|appendix)\s+\d+/i,
  /\bas\s+shown\s+in\s+(?:section|figure|table|fig\.|tab\.)\s+\d+/i,
  /\b(?:figure|fig\.|table|tab\.)\s+\d+\s+(?:shows?|illustrates?|presents?|depicts?|displays?|reports?)\b/i,
  /\bin\s+(?:section|chapter)\s+\d+/i,
  /^\s*(?:section|chapter|appendix)\s+\d+[:.]/i,
  /^\s*\d+(?:\.\d+){0,3}\s+[A-Z]/,        // numbered-section heading lines
];

function isBoilerplate(sentence) {
  for (const re of BOILERPLATE_PATTERNS) if (re.test(sentence)) return true;
  return false;
}

function splitSentencesWithMeta(chunkRows) {
  const out = [];
  for (const row of chunkRows) {
    const text = String(row.text || '');
    const raw = text.split(SENT_SPLIT);
    for (const s of raw) {
      const trimmed = s.trim();
      if (trimmed.length > MAX_SENT_LEN) continue;
      if (!looksLikeRealSentence(trimmed)) continue;   // length + terminal-punct + verb shape
      if (isBoilerplate(trimmed)) continue;            // rhetorical-structure glue
      out.push({
        sentence: trimmed,
        chunk_id: row.chunk_id,
        page: row.page_first ?? null,
        chunk_idx: row.chunk_idx,
      });
    }
  }
  return out;
}

// Exported for tests / shared use from other extractors.
export { isBoilerplate, BOILERPLATE_PATTERNS };

// Cache of prototype embeddings per signal — one process-wide computation,
// re-used across every paper. Avoids re-embedding the same 8 prototype
// sentences for every paper in a 1000-paper corpus.
const _protoCache = new Map();   // signal_name -> { posMat, negMat }

async function getPrototypeMatrices(signalName) {
  if (_protoCache.has(signalName)) return _protoCache.get(signalName);
  const cfg = SIGNALS[signalName];
  const posR = await embedder.embed(cfg.positive);
  const negR = await embedder.embed(cfg.negative);
  const posMat = makeMatrix(cfg.positive.length, posR.dim, new Float32Array(posR.data));
  const negMat = makeMatrix(cfg.negative.length, negR.dim, new Float32Array(negR.data));
  normalize(posMat); normalize(negMat);
  const entry = { posMat, negMat };
  _protoCache.set(signalName, entry);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-paper, per-signal extraction
// ─────────────────────────────────────────────────────────────────────────

async function extractOneSignal(paperId, signalName, opts = {}) {
  const cfg = SIGNALS[signalName];

  // 1. Pull eligible chunks with whole-paper fallback. Tier is recorded
  // in provenance so the reader sees how broadly we searched.
  const { rows: chunks, tier } = eligibleChunksWithFallback(paperId, cfg.sections);
  if (chunks.length === 0) {
    return writeUnknown(paperId, signalName, 'no_chunks', null, tier);
  }

  // 2. Direct-URL short-circuit (releases_code). Cheap and definitive —
  // a github URL in the paper IS the evidence; we don't need NLI.
  if (cfg.urlPatterns) {
    for (const row of chunks) {
      const text = String(row.text || '');
      for (const re of cfg.urlPatterns) {
        const m = re.exec(text);
        if (m) {
          // Pull the URL plus surrounding ~140 chars for context.
          const start = Math.max(0, m.index - 70);
          const end = Math.min(text.length, m.index + m[0].length + 70);
          const quote = text.slice(start, end).trim();
          return writeDecision({
            paperId, signalName, value: 'confirmed',
            quote, chunkId: row.chunk_id, page: row.page_first ?? null,
            mechanism: annotateMechanism(`url_match:${m[0].slice(0, 40)}`, tier),
            cosScore: 1.0,
            nliScores: null,
          });
        }
      }
    }
  }

  // 3. Sentence segmentation + embedding.
  const sentences = splitSentencesWithMeta(chunks);
  if (sentences.length === 0) {
    return writeUnknown(paperId, signalName, 'no_sentences', null, tier);
  }
  const sentEmbR = await embedder.embed(sentences.map((s) => s.sentence));
  const sentMat = makeMatrix(sentences.length, sentEmbR.dim, new Float32Array(sentEmbR.data));
  normalize(sentMat);

  const { posMat, negMat } = await getPrototypeMatrices(signalName);

  // 4. Top-K positive candidates + top-K negative candidates.
  //    semanticSearch returns [query][topK] of {corpus_id, score}.
  //    We use sentences as the corpus and prototypes as queries, then
  //    aggregate the best-prototype-score per sentence by max.
  const posHits = semanticSearch(posMat, sentMat, { topK: Math.min(cfg.topK * 2, sentences.length), scoreFn: 'dot_score' });
  const negHits = semanticSearch(negMat, sentMat, { topK: Math.min(cfg.topK * 2, sentences.length), scoreFn: 'dot_score' });
  const sentBestPos = new Map();
  for (const protoHits of posHits) for (const h of protoHits) {
    const prev = sentBestPos.get(h.corpus_id);
    if (prev == null || h.score > prev) sentBestPos.set(h.corpus_id, h.score);
  }
  const sentBestNeg = new Map();
  for (const protoHits of negHits) for (const h of protoHits) {
    const prev = sentBestNeg.get(h.corpus_id);
    if (prev == null || h.score > prev) sentBestNeg.set(h.corpus_id, h.score);
  }
  const posCandidates = [...sentBestPos.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cfg.topK)
    .map(([idx, score]) => ({ idx, score }));
  const negCandidates = [...sentBestNeg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cfg.topK)
    .map(([idx, score]) => ({ idx, score }));

  // 5. NLI-verify each top candidate against BOTH hypotheses.
  //
  // Candidate cosine floor — only sentences whose cosine to a positive
  // prototype is convincingly high get a real NLI verdict. distilbert
  // is overconfident on contradiction (gives ~1.0 contradict on ANY
  // sentence vs the negative hypothesis) so weakly-related sentences
  // were producing false confirmations. The cosine has to do the
  // semantic-relevance work; NLI just confirms direction.
  const CANDIDATE_COSINE_FLOOR = 0.72;
  const unionIdx = new Map();
  for (const c of posCandidates) {
    if (c.score < CANDIDATE_COSINE_FLOOR) continue;
    unionIdx.set(c.idx, Math.max(unionIdx.get(c.idx) ?? -Infinity, c.score));
  }
  for (const c of negCandidates) {
    if (c.score < CANDIDATE_COSINE_FLOOR) continue;
    unionIdx.set(c.idx, Math.max(unionIdx.get(c.idx) ?? -Infinity, c.score));
  }
  const candidateIdxs = [...unionIdx.entries()].sort((a, b) => b[1] - a[1]).slice(0, cfg.topK * 2);

  let nliDegraded = false;
  const scored = [];     // [{ idx, cosScore, supportScore, e_p, c_p, e_n, c_n }]
  try {
    for (const [idx, cos] of candidateIdxs) {
      const sent = sentences[idx];
      const [vP, vN] = await Promise.all([
        nli.verifyEntailment(sent.sentence, cfg.hypothesisPos),
        nli.verifyEntailment(sent.sentence, cfg.hypothesisNeg),
      ]);
      const supportScore = (vP.entail + vN.contradict) - (vN.entail + vP.contradict);
      scored.push({
        idx, cosScore: cos,
        supportScore,
        e_p: vP.entail, c_p: vP.contradict, n_p: vP.neutral,
        e_n: vN.entail, c_n: vN.contradict, n_n: vN.neutral,
      });
    }
  } catch (e) {
    nliDegraded = true;
    if (nli.isUnavailable && nli.isUnavailable() && posCandidates.length > 0) {
      const c = posCandidates[0];
      if (c.score >= cfg.posThreshold + 0.05) {
        const s = sentences[c.idx];
        return writeDecision({
          paperId, signalName, value: 'confirmed',
          quote: s.sentence,
          chunkId: s.chunk_id, page: s.page,
          mechanism: annotateMechanism('cosine_only(nli_unavailable)', tier),
          cosScore: c.score, nliScores: null,
        });
      }
    }
  }

  // 6. Decision. supportScore captures direction:
  //   support = entail_pos + contradict_neg − entail_neg − contradict_pos
  // The cosine floor above filters semantic-relevance; this just picks
  // the strongest-direction candidate that survived the cosine cut.
  const SUPPORT_FLOOR = 0.30;
  if (scored.length === 0) {
    return writeUnknown(paperId, signalName, 'no_cosine_candidate_above_floor', null, tier);
  }
  scored.sort((a, b) => Math.abs(b.supportScore) - Math.abs(a.supportScore));
  const picked = scored[0];
  const absScore = Math.abs(picked.supportScore);
  if (absScore < SUPPORT_FLOOR) {
    const s = sentences[picked.idx];
    return writeUnknown(paperId, signalName, 'support_below_floor', {
      quote: s.sentence,
      chunkId: s.chunk_id, page: s.page,
      cosScore: picked.cosScore,
      nliScores: {
        support_score: picked.supportScore,
        entail_pos: picked.e_p, contradict_pos: picked.c_p,
        entail_neg: picked.e_n, contradict_neg: picked.c_n,
      },
    }, tier);
  }
  let value, hypo;
  if (picked.supportScore > 0) {
    value = 'confirmed'; hypo = cfg.hypothesisPos;
  } else {
    value = 'refuted';   hypo = cfg.hypothesisNeg;
  }
  const s = sentences[picked.idx];
  return writeDecision({
    paperId, signalName, value,
    quote: s.sentence, chunkId: s.chunk_id, page: s.page,
    mechanism: annotateMechanism(`cosine+nli(${value})`, tier),
    cosScore: picked.cosScore,
    nliScores: {
      support_score: picked.supportScore,
      entail_pos: picked.e_p, contradict_pos: picked.c_p,
      entail_neg: picked.e_n, contradict_neg: picked.c_n,
      hypothesis_pos: cfg.hypothesisPos,
      hypothesis_neg: cfg.hypothesisNeg,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Writers
// ─────────────────────────────────────────────────────────────────────────

function writeDecision({ paperId, signalName, value, quote, chunkId, page, mechanism, cosScore, nliScores }) {
  const provId = store.recordProvenance({
    mechanism,
    model: nliScores ? nli.MODEL : null,
    chunk_id: chunkId,
    page,
    raw_text: quote,
    classifier_scores: {
      cosine: cosScore,
      ...(nliScores || {}),
    },
    confidence: typeof nliScores?.support_score === 'number'
      ? Math.abs(nliScores.support_score)
      : (nliScores?.entail ?? cosScore ?? 1.0),
  });
  store.exec('DELETE FROM paper_field WHERE paper_id = ? AND field_name = ?', [paperId, signalName]);
  store.exec(
    `INSERT INTO paper_field (paper_id, field_name, field_value, field_type, provenance_id)
     VALUES (?, ?, ?, 'bool3', ?)`,
    [paperId, signalName, value, provId],
  );
  return { signal: signalName, value, mechanism, page, quote, scores: { cosine: cosScore, ...(nliScores || {}) } };
}

function writeUnknown(paperId, signalName, reason, evidence, tier) {
  // `reason` ∈ {no_chunks, no_sentences, below_threshold, no_candidate_passed}.
  // We DO write an 'unknown' row (with provenance) so the detector layer
  // can distinguish "extractor checked and found nothing convincing"
  // from "extractor never ran on this paper" (in which case there's no row).
  const provId = store.recordProvenance({
    mechanism: annotateMechanism(`unknown:${reason}`, tier),
    model: evidence?.nliScores ? nli.MODEL : null,
    chunk_id: evidence?.chunkId || null,
    page: evidence?.page ?? null,
    raw_text: evidence?.quote || null,
    classifier_scores: {
      cosine: evidence?.cosScore ?? null,
      ...(evidence?.nliScores || {}),
    },
    confidence: 0,
  });
  store.exec('DELETE FROM paper_field WHERE paper_id = ? AND field_name = ?', [paperId, signalName]);
  store.exec(
    `INSERT INTO paper_field (paper_id, field_name, field_value, field_type, provenance_id)
     VALUES (?, ?, 'unknown', 'bool3', ?)`,
    [paperId, signalName, provId],
  );
  return { signal: signalName, value: 'unknown', reason, tier };
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run all five boolean-signal extractors for one paper. Writes paper_field
 * rows (field_type='bool3', value ∈ {confirmed, refuted, unknown}) and
 * provenance rows with the cosine candidate score + NLI distribution.
 *
 * opts:
 *   only        — array of signal names to run; default = all five
 *   verbose     — log per-candidate scores
 */
export async function extractBoolSignals(paperId, opts = {}) {
  await store.init();
  const which = Array.isArray(opts.only) && opts.only.length
    ? opts.only.filter((s) => s in SIGNALS)
    : Object.keys(SIGNALS);
  const results = [];
  for (const name of which) {
    try {
      const r = await extractOneSignal(paperId, name, opts);
      results.push(r);
    } catch (e) {
      console.warn(`bool_signals.${name} failed for paper ${paperId}:`, e?.message || e);
      results.push({ signal: name, value: null, error: e?.message || String(e) });
    }
  }
  return results;
}

export const SIGNAL_NAMES = Object.keys(SIGNALS);
export function getSignalConfig(name) {
  return SIGNALS[name] || null;
}
