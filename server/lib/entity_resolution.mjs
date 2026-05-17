// entity_resolution.mjs
//
// Canonicalisation of extracted named entities (datasets, frameworks,
// tech stack items, metrics, etc.) so the knowledge graph doesn't
// fragment on spelling variants. Without this, `BERT`, `BERT-base`,
// `bert (base)`, `bert base` and `BERT-Base` become five distinct
// nodes; every detector that touches `tech_stack` / `datasets` /
// `frameworks` silently miscounts.
//
// Three-pass match pipeline (cheap → expensive, first hit wins):
//
//   1. Exact match on the *normalised* form (lowercase, stripped
//      punctuation, stripped version-suffix). Catches the common case.
//   2. Alias list lookup. Each canonical entry carries a curated list
//      of known variant spellings.
//   3. Edit-distance match (Damerau-Levenshtein ≤ 2). Catches typos
//      and minor variants without semantic comparison.
//   4. Embedding cosine match (optional, requires an embedder). Catches
//      semantically equivalent variants the literal layers miss
//      (e.g. "PyTorch deep learning framework" → canonical "pytorch").
//      Only invoked when 1-3 fail, since it's the costly step.
//
// If all four fail, the caller can either:
//   - Accept the raw as a new canonical (auto-add to vocab), or
//   - Reject the candidate as low-confidence (status: 'low_confidence').
//
// The vocabulary persists to JSON at `data/_vocab/<kind>.json`. The
// SQLite `canonical_names` table is the runtime mirror; M1.7 wires them
// together so additions in either path stay in sync.

// ─────────────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────────────

// Strip a trailing version suffix that's unambiguously a *version*:
//   * has a 'v' prefix ("v2", "v2.3", "V1.0.4"), OR
//   * contains at least one decimal point ("2.0", "1.3.5", "10.4")
// A bare trailing single number ("3", "10", "100") is NOT stripped — those
// distinguish MIMIC-III vs MIMIC-IV, F1 vs F2, CIFAR-10 vs CIFAR-100,
// Llama-2 vs Llama-3, GPT-3 vs GPT-4, etc.
const VERSION_SUFFIX = /\s*[-_]?\s*(?:v\d+(?:\.\d+){0,3}|\d+\.\d+(?:\.\d+){0,3})\s*$/i;

// Punctuation we treat as separators rather than identity markers.
const PUNCT_TO_SPACE = /[()\[\]{}:;,!?'"`]/g;

// Hyphen/dot/slash/underscore inside a word: keep as part of the token
// (so "BERT-base" stays a unit) but strip when leading/trailing.
const EDGE_PUNCT = /^[-_./]+|[-_./]+$/g;

export function normalize(raw) {
  if (raw == null) return '';
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/[‘’“”]/g, "'");
  s = s.replace(VERSION_SUFFIX, '');
  s = s.replace(PUNCT_TO_SPACE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(EDGE_PUNCT, '');
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// Damerau-Levenshtein distance
// ─────────────────────────────────────────────────────────────────────────
//
// Counts insertions, deletions, substitutions, AND transpositions of two
// adjacent characters. Better than plain Levenshtein for typos like
// "scikti" → "scikit" (transposition counts as 1, not 2).

export function damerauLevenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // 2D matrix as flat typed array.
  const d = new Uint16Array((m + 1) * (n + 1));
  const idx = (i, j) => i * (n + 1) + j;
  for (let i = 0; i <= m; i++) d[idx(i, 0)] = i;
  for (let j = 0; j <= n; j++) d[idx(0, j)] = j;
  for (let i = 1; i <= m; i++) {
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      let best = Math.min(
        d[idx(i - 1, j)] + 1,         // deletion
        d[idx(i, j - 1)] + 1,         // insertion
        d[idx(i - 1, j - 1)] + cost,  // substitution
      );
      if (i > 1 && j > 1
          && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
          && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        best = Math.min(best, d[idx(i - 2, j - 2)] + 1);  // transposition
      }
      d[idx(i, j)] = best;
    }
  }
  return d[idx(m, n)];
}

