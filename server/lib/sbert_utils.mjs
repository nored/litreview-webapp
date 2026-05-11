// sbert_utils.mjs
//
// JS port of the sentence-transformers utility functions we rely on across
// the litreview pipeline. Source of truth for the algorithms:
//   https://github.com/huggingface/sentence-transformers/blob/main/sentence_transformers/util/
//
// Design choices:
//   - Embeddings are passed as { data: Float32Array, rows, dim } "matrices",
//     row-major. This is the layout sentence-transformers tensors flatten to,
//     it's allocation-free to slice rows, and Float32Array transfers cheaply
//     to Web Workers via postMessage.
//   - All math is single-precision float and runs on the main JS engine; no
//     WASM, no native deps. Hot loops use typed-array reads and avoid object
//     churn so they stay fast at thesis-corpus scale (10k–40k vectors).
//   - The API surface intentionally mirrors the Python names so future ports
//     of additional sentence-transformers utilities slot in cleanly.
//
// Exported:
//   makeMatrix(rows, dim, data?)         build/wrap a flat-row matrix
//   row(M, i)                            view of a single row (no copy)
//   normalize(M)                         L2-normalize each row in place
//   cosSim(A, B)                         row-pairs cosine; A.rows × B.rows
//   dotScore(A, B)                       row-pairs dot product
//   semanticSearch(Q, C, opts)           top-K hits per query
//   paraphraseMining(M, opts)            high-similarity pairs in a corpus
//   communityDetection(M, opts)          embedding-native clustering
//   quantize(M, { kind })                int8 or binary quantization
//   dequantizeInt8(Q)                    inverse of int8 quantize
//   truncateDims(M, dims)                Matryoshka-style dim truncation
//
// All functions are pure (return new buffers) unless explicitly named "*InPlace"
// or documented as in-place.

// ---------------------------------------------------------------------------
// Matrix helpers
// ---------------------------------------------------------------------------

export function makeMatrix(rows, dim, data) {
  if (data) {
    if (data.length !== rows * dim) {
      throw new Error(`makeMatrix: data length ${data.length} != rows*dim ${rows * dim}`);
    }
    return { data, rows, dim };
  }
  return { data: new Float32Array(rows * dim), rows, dim };
}

// Zero-copy view of row i of M as a Float32Array of length M.dim.
export function row(M, i) {
  return M.data.subarray(i * M.dim, (i + 1) * M.dim);
}

function l2Norm(vec) {
  let s = 0;
  for (let k = 0; k < vec.length; k++) s += vec[k] * vec[k];
  return Math.sqrt(s);
}

// In-place L2 normalize each row. Rows of magnitude 0 are left as zero —
// dot-product against them returns 0, which matches sentence-transformers.
export function normalize(M) {
  const { data, rows, dim } = M;
  for (let i = 0; i < rows; i++) {
    const off = i * dim;
    let s = 0;
    for (let k = 0; k < dim; k++) s += data[off + k] * data[off + k];
    if (s === 0) continue;
    const inv = 1 / Math.sqrt(s);
    for (let k = 0; k < dim; k++) data[off + k] *= inv;
  }
  return M;
}

// ---------------------------------------------------------------------------
// Similarity primitives
// ---------------------------------------------------------------------------

// dotScore: out[i*B.rows + j] = <A_i, B_j>. Caller ensures dims match.
// Returns a Float32Array of shape [A.rows, B.rows] in row-major order.
export function dotScore(A, B) {
  if (A.dim !== B.dim) {
    throw new Error(`dotScore: dim mismatch ${A.dim} vs ${B.dim}`);
  }
  const out = new Float32Array(A.rows * B.rows);
  const dim = A.dim;
  for (let i = 0; i < A.rows; i++) {
    const aOff = i * dim;
    const oOff = i * B.rows;
    for (let j = 0; j < B.rows; j++) {
      const bOff = j * dim;
      let s = 0;
      for (let k = 0; k < dim; k++) s += A.data[aOff + k] * B.data[bOff + k];
      out[oOff + j] = s;
    }
  }
  return out;
}

// cosSim normalizes copies so A and B are not mutated.
// For pre-normalized inputs prefer dotScore — same numbers, half the work.
export function cosSim(A, B) {
  const An = makeMatrix(A.rows, A.dim, new Float32Array(A.data));
  const Bn = A === B ? An : makeMatrix(B.rows, B.dim, new Float32Array(B.data));
  normalize(An);
  if (A !== B) normalize(Bn);
  return dotScore(An, Bn);
}

