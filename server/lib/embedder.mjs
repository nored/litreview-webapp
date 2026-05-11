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

let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL_ID).catch((err) => {
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

/** What model + dim is in use. Surfaced so tests / status pills can show it. */
export const MODEL = MODEL_ID;
export const DIMENSIONS = DIM;
