// gliner.mjs
//
// Server-side wrapper for GLiNER — zero-shot named entity recognition.
// Given a list of entity types ("technology", "dataset", "attack_technique",
// "treaty", "company", anything), the model returns labelled spans for
// each type that appears in the text. ONE forward pass for the whole
// (text, types) tuple — no per-span NLI loop, no cosine fallback.
//
// Replaces the previous CoNLL-NER + entity_typing pipeline. GLiNER is
// purpose-built for the type-prompted setting and outperforms generic
// NER on scientific entities (Prime+Probe, MIMIC-III, SGX, GAN) and on
// non-CS entities (Treaty of Versailles, John Maynard Keynes, etc.) —
// because the types come from the user, not a hardcoded label set.
//
// Model: `onnx-community/gliner_medium-v2.1` — ~200M params, fp32 ONNX
// (~800MB). Loaded once per process.
//
// The `gliner` npm package targets the browser (onnxruntime-web), but
// ships a Node entry point that uses onnxruntime-node. The Node entry
// only accepts a local file path (not a URL) for the model, so we
// pre-download the ONNX into the same HuggingFace cache layout that
// `hf_preload` populates and pass the resolved path through.

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { downloadFile } from '@huggingface/hub';
import { chosenProvider } from './platform.mjs';

const MODEL_REPO = 'onnx-community/gliner_medium-v2.1';
const MODEL_FILE = 'onnx/model.onnx';   // fp32 — most reliable across platforms

// Execution provider is picked once by platform.mjs based on detected
// hardware: nvidia→cuda, amd→rocm, win+gpu→dml, apple-silicon→cpu (already
// hits ARM NEON + Accelerate BLAS peak for batch=1). Override with
// LITREVIEW_ONNX_PROVIDER=<name>.

function cacheRoot() {
  return process.env.HF_HUB_CACHE
    || path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}
function snapshotDir(repoId) {
  return path.join(cacheRoot(), 'models--' + repoId.replace('/', '--'), 'snapshots', 'main');
}

// Lazy-load + cache the GLiNER instance.
let _glinerPromise = null;
let _unavailable = false;
let _failureLogged = false;

export function isUnavailable() { return _unavailable; }

async function ensureModelDownloaded() {
  const dir = snapshotDir(MODEL_REPO);
  await fs.mkdir(path.dirname(path.join(dir, MODEL_FILE)), { recursive: true });
  const target = path.join(dir, MODEL_FILE);
  let stat = null;
  try { stat = await fs.stat(target); } catch { /* missing */ }
  if (stat && stat.size > 100_000) return target;   // already there
  // Download via @huggingface/hub (same path the preload route uses).
  const res = await downloadFile({ repo: MODEL_REPO, path: MODEL_FILE });
  if (!res) throw new Error('downloadFile returned nothing');
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(target, buf);
  return target;
}

async function _initGliner() {
  // gliner/node uses onnxruntime-node + @xenova/transformers internally.
  // Bundles its own onnxruntime-node — coexists with our
  // @huggingface/transformers's copy but warns on darwin. The duplicate-
  // class warning is harmless when we pin a single provider.
  const { Gliner } = await import('gliner/node');
  const modelPath = await ensureModelDownloaded();
  const provider = await chosenProvider();
  const g = new Gliner({
    tokenizerPath: MODEL_REPO,
    onnxSettings: {
      modelPath,
      executionProvider: provider,
    },
  });
  await g.initialize();
  console.log(`[gliner] loaded with executionProvider=${provider}`);
  return g;
}

function _getGliner() {
  if (_unavailable) return Promise.reject(new Error('gliner unavailable'));
  if (!_glinerPromise) {
    _glinerPromise = _initGliner().catch((err) => {
      _unavailable = true;
      if (!_failureLogged) {
        console.warn(`gliner: unavailable (${err.message}). Span extraction will skip GLiNER.`);
        _failureLogged = true;
      }
      _glinerPromise = null;
      throw err;
    });
  }
  return _glinerPromise;
}

/** Pre-warm the model. Optional. */
export async function preload() {
  await _getGliner().catch(() => {});
}

/**
 * Extract typed entities from a single text. Returns an array of
 *   { text, label, start, end, score }
 * where `label` is one of the user-supplied `entityTypes`.
 *
 * opts:
 *   threshold       minimum score to keep a span (default 0.40)
 *   flatNer         force single-label-per-span (default true)
 *   multiLabel      allow multiple labels per span (default false)
 *   maxSpansPerText cap returned spans (default 200)
 */
export async function extract(text, entityTypes, opts = {}) {
  if (!text || !Array.isArray(entityTypes) || entityTypes.length === 0) return [];
  const g = await _getGliner();
  const out = await g.inference({
    texts: [String(text)],
    entities: entityTypes,
    threshold: opts.threshold ?? 0.40,
    flatNer: opts.flatNer ?? true,
    multiLabel: opts.multiLabel ?? false,
  });
  // gliner returns [[ {spanText|text, start, end, label, score}, ... ]] —
  // one row per text. Normalise field names since older builds use
  // `spanText` and newer use `text`.
  const rows = Array.isArray(out) ? (Array.isArray(out[0]) ? out[0] : out) : [];
  const max = opts.maxSpansPerText ?? 200;
  return rows.slice(0, max).map((r) => ({
    text: r.spanText ?? r.text ?? '',
    label: r.label ?? '',
    start: r.start ?? null,
    end:   r.end   ?? null,
    score: typeof r.score === 'number' ? r.score : 0,
  })).filter((r) => r.text && r.label);
}

/**
 * Extract entities from an array of texts. Returns one array per text.
 * Same options as extract().
 */
export async function extractBatch(texts, entityTypes, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (!Array.isArray(entityTypes) || entityTypes.length === 0) return texts.map(() => []);
  const g = await _getGliner();
  const out = await g.inference({
    texts: texts.map(String),
    entities: entityTypes,
    threshold: opts.threshold ?? 0.40,
    flatNer: opts.flatNer ?? true,
    multiLabel: opts.multiLabel ?? false,
  });
  const rowsList = Array.isArray(out) ? out : [];
  const max = opts.maxSpansPerText ?? 200;
  return rowsList.map((rows) => (Array.isArray(rows) ? rows.slice(0, max).map((r) => ({
    text: r.spanText ?? r.text ?? '',
    label: r.label ?? '',
    start: r.start ?? null,
    end:   r.end   ?? null,
    score: typeof r.score === 'number' ? r.score : 0,
  })).filter((r) => r.text && r.label) : []));
}

export const MODEL = MODEL_REPO;
