// hf_preload.mjs
//
// Pre-download HuggingFace model files into transformers.js's local
// cache so the per-paper extractors don't depend on HF being reachable
// at call time. Uses `@huggingface/hub` rather than the inline fetch
// inside `@huggingface/transformers`, because the inline fetch trips
// HF's anonymous-request gating in some environments while the
// dedicated hub library downloads cleanly.
//
// Cache layout matches the one transformers.js expects:
//
//   ~/.cache/huggingface/hub/
//     models--<author>--<repo>/
//       snapshots/<commit-or-main>/
//         config.json
//         tokenizer.json
//         ...
//         onnx/
//           model.onnx
//
// On first load transformers.js will find these files and skip the
// network round trip entirely.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listFiles, downloadFile } from '@huggingface/hub';

// Models we use. Add to this list when adding a new model dependency.
export const REQUIRED_MODELS = [
  'Xenova/bge-small-en-v1.5',
  'Xenova/distilbert-base-uncased-mnli',
  'onnx-community/gliner_medium-v2.1',
  'Xenova/ms-marco-MiniLM-L-6-v2',
];

function cacheRoot() {
  // Respect HF_HUB_CACHE if set; otherwise the standard location.
  return process.env.HF_HUB_CACHE
    || path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

function repoCacheDir(repoId) {
  const slug = 'models--' + repoId.replace('/', '--');
  return path.join(cacheRoot(), slug);
}

async function snapshotDir(repoId) {
  // The library doesn't expose a clean way to get the latest commit
  // hash without listing. We use 'main' as a stable pointer; transformers.js
  // resolves either a commit hash or 'main'. Using 'main' avoids cache
  // misses when HF advances a model's main branch.
  const dir = path.join(repoCacheDir(repoId), 'snapshots', 'main');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Download every file for `repoId` into the local HF cache. Returns
 *   { repo, files: [{ path, size, status }], error?: string }
 *
 * Idempotent: skips files that already exist on disk with matching size.
 */
export async function preloadModel(repoId, onProgress) {
  const result = { repo: repoId, files: [] };
  let entries = [];
  try {
    for await (const entry of listFiles({ repo: repoId, recursive: true })) {
      if (entry.type !== 'file') continue;
      entries.push(entry);
    }
  } catch (err) {
    result.error = `list failed: ${err.message}`;
    return result;
  }
  const dir = await snapshotDir(repoId);
  let i = 0;
  for (const entry of entries) {
    i++;
    const target = path.join(dir, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    let skip = false;
    try {
      const stat = await fs.stat(target);
      if (typeof entry.size === 'number' && stat.size === entry.size) skip = true;
    } catch { /* not present yet */ }
    if (skip) {
      result.files.push({ path: entry.path, size: entry.size ?? null, status: 'cached' });
      onProgress?.({ repo: repoId, file: entry.path, index: i, total: entries.length, status: 'cached' });
      continue;
    }
    try {
      const res = await downloadFile({ repo: repoId, path: entry.path });
      if (!res) throw new Error('downloadFile returned nothing');
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(target, buf);
      result.files.push({ path: entry.path, size: buf.length, status: 'downloaded' });
      onProgress?.({ repo: repoId, file: entry.path, index: i, total: entries.length, status: 'downloaded' });
    } catch (err) {
      result.files.push({ path: entry.path, size: entry.size ?? null, status: 'failed', error: err.message });
      onProgress?.({ repo: repoId, file: entry.path, index: i, total: entries.length, status: 'failed', error: err.message });
    }
  }
  return result;
}

/**
 * Preload every model in REQUIRED_MODELS. Returns
 *   { repos: [...preloadModel results], totals: { downloaded, cached, failed } }
 */
export async function preloadAll(onProgress) {
  const repos = [];
  let downloaded = 0, cached = 0, failed = 0;
  for (const repoId of REQUIRED_MODELS) {
    const r = await preloadModel(repoId, onProgress);
    repos.push(r);
    for (const f of r.files || []) {
      if (f.status === 'downloaded') downloaded++;
      else if (f.status === 'cached') cached++;
      else if (f.status === 'failed') failed++;
    }
  }
  return { repos, totals: { downloaded, cached, failed } };
}

/**
 * Report which models are currently cached vs missing. Cheap; just
 * checks for the snapshot dir + key files. Also checks for an ONNX
 * file, since transformers.js needs at least one to run.
 */
export async function status() {
  const out = [];
  for (const repoId of REQUIRED_MODELS) {
    const dir = path.join(repoCacheDir(repoId), 'snapshots', 'main');
    let hasMeta = false;
    let hasOnnx = false;
    try {
      const files = await fs.readdir(dir);
      hasMeta = files.includes('config.json') && (files.includes('tokenizer.json') || files.includes('tokenizer_config.json'));
      try {
        const onnxFiles = await fs.readdir(path.join(dir, 'onnx'));
        hasOnnx = onnxFiles.some((f) => f.endsWith('.onnx'));
      } catch { /* no onnx subdir */ }
    } catch { /* snapshot dir missing */ }
    const cached = hasMeta && hasOnnx;
    out.push({ repo: repoId, cached, has_meta: hasMeta, has_onnx: hasOnnx, snapshot_dir: dir });
  }
  return out;
}

/**
 * Aggregate readiness: are ALL required models locally cached?
 * Returns { ready: boolean, missing: [repoIds], present: [repoIds] }.
 * This is the single source of truth for "can the extractor run at
 * full fidelity?". Used to gate auto-extract.
 */
export async function ready() {
  const s = await status();
  const missing = s.filter((m) => !m.cached).map((m) => m.repo);
  const present = s.filter((m) => m.cached).map((m) => m.repo);
  return { ready: missing.length === 0, missing, present, models: s };
}
