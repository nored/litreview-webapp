// public/views/deep_read_v2.mjs
//
// Stage 4 v2 — structured deep-read surface. Replaces the prose-drafter
// flow with the new extractor pipeline + structured record viewer.
//
// Three-pane layout:
//   * Left  — paper list (eligible papers from the v2 store)
//   * Mid   — PDF viewer (pdfjs, native browser embed for now)
//   * Right — structured record: identification, fields, named entities,
//             results, body sections as quote tables, claims
//
// Editing surfaces in this first cut (M5.b):
//   * Categories — editable chips (add / remove)
//   * "Re-extract structured fields" — runs M2 orchestrator for the paper
//   * "Extract claims (WebLLM)" — runs the M3 prepare → LLM → process pipeline
//   * "Re-ingest chunks" — runs pdf_chunks + section_classifier for the paper
//
// What's read-only for now (full editing UX lands in M5.c):
//   * paper_field rows (methodology_type, system_domain, etc.)
//   * results, name_usage, claims, body section quote tables
//
// Identification + provenance are shown but not editable here — the
// existing identification flow (v1 enrichment via OpenAlex DOI lookup)
// remains the source of truth for those fields.

import { h } from '../lib/dom.mjs';
import * as llm from '../lib/llm.mjs';
import { runClaimsExtraction } from '../lib/webllm_claims.mjs';

const SECTION_LABELS = {
  problem_statement: 'Problem statement',
  method_summary: 'Method summary',
  ground_truth_and_evaluation: 'Ground truth & evaluation',
  stated_limitations: 'Stated limitations',
  gaps_this_paper_opens: 'Gaps this paper opens',
  relevance_to_the_thesis_topic: 'Relevance to the thesis topic',
};

// Per-claim-type display label.
const CLAIM_TYPE_LABEL = {
  contribution: 'Contribution',
  finding: 'Finding',
  limitation: 'Limitation',
  future_work: 'Future work',
  framework: 'Framework',
  method: 'Method',
};

// ─────────────────────────────────────────────────────────────────────────
// Per-paper undo. Inline edits save immediately to SQLite; an undo entry
// is pushed after every successful save. Each entry is tagged with the
// paper it applies to. The visible stack is filtered to the CURRENT
// paper — clicking Undo while viewing paper B never reverts paper A.
// Switching papers leaves the other paper's stack intact (so the user
// can revisit + undo there too).
// ─────────────────────────────────────────────────────────────────────────
let currentUndoPaperId = null;
const UNDO_CAP_PER_PAPER = 20;
const undoStacksByPaper = new Map();   // paper_id → Array<entry>
const undoListeners = new Set();

// ─────────────────────────────────────────────────────────────────────
// Cross-mount cache. The view re-mounts every time the user navigates
// back to #/stage4 — going to downloads and back was triggering a full
// re-fetch + re-render. Cache the list result for a short window so
// quick tab-switches feel instant. Invalidates on extract-job state
// change or after 60s (whichever first).
// ─────────────────────────────────────────────────────────────────────
const deepReadCache = {
  papers: null,         // last fetched list
  fetched_at: 0,
  ttl_ms: 60_000,
};
function deepReadCacheGet() {
  if (!deepReadCache.papers) return null;
  if (Date.now() - deepReadCache.fetched_at > deepReadCache.ttl_ms) return null;
  return deepReadCache.papers;
}
function deepReadCacheSet(papers) {
  deepReadCache.papers = papers;
  deepReadCache.fetched_at = Date.now();
}
function deepReadCacheClear() {
  deepReadCache.papers = null;
  deepReadCache.fetched_at = 0;
}

function setCurrentUndoPaper(paperId) {
  currentUndoPaperId = paperId;
  for (const l of undoListeners) l();
}
function activeStack() {
  if (!currentUndoPaperId) return [];
  if (!undoStacksByPaper.has(currentUndoPaperId)) {
    undoStacksByPaper.set(currentUndoPaperId, []);
  }
  return undoStacksByPaper.get(currentUndoPaperId);
}
function pushUndo(entry) {
  if (!currentUndoPaperId) return;
  const stack = activeStack();
  stack.push({ ...entry, paper_id: currentUndoPaperId });
  while (stack.length > UNDO_CAP_PER_PAPER) stack.shift();
  for (const l of undoListeners) l();
}
async function popAndUndo() {
  const stack = activeStack();
  const e = stack.pop();
  if (!e) return;
  // Safety: the entry's paper_id MUST match the visible paper. If the
  // user switched papers between push and Cmd+Z, the entry is left in
  // its origin paper's stack — we don't fire here.
  if (e.paper_id !== currentUndoPaperId) {
    stack.push(e);
    return;
  }
  try {
    await e.undoFn();
    showUndoToast(`Undone: ${e.description}`);
  } catch (err) {
    alert('Undo failed: ' + (err?.message || err));
  }
  for (const l of undoListeners) l();
}
function subscribeUndo(fn) {
  undoListeners.add(fn);
  return () => undoListeners.delete(fn);
}

// Transient toast for keyboard-triggered undo so the user gets visible
// feedback even when the toolbar button is off-screen.
function showUndoToast(message) {
  const existing = document.querySelector('.dr2-undo-toast');
  if (existing) existing.remove();
  const t = h('div', { class: 'dr2-undo-toast' }, [message]);
  document.body.appendChild(t);
  setTimeout(() => { t.classList.add('fade'); }, 1500);
  setTimeout(() => { t.remove(); }, 2200);
}

// Global keyboard shortcut: Cmd+Z / Ctrl+Z pops the undo stack. Idempotent
// — repeated module loads won't stack listeners.
let _undoKeyboardListenerAttached = false;
function ensureUndoKeyboardListener() {
  if (_undoKeyboardListenerAttached) return;
  _undoKeyboardListenerAttached = true;
  document.addEventListener('keydown', (e) => {
    // Only intercept when not typing in an input/textarea — otherwise
    // we'd swallow the browser's native text-input undo.
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      // Only fire when Stage 4 v2 is active.
      if (location.hash !== '#/stage4') return;
      if (activeStack().length === 0) return;
      e.preventDefault();
      popAndUndo();
    }
  });
}

