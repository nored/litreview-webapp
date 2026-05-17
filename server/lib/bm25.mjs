// bm25.mjs
//
// Pure-JS BM25 ranking. The sparse half of the hybrid retrieval pair —
// BM25 catches exact technical terms (dataset names, framework names,
// metric names, acronyms) that semantic embeddings can blur, while the
// dense embedder catches paraphrase / synonymy. Hybrid retrieval combines
// both via Reciprocal Rank Fusion (see hybrid_retrieval.mjs in M1.4).
//
// Algorithm (Robertson & Walker, the "Okapi BM25" variant):
//
//   score(D, Q) = Σ_{q ∈ Q}  IDF(q) ·  f(q,D)·(k1+1) / (f(q,D) + k1·(1 - b + b·|D|/avgdl))
//
//   IDF(q) = ln( (N - df(q) + 0.5) / (df(q) + 0.5) + 1 )
//
// where f(q,D) is the term frequency of q in document D, |D| is the
// document length in tokens, avgdl is the average document length across
// the indexed collection, N is the total number of indexed documents,
// and df(q) is the number of documents that contain q at least once.
// k1 ≈ 1.2–2.0 and b ≈ 0.75 are the standard tuning parameters; defaults
// below match the conventional Okapi defaults.
//
// Persistence: the index serialises to a JSON blob via toJSON() / fromJSON().
// At thesis scale (~10k chunks) the blob is ~5–20MB; a binary format would
// shave bytes but isn't worth the complexity yet.

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------
//
// Simple, deterministic, no stemming. Modern BM25 + dense hybrid does well
// without stemming because the dense half catches morphological variants
// the lexical side misses. Stopwords are a short curated list to keep
// noise out of the IDF.

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

const MIN_TOKEN_LENGTH = 2;
const MAX_TOKEN_LENGTH = 60;

