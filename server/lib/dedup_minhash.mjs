// dedup_minhash.mjs
//
// MinHash + Jaccard near-duplicate detection. Pure JS, deterministic given
// a fixed seed. The existing search-stage dedup (server/lib/search.mjs)
// already catches exact DOI / title duplicates; MinHash catches the
// trickier near-duplicates that share substantial text:
//
//   - preprint (arXiv) + later journal version
//   - workshop paper + extended conference paper
//   - conference paper + extended journal version
//   - self-republished work with minor tweaks
//
// Algorithm:
//
//   1. Tokenise text into word n-grams (shingles).
//   2. For each of S hash functions, compute h_i(shingle) for every shingle
//      and take the minimum — that's the i-th element of the document's
//      "MinHash signature".
//   3. Jaccard similarity between two documents is estimated as the
//      fraction of matching positions in their signatures. Estimate
//      variance shrinks like 1/√S, so S=128 gives ±9% precision; S=256
//      gives ±6%. 128 is the standard pick.
//
// For thesis-scale corpora (~hundreds to a few thousand papers) we do
// the obvious O(N²) all-pairs comparison after computing signatures.
// That's trivial: 400 papers × 128 ints/signature × 80k pairs ≈ 10ms
// of comparison work. LSH bucketing is the standard scale-up; we'll
// add it only when N pushes us past ~10k papers (no current pressure).

// ─────────────────────────────────────────────────────────────────────────
// Shingling
// ─────────────────────────────────────────────────────────────────────────

// Default shingle size = 3 words. For paper-scale text (abstracts 150-300
// words, full papers thousands), 3-word shingles balance sensitivity to
// small edits with enough shingles for stable Jaccard estimation. Size 5
// is more selective for very long docs; size 2 is for very short titles.
const DEFAULT_SHINGLE_SIZE = 3;