function renderUndoButton(host) {
  function refresh(btn) {
    const stack = activeStack();
    const last = stack[stack.length - 1];
    btn.textContent = stack.length ? `↶ Undo (${stack.length})` : '↶ Undo';
    btn.title = last ? 'Undo: ' + last.description : 'Nothing to undo';
    if (stack.length === 0) btn.setAttribute('disabled', '');
    else btn.removeAttribute('disabled');
  }
  const btn = h('button', {
    type: 'button',
    class: 'btn btn-ghost dr2-undo-btn',
    onclick: () => popAndUndo(),
  }, []);
  refresh(btn);
  host.appendChild(btn);
  const unsub = subscribeUndo(() => refresh(btn));
  return unsub;
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

export async function renderDeepReadV2(root) {
  root.innerHTML = '';
  root.classList.add('view-deepread-v2');

  // State.
  const state = {
    papers: [],
    currentPaperId: null,
    extractionInFlight: false,
    claimsInFlight: false,
  };

  // Layout.
  const layout = h('div', { class: 'dr2-layout' });
  const listPane = h('aside', { class: 'dr2-list' });
  const pdfPane  = h('div', { class: 'dr2-pdf' });
  const detailPane = h('div', { class: 'dr2-detail' });
  layout.appendChild(listPane);
  layout.appendChild(pdfPane);
  layout.appendChild(detailPane);
  root.appendChild(layout);

  // Toolbar. Sync auto-fires on mount (reloadList autoSync) so the
  // explicit Sync button is gone. Export lives in Setup → Danger zone.
  // Button starts DISABLED + non-pulsing until the list resolves AND
  // the AI models are cached locally. Without those models extraction
  // would silently produce thin records, so we refuse to launch.
  const autoBtn = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    disabled: true,
    onclick: () => runAutoExtractAll(),
  }, ['✨ Auto-extract everything']);
  // Model-readiness banner. Replaces the auto-extract pulse when
  // models aren't downloaded yet.
  const modelBanner = h('div', { class: 'dr2-model-banner', style: 'display:none;' });
  // Progress widget: bar + label + eta + live activity. Hidden until
  // a job starts. The activity row shows current paper + current step
  // ("topic_enums on paper_037 — Smith et al. 2024") so the user knows
  // exactly what is happening NOW, not just the aggregate count.
  const autoLabel = h('span', { class: 'dr2-auto-label muted small' }, ['']);
  const autoEta = h('span', { class: 'dr2-auto-eta muted small' }, ['']);
  const autoBarFill = h('div', { class: 'dr2-auto-bar-fill' });
  const autoBarOuter = h('div', { class: 'dr2-auto-bar' }, [autoBarFill]);
  const autoCurrent = h('div', { class: 'dr2-auto-current muted small' }, ['']);
  const autoActivity = h('details', { class: 'dr2-auto-activity' }, [
    h('summary', { class: 'muted small' }, ['recent activity ▾']),
  ]);
  // Cancel button. Visible only while a corpus job is running. Sends a
  // cancel signal that the orchestrator picks up at the next paper
  // boundary (typically within 30-300s).
  const autoCancel = h('button', { type: 'button', class: 'btn btn-warn dr2-auto-cancel' }, ['Cancel']);
  autoCancel.addEventListener('click', async () => {
    if (!confirm('Cancel the running extraction? The current paper will finish, then it stops.')) return;
    autoCancel.disabled = true;
    autoCancel.textContent = 'Cancelling…';
    const r = await fetchJson('/api/v2/extract/corpus/cancel', { method: 'POST' });
    if (r.error) alert('Cancel failed: ' + r.error);
  });
  const autoProgress = h('div', { class: 'dr2-auto-progress', style: 'display:none;' }, [
    h('div', { class: 'dr2-auto-progress-row' }, [autoLabel, autoEta, autoCancel]),
    autoBarOuter,
    autoCurrent,
    autoActivity,
  ]);
  const toolbar = h('div', { class: 'dr2-toolbar' }, [
    h('h2', { class: 'dr2-title' }, ['Deep read']),
    autoBtn,
    autoProgress,
  ]);
  renderUndoButton(toolbar);
  ensureUndoKeyboardListener();
  root.insertBefore(toolbar, layout);
  // Two stacked banners. seedBanner sits above modelBanner so the "you
  // have no extraction axes yet" story plays out before the "models not
  // cached" one — auto-seed produces the axes the methodological /
  // knowledge / population detectors classify against.
  const seedBanner = h('div', { class: 'dr2-seed-banner', style: 'display:none;' });
  root.insertBefore(modelBanner, layout);
  root.insertBefore(seedBanner, modelBanner);
  // Check AI-model readiness on mount + after any preload action.
  // The auto-extract button stays disabled and the banner sits visible
  // until every required model is cached locally.
  checkModelReadiness();
  // Check topic.md axes (categories + method_families). Empty axes mean
  // five of seven gap detectors won't produce candidates. Prompt seeding.
  checkSeedStatus();
  async function checkSeedStatus() {
    let r;
    try { r = await fetchJson('/api/v2/topic/seed-status'); }
    catch (e) { r = { error: e.message }; }
    renderSeedBanner(r);
  }
  function renderSeedBanner(r) {
    seedBanner.innerHTML = '';
    if (!r || r.error || !r.needs_seed) {
      seedBanner.style.display = 'none';
      return;
    }
    if (r.corpus_size < 4) {
      // Too small to cluster. Hint but don't pressure.
      seedBanner.style.display = '';
      seedBanner.appendChild(h('div', { class: 'banner banner-info' }, [
        h('strong', {}, ['Topic axes not set. ']),
        `Once at least 4 papers have abstracts (currently ${r.corpus_size}), this banner offers a one-click auto-seed of categories + method families.`,
      ]));
      return;
    }
    seedBanner.style.display = '';
    const status = h('p', { class: 'muted small' }, ['']);
    const seedBtn = h('button', { type: 'button', class: 'btn btn-ai' }, ['✨ Auto-seed topic axes']);
    seedBtn.addEventListener('click', async () => {
      seedBtn.disabled = true;
      status.textContent = r.has_llm
        ? `Clustering corpus (sentence-embeddings + communityDetection); ${r.llm_provider} names each cluster…`
        : 'Clustering corpus and labelling clusters by their most distinctive bigrams (no AI provider configured)…';
      const res = await fetchJson('/api/v2/topic/auto-seed', { method: 'POST', body: '{}' });
      if (res?.error) {
        status.textContent = 'Auto-seed failed: ' + res.error;
        seedBtn.disabled = false;
        return;
      }
      const cats = (res.categories || []).join(', ');
      const ms = (res.method_families || []).join(', ');
      status.innerHTML = '';
      status.appendChild(h('span', {}, [
        `Seeded. Categories: ${cats || '(none)'}. Method families: ${ms || '(none)'}. `,
        h('a', { href: '#/setup' }, ['Review in Setup ↗']),
      ]));
      setTimeout(checkSeedStatus, 800);
    });
    seedBanner.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('div', {}, [
        h('strong', {}, ['Your topic.md has no categories or method families set. ']),
        'Without these axes the methodological / knowledge / population / theoretical / practical gap detectors stay empty (they classify each paper against these labels). ',
        r.has_llm
          ? `Clustering is local (sentence-embeddings + communityDetection); ${r.llm_provider} names each cluster (a generative task where AI helps).`
          : 'Local clustering + distinctive-bigram labels; configure OpenAI or Anthropic for readable cluster names.',
      ]),
      h('div', { class: 'banner-actions' }, [seedBtn, status]),
    ]));
  }
  async function checkModelReadiness() {
    let r;
    try { r = await fetchJson('/api/models/ready'); }
    catch (e) { r = { error: e.message }; }
    renderModelBanner(r);
  }
  function renderModelBanner(r) {
    modelBanner.innerHTML = '';
    if (!r || r.error) {
      modelBanner.style.display = '';
      modelBanner.appendChild(h('div', { class: 'banner banner-warn' }, [
        h('strong', {}, ['Could not check AI model status. ']),
        r?.error || '',
      ]));
      autoBtn.disabled = true;
      autoBtn.classList.remove('btn-rainbow-pulse');
      return;
    }
    if (r.ready) {
      modelBanner.style.display = 'none';
      // Models OK; the reloadList success path enables the button.
      return;
    }
    // Not ready: show what's missing + preload button.
    modelBanner.style.display = '';
    const preloadBtn = h('button', { type: 'button', class: 'btn btn-primary' }, ['↓ Preload AI models']);
    const status = h('p', { class: 'muted small' }, ['']);
    preloadBtn.addEventListener('click', async () => {
      preloadBtn.disabled = true;
      status.textContent = 'Starting download…';
      const start = await fetchJson('/api/models/preload', { method: 'POST', body: '{}' });
      if (start?.error) { status.textContent = 'Failed: ' + start.error; preloadBtn.disabled = false; return; }
      const poll = setInterval(async () => {
        const s = await fetchJson('/api/models/preload/status');
        if (!s.running) {
          clearInterval(poll);
          if (s.last?.error) {
            status.textContent = 'Failed: ' + s.last.error + ' (try again — HF may be rate-limited)';
            preloadBtn.disabled = false;
          } else {
            const t = s.last?.result?.totals;
            status.textContent = `Done. ${t?.downloaded || 0} downloaded, ${t?.cached || 0} already present, ${t?.failed || 0} failed.`;
            checkModelReadiness();
          }
        } else {
          const p = s.last?.progress;
          if (p) status.textContent = `${p.repo} · file ${p.index}/${p.total} (${p.status})`;
        }
      }, 1000);
    });
    modelBanner.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('div', {}, [
        h('strong', {}, ['AI models not cached locally. ']),
        `Auto-extract needs ${r.missing.length} model${r.missing.length === 1 ? '' : 's'} to produce a full structured record per paper. Running without them gives misleading partial output.`,
      ]),
      h('ul', { class: 'muted small' }, r.missing.map((m) => h('li', {}, [h('code', {}, [m])]))),
      h('div', { class: 'banner-actions' }, [preloadBtn, status]),
    ]));
    autoBtn.disabled = true;
    autoBtn.classList.remove('btn-rainbow-pulse');
  }

  function setAutoProgress({ visible, done, total, elapsedPerPaperMs, message, current, activity }) {
    if (!visible) {
      autoProgress.style.display = 'none';
      autoCancel.disabled = false;
      autoCancel.textContent = 'Cancel';
      return;
    }
    autoProgress.style.display = '';
    autoCancel.disabled = false;
    autoCancel.textContent = 'Cancel';
    if (message) {
      autoLabel.textContent = message;
      autoEta.textContent = '';
      autoBarFill.style.width = '0%';
      autoCurrent.textContent = '';
      return;
    }
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    autoLabel.textContent = `Extracting ${done} of ${total} papers (${pct}%)`;
    autoBarFill.style.width = pct + '%';
    if (elapsedPerPaperMs > 0 && total > done) {
      const remaining = (total - done) * elapsedPerPaperMs;
      autoEta.textContent = '~' + formatEta(remaining) + ' left';
    } else {
      autoEta.textContent = '';
    }
    // Live "now doing" line: step + paper.
    if (current && current.step && current.paper_id) {
      const stepLabel = STEP_LABEL[current.step] || current.step;
      const titleSnippet = current.paper_title
        ? ` — ${current.paper_title.slice(0, 70)}`
        : '';
      autoCurrent.textContent = `→ ${stepLabel} on ${current.paper_id}${titleSnippet}`;
    } else {
      autoCurrent.textContent = '';
    }
    // Activity log (last several step transitions).
    if (Array.isArray(activity) && activity.length) {
      // Preserve <summary>; replace the rest.
      while (autoActivity.children.length > 1) autoActivity.removeChild(autoActivity.lastChild);
      const list = h('ul', { class: 'dr2-auto-activity-list' });
      // Newest first.
      for (const a of [...activity].reverse()) {
        const stepLabel = STEP_LABEL[a.step] || a.step;
        const time = new Date(a.at).toLocaleTimeString();
        list.appendChild(h('li', { class: 'muted small' }, [
          h('span', { class: 'dr2-auto-activity-time' }, [time]),
          ' ',
          h('strong', {}, [stepLabel]),
          ' on ',
          h('code', {}, [a.paper_id]),
          a.paper_title ? ` — ${a.paper_title.slice(0, 60)}` : '',
        ]));
      }
      autoActivity.appendChild(list);
    }
  }

  // Friendly labels for the orchestrator step names.
  const STEP_LABEL = {
    // New v2 pipeline steps (used by extractFullPipelineCorpus).
    grobid: 'parsing PDF (grobid)',
    entities: 'tagging entities (GLiNER)',
    claims: 'extracting typed claims',
    numerical: 'extracting numerical results',
    stance: 'classifying citation stance',
    'phase3-embed': 'embedding for clustering',
    'phase3-cluster': 'clustering + labelling',
    'phase4-detect': 'detecting gap candidates',
    // Legacy v1 orchestrator steps (kept so a paused run from before
    // the switchover still renders sensibly).
    ingest_check: 'checking PDF',
    topic_enums: 'classifying topic + method',
    topic_relevance: 'scoring topic relevance',
    bool: 'extracting boolean signals',
    categorical: 'classifying enums',
    named_entities: 'finding named entities',
  };

  function formatEta(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }

  // Background corpus-wide extraction. The default path: one click,
  // every paper gets chunk ingestion + structured extraction. Per-paper
  // re-extract buttons stay as a fallback for individual touch-ups.
  // The progress widget shows N of M done + a real ETA computed from
  // recent per-paper elapsed times.
  let autoPollTimer = null;
  let autoStartedAt = null;
  let autoLastDone = 0;

  async function runAutoExtractAll() {
    autoBtn.disabled = true;
    autoBtn.classList.remove('btn-rainbow-pulse');
    autoStartedAt = Date.now();
    autoLastDone = 0;
    setAutoProgress({ visible: true, message: 'Starting…' });
    try {
      const r = await fetchJson('/api/v2/extract/corpus', { method: 'POST', body: '{}' });
      if (r.error) {
        setAutoProgress({ visible: true, message: 'Failed: ' + r.error });
        autoBtn.disabled = false;
        return;
      }
      pollAutoExtractStatus();
    } catch (e) {
      setAutoProgress({ visible: true, message: 'Failed: ' + e.message });
      autoBtn.disabled = false;
    }
  }

  async function pollAutoExtractStatus() {
    if (autoPollTimer) clearTimeout(autoPollTimer);
    const r = await fetchJson('/api/v2/extract/corpus/status');
    const job = r?.job;
    if (!job) {
      setAutoProgress({ visible: false });
      autoBtn.disabled = false;
      return;
    }
    if (job.finished_at) {
      const summary = job.error
        ? `Failed: ${job.error}`
        : `Done. ${(job.completed || []).length} extracted, ${(job.failed || []).length} failed.`;
      setAutoProgress({ visible: true, message: summary });
      autoBtn.disabled = false;
      autoPollTimer = setTimeout(() => setAutoProgress({ visible: false }), 6000);
      deepReadCacheClear();   // extraction changed the data; force fresh fetch
      await reloadList();
      return;
    }
    const p = job.progress_per_paper;
    if (p && typeof p.done === 'number' && typeof p.total === 'number') {
      // Refresh the paper list when a new paper completes so badges
      // flip from "needs extract" to "ready" in real time. Without
      // this the user sees the list frozen for hours.
      if (p.done > autoLastDone) {
        deepReadCacheClear();
        refreshListInBackground();
      }
      autoLastDone = p.done;
      // Windowed ETA: average of the last few completed papers, not the
      // full-history mean. The first paper is much slower than the rest
      // (NLI model load + cold cache), so total/N would massively
      // overestimate. recent_elapsed_ms holds the last 8 papers.
      const recent = Array.isArray(job.recent_elapsed_ms) ? job.recent_elapsed_ms : [];
      let perPaperMs = 0;
      if (recent.length >= 2) {
        const sum = recent.reduce((s, x) => s + x, 0);
        perPaperMs = sum / recent.length;
      } else if (autoStartedAt && p.done > 0) {
        perPaperMs = (Date.now() - autoStartedAt) / p.done;
      } else {
        perPaperMs = p.elapsed_ms || 0;
      }
      setAutoProgress({
        visible: true, done: p.done, total: p.total,
        elapsedPerPaperMs: perPaperMs,
        current: job.current,
        activity: job.activity,
      });
    } else if (job.current) {
      // No paper has fully completed yet, but a step is in flight —
      // show that.
      setAutoProgress({
        visible: true, done: 0, total: job.total || 0,
        elapsedPerPaperMs: 0,
        current: job.current,
        activity: job.activity,
      });
    } else {
      setAutoProgress({ visible: true, message: 'Running…' });
    }
    autoPollTimer = setTimeout(pollAutoExtractStatus, 2000);
  }

  // If the user reloads mid-run, pick up where we left off. Disable
  // the button + remove the pulse so the user doesn't get teased into
  // clicking a button that's already actively running.
  fetchJson('/api/v2/extract/corpus/status').then((r) => {
    if (r?.job && !r.job.finished_at) {
      autoBtn.disabled = true;
      autoBtn.classList.remove('btn-rainbow-pulse');
      autoStartedAt = Date.now();
      autoLastDone = r.job.progress_per_paper?.done || 0;
      pollAutoExtractStatus();
    }
  });

  // Helpers.
  async function reloadList({ autoSync = false, useCache = false } = {}) {
    // Cache fast path: when the user just nav-switched back to Deep
    // Read, show the cached list immediately. We still kick a fresh
    // fetch in the background, but the user sees content in <50ms.
    if (useCache) {
      const cached = deepReadCacheGet();
      if (cached) {
        state.papers = cached;
        renderList();
        // Re-enable the auto-extract button now that we have data.
        autoBtn.disabled = false;
        if (!autoExtractInFlight()) autoBtn.classList.add('btn-rainbow-pulse');
        // Background refresh; don't block the user.
        refreshListInBackground();
        return;
      }
    }
    listPane.innerHTML = '<p class="muted small">Loading…</p>';
    // Empty query returns every paper. pdf_only=1 has the server check
    // the actual file on disk so we never list a paper whose PDF isn't
    // there (the DB's pdf_path can lie when download failed). 1000-cap
    // covers large corpora. order_by=paper_id keeps the list in stable
    // sequential order (001, 002, 003…) matching the triage CSV.
    const r = await fetchJson('/api/v2/query?q=&limit=1000&pdf_only=1&order_by=paper_id');
    const empty = !r.error && Array.isArray(r.papers) && r.papers.length === 0;
    if (empty && autoSync) {
      // v2 store really is empty (the query succeeded, just no rows).
      // Mirror the triage CSV in, then retry without re-syncing.
      listPane.innerHTML = '<p class="muted small">Syncing triage CSV into the v2 store…</p>';
      const sync = await fetchJson('/api/v2/sync', { method: 'POST' });
      if (sync?.error) {
        listPane.innerHTML = '';
        listPane.appendChild(h('p', { class: 'muted small' }, ['Sync failed: ' + sync.error]));
        return;
      }
      const synced = sync?.papers?.synced ?? sync?.papers?.inserted ?? sync?.papers?.total ?? null;
      if (synced === 0 || (synced == null && empty)) {
        listPane.innerHTML = '';
        listPane.appendChild(h('p', { class: 'muted small' }, [
          'No papers found in the triage CSV either. Run search (Stage 1) and triage (Stage 2) first.',
        ]));
        return;
      }
      return reloadList({ autoSync: false });
    }
    if (r.error) {
      listPane.innerHTML = '';
      listPane.appendChild(h('p', { class: 'muted small' }, ['Query failed: ' + r.error]));
      return;
    }
    state.papers = r.papers || [];
    deepReadCacheSet(state.papers);
    renderList();
    // Re-enable the auto-extract button ONLY if AI models are ready.
    // Otherwise leave it disabled; the model banner is showing the
    // preload action instead.
    try {
      const ready = await fetchJson('/api/models/ready');
      if (ready?.ready) {
        autoBtn.disabled = false;
        if (!autoExtractInFlight()) autoBtn.classList.add('btn-rainbow-pulse');
      }
    } catch { /* leave disabled */ }
  }

  function autoExtractInFlight() {
    return autoBtn.disabled || autoBtn.textContent !== '✨ Auto-extract everything';
  }

  async function refreshListInBackground() {
    try {
      const r = await fetchJson('/api/v2/query?q=&limit=1000&pdf_only=1&order_by=paper_id');
      if (!r?.error && Array.isArray(r.papers)) {
        state.papers = r.papers;
        deepReadCacheSet(state.papers);
        renderList();
      }
    } catch { /* keep cached view */ }
  }
  function renderList() {
    listPane.innerHTML = '';
    if (state.papers.length === 0) {
      listPane.appendChild(h('p', { class: 'muted small' }, ['No papers yet.']));
      return;
    }
    // Deep Read is the readable corpus. The /api/v2/query?pdf_only=1
    // endpoint already filters to papers whose PDF exists on disk, so
    // state.papers here is the readable set.
    listPane.appendChild(h('p', { class: 'muted small' }, [
      `${state.papers.length} paper${state.papers.length === 1 ? '' : 's'}`,
    ]));
    if (state.papers.length === 0) {
      listPane.appendChild(h('p', { class: 'muted small' }, [
        'No PDFs on disk yet. The download daemon is still working through the queue.',
      ]));
      return;
    }
    for (const p of state.papers) {
      const isActive = p.paper_id === state.currentPaperId;
      // Per-paper status badge. PDF is guaranteed here (filtered above).
      const hasChunks = (p.chunk_count || 0) > 0;
      const hasFields = (p.field_count || 0) > 0;
      let statusBadge;
      if (!hasChunks) {
        statusBadge = h('span', { class: 'dr2-list-badge badge-waiting', title: 'PDF on disk, awaiting chunk ingestion.' }, ['needs ingest']);
      } else if (!hasFields) {
        statusBadge = h('span', { class: 'dr2-list-badge badge-waiting', title: 'Chunks ingested, awaiting structured extraction.' }, ['needs extract']);
      } else {
        statusBadge = h('span', { class: 'dr2-list-badge badge-ready', title: 'PDF + chunks + structured extraction all present.' }, ['ready']);
      }
      const deleteBtn = h('span', {
        class: 'dr2-list-delete',
        title: 'Remove this paper from the corpus (marks excluded + clears v2 extractions; can be undone via triage CSV).',
        onclick: (e) => {
          e.stopPropagation();
          confirmAndDelete(p);
        },
      }, ['×']);
      const row = h('div', {
        class: 'dr2-list-row' + (isActive ? ' active' : ''),
        onclick: () => selectPaper(p.paper_id),
      }, [
        h('span', { class: 'dr2-list-id' }, [p.paper_id]),
        h('span', { class: 'dr2-list-title' }, [(p.title || '(no title)').slice(0, 80)]),
        h('span', { class: 'dr2-list-year muted small' }, [String(p.year || '')]),
        statusBadge,
        deleteBtn,
      ]);
      listPane.appendChild(row);
    }
  }

  async function confirmAndDelete(p) {
    const title = (p.title || '(untitled)').slice(0, 80);
    if (!confirm(`Remove "${title}" from the corpus?\n\nMarks the row excluded in triage, clears its v2 store data (chunks, fields, claims, etc.), and deletes the PDF from disk. The triage CSV row stays so paper_id assignments don't shift.`)) {
      return;
    }
    const r = await fetchJson(`/api/v2/papers/${encodeURIComponent(p.paper_id)}/remove`, { method: 'POST' });
    if (r.error) { alert('Remove failed: ' + r.error); return; }
    // If we deleted the currently-open paper, clear the right pane.
    if (state.currentPaperId === p.paper_id) {
      state.currentPaperId = null;
      pdfPane.innerHTML = '';
      detailPane.innerHTML = '<p class="muted small">Paper removed. Pick another from the list.</p>';
    }
    deepReadCacheClear();
    await reloadList();
  }

  async function selectPaper(paperId) {
    state.currentPaperId = paperId;
    renderList();
    pdfPane.innerHTML = '';
    const pdfUrl = `/api/notes/${encodeURIComponent(paperId)}/pdf`;
    pdfPane.appendChild(h('iframe', { src: pdfUrl, class: 'dr2-pdf-frame', title: 'PDF' }));
    await renderDetail(paperId);
  }

  async function renderDetail(paperId) {
    setCurrentUndoPaper(paperId);
    detailPane.innerHTML = '<p class="muted small">Loading structured record…</p>';
    const data = await fetchJson(`/api/v2/papers/${encodeURIComponent(paperId)}/structured`);
    detailPane.innerHTML = '';
    if (data.error) {
      detailPane.appendChild(h('div', { class: 'banner banner-warn' }, [data.error]));
      return;
    }
    renderDetailSections(detailPane, data, { state, selectPaper, reloadList, renderDetail });
  }

  // Initial load: try the cache first for instant restore on
  // navigate-back; otherwise hit the server and auto-sync if empty.
  await reloadList({ autoSync: true, useCache: true });
}

