// extractors/_entity_typing.mjs
//
// Zero-shot type classifier for candidate entity spans. Takes a proposed
// span (from _span_proposal.mjs), looks at its sentence context, and
// assigns one of the user's `entity_types` from topic.md. No dictionary;
// the types are short prompts the user (or auto-seed) maintains in topic.md.
//
// Two-stage classification:
//
//   1. Embedding cosine: the span PLUS its sentence is embedded once. Each
//      `entity_type` is expanded into 1-3 prototype sentences ("X is a
//      cryptographic primitive used in security protocols"), pre-embedded
//      and cached. Top-N closest types pass to stage 2.
//
//   2. NLI verification: for each top-N type, ask "Does the sentence
//      entail that <span> is a <type>?". Accept the strongest entailment
//      that beats the runner-up by a margin.
//
// Output per accepted span:
//   { kind, canonical, raw, span_text, page, chunk_id,
//     scores: { cosine, entail, neutral, contradict, margin },
//     all_type_scores: [...] }
//
// kind is the user's entity_type token. canonical is a slug for the
// span suitable for the canonical_names table. raw is the verbatim text.
//
// No type can be assigned without both cosine and NLI agreeing — a span
// matching no type with both is dropped (returns null).

import * as embedder from '../embedder.mjs';
import * as nli from '../nli.mjs';
import { makeMatrix, normalize, semanticSearch } from '../sbert_utils.mjs';
import { sentenceContext } from './_span_proposal.mjs';

// Cosine floor for stage 1. Below this the span doesn't get NLI-verified
// against this type. bge-small short-phrase cosines run ~0.4 baseline,
// so this is a soft filter.
const COSINE_FLOOR = 0.40;
// How many top types get NLI verification per span.
const TOP_TYPES_NLI = 3;
// NLI entailment threshold to accept a type assignment.
const NLI_ACCEPT = 0.45;
// Margin (best - second) on NLI required.
const NLI_MARGIN = 0.05;

// ─────────────────────────────────────────────────────────────────────────
// Type prototype catalogue
// ─────────────────────────────────────────────────────────────────────────
//
// Each entity_type maps to:
//   prototypes  — 1-3 short sentences describing the type. Embedded.
//   hypothesis  — single NLI hypothesis template containing {span}.
//
// Built-in prototypes are intentionally MINIMAL and domain-neutral. They
// work for any field — CS, business, history, biomedical, social science.
// The user (or auto-seed) declares the FULL list of entity_types in
// topic.md; anything not in this catalogue gets a generic prototype +
// hypothesis via genericTypeEntry().
//
// Why so few defaults: hardcoding "library" / "attack_technique" /
// "mitigation" biases the system toward CS. For a history topic the
// useful types are person, place, treaty, regime; for business they're
// company, kpi, regulation. Defaults must not steer the user away from
// the right vocabulary for their field — they only describe types so
// universal they apply almost anywhere.
const BUILTIN_TYPES = {
  person: {
    prototypes: [
      'A specific named individual person.',
      'A historical figure, researcher, author, or named human actor.',
    ],
    hypothesis: 'In this sentence, {span} is a specific named person.',
  },
  organisation: {
    prototypes: [
      'A named organisation, company, institution, or group.',
      'A formal entity that operates as a collective actor.',
    ],
    hypothesis: 'In this sentence, {span} is an organisation, company, or institution.',
  },
  place: {
    prototypes: [
      'A named geographical place, country, city, or region.',
      'A specific physical location with a recognised name.',
    ],
    hypothesis: 'In this sentence, {span} is a named place or geographical location.',
  },
  time_period: {
    prototypes: [
      'A specific historical period, era, or named time span.',
      'A bounded interval of time with a recognised label.',
    ],
    hypothesis: 'In this sentence, {span} is a named time period or era.',
  },
  document: {
    prototypes: [
      'A specific named document, treaty, agreement, or publication.',
      'A written artefact with a formal title.',
    ],
    hypothesis: 'In this sentence, {span} is a named document or publication.',
  },
  quantity: {
    prototypes: [
      'A named quantitative measure, metric, or indicator.',
      'A score or value used to quantify something.',
    ],
    hypothesis: 'In this sentence, {span} is a named quantitative measure or indicator.',
  },
  concept: {
    prototypes: [
      'A specific named concept, theory, framework, or methodological approach.',
      'A coined term that refers to a definable abstract idea.',
    ],
    hypothesis: 'In this sentence, {span} is a named concept, theory, or framework.',
  },
};

