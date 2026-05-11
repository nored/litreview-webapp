// embedder.mjs (server)
//
// Node-side embedder. Mirror of public/lib/vectors_worker.js but running in
// the server process — same library (@huggingface/transformers), same model
// (Xenova/bge-small-en-v1.5), same pooling+normalize. Vectors are
// bit-equivalent to what the browser worker produces, so the two stores
// freely interchange under server/lib/vectors.mjs.
//
// Why server-side at all when the browser can also do it:
//   - Long batch jobs (embed every PDF, embed snowballed citations) need
//     to survive tab-close. The Node process is the right home.
//   - onnxruntime-node is 2–5× faster per text than onnxruntime-web's WASM
//     path on a typical laptop, which compounds at 10k+ texts.
//   - The embedding daemon (server/lib/embed_daemon.mjs, next file up)
//     calls in here on a worker loop the same way download_daemon does.
//
// Model files cache to ~/.cache/huggingface/ on first call (~130 MB,
// one-time). Subsequent process boots reuse the cache.

import { pipeline, env } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const DIM = 384;

// Defaults are fine for Node: allow remote downloads (first run), allow
// local files (cache hits). We don't override env.cacheDir — let it use
// the user's HF cache so the same files are reused across projects.
env.allowRemoteModels = true;
env.allowLocalModels = true;

// Auto-pick a sensible dtype for this machine. The library otherwise
// warns "dtype not specified, using fp32" on every boot.
//
//   - Apple Silicon (darwin + arm64): bge-small ships fp16 + q8 variants
//     that work well through ONNX Runtime's CoreML execution provider
//     (the Mac equivalent of MLX for our JS toolchain — MLX itself is
//     Python/Swift only and can't be called from @huggingface/transformers).
//     fp16 halves memory and is meaningfully faster than fp32 on M-series.
//   - Linux/Windows on CPU: fp32 stays the default — onnxruntime-node's
//     CPU EP doesn't gain much from fp16 without AVX-512.
//   - Any platform: LITREVIEW_EMBED_DTYPE env var overrides
//     (`fp32` | `fp16` | `q8` | `q4`). Set this if you want to swap.
//
// Vectors persisted to project/data/_vectors/*.jsonl carry no dtype
// fingerprint, so switching between fp32 and fp16 mid-project is safe
// in practice (cosine geometry barely shifts), but if you switch
// FROM fp32 TO q4 you may want to re-embed to keep scores comparable.
function pickDtype() {
  const override = (process.env.LITREVIEW_EMBED_DTYPE || '').toLowerCase().trim();
  if (override) return override;
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'fp16';
  return 'fp32';
}

const DTYPE = pickDtype();

let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL_ID, { dtype: DTYPE })
      .catch(async (err) => {
        // fp16 / q8 / q4 builds may be missing for some model exports.
        // Fall back to fp32 silently so the daemon doesn't die on first
        // run for a less-common platform.
        if (DTYPE !== 'fp32') {
          console.warn(`embedder: ${DTYPE} load failed (${err.message}); falling back to fp32`);
          extractorPromise = pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' })
            .catch((fallbackErr) => {
              extractorPromise = null;
              throw fallbackErr;
            });
          return extractorPromise;
        }
        // Don't pin a failed promise — let the next call retry the load.
        extractorPromise = null;
        throw err;
      });
  }
  return extractorPromise;
}

/** Pre-warm the model. Optional; the first embed() call will load it lazily. */
export async function preload() {
  await getExtractor();
}

/**
 * Embed a batch of strings. Returns { data: Float32Array, rows, dim }
 * with row-major flat layout — same shape as sbert_utils.makeMatrix.
 *
 * Per-string loop rather than a tensor batch: bge-small caps at 512 tokens
 * and literature texts vary wildly in length, so padding-batched calls
 * waste compute. Throughput on a typical laptop: ~30–80 texts/sec.
 */
export async function embed(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('embed: texts must be a non-empty string[]');
  }
  const ext = await getExtractor();
  const out = new Float32Array(texts.length * DIM);
  for (let i = 0; i < texts.length; i++) {
    const result = await ext(String(texts[i] ?? ''), {
      pooling: 'mean',
      normalize: true,
    });
    if (result.data.length !== DIM) {
      throw new Error(`unexpected embedding dim ${result.data.length}, want ${DIM}`);
    }
    out.set(result.data, i * DIM);
  }
  return { data: out, rows: texts.length, dim: DIM };
}

/** Convenience: embed one string, return its Float32Array row. */
export async function embedOne(text) {
  const m = await embed([text]);
  return m.data;
}

/** What model + dim + dtype is in use. Surfaced so tests / status pills can show it. */
export const MODEL = MODEL_ID;
export const DIMENSIONS = DIM;
export const DTYPE_IN_USE = DTYPE;