// ─────────────────────────────────────────────────────────────────────────
// Detail sections (the right-pane content)
// ─────────────────────────────────────────────────────────────────────────

function renderDetailSections(detail, data, ctx) {
  const paperId = data.paper.paper_id;

  // Header card.
  detail.appendChild(h('div', { class: 'dr2-header' }, [
    h('h3', { class: 'dr2-paper-title' }, [data.paper.title || '(no title)']),
    h('div', { class: 'dr2-paper-meta muted small' }, [
      h('span', {}, [String(data.paper.year || '?'), ' · ']),
      h('span', {}, [data.paper.venue || 'unknown venue', ' · ']),
      h('span', {}, [(data.authors || []).slice(0, 3).join(', ') + ((data.authors || []).length > 3 ? ' et al.' : '')]),
    ]),
    h('div', { class: 'dr2-paper-ids muted small' }, [
      data.paper.doi ? h('a', { href: 'https://doi.org/' + data.paper.doi, target: '_blank' }, ['DOI ' + data.paper.doi]) : null,
      data.paper.arxiv_id ? h('a', { href: 'https://arxiv.org/abs/' + data.paper.arxiv_id, target: '_blank' }, [' · arXiv ' + data.paper.arxiv_id]) : null,
    ].filter(Boolean)),
    renderActions(paperId, data, ctx),
  ]));

  // Phase 1: grobid structured parse panel. Loads from the new endpoint;
  // shows sections / refs / citation markers / tables / figures with
  // canonical section types. Phase 2 will fold richer extracts into this.
  const grobidRoot = h('div', { class: 'dr2-grobid' });
  detail.appendChild(grobidRoot);
  loadGrobidStructured(paperId, grobidRoot);

  // Phase 2: per-paper extraction outputs (entities + typed claims +
  // numerical results + citation-context stance).
  const phase2Root = h('div', { class: 'dr2-phase2' });
  detail.appendChild(phase2Root);
  loadPhase2Structured(paperId, phase2Root);

  // Phase 3: emergent cluster context — which paper-cluster + method-
  // cluster this paper belongs to, plus its claim/entity-cluster
  // distribution. Where the gap-finding signal will eventually live.
  const phase3Root = h('div', { class: 'dr2-phase3' });
  detail.appendChild(phase3Root);
  loadPhase3Context(paperId, phase3Root);

  // Categories (editable).
  detail.appendChild(renderCategories(paperId, data.categories || [], ctx));

  // paper_field rows.
  if (data.fields?.length) {
    detail.appendChild(h('h4', {}, ['Extracted fields ', h('span', { class: 'muted small' }, ['(click any value to edit)'])]));
    detail.appendChild(renderFieldsTable(data.fields, paperId, ctx));
  }

  // Named entities by kind — editable.
  const SHOWN_KINDS = ['tech', 'dataset', 'framework'];
  for (const kind of SHOWN_KINDS) {
    const items = (data.names_by_kind && data.names_by_kind[kind]) || [];
    detail.appendChild(h('h4', {}, [
      `${kind}${items.length ? ` (${items.length})` : ''} `,
      h('span', { class: 'muted small' }, ['(× to remove · + to add)']),
    ]));
    detail.appendChild(renderEditableNameChips(items, kind, paperId, ctx));
  }

  // Results — editable.
  detail.appendChild(h('h4', {}, [
    `Results${data.results?.length ? ` (${data.results.length})` : ''} `,
    h('span', { class: 'muted small' }, ['(× to remove · + to add)']),
  ]));
  detail.appendChild(renderEditableResultsTable(data.results || [], paperId, ctx));

  // Body-section quote tables.
  detail.appendChild(h('h4', {}, [
    'Body sections ',
    h('span', { class: 'muted small' }, ['(verbatim quotes per section · click + to add)']),
  ]));
  const bodyRoot = h('div', { class: 'dr2-bodies' });
  detail.appendChild(bodyRoot);
  loadBodySections(paperId, bodyRoot, ctx);

  // Claims (grouped by claim_type).
  if (data.claims?.length) {
    detail.appendChild(h('h4', {}, [`Claims (${data.claims.length})`]));
    detail.appendChild(renderClaims(data.claims));
  }

  // Empty-state hint.
  if ((data.fields?.length || 0) === 0 &&
      (data.claims?.length || 0) === 0 &&
      (data.results?.length || 0) === 0) {
    detail.appendChild(h('div', { class: 'dr2-empty' }, [
      h('p', { class: 'muted' }, [
        'No structured data yet for this paper. Use the buttons above to run the extractors.',
      ]),
    ]));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Action buttons
// ─────────────────────────────────────────────────────────────────────────

function renderActions(paperId, data, ctx) {
  const row = h('div', { class: 'dr2-actions' });

  const reIngestBtn = h('button', { type: 'button', class: 'btn' }, ['↻ Re-ingest chunks']);
  reIngestBtn.addEventListener('click', async () => {
    reIngestBtn.disabled = true;
    reIngestBtn.textContent = 'Ingesting…';
    const r = await fetchJson(`/api/v2/papers/${encodeURIComponent(paperId)}/ingest`, { method: 'POST' });
    reIngestBtn.disabled = false;
    reIngestBtn.textContent = '↻ Re-ingest chunks';
    if (r.error) { alert('Ingest failed: ' + r.error); return; }
    if (r.error === 'pdf not found') alert('No PDF on disk for this paper.');
    else alert(`Ingested ${r.n_chunks} chunks across ${Object.keys(r.sections || {}).length} sections`);
    await ctx.renderDetail(paperId);
  });
  row.appendChild(reIngestBtn);

  // (The four per-phase buttons here — Grobid, Phase 2, Phase 3, Phase
  // 4 — are now subsumed by the single corpus-wide "Auto-extract
  // everything" button at the top of the view. The old per-phase
  // buttons created a Zelda-style "click in correct order" puzzle:
  // every paper needs all four phases anyway. Use Auto-extract for the
  // full pipeline; this row only keeps re-run shortcuts for the legacy
  // v1 path below.)

  const extractBtn = h('button', { type: 'button', class: 'btn btn-ai' }, ['✨ Re-extract structured fields']);
  extractBtn.addEventListener('click', async () => {
    extractBtn.disabled = true;
    extractBtn.textContent = 'Extracting… (~15-20s)';
    const r = await fetchJson(`/api/v2/papers/${encodeURIComponent(paperId)}/extract`, { method: 'POST', body: '{}' });
    extractBtn.disabled = false;
    extractBtn.textContent = '✨ Re-extract structured fields';
    if (r.error) { alert('Extract failed: ' + r.error); return; }
    if (r.errors?.length) alert('Errors: ' + r.errors.join(' · '));
    await ctx.renderDetail(paperId);
  });
  row.appendChild(extractBtn);

  const claimsBtn = h('button', { type: 'button', class: 'btn btn-ai' }, ['💬 Extract claims (LLM)']);
  claimsBtn.addEventListener('click', async () => {
    const provider = llm.getProvider?.();
    if (provider === 'off' || provider === 'share-to-chat') {
      alert(`LLM provider is "${provider}" — claim extraction needs WebLLM, OpenAI, or Anthropic. Configure in the topbar AI pill.`);
      return;
    }
    if (provider === 'webllm' && !llm.isLoaded?.()) {
      alert('WebLLM model not loaded — open the topbar AI pill to load one first.');
      return;
    }
    claimsBtn.disabled = true;
    const status = h('span', { class: 'dr2-claim-status muted small' }, ['']);
    row.appendChild(status);
    try {
      const r = await runClaimsExtraction(paperId, {
        onProgress: (claimType, st, detailMsg) => {
          status.textContent = `[${claimType}] ${st}${detailMsg ? ': ' + String(detailMsg).slice(0, 60) : ''}`;
        },
      });
      claimsBtn.disabled = false;
      status.textContent = r.error ? `failed: ${r.error}` : `done — ${r.total_accepted} accepted`;
      await ctx.renderDetail(paperId);
    } catch (e) {
      claimsBtn.disabled = false;
      status.textContent = 'failed: ' + (e?.message || e);
    }
  });
  row.appendChild(claimsBtn);

  return row;
}

// ─────────────────────────────────────────────────────────────────────────
// Categories — editable chip list
// ─────────────────────────────────────────────────────────────────────────

function renderCategories(paperId, categories, ctx) {
  const wrap = h('div', { class: 'dr2-categories' });
  wrap.appendChild(h('h4', {}, ['Categories']));
  const chips = h('div', { class: 'dr2-chips' });
  for (const c of categories) {
    chips.appendChild(makeRemovableChip(c, async () => {
      const prev = [...categories];
      const next = categories.filter((x) => x !== c);
      await saveCategories(paperId, next);
      pushUndo({
        description: `remove category "${c}"`,
        undoFn: async () => { await saveCategories(paperId, prev); await ctx.renderDetail(paperId); },
      });
      await ctx.renderDetail(paperId);
    }));
  }
  // Add-new control.
  const addInput = h('input', { type: 'text', class: 'dr2-chip-add', placeholder: '+ add category' });
  addInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const v = addInput.value.trim();
      if (!v) return;
      const prev = [...categories];
      const next = [...new Set([...categories, v])];
      await saveCategories(paperId, next);
      pushUndo({
        description: `add category "${v}"`,
        undoFn: async () => { await saveCategories(paperId, prev); await ctx.renderDetail(paperId); },
      });
      await ctx.renderDetail(paperId);
    }
  });
  chips.appendChild(addInput);
  wrap.appendChild(chips);
  return wrap;
}