// Normalised similarity: 1.0 = identical, 0.0 = totally different.
export function editSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - damerauLevenshtein(a, b) / maxLen;
}

// ─────────────────────────────────────────────────────────────────────────
// EntityResolver
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_EDIT_SIM_THRESHOLD = 0.85;
const DEFAULT_COSINE_THRESHOLD = 0.85;

export class EntityResolver {
  /**
   * kind:     'dataset' | 'tech' | 'framework' | 'metric' (informational)
   * embedFn:  optional async (text) → Float32Array; if provided enables
   *           the cosine fallback layer.
   */
  constructor({ kind, embedFn } = {}) {
    this.kind = kind || 'unknown';
    this.embedFn = embedFn || null;

    // canonical → { label, aliases: Set<string>, normalized, embedding?: Float32Array }
    this._entries = new Map();
    // normalized → canonical (reverse lookup for the exact-match layer)
    this._byNormalized = new Map();
    // normalized alias → canonical
    this._byAlias = new Map();
  }

  get size() { return this._entries.size; }

  /**
   * Load entries from a JSON blob. Shape:
   *   {
   *     kind: 'tech',
   *     entries: {
   *       pytorch:      { label: 'PyTorch',      aliases: ['py-torch'] },
   *       'scikit-learn': { label: 'scikit-learn', aliases: ['sklearn', 'scikit learn'] },
   *       ...
   *     }
   *   }
   */
  loadFromObject(blob) {
    if (!blob || typeof blob !== 'object' || !blob.entries) return;
    for (const [canonical, info] of Object.entries(blob.entries)) {
      const label = info?.label || canonical;
      const aliases = Array.isArray(info?.aliases) ? info.aliases : [];
      this.add(canonical, { label, aliases });
    }
  }

  /** Snapshot to a JSON-serialisable object. */
  toObject() {
    const entries = {};
    for (const [canonical, info] of this._entries) {
      entries[canonical] = {
        label: info.label,
        aliases: [...info.aliases],
      };
    }
    return { kind: this.kind, version: 1, entries };
  }

  /**
   * Register or update a canonical entry.
   * opts.label    — display form
   * opts.aliases  — known variant spellings
   * opts.embedding — pre-computed Float32Array (optional)
   */
  add(canonical, opts = {}) {
    const c = String(canonical || '').trim();
    if (!c) throw new Error('EntityResolver.add: canonical required');
    const normalized = normalize(c);
    const existing = this._entries.get(c);
    const aliases = new Set(existing?.aliases || []);
    for (const a of opts.aliases || []) aliases.add(String(a));
    const entry = {
      label: opts.label ?? existing?.label ?? c,
      aliases,
      normalized,
      embedding: opts.embedding ?? existing?.embedding ?? null,
    };
    this._entries.set(c, entry);
    this._byNormalized.set(normalized, c);
    for (const a of aliases) this._byAlias.set(normalize(a), c);
    return c;
  }