// Generic fallback for user-defined types not in BUILTIN_TYPES.
function genericTypeEntry(typeName) {
  const human = String(typeName).replace(/_/g, ' ');
  return {
    prototypes: [`A specific named ${human}.`],
    hypothesis: `In this sentence, {span} is a ${human}.`,
  };
}

// Resolve user's entity_types list into the full prototype catalogue.
function buildTypeCatalogue(userTypes) {
  const types = Array.isArray(userTypes) && userTypes.length
    ? userTypes
    : Object.keys(BUILTIN_TYPES);
  const out = [];
  for (const t of types) {
    const entry = BUILTIN_TYPES[t] || genericTypeEntry(t);
    out.push({ name: t, prototypes: entry.prototypes, hypothesis: entry.hypothesis });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Prototype embeddings — cached per (catalogue fingerprint, process)
// ─────────────────────────────────────────────────────────────────────────

let _cachedFingerprint = null;
let _cachedProto = null;

async function getPrototypeMatrix(catalogue) {
  const fingerprint = catalogue.map((t) => t.name + ':' + t.prototypes.join('|')).join('\n');
  if (_cachedFingerprint === fingerprint && _cachedProto) return _cachedProto;
  const texts = [];
  const typeIndex = [];  // parallel to texts: which type each prototype belongs to
  for (let ti = 0; ti < catalogue.length; ti++) {
    for (const p of catalogue[ti].prototypes) {
      texts.push(p);
      typeIndex.push(ti);
    }
  }
  const emb = await embedder.embed(texts);
  const mat = makeMatrix(texts.length, emb.dim, new Float32Array(emb.data));
  normalize(mat);
  _cachedFingerprint = fingerprint;
  _cachedProto = { mat, typeIndex, catalogue };
  return _cachedProto;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-span classification
// ─────────────────────────────────────────────────────────────────────────

/**
 * Classify a single proposed span into one of the catalogue types. Returns:
 *   { kind, scores: { cosine, entail, neutral, contradict, margin },
 *     all_type_scores: [{type, cosine, entail}], context_sentence }
 * or null if no type both passes cosine floor AND clears NLI threshold.
 *
 * opts.chunkText — full chunk text (for sentence context window)
 * opts.userTypes — user's entity_types list (from topic.md). Defaults to
 *                  BUILTIN_TYPES if empty.
 */
export async function classifySpan(span, chunkText, opts = {}) {
  const userTypes = opts.userTypes;
  const catalogue = buildTypeCatalogue(userTypes);
  if (catalogue.length === 0) return null;

  // Build the query string: span + its sentence context.
  const ctx = sentenceContext(chunkText, span.start, span.end, 80);
  const query = ctx ? `${span.text}. ${ctx}` : span.text;

  // Stage 1: cosine to type prototypes.
  const qEmb = await embedder.embed([query]);
  const qMat = makeMatrix(1, qEmb.dim, new Float32Array(qEmb.data));
  normalize(qMat);
  const { mat: protoMat, typeIndex } = await getPrototypeMatrix(catalogue);
  const hits = semanticSearch(qMat, protoMat, {
    topK: protoMat.rows,
    scoreFn: 'dot_score',
  });
  // Max-over-prototypes per type.
  const typeMax = new Map();   // type_index -> max_cosine
  for (const h of hits[0]) {
    const ti = typeIndex[h.corpus_id];
    if (typeMax.get(ti) == null || h.score > typeMax.get(ti)) typeMax.set(ti, h.score);
  }
  const ranked = [...typeMax.entries()]
    .map(([ti, score]) => ({ type: catalogue[ti].name, cosine: score, ti }))
    .sort((a, b) => b.cosine - a.cosine);

  // Pre-filter by cosine floor for the NLI pass.
  const candidates = ranked.filter((r) => r.cosine >= COSINE_FLOOR).slice(0, TOP_TYPES_NLI);
  const allScores = ranked.slice(0, 5).map((r) => ({ type: r.type, cosine: Number(r.cosine.toFixed(4)) }));
  if (candidates.length === 0) {
    return null;
  }

  // Stage 2: NLI verification. Batched: one call per candidate type
  // (typically 3) classifying the same context sentence against the type
  // hypothesis (with {span} substituted in).
  if (nli.isUnavailable && nli.isUnavailable()) {
    // No NLI — fall back to cosine-only. Accept the top type if cosine
    // is well above the floor (margin over runner-up).
    const top = candidates[0];
    const margin = top.cosine - (candidates[1]?.cosine || 0);
    if (top.cosine >= COSINE_FLOOR + 0.08 && margin >= 0.05) {
      return {
        kind: top.type,
        scores: { cosine: top.cosine, entail: null, neutral: null, contradict: null, margin },
        all_type_scores: allScores,
        context_sentence: ctx,
        mechanism: 'cosine_only(nli_unavailable)',
      };
    }
    return null;
  }

  let bestNli = null;   // { type, entail, neutral, contradict, cosine }
  let secondEntail = 0;
  for (const cand of candidates) {
    const tEntry = catalogue[cand.ti];
    const hyp = tEntry.hypothesis.replace('{span}', span.text);
    try {
      const r = await nli.verifyEntailment(ctx || span.text, hyp);
      if (!bestNli || r.entail > bestNli.entail) {
        if (bestNli) secondEntail = Math.max(secondEntail, bestNli.entail);
        bestNli = {
          type: cand.type, ti: cand.ti,
          entail: r.entail, neutral: r.neutral, contradict: r.contradict,
          cosine: cand.cosine,
        };
      } else if (r.entail > secondEntail) {
        secondEntail = r.entail;
      }
    } catch { /* skip on NLI failure */ }
  }
  if (!bestNli) return null;
  const nliMargin = bestNli.entail - secondEntail;
  if (bestNli.entail < NLI_ACCEPT || nliMargin < NLI_MARGIN) {
    return null;
  }

  return {
    kind: bestNli.type,
    scores: {
      cosine: Number(bestNli.cosine.toFixed(4)),
      entail: Number(bestNli.entail.toFixed(4)),
      neutral: Number(bestNli.neutral.toFixed(4)),
      contradict: Number(bestNli.contradict.toFixed(4)),
      margin: Number(nliMargin.toFixed(4)),
    },
    all_type_scores: allScores,
    context_sentence: ctx,
    mechanism: 'cosine+nli_type',
  };
}

/**
 * Classify many spans, sharing the prototype-embedding cache across them.
 * Used by named_entities.mjs to process every span proposed for a paper.
 */
export async function classifySpansBatch(spans, chunkTextById, opts = {}) {
  const out = [];
  for (const s of spans) {
    const chunkText = chunkTextById.get(s.chunk_id) || '';
    const result = await classifySpan(s, chunkText, opts);
    if (result) {
      out.push({
        ...result,
        text: s.text,
        chunk_id: s.chunk_id,
        page: s.page,
        sources: s.sources,
        ner_score: s.ner_score,
      });
    }
  }
  return out;
}

// Slugify a span into a canonical_names id.
export function canonicaliseSlug(raw) {
  return String(raw).toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._+-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const BUILTIN_TYPE_NAMES = Object.keys(BUILTIN_TYPES);