function makeRemovableChip(label, onRemove) {
  const x = h('button', { type: 'button', class: 'dr2-chip-x', onclick: onRemove }, ['×']);
  return h('span', { class: 'chip dr2-chip' }, [label, x]);
}

async function saveCategories(paperId, categories) {
  const r = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/categories`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ categories }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: 'http ' + r.status }));
    alert('Save failed: ' + (err.error || r.status));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Fields / names / results / claims render
// ─────────────────────────────────────────────────────────────────────────

function renderFieldsTable(fields, paperId, ctx) {
  // Two-row layout per field: header row (field + value + meta) AND
  // a sub-row with the verbatim quote. The quote is the "grounded in
  // truth" evidence — readable inline so the user doesn't have to hover.
  const tbl = h('table', { class: 'structured-table dr2-fields' });
  tbl.appendChild(h('thead', {}, [
    h('tr', {}, ['Field', 'Value', 'Mechanism', 'Confidence', 'Source page'].map((s) => h('th', {}, [s]))),
  ]));
  const body = h('tbody');
  for (const f of fields) {
    const scoresPreview = f.classifier_scores_json ? renderScoresHover(f.classifier_scores_json) : null;
    const valueCell = h('td', {
      class: 'dr2-editable-cell',
      title: 'Click to edit',
      onclick: (e) => editFieldInline(e.currentTarget, paperId, f, ctx),
    }, [renderFieldValue(f)]);
    const mechCell = h('td', { class: 'muted small dr2-mech' }, [
      h('code', {}, [f.mechanism || '?']),
      f.model ? h('span', { class: 'muted small' }, [' · ', String(f.model).slice(0, 40)]) : null,
    ].filter(Boolean));
    body.appendChild(h('tr', { class: 'dr2-field-row' }, [
      h('td', {}, [f.field_name]),
      valueCell,
      mechCell,
      h('td', { class: 'muted small' }, [
        typeof f.confidence === 'number' ? f.confidence.toFixed(2) : '',
        scoresPreview ? h('span', { class: 'dr2-info' }, [' ⓘ', scoresPreview]) : null,
      ]),
      h('td', { class: 'muted small' }, [f.chunk_id ? `${f.chunk_id} · p.${f.page ?? '?'}` : '—']),
    ]));
    // Verbatim-quote sub-row. Shows the substring-validated evidence that
    // produced the value. This is what makes the cell explainable.
    if (f.raw_text && String(f.raw_text).trim()) {
      body.appendChild(h('tr', { class: 'dr2-field-evidence' }, [
        h('td', { colspan: 5 }, [
          h('span', { class: 'muted small' }, ['evidence: ']),
          h('q', { class: 'dr2-field-quote' }, [String(f.raw_text)]),
        ]),
      ]));
    }
  }
  tbl.appendChild(body);
  return tbl;
}

// Render the field value with extra cues for the three-valued boolean
// type (confirmed/refuted/unknown) the LLM finder emits. Legacy local-path
// rows have field_type='bool' with value 'true' / 'false'; we map those
// onto confirmed/unknown for visual consistency.
function renderFieldValue(f) {
  const raw = String(f.field_value ?? '');
  if (f.field_type === 'bool3' || f.field_type === 'bool') {
    const norm = f.field_type === 'bool'
      ? (raw === 'true' ? 'confirmed' : raw === 'false' ? 'unknown' : raw)
      : raw;
    const cls = norm === 'confirmed' ? 'dr2-bool-confirmed'
              : norm === 'refuted'   ? 'dr2-bool-refuted'
              : 'dr2-bool-unknown';
    return h('span', { class: `dr2-bool-pill ${cls}` }, [norm]);
  }
  return raw;
}

// Replace the value cell with an input; Enter commits, Escape cancels.
function editFieldInline(td, paperId, field, ctx) {
  const oldValue = String(field.field_value ?? '');
  td.innerHTML = '';
  const input = h('input', {
    type: 'text',
    class: 'dr2-inline-edit',
    value: oldValue,
  });
  td.appendChild(input);
  input.focus();
  input.select();
  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const next = input.value.trim();
    if (next === oldValue) { restore(); return; }
    td.innerHTML = '<span class="muted small">saving…</span>';
    const r = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/fields/${encodeURIComponent(field.field_name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: next, field_type: field.field_type || 'string' }),
    }).then((r) => r.json()).catch((e) => ({ error: e.message }));
    if (r.error) {
      td.textContent = oldValue;
      alert('Save failed: ' + r.error);
      return;
    }
    pushUndo({
      description: `${field.field_name}: "${next}" → "${oldValue}"`,
      undoFn: async () => {
        await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/fields/${encodeURIComponent(field.field_name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: oldValue, field_type: field.field_type || 'string' }),
        });
        await ctx.renderDetail(paperId);
      },
    });
    await ctx.renderDetail(paperId);
  }
  function restore() {
    td.textContent = oldValue;
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); restore(); }
  });
  input.addEventListener('blur', () => commit());
}

function renderScoresHover(scoresJson) {
  let parsed;
  try { parsed = JSON.parse(scoresJson); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const sorted = Object.entries(parsed).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return h('span', { class: 'dr2-tooltip' }, [
    sorted.map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`).join('  '),
  ]);
}