// Tokenise text into lowercased words. Simpler than the BM25 tokenizer
// — no stopword filtering here, because for near-duplicate detection
// stopwords *are* signal (two papers that share stopword cadence are
// candidate copies).
function tokens(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9_\-./]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Generate word n-gram shingles. Yields each shingle as a string.
function* shingleStrings(text, size = DEFAULT_SHINGLE_SIZE) {
  const toks = tokens(text);
  if (toks.length < size) {
    // Short docs: still emit something so they have a non-empty signature.
    if (toks.length > 0) yield toks.join(' ');
    return;
  }
  for (let i = 0; i <= toks.length - size; i++) {
    yield toks.slice(i, i + size).join(' ');
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────
//
// FNV-1a 32-bit string hash. Cheap, well-distributed for small inputs.
// We use this as the base hash; the S independent MinHash functions are
// derived from one base hash via affine transforms (a*h + b) mod P. This
// is the standard "k-wise independence via linear maps" trick — much
// cheaper than computing S full hash functions per shingle.

const FNV_PRIME = 16777619;
const FNV_OFFSET = 2166136261;

function fnv1a(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;  // unsigned 32-bit
}

// Mersenne prime > 2^32 used as modulus; ensures result fits comfortably.
const MOD = 4294967311;  // smallest prime > 2^32

// Seeded PRNG (mulberry32) so signatures are reproducible across runs.
function makePrng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MinHash signature
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_NUM_HASHES = 128;
const DEFAULT_SEED = 0x9E3779B1;   // golden ratio constant — arbitrary but fixed

function makeHashCoefficients(numHashes, seed) {
  const prng = makePrng(seed);
  const a = new Uint32Array(numHashes);
  const b = new Uint32Array(numHashes);
  for (let i = 0; i < numHashes; i++) {
    // a must be non-zero for the hash to be a permutation.
    let av;
    do { av = prng(); } while (av === 0);
    a[i] = av;
    b[i] = prng();
  }
  return { a, b };
}

/**
 * Compute a MinHash signature for a single text.
 *
 * opts:
 *   numHashes    — signature length (default 128)
 *   shingleSize  — word n-gram size (default 5)
 *   seed         — PRNG seed for hash coefficients (default 0x9E3779B1)
 *
 * Returns a Uint32Array of length numHashes.
 */
export function minHashOfText(text, opts = {}) {
  const numHashes = opts.numHashes ?? DEFAULT_NUM_HASHES;
  const shingleSize = opts.shingleSize ?? DEFAULT_SHINGLE_SIZE;
  const seed = opts.seed ?? DEFAULT_SEED;
  return _minHashWith(text, numHashes, shingleSize, makeHashCoefficients(numHashes, seed));
}

function _minHashWith(text, numHashes, shingleSize, coeffs) {
  const sig = new Uint32Array(numHashes).fill(0xFFFFFFFF);
  const { a, b } = coeffs;
  let any = false;
  for (const sh of shingleStrings(text, shingleSize)) {
    any = true;
    const baseHash = fnv1a(sh);
    for (let i = 0; i < numHashes; i++) {
      // (a_i * base + b_i) mod MOD, all 32-bit unsigned.
      const h = (Math.imul(a[i], baseHash) + b[i]) >>> 0;
      const v = h % MOD;
      if (v < sig[i]) sig[i] = v;
    }
  }
  // Empty doc: leave signature as all-FFFFFFFF. Jaccard to anything else
  // will be 0, which is right.
  return sig;
}

/**
 * Estimate Jaccard similarity between two signatures.
 * Both must be the same length and computed with the same seed/numHashes.
 */
export function jaccard(sigA, sigB) {
  if (!sigA || !sigB || sigA.length !== sigB.length || sigA.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < sigA.length; i++) {
    if (sigA[i] === sigB[i]) matches++;
  }
  return matches / sigA.length;
}

// ─────────────────────────────────────────────────────────────────────────
// Near-duplicate detector (stateful, all-pairs)
// ─────────────────────────────────────────────────────────────────────────

// Threshold guide for paper-level near-duplicate detection (3-word shingles
// on full abstracts). Empirically:
//   ≥ 0.7   obvious duplicate (lightly edited republish)
//   0.4-0.7 likely different versions of the same work (preprint ↔ journal,
//           conference ↔ extended journal). Default for "suggest possible
//           duplicates" workflows.
//   0.2-0.4 same topic / overlapping vocabulary, distinct papers
//   < 0.2   essentially independent
//
// Default leaves the conservative 0.7 — only flag clear duplicates without
// human review. Callers in suggestion-mode should lower to ~0.4.
const DEFAULT_DUPLICATE_THRESHOLD = 0.7;

export class NearDuplicateDetector {
  /**
   * opts:
   *   numHashes    — signature length (default 128)
   *   shingleSize  — word n-gram size (default 5)
   *   seed         — PRNG seed (default 0x9E3779B1)
   *   threshold    — Jaccard cutoff for "near-duplicate" (default 0.7)
   */
  constructor(opts = {}) {
    this.numHashes = opts.numHashes ?? DEFAULT_NUM_HASHES;
    this.shingleSize = opts.shingleSize ?? DEFAULT_SHINGLE_SIZE;
    this.seed = opts.seed ?? DEFAULT_SEED;
    this.threshold = opts.threshold ?? DEFAULT_DUPLICATE_THRESHOLD;
    this._coeffs = makeHashCoefficients(this.numHashes, this.seed);
    this._signatures = new Map();    // doc_id → Uint32Array
  }

  get size() { return this._signatures.size; }

  /**
   * Add a document. Returns the computed signature for inspection.
   * Replaces the signature if doc_id is already present.
   */
  add(docId, text) {
    const sig = _minHashWith(text, this.numHashes, this.shingleSize, this._coeffs);
    this._signatures.set(docId, sig);
    return sig;
  }

  remove(docId) {
    this._signatures.delete(docId);
  }

  /**
   * Return all known near-duplicates of doc_id, sorted by Jaccard desc.
   * Returns [{ doc_id, jaccard }, ...]; excludes the query doc itself.
   */
  findDuplicates(docId, threshold = this.threshold) {
    const sig = this._signatures.get(docId);
    if (!sig) return [];
    const out = [];
    for (const [otherId, otherSig] of this._signatures) {
      if (otherId === docId) continue;
      const j = jaccard(sig, otherSig);
      if (j >= threshold) out.push({ doc_id: otherId, jaccard: j });
    }
    out.sort((a, b) => b.jaccard - a.jaccard);
    return out;
  }

  /**
   * All pairs above threshold across the indexed set. Returns
   * [{ a, b, jaccard }, ...] with a < b lexicographically to avoid
   * duplicate pairs.
   */
  pairs(threshold = this.threshold) {
    const ids = [...this._signatures.keys()].sort();
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const aId = ids[i];
      const aSig = this._signatures.get(aId);
      for (let j = i + 1; j < ids.length; j++) {
        const bId = ids[j];
        const bSig = this._signatures.get(bId);
        const sim = jaccard(aSig, bSig);
        if (sim >= threshold) out.push({ a: aId, b: bId, jaccard: sim });
      }
    }
    out.sort((a, b) => b.jaccard - a.jaccard);
    return out;
  }
}