// ---------------------------------------------------------------------------
// Top-K helper (max-K via min-heap)
// ---------------------------------------------------------------------------

// Selects top-K largest scores from a row of length n. Returns parallel
// arrays { values, indices }, sorted descending by value. Stable order on
// ties is not guaranteed (doesn't matter for retrieval).
function topK(scoresRow, n, k) {
  if (k >= n) {
    // Just sort everything when K covers the row.
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const arr = Array.from(idx).sort((a, b) => scoresRow[b] - scoresRow[a]);
    const values = new Float32Array(n);
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      indices[i] = arr[i];
      values[i] = scoresRow[arr[i]];
    }
    return { values, indices };
  }
  // Min-heap of size K: heap root is the smallest currently-in-top-K.
  // If a new score beats the root, swap and sift down.
  const heapVals = new Float32Array(k);
  const heapIdx = new Int32Array(k);
  // Seed with first K entries.
  for (let i = 0; i < k; i++) {
    heapVals[i] = scoresRow[i];
    heapIdx[i] = i;
  }
  // Heapify (Floyd's algorithm).
  for (let i = (k >> 1) - 1; i >= 0; i--) siftDownMin(heapVals, heapIdx, i, k);
  for (let i = k; i < n; i++) {
    const v = scoresRow[i];
    if (v > heapVals[0]) {
      heapVals[0] = v;
      heapIdx[0] = i;
      siftDownMin(heapVals, heapIdx, 0, k);
    }
  }
  // Heap holds top K but unordered. Sort descending for output.
  const order = Array.from({ length: k }, (_, i) => i).sort(
    (a, b) => heapVals[b] - heapVals[a],
  );
  const values = new Float32Array(k);
  const indices = new Int32Array(k);
  for (let i = 0; i < k; i++) {
    values[i] = heapVals[order[i]];
    indices[i] = heapIdx[order[i]];
  }
  return { values, indices };
}

function siftDownMin(vals, idx, start, end) {
  let root = start;
  for (;;) {
    const left = 2 * root + 1;
    const right = left + 1;
    let smallest = root;
    if (left < end && vals[left] < vals[smallest]) smallest = left;
    if (right < end && vals[right] < vals[smallest]) smallest = right;
    if (smallest === root) return;
    const tv = vals[root];
    vals[root] = vals[smallest];
    vals[smallest] = tv;
    const ti = idx[root];
    idx[root] = idx[smallest];
    idx[smallest] = ti;
    root = smallest;
  }
}

// ---------------------------------------------------------------------------
// semanticSearch
// ---------------------------------------------------------------------------

