// platform.mjs
//
// Single source of truth for "what's this machine, and what ONNX
// execution providers can we actually use?". Probed once at boot,
// cached for the process lifetime. The result drives:
//
//   - server/lib/gliner.mjs        executionProvider for the GLiNER model
//   - server/lib/nli.mjs           dtype + device for distilbert / DeBERTa NLI
//   - server/lib/embedder.mjs      dtype for bge-small
//   - server/lib/reranker.mjs      dtype for ms-marco MiniLM
//   - GET /api/platform            UI / debug view
//
// Detection covers:
//
//   * OS + CPU arch (trivial from process.platform / process.arch)
//   * Apple Silicon (darwin + arm64)
//   * NVIDIA GPU presence (try `nvidia-smi`)
//   * AMD GPU presence (try `rocm-smi`)
//   * Intel/Apple GPU (heuristic via system_profiler on macOS)
//   * Which onnxruntime-node EPs are actually registered (try a minimal
//     session create and read the available providers list)
//
// `LITREVIEW_ONNX_PROVIDER=<name>` overrides the auto-pick.

import os from 'node:os';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function runCommand(cmd, args = [], { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: e.message });
      return;
    }
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, code: -1, stdout, stderr: stderr || e.message });
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* */ }
      resolve({ ok: false, code: -1, stdout, stderr: 'timeout' });
    }, timeoutMs);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// GPU probes
// ─────────────────────────────────────────────────────────────────────────

async function probeNvidia() {
  const r = await runCommand('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (!r.ok) return null;
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const gpus = lines.map((line) => {
    const parts = line.split(',').map((s) => s.trim());
    return { name: parts[0], memory_mb: parseInt(parts[1], 10) || null, driver: parts[2] || null };
  });
  return { vendor: 'nvidia', gpus, count: gpus.length };
}

async function probeAmd() {
  const r = await runCommand('rocm-smi', ['--showproductname', '--csv']);
  if (!r.ok) return null;
  const lines = r.stdout.split('\n').filter((l) => l.includes(','));
  if (lines.length <= 1) return null;
  return { vendor: 'amd', gpus: lines.slice(1).map((l) => ({ name: l.trim() })), count: lines.length - 1 };
}

async function probeAppleGpu() {
  if (process.platform !== 'darwin') return null;
  const r = await runCommand('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 3000 });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.stdout);
    const arr = j?.SPDisplaysDataType || [];
    const gpus = arr.map((d) => ({
      name: d.sppci_model || d._name || 'Apple GPU',
      cores: d.sppci_cores || null,
      neural_engine: process.arch === 'arm64',
    }));
    return { vendor: 'apple', gpus, count: gpus.length };
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────
// Available ONNX execution providers
// ─────────────────────────────────────────────────────────────────────────
//
// onnxruntime-node ships with a subset of EPs compiled in per platform.
// We probe by listing what the runtime advertises. This is the cheapest
// reliable check — we don't actually have to create a session.

async function listOnnxProviders() {
  try {
    const ort = await import('onnxruntime-node');
    const provider = ort.default || ort;
    // The library exposes the list of registered providers via
    // `availableExecutionProviders` (newer builds) or by attempting
    // session.create with a list and reading the resolved order.
    if (Array.isArray(provider.availableExecutionProviders)) {
      return provider.availableExecutionProviders.map((p) => String(p).toLowerCase());
    }
  } catch (e) {
    // onnxruntime-node not installed or failed to load — fall through.
  }
  // Heuristic fallback: declare what each platform ships with by default.
  const platformDefaults = {
    'darwin-arm64': ['coreml', 'cpu'],
    'darwin-x64':   ['cpu'],
    'linux-x64':    ['cpu'],
    'linux-arm64':  ['cpu'],
    'win32-x64':    ['dml', 'cpu'],
    'win32-arm64':  ['cpu'],
  };
  return platformDefaults[`${process.platform}-${process.arch}`] || ['cpu'];
}

// ─────────────────────────────────────────────────────────────────────────
// Decision: best execution provider for this machine
// ─────────────────────────────────────────────────────────────────────────

function decideProvider({ os: platform, arch, nvidia, amd, apple, available }) {
  const override = (process.env.LITREVIEW_ONNX_PROVIDER || '').toLowerCase().trim();
  if (override) {
    return {
      name: override,
      reason: 'LITREVIEW_ONNX_PROVIDER env override',
      available_alternatives: available,
    };
  }
  const has = (name) => available.includes(name);

  // NVIDIA GPU + cuda EP available — biggest single win across platforms.
  if (nvidia && has('cuda')) {
    return { name: 'cuda', reason: `NVIDIA ${nvidia.gpus[0]?.name || 'GPU'} detected`, available_alternatives: available };
  }
  // AMD GPU on Linux + rocm EP.
  if (amd && has('rocm')) {
    return { name: 'rocm', reason: `AMD ${amd.gpus[0]?.name || 'GPU'} detected`, available_alternatives: available };
  }
  // Windows with DirectML.
  if (platform === 'win32' && has('dml')) {
    return { name: 'dml', reason: 'Windows + DirectML', available_alternatives: available };
  }
  // macOS Apple Silicon — CoreML EP is available but for our model sizes
  // it matches CPU at batch=1 (Accelerate BLAS already uses NEON). We
  // pick 'cpu' which is the simpler / less warning-prone path. Users
  // can force 'coreml' via the env override.
  // CPU is the safe default everywhere else.
  return {
    name: 'cpu',
    reason: platform === 'darwin' && arch === 'arm64'
      ? 'Apple Silicon: cpu provider already uses ARM NEON + Accelerate; coreml available as alternative'
      : 'no accelerator detected',
    available_alternatives: available,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

let _cache = null;
let _inflight = null;

async function _detect() {
  const platform = process.platform;
  const arch = process.arch;
  const cpuModel = os.cpus()?.[0]?.model || 'unknown';
  const cpuCount = os.cpus()?.length || 1;
  const totalRamGb = Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(1));
  const [nvidia, amd, apple, available] = await Promise.all([
    probeNvidia(),
    probeAmd(),
    probeAppleGpu(),
    listOnnxProviders(),
  ]);
  const decision = decideProvider({ os: platform, arch, nvidia, amd, apple, available });
  return {
    os: platform,
    arch,
    cpu: { model: cpuModel, cores: cpuCount },
    ram_gb: totalRamGb,
    accelerators: {
      nvidia: nvidia || null,
      amd: amd || null,
      apple: apple || null,
    },
    onnx: {
      available_providers: available,
      chosen_provider: decision.name,
      chosen_reason: decision.reason,
      env_override: process.env.LITREVIEW_ONNX_PROVIDER || null,
    },
    apple_silicon: platform === 'darwin' && arch === 'arm64',
  };
}

/** Returns the cached platform snapshot. Probes lazily on first call. */
export async function detect() {
  if (_cache) return _cache;
  if (_inflight) return _inflight;
  _inflight = _detect().then((r) => { _cache = r; _inflight = null; return r; });
  return _inflight;
}

/** Convenience: just the chosen execution provider string (e.g. 'cpu'). */
export async function chosenProvider() {
  const p = await detect();
  return p.onnx.chosen_provider;
}

/** Re-probe (e.g. after the user installs a CUDA driver). */
export function reset() {
  _cache = null;
  _inflight = null;
}