function renderNameChips(items) {
  return h('div', { class: 'dr2-chips' },
    items.map((it) => h('span', {
      class: 'chip',
      title: [it.mechanism || '', it.score ? 's=' + Number(it.score).toFixed(2) : '', it.role || ''].filter(Boolean).join(' · '),
    }, [
      it.preferred_label || it.canonical,
      it.raw && it.raw !== (it.preferred_label || it.canonical)
        ? h('span', { class: 'muted small' }, [` (${it.raw})`]) : null,
    ])));
}

function renderEditableNameChips(items, kind, paperId, ctx) {
  const wrap = h('div', { class: 'dr2-chips' });
  for (const it of items) {
    const label = it.preferred_label || it.canonical;
    const x = h('button', {
      type: 'button',
      class: 'dr2-chip-x',
      title: 'Remove',
      onclick: async () => {
        const r = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/name-usage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove_by_canonical', kind, canonical: it.canonical }),
        }).then((r) => r.json()).catch((e) => ({ error: e.message }));
        if (r.error) { alert('Remove failed: ' + r.error); return; }
        pushUndo({
          description: `remove ${kind} "${label}"`,
          undoFn: async () => {
            await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/name-usage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'add', kind, canonical: it.canonical, raw: it.raw || label }),
            });
            await ctx.renderDetail(paperId);
          },
        });
        await ctx.renderDetail(paperId);
      },
    }, ['×']);
    wrap.appendChild(h('span', {
      class: 'chip dr2-chip',
      title: [it.mechanism || '', it.score ? 's=' + Number(it.score).toFixed(2) : '', it.role || ''].filter(Boolean).join(' · '),
    }, [
      label,
      it.raw && it.raw !== label
        ? h('span', { class: 'muted small' }, [` (${it.raw})`]) : null,
      x,
    ]));
  }
  // Add control.
  const input = h('input', {
    type: 'text',
    class: 'dr2-chip-add',
    placeholder: `+ add ${kind}`,
  });
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    // Use the raw text as the canonical for user-added entries; the
    // entity-resolution layer will absorb it on the next re-extract.
    const canonical = v.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '');
    const r = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/name-usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', kind, canonical, raw: v }),
    }).then((r) => r.json()).catch((e) => ({ error: e.message }));
    if (r.error) { alert('Add failed: ' + r.error); return; }
    pushUndo({
      description: `add ${kind} "${v}"`,
      undoFn: async () => {
        await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/name-usage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove_by_canonical', kind, canonical }),
        });
        await ctx.renderDetail(paperId);
      },
    });
    input.value = '';
    await ctx.renderDetail(paperId);
  });
  wrap.appendChild(input);
  return wrap;
}

function renderResultsTable(results) {
  // Read-only variant kept for callers that don't need editing context.
  const tbl = h('table', { class: 'structured-table' });
  tbl.appendChild(h('thead', {}, [
    h('tr', {}, ['Metric','Value','Dataset','Split','Page'].map((s) => h('th', {}, [s]))),
  ]));
  const body = h('tbody');
  for (const r of results) {
    body.appendChild(h('tr', {}, [
      h('td', {}, [r.metric]),
      h('td', {}, [String(r.value)]),
      h('td', {}, [r.dataset || '—']),
      h('td', {}, [r.split || '—']),
      h('td', { class: 'muted small' }, [String(r.page || '')]),
    ]));
  }
  tbl.appendChild(body);
  return tbl;
}

function renderEditableResultsTable(results, paperId, ctx) {
  const tbl = h('table', { class: 'structured-table dr2-results-table' });
  tbl.appendChild(h('thead', {}, [
    h('tr', {}, ['Metric','Value','Dataset','Split','Page',''].map((s) => h('th', {}, [s]))),
  ]));
  const body = h('tbody');
  for (const r of results) body.appendChild(renderResultRow(r, paperId, ctx));
  body.appendChild(renderAddResultRow(paperId, ctx));
  tbl.appendChild(body);
  return tbl;
}