export function tokenize(text) {
  if (!text) return [];
  const tokens = String(text)
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")         // smart quotes → ascii
    .replace(/[^a-z0-9_\-./]+/g, ' ')                     // keep letters, digits, underscore, dash, slash, dot
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  for (let t of tokens) {
    // Strip leading/trailing dots/slashes/dashes from terms (artefacts
    // of running parses through stripped punctuation).
    t = t.replace(/^[-./]+|[-./]+$/g, '');
    if (t.length < MIN_TOKEN_LENGTH || t.length > MAX_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// BM25Index
// ---------------------------------------------------------------------------

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

export class BM25Index {
  constructor(opts = {}) {
    this.k1 = opts.k1 ?? DEFAULT_K1;
    this.b = opts.b ?? DEFAULT_B;

    // term → { df, postings: Map<doc_id, tf> }
    // df is denormalised on writes so search() doesn't recount.
    this._terms = new Map();
    // doc_id → length (token count, including duplicates)
    this._docLengths = new Map();
    this._totalLength = 0;
  }

  get numDocs() { return this._docLengths.size; }
  get avgDocLength() {
    return this._docLengths.size ? this._totalLength / this._docLengths.size : 0;
  }
  get numTerms() { return this._terms.size; }

  /**
   * Add a document (or replace an existing one with the same id).
   * Returns the number of tokens indexed.
   */
  add(docId, text) {
    if (docId == null || docId === '') throw new Error('BM25Index.add: docId required');
    if (this._docLengths.has(docId)) this.remove(docId);
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      // Still record the doc — zero-length docs exist (e.g. an empty chunk).
      this._docLengths.set(docId, 0);
      return 0;
    }
    // Count term frequencies in this doc.
    const tfs = new Map();
    for (const t of tokens) tfs.set(t, (tfs.get(t) || 0) + 1);
    for (const [t, tf] of tfs) {
      let entry = this._terms.get(t);
      if (!entry) { entry = { df: 0, postings: new Map() }; this._terms.set(t, entry); }
      entry.postings.set(docId, tf);
      entry.df = entry.postings.size;
    }
    this._docLengths.set(docId, tokens.length);
    this._totalLength += tokens.length;
    return tokens.length;
  }

  /**
   * Remove a document. No-op if not present.
   */
  remove(docId) {
    if (!this._docLengths.has(docId)) return;
    const len = this._docLengths.get(docId);
    this._docLengths.delete(docId);
    this._totalLength -= len;
    // Walk every term and drop this doc from the postings (cheap because
    // most terms don't reference this doc; we could optimize by keeping a
    // reverse map, but at thesis scale it's not worth it).
    for (const [term, entry] of this._terms) {
      if (entry.postings.delete(docId)) {
        entry.df = entry.postings.size;
        if (entry.df === 0) this._terms.delete(term);
      }
    }
  }

  /** Wipe the index. */
  clear() {
    this._terms.clear();
    this._docLengths.clear();
    this._totalLength = 0;
  }

  /**
   * Inverse document frequency for term q.
   * Returns 0 (not negative) for terms that appear in > half the corpus —
   * standard Okapi tweak to avoid negative IDFs harming scores.
   */
  _idf(term) {
    const entry = this._terms.get(term);
    if (!entry) return 0;
    const n = this.numDocs;
    const df = entry.df;
    const num = n - df + 0.5;
    const den = df + 0.5;
    const idf = Math.log(num / den + 1);
    // Standard variant; idf is always > 0 because of the +1.
    return idf;
  }

  /**
   * Rank documents against a query. Returns [{doc_id, score}, ...] sorted
   * descending by score, capped at topK.
   *
   * opts:
   *   topK            — max results (default 10)
   *   minScore        — drop docs below this (default 0)
   *   scoreThreshold  — alias for minScore
   */
  search(queryText, opts = {}) {
    const topK = opts.topK ?? 10;
    const minScore = opts.minScore ?? opts.scoreThreshold ?? 0;
    const queryTerms = tokenize(queryText);
    if (queryTerms.length === 0 || this.numDocs === 0) return [];

    // Unique query terms — repeated terms don't change BM25's per-doc
    // contribution beyond what their per-doc tf in the document gives.
    const uniqueQueryTerms = Array.from(new Set(queryTerms));
    const avgdl = this.avgDocLength;
    const k1 = this.k1;
    const b = this.b;

    const scores = new Map();
    for (const q of uniqueQueryTerms) {
      const entry = this._terms.get(q);
      if (!entry) continue;
      const idf = this._idf(q);
      if (idf <= 0) continue;
      for (const [docId, tf] of entry.postings) {
        const docLen = this._docLengths.get(docId) || 0;
        const norm = docLen / (avgdl || 1);
        const denom = tf + k1 * (1 - b + b * norm);
        const contribution = idf * (tf * (k1 + 1)) / (denom || 1);
        scores.set(docId, (scores.get(docId) || 0) + contribution);
      }
    }

    const ranked = [];
    for (const [docId, score] of scores) {
      if (score >= minScore) ranked.push({ doc_id: docId, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, topK);
  }

  // -----------------------------------------------------------------------
  // Persistence — JSON-serialisable form. Maps become object dicts; the
  // postings shape stays sparse. fromJSON reconstructs the Map-backed
  // internals so search() stays O(unique query terms · avg postings/term).
  // -----------------------------------------------------------------------

  toJSON() {
    const terms = {};
    for (const [term, entry] of this._terms) {
      const postings = {};
      for (const [docId, tf] of entry.postings) postings[docId] = tf;
      terms[term] = { df: entry.df, postings };
    }
    const docLengths = {};
    for (const [docId, len] of this._docLengths) docLengths[docId] = len;
    return {
      version: 1,
      k1: this.k1,
      b: this.b,
      total_length: this._totalLength,
      doc_lengths: docLengths,
      terms,
    };
  }

  static fromJSON(blob) {
    const idx = new BM25Index({ k1: blob.k1, b: blob.b });
    for (const [term, { df, postings }] of Object.entries(blob.terms || {})) {
      const m = new Map();
      for (const [docId, tf] of Object.entries(postings || {})) m.set(docId, tf);
      idx._terms.set(term, { df, postings: m });
    }
    for (const [docId, len] of Object.entries(blob.doc_lengths || {})) {
      idx._docLengths.set(docId, len);
    }
    idx._totalLength = blob.total_length ?? 0;
    return idx;
  }
}

// ---------------------------------------------------------------------------
// Convenience: build an index from an array of {doc_id, text}.
// ---------------------------------------------------------------------------

export function buildIndex(docs, opts = {}) {
  const idx = new BM25Index(opts);
  for (const d of docs) idx.add(d.doc_id, d.text);
  return idx;
}