// Returns: array (length Q.rows) of arrays of { corpus_id, score }, each
// sorted descending by score, capped at topK.
//
// Mirrors sentence_transformers.util.semantic_search. We process queries in
// batches so we don't materialize the full Q.rows × C.rows score matrix
// when the corpus is large.
export function semanticSearch(Q, C, opts = {}) {
  const {
    topK = 10,
    scoreFn = 'cos_sim',           // 'cos_sim' | 'dot_score'
    queryBatchSize = 100,
    corpusBatchSize = 50_000,
    scoreThreshold = -Infinity,
  } = opts;

  if (Q.dim !== C.dim) {
    throw new Error(`semanticSearch: dim mismatch ${Q.dim} vs ${C.dim}`);
  }

  // For cos_sim, normalize once and reuse. For dot_score, leave inputs alone.
  let qUse = Q, cUse = C;
  if (scoreFn === 'cos_sim') {
    qUse = makeMatrix(Q.rows, Q.dim, new Float32Array(Q.data));
    cUse = makeMatrix(C.rows, C.dim, new Float32Array(C.data));
    normalize(qUse);
    normalize(cUse);
  }

  const results = new Array(Q.rows);
  for (let qStart = 0; qStart < Q.rows; qStart += queryBatchSize) {
    const qEnd = Math.min(qStart + queryBatchSize, Q.rows);
    const qBatch = makeMatrix(
      qEnd - qStart,
      qUse.dim,
      qUse.data.subarray(qStart * qUse.dim, qEnd * qUse.dim),
    );

    // Per-query running top-K across corpus batches.
    const k = Math.min(topK, C.rows);
    const runningVals = Array.from({ length: qBatch.rows }, () => new Float32Array(k).fill(-Infinity));
    const runningIdx = Array.from({ length: qBatch.rows }, () => new Int32Array(k).fill(-1));
    // Heapify each running buffer once (min-heap on score).
    for (let i = 0; i < qBatch.rows; i++) {
      // already filled with -Infinity; heap property holds trivially
    }

    for (let cStart = 0; cStart < C.rows; cStart += corpusBatchSize) {
      const cEnd = Math.min(cStart + corpusBatchSize, C.rows);
      const cBatch = makeMatrix(
        cEnd - cStart,
        cUse.dim,
        cUse.data.subarray(cStart * cUse.dim, cEnd * cUse.dim),
      );
      const scores = dotScore(qBatch, cBatch);  // qBatch.rows × cBatch.rows

      for (let i = 0; i < qBatch.rows; i++) {
        const rowOff = i * cBatch.rows;
        const heapVals = runningVals[i];
        const heapIdx = runningIdx[i];
        for (let j = 0; j < cBatch.rows; j++) {
          const v = scores[rowOff + j];
          if (v < scoreThreshold) continue;
          if (v > heapVals[0]) {
            heapVals[0] = v;
            heapIdx[0] = cStart + j;
            siftDownMin(heapVals, heapIdx, 0, k);
          }
        }
      }
    }

    // Sort each query's heap descending and emit objects.
    for (let i = 0; i < qBatch.rows; i++) {
      const heapVals = runningVals[i];
      const heapIdx = runningIdx[i];
      const order = Array.from({ length: k }, (_, n) => n)
        .filter((n) => heapIdx[n] !== -1)
        .sort((a, b) => heapVals[b] - heapVals[a]);
      results[qStart + i] = order.map((n) => ({
        corpus_id: heapIdx[n],
        score: heapVals[n],
      }));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// paraphraseMining
// ---------------------------------------------------------------------------

// Returns: array of [score, i, j] triples, sorted descending by score.
// Excludes self-pairs and orders pairs as i < j to avoid duplicates.
//
// Mirrors sentence_transformers.util.paraphrase_mining_embeddings. The
// algorithm is: for each row i, find top-K most similar rows; emit the
// (score, i, j) triples; dedupe and rank globally.
export function paraphraseMining(M, opts = {}) {
  const {
    topK = 100,
    queryBatchSize = 256,
    corpusBatchSize = 50_000,
    minScore = -Infinity,
    maxPairs = 500_000,
  } = opts;

  // Normalize a copy and use dot-score (= cosine on normalized vectors).
  const Mn = makeMatrix(M.rows, M.dim, new Float32Array(M.data));
  normalize(Mn);

  // Use semanticSearch with M as both queries and corpus, then drop
  // self-pairs and canonicalize to i < j.
  const hits = semanticSearch(Mn, Mn, {
    topK: topK + 1, // +1 because the top hit will be the row itself
    scoreFn: 'dot_score',
    queryBatchSize,
    corpusBatchSize,
    scoreThreshold: minScore,
  });

  // Use a Map keyed by (smaller_id * rows + bigger_id) to dedupe.
  const seen = new Map();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    for (let n = 0; n < h.length; n++) {
      const j = h[n].corpus_id;
      if (j === i) continue;
      const a = i < j ? i : j;
      const b = i < j ? j : i;
      const key = a * M.rows + b;
      const prev = seen.get(key);
      if (prev === undefined || h[n].score > prev) seen.set(key, h[n].score);
    }
  }

  const pairs = new Array(seen.size);
  let idx = 0;
  for (const [key, score] of seen) {
    const a = Math.floor(key / M.rows);
    const b = key - a * M.rows;
    pairs[idx++] = [score, a, b];
  }
  pairs.sort((p, q) => q[0] - p[0]);
  if (pairs.length > maxPairs) pairs.length = maxPairs;
  return pairs;
}

// ---------------------------------------------------------------------------
// communityDetection
// ---------------------------------------------------------------------------

// Direct port of sentence_transformers.util.community_detection (CPU path).
//
// For each row i, look at its top sort_max_size most-similar rows. If the
// min_community_size'th-best score is >= threshold, take all neighbors with
// score >= threshold as a candidate community (with i as the central point).
// Then sort communities by size descending and greedily remove overlaps.
//
// Returns: array of arrays of indices. Each community has its central
// (densest) point first; arrays are sorted by community size descending.
export function communityDetection(M, opts = {}) {
  let {
    threshold = 0.75,
    minCommunitySize = 10,
    batchSize = 1024,
  } = opts;

  // Normalize a copy so we can use dot-product as cosine.
  const Mn = makeMatrix(M.rows, M.dim, new Float32Array(M.data));
  normalize(Mn);

  minCommunitySize = Math.min(minCommunitySize, Mn.rows);
  let sortMaxSize = Math.min(Math.max(2 * minCommunitySize, 50), Mn.rows);

  const extracted = [];

  for (let start = 0; start < Mn.rows; start += batchSize) {
    const end = Math.min(start + batchSize, Mn.rows);
    const batch = makeMatrix(
      end - start,
      Mn.dim,
      Mn.data.subarray(start * Mn.dim, end * Mn.dim),
    );
    const scores = dotScore(batch, Mn); // (end-start) × Mn.rows

    for (let i = 0; i < batch.rows; i++) {
      const sRow = scores.subarray(i * Mn.rows, (i + 1) * Mn.rows);

      // Quick reject: top-min_community_size's last value < threshold means
      // this row doesn't have enough neighbors. Avoids the larger top-k call.
      const small = topK(sRow, Mn.rows, minCommunitySize);
      if (small.values[minCommunitySize - 1] < threshold) continue;

      // Get top sortMaxSize. Expand if the smallest value is still above
      // threshold — there may be more neighbors past the current cutoff.
      let large = topK(sRow, Mn.rows, sortMaxSize);
      while (large.values[large.values.length - 1] > threshold && sortMaxSize < Mn.rows) {
        sortMaxSize = Math.min(2 * sortMaxSize, Mn.rows);
        large = topK(sRow, Mn.rows, sortMaxSize);
      }

      // Take all indices whose score >= threshold. The first index will be
      // the row itself (score 1.0 after normalize); that is the "central
      // point" by sentence-transformers convention.
      const community = [];
      for (let n = 0; n < large.values.length; n++) {
        if (large.values[n] >= threshold) community.push(large.indices[n]);
        else break; // values are descending
      }
      extracted.push(community);
    }
  }

  // Largest cluster first, then strip overlapping members greedily.
  extracted.sort((a, b) => b.length - a.length);
  const taken = new Set();
  const unique = [];
  for (const community of extracted) {
    const fresh = [];
    for (const id of community) if (!taken.has(id)) fresh.push(id);
    if (fresh.length >= minCommunitySize) {
      unique.push(fresh);
      for (const id of fresh) taken.add(id);
    }
  }
  unique.sort((a, b) => b.length - a.length);
  return unique;
}

// ---------------------------------------------------------------------------
// Auto-tuning for communityDetection (k-NN-based)
// ---------------------------------------------------------------------------

// communityDetection takes a fixed `threshold` and `minCommunitySize`. For
// small label sets in tight domains, hardcoded defaults are wrong — too
// strict and nothing clusters, too loose and everything merges. We can
// derive sensible values by looking at the actual k-NN structure of the
// input: how close *are* its neighbors, and how many close neighbors does
// a typical point have?
//
// Approach:
//   - For each row, find its top-k nearest other rows (k small, ≤ 5).
//   - Use the median of the k-th nearest-neighbor cosine as `threshold`.
//     This captures "what 'close enough to be in the same community'
//     actually means for *this* corpus".
//   - Set `minCommunitySize` as a function of total size, floored at 2
//     so even small label sets can form a community.
//
// Returns { threshold, minCommunitySize, k_used, n }.
export function autoTuneCommunityParams(M, opts = {}) {
  const {
    k = 3,
    minThreshold = 0.55,   // never go below the noise floor of same-genre text
    maxThreshold = 0.92,   // never go above; would prevent any merging
    minSize = 2,
  } = opts;

  const n = M.rows;
  if (n < 3) {
    return { threshold: 0.75, minCommunitySize: minSize, k_used: 0, n };
  }
  // Normalize a copy so cosine = dot. Self-pair (cos = 1) is excluded.
  const Mn = makeMatrix(n, M.dim, new Float32Array(M.data));
  normalize(Mn);
  const kEff = Math.max(1, Math.min(k, n - 1));
  const kthCosines = new Float32Array(n);
  const scratch = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const offI = i * M.dim;
    for (let j = 0; j < n; j++) {
      if (i === j) { scratch[j] = -Infinity; continue; }
      let s = 0;
      const offJ = j * M.dim;
      for (let d = 0; d < M.dim; d++) s += Mn.data[offI + d] * Mn.data[offJ + d];
      scratch[j] = s;
    }
    // Find the k-th largest among non-self values.
    const top = topK(scratch, n, kEff);
    kthCosines[i] = top.values[kEff - 1];
  }
  // Median of k-th nearest cosines — robust to outliers vs. mean.
  const sorted = Array.from(kthCosines).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(minThreshold, Math.min(maxThreshold, med));
  // minCommunitySize: scale with set size, but never below 2 — at thesis
  // scale you can have 3 papers that form a real micro-community.
  const minCommunitySize = Math.max(minSize, Math.floor(n / 5));
  return { threshold, minCommunitySize, k_used: kEff, n };
}

// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

// int8: linear-scale each dimension globally to [-127, 127]. Stores the
// global min/max so dequantize can invert. ~4× shrink vs float32 with
// ~1% retrieval-recall loss in practice.
//
// binary: keep only the sign bit per value, packed 8 to a byte. ~32× shrink,
// usable as a fast pre-filter, then re-rank top results with int8 or float.
export function quantize(M, opts = {}) {
  const { kind = 'int8' } = opts;
  if (kind === 'int8') return quantizeInt8(M);
  if (kind === 'binary') return quantizeBinary(M);
  throw new Error(`quantize: unknown kind '${kind}'`);
}

function quantizeInt8(M) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < M.data.length; k++) {
    const v = M.data[k];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const absMax = Math.max(Math.abs(lo), Math.abs(hi));
  const scale = absMax === 0 ? 1 : 127 / absMax;
  const out = new Int8Array(M.data.length);
  for (let k = 0; k < M.data.length; k++) {
    const q = Math.round(M.data[k] * scale);
    out[k] = q < -127 ? -127 : q > 127 ? 127 : q;
  }
  return { kind: 'int8', data: out, rows: M.rows, dim: M.dim, scale };
}