function renderResultRow(r, paperId, ctx) {
  function editable(value, fieldName, type = 'text') {
    return h('td', {
      class: 'dr2-editable-cell',
      title: 'Click to edit',
      onclick: (e) => editResultCell(e.currentTarget, paperId, r, fieldName, type, ctx),
    }, [String(value ?? '')]);
  }
  const removeCell = h('td', { class: 'dr2-span-actions' }, [
    h('button', {
      type: 'button', class: 'dr2-chip-x', title: 'Remove',
      onclick: async () => {
        const prev = { ...r };
        const res = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', result_id: r.result_id }),
        }).then((x) => x.json()).catch((e) => ({ error: e.message }));
        if (res.error) { alert('Remove failed: ' + res.error); return; }
        pushUndo({
          description: `restore result ${prev.metric}=${prev.value}`,
          undoFn: async () => {
            await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/results`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'add', metric: prev.metric, value: prev.value, dataset: prev.dataset, split: prev.split }),
            });
            await ctx.renderDetail(paperId);
          },
        });
        await ctx.renderDetail(paperId);
      },
    }, ['×']),
  ]);
  return h('tr', {}, [
    editable(r.metric, 'metric'),
    editable(r.value, 'value', 'number'),
    editable(r.dataset || '', 'dataset'),
    editable(r.split || '', 'split'),
    h('td', { class: 'muted small' }, [String(r.page || '')]),
    removeCell,
  ]);
}

function editResultCell(td, paperId, r, fieldName, type, ctx) {
  const oldValue = String(r[fieldName] ?? '');
  td.innerHTML = '';
  const input = h('input', { type: type === 'number' ? 'number' : 'text', class: 'dr2-inline-edit', value: oldValue });
  td.appendChild(input);
  input.focus(); input.select();
  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const next = input.value.trim();
    if (next === oldValue) { td.textContent = oldValue; return; }
    td.innerHTML = '<span class="muted small">saving…</span>';
    const payload = {
      action: 'edit',
      result_id: r.result_id,
      metric: r.metric, value: r.value, dataset: r.dataset, split: r.split,
      [fieldName]: type === 'number' ? Number(next) : next,
    };
    const res = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (res.error) { td.textContent = oldValue; alert('Save failed: ' + res.error); return; }
    await ctx.renderDetail(paperId);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); td.textContent = oldValue; }
  });
  input.addEventListener('blur', commit);
}

function renderAddResultRow(paperId, ctx) {
  const tr = h('tr', { class: 'dr2-span-addrow' });
  const metric = h('input', { type: 'text', class: 'dr2-span-input', placeholder: 'metric (e.g. f1)' });
  const value = h('input', { type: 'number', step: 'any', class: 'dr2-span-input', placeholder: 'value' });
  const dataset = h('input', { type: 'text', class: 'dr2-span-input', placeholder: 'dataset (optional)' });
  const split = h('input', { type: 'text', class: 'dr2-span-input', placeholder: 'split' });
  const addBtn = h('button', { type: 'button', class: 'btn dr2-span-add' }, ['Add']);
  async function commit() {
    if (!metric.value.trim() || !value.value) return;
    const addBody = {
      action: 'add',
      metric: metric.value.trim(),
      value: Number(value.value),
      dataset: dataset.value.trim() || null,
      split: split.value.trim() || null,
    };
    const res = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addBody),
    }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (res.error) { alert('Add failed: ' + res.error); return; }
    pushUndo({
      description: `add result ${addBody.metric}=${addBody.value}`,
      undoFn: async () => {
        if (res.result_id) {
          await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/results`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'remove', result_id: res.result_id }),
          });
        }
        await ctx.renderDetail(paperId);
      },
    });
    metric.value = ''; value.value = ''; dataset.value = ''; split.value = '';
    await ctx.renderDetail(paperId);
  }
  addBtn.addEventListener('click', commit);
  for (const i of [metric, value, dataset, split]) {
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  }
  tr.appendChild(h('td', {}, [metric]));
  tr.appendChild(h('td', {}, [value]));
  tr.appendChild(h('td', {}, [dataset]));
  tr.appendChild(h('td', {}, [split]));
  tr.appendChild(h('td', {}, []));
  tr.appendChild(h('td', {}, [addBtn]));
  return tr;
}

// Body-section quote tables. Each of the six required sections gets a
// table; rows are editable (click text to edit, × to remove); a "+" row
// at the bottom adds a new span.
async function loadBodySections(paperId, root, ctx) {
  root.innerHTML = '<p class="muted small">Loading body sections…</p>';
  const data = await fetchJson(`/api/v2/papers/${encodeURIComponent(paperId)}/spans`);
  root.innerHTML = '';
  if (data.error) {
    root.appendChild(h('div', { class: 'banner banner-warn' }, [data.error]));
    return;
  }
  const bySection = data.by_section || {};
  for (const [key, label] of Object.entries(SECTION_LABELS)) {
    root.appendChild(renderBodySection(paperId, key, label, bySection[key] || [], ctx));
  }
}

function renderBodySection(paperId, sectionKey, sectionLabel, spans, ctx) {
  const wrap = h('section', { class: 'dr2-body-section' });
  wrap.appendChild(h('h5', {}, [sectionLabel, h('span', { class: 'muted small' }, [` · ${spans.length}`])]));
  const tbl = h('table', { class: 'structured-table dr2-spans-table' });
  tbl.appendChild(h('thead', {}, [
    h('tr', {}, ['Quote', 'p.', ''].map((s) => h('th', {}, [s]))),
  ]));
  const body = h('tbody');
  for (const span of spans) body.appendChild(renderSpanRow(paperId, sectionKey, span, ctx));
  body.appendChild(renderAddSpanRow(paperId, sectionKey, ctx));
  tbl.appendChild(body);
  wrap.appendChild(tbl);
  return wrap;
}

function renderSpanRow(paperId, sectionKey, span, ctx) {
  const textCell = h('td', {
    class: 'dr2-editable-cell dr2-span-text',
    title: 'Click to edit',
    onclick: (e) => editSpanInline(e.currentTarget, paperId, span, ctx),
  }, [`"${span.text}"`]);
  const pageCell = h('td', { class: 'muted small' }, [String(span.page || '')]);
  const removeCell = h('td', { class: 'dr2-span-actions' }, [
    h('button', {
      type: 'button',
      class: 'dr2-chip-x',
      title: 'Remove',
      onclick: async () => {
        const prev = { ...span };
        const r = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/spans`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', span_id: span.span_id }),
        }).then((r) => r.json()).catch((e) => ({ error: e.message }));
        if (r.error) { alert('Remove failed: ' + r.error); return; }
        pushUndo({
          description: `restore quote "${prev.text.slice(0, 40)}…"`,
          undoFn: async () => {
            await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/spans`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'add', section: sectionKey, text: prev.text, page: prev.page }),
            });
            await ctx.renderDetail(paperId);
          },
        });
        await ctx.renderDetail(paperId);
      },
    }, ['×']),
  ]);
  return h('tr', {}, [textCell, pageCell, removeCell]);
}