  /**
   * Canonicalise a raw string. Returns
   *   { canonical, label, mechanism, score, raw_normalized, status }
   * status:
   *   'exact'       — normalised string matched a canonical or alias
   *   'edit'        — close enough by edit distance
   *   'embedding'   — close enough by cosine to a registered embedding
   *   'low_confidence' — no match; caller decides whether to add or reject
   *
   * opts:
   *   editThreshold     — normalised similarity floor (default 0.85)
   *   cosineThreshold   — cosine floor for embedding match (default 0.85)
   *   skipEmbedding     — disable the cosine fallback for this call
   */
  async canonicalise(raw, opts = {}) {
    const editThreshold = opts.editThreshold ?? DEFAULT_EDIT_SIM_THRESHOLD;
    const cosineThreshold = opts.cosineThreshold ?? DEFAULT_COSINE_THRESHOLD;
    const skipEmbedding = !!opts.skipEmbedding;

    const rawNorm = normalize(raw);
    if (!rawNorm) return {
      canonical: null, label: null, mechanism: null, score: 0,
      raw_normalized: '', status: 'low_confidence',
    };

    // Layer 1: exact normalised match (canonical or alias).
    const exactCanon = this._byNormalized.get(rawNorm) || this._byAlias.get(rawNorm);
    if (exactCanon) {
      const e = this._entries.get(exactCanon);
      return {
        canonical: exactCanon, label: e.label,
        mechanism: 'exact', score: 1.0,
        raw_normalized: rawNorm, status: 'exact',
      };
    }

    // Layer 2: edit-distance match across canonicals + aliases.
    let bestEdit = null;
    for (const [normFormA, canonical] of this._byNormalized) {
      const sim = editSimilarity(rawNorm, normFormA);
      if (sim >= editThreshold && (!bestEdit || sim > bestEdit.score)) {
        bestEdit = { canonical, score: sim };
      }
    }
    for (const [normAlias, canonical] of this._byAlias) {
      const sim = editSimilarity(rawNorm, normAlias);
      if (sim >= editThreshold && (!bestEdit || sim > bestEdit.score)) {
        bestEdit = { canonical, score: sim };
      }
    }
    if (bestEdit) {
      const e = this._entries.get(bestEdit.canonical);
      return {
        canonical: bestEdit.canonical, label: e.label,
        mechanism: 'edit', score: bestEdit.score,
        raw_normalized: rawNorm, status: 'edit',
      };
    }

    // Layer 3: embedding cosine match (optional).
    if (this.embedFn && !skipEmbedding && this._entries.size > 0) {
      const queryEmb = await this.embedFn(rawNorm);
      if (queryEmb) {
        let bestCos = null;
        for (const [canonical, entry] of this._entries) {
          if (!entry.embedding) {
            entry.embedding = await this.embedFn(entry.normalized);
          }
          if (!entry.embedding) continue;
          const sim = cosineUnnormalized(queryEmb, entry.embedding);
          if (sim >= cosineThreshold && (!bestCos || sim > bestCos.score)) {
            bestCos = { canonical, score: sim };
          }
        }
        if (bestCos) {
          const e = this._entries.get(bestCos.canonical);
          return {
            canonical: bestCos.canonical, label: e.label,
            mechanism: 'embedding', score: bestCos.score,
            raw_normalized: rawNorm, status: 'embedding',
          };
        }
      }
    }

    // No match.
    return {
      canonical: null, label: null,
      mechanism: null, score: 0,
      raw_normalized: rawNorm, status: 'low_confidence',
    };
  }

  /**
   * Convenience: canonicalise OR add-as-new. Returns the canonical (creates
   * it if status was 'low_confidence', so callers don't need to branch).
   * Use sparingly — auto-add is appropriate for confident NER outputs, but
   * for fuzzy regex hits prefer explicit `canonicalise` and let the caller
   * decide.
   */
  async canonicaliseOrAdd(raw, opts = {}) {
    const res = await this.canonicalise(raw, opts);
    if (res.status !== 'low_confidence') return res;
    // Auto-add. Use the normalised form as the canonical id; preserve the
    // raw as the display label and as an alias.
    const canonical = res.raw_normalized;
    this.add(canonical, { label: String(raw).trim(), aliases: [String(raw)] });
    return {
      canonical, label: String(raw).trim(),
      mechanism: 'new', score: 1.0,
      raw_normalized: canonical, status: 'new',
    };
  }
}

// Cosine for raw embeddings (which may or may not be L2-normalised).
// Embedder.mjs L2-normalises outputs, so dot product would suffice for
// those; we use unnormalised cosine to be safe if a caller passes raw.
function cosineUnnormalized(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