export function dequantizeInt8(Q) {
  if (Q.kind !== 'int8') throw new Error(`dequantizeInt8: not int8`);
  const out = new Float32Array(Q.data.length);
  const inv = 1 / Q.scale;
  for (let k = 0; k < Q.data.length; k++) out[k] = Q.data[k] * inv;
  return makeMatrix(Q.rows, Q.dim, out);
}

function quantizeBinary(M) {
  // 1 bit per dim, MSB-first packing. dim must be padded; we pad with 0s,
  // which biases packed-popcount slightly but negligibly for retrieval.
  const bytesPerRow = Math.ceil(M.dim / 8);
  const out = new Uint8Array(M.rows * bytesPerRow);
  for (let i = 0; i < M.rows; i++) {
    const inOff = i * M.dim;
    const outOff = i * bytesPerRow;
    for (let k = 0; k < M.dim; k++) {
      if (M.data[inOff + k] > 0) {
        out[outOff + (k >> 3)] |= 1 << (7 - (k & 7));
      }
    }
  }
  return { kind: 'binary', data: out, rows: M.rows, dim: M.dim, bytesPerRow };
}

// ---------------------------------------------------------------------------
// Matryoshka truncation
// ---------------------------------------------------------------------------

// Models trained Matryoshka-style let you keep only the first `dims`
// dimensions of each row and still get useful (lower-quality) embeddings.
// Cheap way to halve storage when retrieval recall isn't critical.
// bge-small-en-v1.5 is *not* Matryoshka-trained, so this is a no-op
// quality-wise for our default — kept for forward-compat with future models.
export function truncateDims(M, dims) {
  if (dims > M.dim) throw new Error(`truncateDims: ${dims} > ${M.dim}`);
  const out = new Float32Array(M.rows * dims);
  for (let i = 0; i < M.rows; i++) {
    const src = i * M.dim;
    const dst = i * dims;
    for (let k = 0; k < dims; k++) out[dst + k] = M.data[src + k];
  }
  return makeMatrix(M.rows, dims, out);
}