function renderAddSpanRow(paperId, sectionKey, ctx) {
  const tr = h('tr', { class: 'dr2-span-addrow' });
  const textInput = h('input', { type: 'text', class: 'dr2-span-input', placeholder: '+ paste a verbatim quote' });
  const pageInput = h('input', { type: 'number', class: 'dr2-span-page-input', placeholder: 'p.' });
  const addBtn = h('button', { type: 'button', class: 'btn dr2-span-add' }, ['Add']);
  async function commit() {
    const text = textInput.value.trim();
    if (!text) return;
    const page = pageInput.value ? parseInt(pageInput.value, 10) : null;
    const r = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/spans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', section: sectionKey, text, page }),
    }).then((r) => r.json()).catch((e) => ({ error: e.message }));
    if (r.error) { alert('Add failed: ' + r.error); return; }
    pushUndo({
      description: `add quote "${text.slice(0, 40)}…"`,
      undoFn: async () => {
        if (r.span_id) {
          await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/spans`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'remove', span_id: r.span_id }),
          });
        }
        await ctx.renderDetail(paperId);
      },
    });
    textInput.value = ''; pageInput.value = '';
    await ctx.renderDetail(paperId);
  }
  addBtn.addEventListener('click', commit);
  textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  tr.appendChild(h('td', {}, [textInput]));
  tr.appendChild(h('td', {}, [pageInput]));
  tr.appendChild(h('td', {}, [addBtn]));
  return tr;
}

function editSpanInline(td, paperId, span, ctx) {
  const oldText = span.text;
  td.innerHTML = '';
  const input = h('input', { type: 'text', class: 'dr2-inline-edit', value: oldText });
  td.appendChild(input);
  input.focus(); input.select();
  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const next = input.value.trim();
    if (!next || next === oldText) { td.textContent = `"${oldText}"`; return; }
    td.innerHTML = '<span class="muted small">saving…</span>';
    const r = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/spans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'edit', span_id: span.span_id, text: next }),
    }).then((r) => r.json()).catch((e) => ({ error: e.message }));
    if (r.error) { td.textContent = `"${oldText}"`; alert('Save failed: ' + r.error); return; }
    await ctx.renderDetail(paperId);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); td.textContent = `"${oldText}"`; }
  });
  input.addEventListener('blur', commit);
}

function renderClaims(claims) {
  const wrap = h('div', { class: 'dr2-claims' });
  const grouped = {};
  for (const c of claims) {
    if (!grouped[c.claim_type]) grouped[c.claim_type] = [];
    grouped[c.claim_type].push(c);
  }
  for (const [type, items] of Object.entries(grouped)) {
    wrap.appendChild(h('div', { class: 'dr2-claim-group' }, [
      h('h5', {}, [CLAIM_TYPE_LABEL[type] || type, ` (${items.length})`]),
      ...items.map((c) => h('div', { class: 'dr2-claim' }, [
        h('div', { class: 'muted small' }, [
          `stance=${c.stance || '?'}  p.${c.page || '?'}  ${c.chunk_id || ''}`,
        ]),
        h('div', { class: 'dr2-claim-text' }, [`"${c.text}"`]),
      ])),
    ]));
  }
  return wrap;
}

// ─────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────

// Phase 1: render the structured-parse output (sections / refs / cite
// markers / tables / figures) produced by grobid-js. Read-only.
async function loadGrobidStructured(paperId, root) {
  root.innerHTML = '<p class="muted small">Loading grobid structured parse…</p>';
  const r = await fetchJson(`/api/v2/papers/${encodeURIComponent(paperId)}/grobid-structured`);
  root.innerHTML = '';
  if (r.error) {
    // 404 here means the paper hasn't been ingested through grobid yet.
    if (r.error === 'paper_not_found') return;
    root.appendChild(h('p', { class: 'muted small' }, [
      'No grobid parse for this paper yet. Click "🔬 Grobid structured parse" above to run it (~3-10s after first download).',
    ]));
    return;
  }
  if (!r.sections || r.sections.length === 0) {
    root.appendChild(h('p', { class: 'muted small' }, [
      'No grobid parse for this paper yet. Click "🔬 Grobid structured parse" above to run it.',
    ]));
    return;
  }
  root.appendChild(h('h4', {}, [
    'Grobid structured parse ',
    h('span', { class: 'muted small' }, [
      `(${r.sections.length} sections · ${r.total_paragraphs} paragraphs · ${r.references.length} refs · ${r.citation_stats.linked}/${r.citation_stats.total} citation markers linked · ${r.tables.length} tables · ${r.figures.length} figures)`,
    ]),
  ]));

  // Sections summary table.
  const secTbl = h('table', { class: 'structured-table dr2-sections-table' });
  secTbl.appendChild(h('thead', {}, [
    h('tr', {}, ['Section', 'Type', 'Paras', 'Sample'].map((s) => h('th', {}, [s]))),
  ]));
  const secBody = h('tbody');
  for (const s of r.sections) {
    const indent = '  '.repeat(Math.max(0, (s.level || 1) - 1));
    const sample = (s.sample_paragraphs?.[0]?.preview || '').slice(0, 100);
    secBody.appendChild(h('tr', {}, [
      h('td', {}, [
        h('span', { class: 'muted small' }, [indent]),
        h('code', { class: 'dr2-section-heading' }, [s.raw_heading || '(no heading)']),
      ]),
      h('td', {}, [h('span', { class: `dr2-section-type type-${s.canonical_type}` }, [s.canonical_type])]),
      h('td', { class: 'muted small' }, [String(s.n_paragraphs)]),
      h('td', { class: 'muted small' }, [sample + (sample.length === 100 ? '…' : '')]),
    ]));
  }
  secTbl.appendChild(secBody);
  root.appendChild(secTbl);

  // References summary — collapsed by default.
  if (r.references.length > 0) {
    const refsDetails = h('details', { class: 'dr2-refs-details' });
    refsDetails.appendChild(h('summary', { class: 'muted small' }, [
      `Parsed references (${r.references.length})`,
    ]));
    const refsList = h('ol', { class: 'dr2-refs-list' });
    for (const ref of r.references.slice(0, 100)) {
      const parts = [
        ref.title ? h('strong', {}, [ref.title]) : null,
        ref.authors_raw ? h('span', { class: 'muted small' }, [' · ' + ref.authors_raw.slice(0, 80)]) : null,
        ref.date_year ? h('span', { class: 'muted small' }, [` (${ref.date_year})`]) : null,
        ref.journal ? h('span', { class: 'muted small' }, [` · ${ref.journal}`]) : null,
        ref.doi ? h('a', { href: 'https://doi.org/' + ref.doi, target: '_blank', class: 'muted small' }, [` · doi:${ref.doi}`]) : null,
      ].filter(Boolean);
      refsList.appendChild(h('li', {}, parts.length ? parts : [h('span', { class: 'muted small' }, ['(unparsed reference)'])]));
    }
    refsDetails.appendChild(refsList);
    root.appendChild(refsDetails);
  }

  // Tables + figures — captions only.
  if (r.tables.length > 0 || r.figures.length > 0) {
    const tfDetails = h('details', { class: 'dr2-tf-details' });
    tfDetails.appendChild(h('summary', { class: 'muted small' }, [
      `Tables (${r.tables.length}) + Figures (${r.figures.length})`,
    ]));
    const ul = h('ul', { class: 'dr2-tf-list' });
    for (const t of r.tables) {
      ul.appendChild(h('li', {}, [
        h('strong', {}, [t.label || 'Table']),
        h('span', { class: 'muted small' }, [` · p.${t.page ?? '?'} · `, (t.caption || '').slice(0, 120)]),
      ]));
    }
    for (const f of r.figures) {
      ul.appendChild(h('li', {}, [
        h('strong', {}, [f.label || 'Figure']),
        h('span', { class: 'muted small' }, [` · p.${f.page ?? '?'} · `, (f.caption || '').slice(0, 120)]),
      ]));
    }
    tfDetails.appendChild(ul);
    root.appendChild(tfDetails);
  }
}

// Phase 4: render the corpus-wide detection result in a floating /
// modal-style panel below the toolbar.
const GAP_DEFINITIONS = {
  evidence:       'Findings on the same metric × dataset disagree across papers.',
  knowledge:      'A (topic × method) cell is empty while neighbouring cells are dense.',
  methodological: 'A topic cluster has not been studied with a method the corpus DOES use elsewhere.',
  empirical:      'A claim is theorised repeatedly but never empirically validated.',
  theoretical:    'A topic produces findings but cites few/no theoretical frameworks.',
  population:     'A population descriptor appears in some topic clusters but not others.',
  practical:      'A claim cluster sees supportive stance in one topic cluster, adversarial in another.',
};
function showPhase4Result(r) {
  // Replace any prior modal.
  document.querySelectorAll('.dr2-phase4-modal').forEach((n) => n.remove());
  const modal = h('div', { class: 'dr2-phase4-modal' });
  const close = h('button', { type: 'button', class: 'dr2-phase4-close' }, ['close ×']);
  close.addEventListener('click', () => modal.remove());
  modal.appendChild(close);
  modal.appendChild(h('h3', {}, ['Phase 4 — emergent gap detection ',
    h('span', { class: 'muted small' }, [`(${r.elapsed_ms} ms · ${r.summary.total} candidates across 7 types)`]),
  ]));
  if (r.preconditions?.length) {
    modal.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('strong', {}, ['Sparse inputs:']),
      h('ul', {}, r.preconditions.map((p) => h('li', {}, [p]))),
    ]));
  }
  for (const type of ['evidence', 'knowledge', 'methodological', 'empirical', 'theoretical', 'population', 'practical']) {
    const block = r.byType[type] || { candidates: [], n: 0 };
    const sect = h('section', { class: 'dr2-phase4-section' });
    sect.appendChild(h('h4', {}, [
      h('strong', {}, [type]),
      h('span', { class: 'muted small' }, [`  · ${block.n} candidate${block.n === 1 ? '' : 's'}`]),
    ]));
    sect.appendChild(h('p', { class: 'muted small' }, [GAP_DEFINITIONS[type] || '']));
    if (block.error) {
      sect.appendChild(h('p', { class: 'hint hint-warn' }, ['Error: ' + block.error]));
    } else if (block.n === 0) {
      sect.appendChild(h('p', { class: 'muted small' }, ['(no candidates in this corpus state)']));
    } else {
      const ul = h('ul', { class: 'dr2-phase4-list' });
      for (const c of block.candidates.slice(0, 10)) {
        ul.appendChild(h('li', {}, [
          h('span', { class: 'dr2-phase4-sal' }, [`s=${c.salience}`]),
          ' ',
          h('span', {}, [c.description || '']),
          c.contributing_papers?.length
            ? h('div', { class: 'muted small' }, [`papers: ${c.contributing_papers.slice(0, 6).join(', ')}${c.contributing_papers.length > 6 ? ` (+${c.contributing_papers.length - 6})` : ''}`])
            : null,
        ].filter(Boolean)));
      }
      sect.appendChild(ul);
    }
    modal.appendChild(sect);
  }
  document.body.appendChild(modal);
}

// Phase 3: this paper's emergent cluster context. Shows the
// paper-cluster + method-cluster it landed in, the sibling papers in
// the same cluster, and the claim/entity-cluster distribution.
async function loadPhase3Context(paperId, root) {
  root.innerHTML = '<p class="muted small">Loading cluster context…</p>';
  const r = await fetchJson(`/api/v2/papers/${encodeURIComponent(paperId)}/cluster-context`);
  root.innerHTML = '';
  if (r.error) {
    if (r.error !== 'paper_not_found') {
      root.appendChild(h('p', { class: 'muted small' }, ['No clusters yet. Run "🌐 Phase 3 cluster" above.']));
    }
    return;
  }
  const hasAny = r.paper_cluster || r.method_cluster || (r.claim_clusters?.length > 0) || (r.entity_clusters?.length > 0);
  if (!hasAny) {
    root.appendChild(h('p', { class: 'muted small' }, ['No clusters yet. Run "🌐 Phase 3 cluster" above (corpus-wide pass).']));
    return;
  }
  root.appendChild(h('h4', {}, ['Emergent cluster context ',
    h('span', { class: 'muted small' }, ['(no static taxonomy — labels emerge from corpus structure)']),
  ]));

  // Paper-cluster + method-cluster pills.
  const tagsRow = h('div', { class: 'dr2-phase3-tags' });
  if (r.paper_cluster) {
    tagsRow.appendChild(h('span', { class: 'dr2-cluster-pill cluster-paper' }, [
      'paper cluster: ',
      h('strong', {}, [r.paper_cluster.auto_label || `#${r.paper_cluster.cluster_id}`]),
      h('span', { class: 'muted small' }, [` (${r.paper_cluster.member_count} papers)`]),
    ]));
  } else {
    tagsRow.appendChild(h('span', { class: 'dr2-cluster-pill cluster-outlier' }, [
      'paper cluster: ', h('em', {}, ['outlier — no strong topical neighbours']),
    ]));
  }
  if (r.method_cluster) {
    tagsRow.appendChild(h('span', { class: 'dr2-cluster-pill cluster-method' }, [
      'method cluster: ',
      h('strong', {}, [r.method_cluster.auto_label || `#${r.method_cluster.cluster_id}`]),
      h('span', { class: 'muted small' }, [` (${r.method_cluster.member_count} papers)`]),
    ]));
  }
  root.appendChild(tagsRow);

  // Sibling papers (in the same paper-cluster).
  if (r.sibling_papers && r.sibling_papers.length > 0) {
    const d = h('details', { class: 'dr2-phase3-details', open: '' });
    d.appendChild(h('summary', { class: 'muted small' }, [`Sibling papers in this cluster (${r.sibling_papers.length})`]));
    const ul = h('ul', { class: 'dr2-phase3-list' });
    for (const sib of r.sibling_papers.slice(0, 12)) {
      ul.appendChild(h('li', {}, [
        h('code', {}, [sib.paper_id]),
        ' ', h('span', { class: 'muted small' }, [(sib.title || '(no title)').slice(0, 100)]),
      ]));
    }
    if (r.sibling_papers.length > 12) ul.appendChild(h('li', { class: 'muted small' }, [`(+${r.sibling_papers.length - 12} more)`]));
    d.appendChild(ul);
    root.appendChild(d);
  }

  // Claim-cluster distribution within this paper.
  if (r.claim_clusters && r.claim_clusters.length > 0) {
    const d = h('details', { class: 'dr2-phase3-details', open: '' });
    d.appendChild(h('summary', { class: 'muted small' }, [
      `Claim clusters touched by this paper (${r.claim_clusters.length})`,
    ]));
    const ul = h('ul', { class: 'dr2-phase3-list' });
    for (const c of r.claim_clusters.slice(0, 15)) {
      ul.appendChild(h('li', {}, [
        h('strong', {}, [c.auto_label || `cluster #${c.cluster_id}`]),
        h('span', { class: 'muted small' }, [` · ${c.n_in_paper} claims from this paper`]),
      ]));
    }
    d.appendChild(ul);
    root.appendChild(d);
  }

  // Entity-cluster distribution within this paper.
  if (r.entity_clusters && r.entity_clusters.length > 0) {
    const d = h('details', { class: 'dr2-phase3-details', open: '' });
    d.appendChild(h('summary', { class: 'muted small' }, [
      `Entity clusters touched by this paper (${r.entity_clusters.length})`,
    ]));
    const ul = h('ul', { class: 'dr2-phase3-list' });
    for (const c of r.entity_clusters.slice(0, 25)) {
      ul.appendChild(h('li', {}, [
        h('strong', {}, [c.auto_label || `cluster #${c.cluster_id}`]),
        h('span', { class: 'muted small' }, [` · ${c.n_in_paper} spans from this paper`]),
      ]));
    }
    if (r.entity_clusters.length > 25) ul.appendChild(h('li', { class: 'muted small' }, [`(+${r.entity_clusters.length - 25} more)`]));
    d.appendChild(ul);
    root.appendChild(d);
  }
}

// Phase 2: render entity spans (grouped by GLiNER initial type), typed
// claims (grouped by claim_type), numerical results, citation stance.
async function loadPhase2Structured(paperId, root) {
  root.innerHTML = '<p class="muted small">Loading Phase 2 outputs…</p>';
  const r = await fetchJson(`/api/v2/papers/${encodeURIComponent(paperId)}/phase2-structured`);
  root.innerHTML = '';
  if (r.error) {
    if (r.error !== 'paper_not_found') {
      root.appendChild(h('p', { class: 'muted small' }, [
        'No Phase 2 output yet. Run "✨ Phase 2 extract" above.',
      ]));
    }
    return;
  }
  const entityTotal = r.entities?.total || 0;
  const claimTotal  = r.claims?.total  || 0;
  const resultTotal = (r.results || []).length;
  const stanceTotal = (r.stance?.by_stance || []).reduce((s, x) => s + (x.n || 0), 0);
  if (entityTotal + claimTotal + resultTotal + stanceTotal === 0) {
    root.appendChild(h('p', { class: 'muted small' }, [
      'No Phase 2 output yet. Run "✨ Phase 2 extract" above.',
    ]));
    return;
  }
  root.appendChild(h('h4', {}, [
    'Phase 2 extraction ',
    h('span', { class: 'muted small' }, [
      `(${entityTotal} entity spans · ${claimTotal} claims · ${resultTotal} results · ${stanceTotal} stance-classified citations)`,
    ]),
  ]));

  // Entity spans grouped by GLiNER initial label.
  if (entityTotal > 0) {
    const entDetails = h('details', { class: 'dr2-phase2-details', open: '' });
    entDetails.appendChild(h('summary', { class: 'muted small' }, [
      `Entity spans (${entityTotal} across ${Object.keys(r.entities.by_label).length} initial types — type labels are HINTS; Phase 3 clustering produces the real types)`,
    ]));
    const entries = Object.entries(r.entities.by_label).sort((a, b) => b[1].length - a[1].length);
    for (const [label, items] of entries) {
      const inner = h('details', { class: 'dr2-phase2-subdetails' });
      inner.appendChild(h('summary', {}, [
        h('strong', {}, [label]),
        h('span', { class: 'muted small' }, [` (${items.length})`]),
      ]));
      const ul = h('ul', { class: 'dr2-phase2-list' });
      for (const e of items.slice(0, 30)) {
        ul.appendChild(h('li', {}, [
          h('code', {}, [e.span_text]),
          h('span', { class: 'muted small' }, [` · s=${e.gliner_score?.toFixed?.(2) ?? ''}`]),
        ]));
      }
      if (items.length > 30) ul.appendChild(h('li', { class: 'muted small' }, [`(+${items.length - 30} more)`]));
      inner.appendChild(ul);
      entDetails.appendChild(inner);
    }
    root.appendChild(entDetails);
  }

  // Typed claims grouped by claim_type.
  if (claimTotal > 0) {
    const cDetails = h('details', { class: 'dr2-phase2-details', open: '' });
    cDetails.appendChild(h('summary', { class: 'muted small' }, [
      `Typed claims (${claimTotal} across ${Object.keys(r.claims.by_type).length} types — LLM-as-finder, substring-validated)`,
    ]));
    for (const [type, items] of Object.entries(r.claims.by_type)) {
      const inner = h('details', { class: 'dr2-phase2-subdetails', open: '' });
      inner.appendChild(h('summary', {}, [
        h('strong', {}, [type]),
        h('span', { class: 'muted small' }, [` (${items.length})`]),
      ]));
      const ul = h('ul', { class: 'dr2-phase2-claims' });
      for (const c of items) {
        ul.appendChild(h('li', {}, [
          h('span', { class: `dr2-claim-stance stance-${c.stance}` }, [c.stance || 'asserts']),
          ' ',
          h('q', {}, [c.text]),
          h('span', { class: 'muted small' }, [` · p.${c.page ?? '?'} · ${c.provider || c.mechanism}`]),
        ]));
      }
      inner.appendChild(ul);
      cDetails.appendChild(inner);
    }
    root.appendChild(cDetails);
  }

  // Numerical results.
  if (resultTotal > 0) {
    const tbl = h('table', { class: 'structured-table dr2-phase2-results' });
    tbl.appendChild(h('thead', {}, [
      h('tr', {}, ['Metric', 'Value', 'Dataset', 'Split', 'Page', 'Quote'].map((s) => h('th', {}, [s]))),
    ]));
    const tbody = h('tbody');
    for (const res of r.results) {
      tbody.appendChild(h('tr', {}, [
        h('td', {}, [res.metric]),
        h('td', {}, [String(res.value)]),
        h('td', {}, [res.dataset || '—']),
        h('td', {}, [res.split || '—']),
        h('td', { class: 'muted small' }, [String(res.page ?? '')]),
        h('td', { class: 'muted small' }, [(res.raw_text || '').slice(0, 120)]),
      ]));
    }
    tbl.appendChild(tbody);
    const details = h('details', { class: 'dr2-phase2-details', open: '' });
    details.appendChild(h('summary', { class: 'muted small' }, [`Numerical results (${resultTotal})`]));
    details.appendChild(tbl);
    root.appendChild(details);
  }

  // Citation stance.
  if (stanceTotal > 0) {
    const details = h('details', { class: 'dr2-phase2-details' });
    details.appendChild(h('summary', { class: 'muted small' }, [
      `Citation stance (${stanceTotal} classified) — ${r.stance.by_stance.map((s) => `${s.stance}: ${s.n}`).join(' · ')}`,
    ]));
    const ul = h('ul', { class: 'dr2-phase2-stances' });
    for (const s of (r.stance.sample || []).slice(0, 30)) {
      ul.appendChild(h('li', {}, [
        h('span', { class: `dr2-stance-pill stance-${s.stance}` }, [s.stance]),
        ' ',
        h('strong', {}, [s.surface_text || '?']),
        s.cited_title ? h('span', { class: 'muted small' }, [` → "${s.cited_title.slice(0, 80)}"`]) : null,
        h('div', { class: 'muted small' }, [(s.context_text || '').slice(0, 200)]),
        s.rationale ? h('div', { class: 'muted small dr2-stance-rationale' }, ['why: ', s.rationale]) : null,
      ].filter(Boolean)));
    }
    details.appendChild(ul);
    root.appendChild(details);
  }
}

// Phase 1: render the structured-parse output (sections / refs / cite
// markers / tables / figures) produced by grobid-js. Read-only.
async function fetchJson(url, opts = {}) {
  const fetchOpts = { ...opts };
  if (fetchOpts.body && !fetchOpts.headers) {
    fetchOpts.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(url, fetchOpts);
  try { return await r.json(); }
  catch (e) { return { error: 'invalid response: ' + (await r.text()).slice(0, 200) }; }
}
