// Stage 2: Triage. Mail-client layout.
// Left: filterable paper list. Right: paper detail with abstract + decision
// buttons + AI suggestion. Keyboard: I/E/M to label, J/K to navigate,
// Enter to accept the AI suggestion. Auto-advances to next pending.

import { h } from '../lib/dom.mjs';
import * as llm from '../lib/llm.mjs';

const SYSTEM = `You are a literature-review triage assistant. Decide whether a paper should be included in a thesis literature review based on its title and abstract. Use the inclusion and exclusion criteria provided. Output exactly two lines:
LABEL: include  (or exclude or maybe)
REASON: <one short sentence, no preamble>`;

// Batch mode: label only, no reason. ~5x faster per paper because it
// generates 1-2 output tokens instead of ~15. Reasons can still be
// requested per-paper from the detail pane.
const BATCH_SYSTEM = `You are a literature-review triage assistant. Decide whether a paper belongs in a thesis literature review based on its title and abstract. Reply with exactly one word: include, exclude, or maybe. No punctuation, no explanation.`;

const FILTERS = [
  { id: 'all',     label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'include', label: 'Include' },
  { id: 'maybe',   label: 'Maybe' },
  { id: 'exclude', label: 'Exclude' },
];

export async function renderStage2(root) {
  // Loading state
  root.innerHTML = '<h1>2. Triage</h1><div class="placeholder">loading…</div>';

  let papersRes;
  try {
    papersRes = await fetch('/api/triage/papers').then((r) => r.json());
    if (papersRes.error) throw new Error(papersRes.error);
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['2. Triage']));
    root.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('strong', {}, ['Cannot start triage. ']),
      err.message,
      ' ',
      h('a', { href: '#/stage1' }, ['Go to stage 1.']),
    ]));
    return;
  }

  // Load topic + criteria for AI prompts
  const [topicRes, criteriaRes] = await Promise.all([
    fetch('/api/protocol/topic').then((r) => r.json()),
    fetch('/api/protocol/inclusion_criteria').then((r) => r.json()),
  ]);
  const topicMd = topicRes.content || '';
  const criteriaMd = criteriaRes.content || '';
  const topicTitle = (topicMd.match(/title:\s*(.+)/) || [])[1]?.trim() || '';
  const topicDesc = ((topicMd.match(/description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/) || [])[1] || '')
    .split('\n').map((l) => l.replace(/^[ \t]{2}/, '')).join('\n').trim();

  let papers = papersRes.papers;
  let filter = 'pending';
  let selectedRow = null;
  // Sort mode for the pending filter. 'row' = original CSV order (default,
  // matches the current behaviour). 'uncertainty' = active-learning order:
  // most-ambiguous papers (smallest |margin| against include/exclude
  // prototypes) first, so the student decides the highest-information
  // cases first and the centroids converge fastest.
  let pendingSort = 'row';
  // row_index → uncertainty score, populated from /api/triage/prefilter/pending-ranked
  let uncertaintyMap = null;

  // Layout shell
  root.innerHTML = '';
  root.classList.add('view-triage');

  const filterBar = h('div', { class: 'triage-filter-bar' });
  const prefilterBar = h('div', { class: 'prefilter-bar' });
  const prefilterPanel = h('div', { class: 'prefilter-panel' });
  const snowballBar = h('div', { class: 'snowball-bar' });
  const batchBar = h('div', { class: 'batch-bar' });
  const layout = h('div', { class: 'triage-layout' });
  const listEl = h('div', { class: 'triage-list', tabindex: '0' });
  const detailEl = h('div', { class: 'triage-detail' });
  layout.appendChild(listEl);
  layout.appendChild(detailEl);

  root.appendChild(h('div', { class: 'triage-header' }, [
    h('h1', {}, ['2. Triage']),
    h('p', { class: 'lead' }, [
      'Decide ', h('span', { class: 'kbd-hint' }, ['I=Include']),
      ' ', h('span', { class: 'kbd-hint' }, ['M=Maybe']),
      ' ', h('span', { class: 'kbd-hint' }, ['E=Exclude']),
      ' ', h('span', { class: 'kbd-hint' }, ['J/K=Next/Prev']),
      ' ', h('span', { class: 'kbd-hint' }, ['Enter=Accept ✨']),
    ]),
  ]));
  root.appendChild(filterBar);
  root.appendChild(prefilterBar);
  root.appendChild(prefilterPanel);
  root.appendChild(snowballBar);
  root.appendChild(batchBar);
  root.appendChild(layout);

  function counts() {
    const c = { all: papers.length, pending: 0, include: 0, exclude: 0, maybe: 0 };
    for (const p of papers) {
      const k = p.triage_label || 'pending';
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }

  function visiblePapers() {
    if (filter === 'all') return papers;
    if (filter === 'pending') {
      const list = papers.filter((p) => !p.triage_label);
      if (pendingSort === 'uncertainty' && uncertaintyMap) {
        // Most-uncertain first; rows missing a score (no prototypes) sort last.
        return list.slice().sort((a, b) => {
          const ua = uncertaintyMap.get(a.row_index);
          const ub = uncertaintyMap.get(b.row_index);
          if (ua == null && ub == null) return 0;
          if (ua == null) return 1;
          if (ub == null) return -1;
          return ub - ua;
        });
      }
      return list;
    }
    return papers.filter((p) => p.triage_label === filter);
  }

  async function loadPendingRankings() {
    try {
      const r = await fetch('/api/triage/prefilter/pending-ranked').then((res) => res.json());
      if (!r.ok || !Array.isArray(r.ranked)) {
        uncertaintyMap = null;
        return;
      }
      uncertaintyMap = new Map();
      for (const p of r.ranked) {
        if (p.uncertainty != null && p.uncertainty >= 0) {
          uncertaintyMap.set(p.row_index, p.uncertainty);
        }
      }
    } catch {
      uncertaintyMap = null;
    }
  }

  function renderFilters() {
    const c = counts();
    filterBar.innerHTML = '';
    for (const f of FILTERS) {
      const btn = h('button', {
        type: 'button',
        class: 'filter-pill ' + (filter === f.id ? 'active' : ''),
        onclick: () => {
          filter = f.id;
          renderFilters();
          renderList();
          // Move selection into the new filter set
          const vp = visiblePapers();
          if (vp.length && (selectedRow == null || !vp.some((p) => p.row_index === selectedRow))) {
            selectRow(vp[0].row_index);
          } else {
            renderDetail();
          }
        },
      }, [f.label, ' ', h('span', { class: 'filter-count' }, [String(c[f.id] ?? 0)])]);
      filterBar.appendChild(btn);
    }

    // Active-learning sort toggle, only relevant when looking at pending.
    if (filter === 'pending' && c.pending > 0) {
      const toggle = h('button', {
        type: 'button',
        class: 'filter-pill sort-toggle ' + (pendingSort === 'uncertainty' ? 'active' : ''),
        title: 'Sort pending by ambiguity (most informative first)',
        onclick: async () => {
          if (pendingSort === 'row') {
            // Switch on — fetch fresh rankings each time so they reflect
            // the latest centroids (decisions can shift them).
            pendingSort = 'uncertainty';
            await loadPendingRankings();
          } else {
            pendingSort = 'row';
          }
          renderFilters();
          renderList();
          // Keep selection if still in the new ordering
          const vp = visiblePapers();
          if (vp.length && (selectedRow == null || !vp.some((p) => p.row_index === selectedRow))) {
            selectRow(vp[0].row_index);
          }
        },
      }, [
        pendingSort === 'uncertainty' ? '↕ active learning' : '↕ row order',
      ]);
      filterBar.appendChild(toggle);
    }
  }

  function shortAuthors(s) {
    if (!s) return '';
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} & ${parts[1]}`;
    return `${parts[0]} et al.`;
  }

  function renderList() {
    listEl.innerHTML = '';
    const vp = visiblePapers();
    if (!vp.length) {
      listEl.appendChild(h('div', { class: 'empty-list muted small' }, [
        filter === 'pending' ? 'Nothing pending. Try a different filter.' : 'No papers in this filter.',
      ]));
      return;
    }
    for (const p of vp) {
      const isAutoDecided = p.triage_label && /^auto-triage \(embedding pre-filter\)/.test(p.triage_reason || '');
      const row = h('div', {
        class: 'paper-row label-' + (p.triage_label || 'pending') +
               (selectedRow === p.row_index ? ' selected' : ''),
        dataset: { rowIndex: String(p.row_index) },
        onclick: () => selectRow(p.row_index),
      }, [
        h('span', { class: 'paper-row-marker' }, []),
        h('div', { class: 'paper-row-body' }, [
          h('div', { class: 'paper-row-title' }, [
            p.title || '(untitled)',
            isAutoDecided
              ? h('span', { class: 'auto-badge', title: 'Auto-decided by embedding pre-filter' }, ['✨ auto'])
              : null,
          ]),
          h('div', { class: 'paper-row-meta muted small' }, [
            shortAuthors(p.authors),
            p.year ? ` · ${p.year}` : '',
            p.venue ? ` · ${p.venue.slice(0, 40)}` : '',
          ]),
          p.ai_suggestion && !p.triage_label
            ? h('div', { class: 'paper-row-suggestion suggestion-' + p.ai_suggestion.label }, [
                '✨ ', p.ai_suggestion.label,
              ])
            : null,
        ]),
      ]);
      listEl.appendChild(row);
    }
  }

  function selectRow(rowIndex) {
    selectedRow = rowIndex;
    listEl.querySelectorAll('.paper-row').forEach((el) => {
      el.classList.toggle('selected', Number(el.dataset.rowIndex) === rowIndex);
    });
    const sel = listEl.querySelector('.paper-row.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    renderDetail();
  }

  function renderDetail() {
    detailEl.innerHTML = '';
    if (selectedRow == null) {
      detailEl.appendChild(h('div', { class: 'placeholder' }, [
        'Select a paper from the list.',
      ]));
      return;
    }
    const p = papers.find((x) => x.row_index === selectedRow);
    if (!p) return;

    const title = h('h2', { class: 'detail-title' }, [p.title || '(untitled)']);
    const meta = h('p', { class: 'detail-meta muted' }, [
      p.authors || '(unknown authors)',
      ' · ', p.year || 'n.d.',
      p.venue ? ' · ' : '',
      p.venue || '',
    ]);
    const links = h('p', { class: 'detail-links' }, [
      p.doi ? h('a', { href: `https://doi.org/${p.doi}`, target: '_blank', rel: 'noopener' }, ['Open DOI']) : null,
      p.arxiv_id ? h('a', { href: `https://arxiv.org/abs/${p.arxiv_id}`, target: '_blank', rel: 'noopener' }, ['arXiv abstract']) : null,
      p.pdf_url ? h('a', { href: p.pdf_url, target: '_blank', rel: 'noopener' }, ['PDF']) : null,
      p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener' }, ['Source page']) : null,
    ].filter(Boolean));

    const abstract = h('div', { class: 'detail-abstract' }, [
      p.abstract || h('em', { class: 'muted' }, ['No abstract available.']),
    ]);

    // AI suggestion box
    const aiBox = h('div', { class: 'ai-suggestion-box' });
    renderAiBox(aiBox, p);

    // Decision buttons
    const reasonInput = h('input', {
      type: 'text',
      class: 'decision-reason',
      placeholder: 'Reason (optional, kept in the CSV)',
      value: p.triage_reason || '',
    });
    const labelButtons = ['include', 'maybe', 'exclude'].map((label) => {
      return h('button', {
        type: 'button',
        class: 'decision-btn label-' + label + (p.triage_label === label ? ' active' : ''),
        onclick: () => decide(p.row_index, label, reasonInput.value),
      }, [
        label === 'include' ? 'Include (I)' :
          label === 'maybe' ? 'Maybe (M)' : 'Exclude (E)',
      ]);
    });
    const clearBtn = h('button', {
      type: 'button',
      class: 'btn btn-ghost',
      onclick: () => decide(p.row_index, '', ''),
      style: { display: p.triage_label ? '' : 'none' },
    }, ['Clear decision']);

    const decision = h('div', { class: 'decision-block' }, [
      h('div', { class: 'decision-buttons' }, labelButtons),
      reasonInput,
      h('div', { class: 'decision-actions' }, [
        clearBtn,
        p.triage_label
          ? h('span', { class: 'status-pill saved' }, ['saved as ' + p.triage_label])
          : h('span', { class: 'muted small' }, ['no decision yet']),
      ]),
    ]);

    detailEl.appendChild(title);
    detailEl.appendChild(meta);
    if (links.children.length) detailEl.appendChild(links);
    detailEl.appendChild(abstract);
    detailEl.appendChild(aiBox);
    detailEl.appendChild(decision);
  }

  let suggestInflight = null;
  const batchState = {
    running: false,
    cancelled: false,
    total: 0,
    done: 0,
    skipped: 0,
    errors: 0,
    started: 0,
    currentTitle: '',
  };

  function pendingWithoutSuggestion() {
    return papers.filter((p) => !p.triage_label && !p.ai_suggestion);
  }

  function renderBatchBar() {
    // The old LLM "Suggest all pending" bar is hidden by default — the
    // training wizard's cascading auto-apply replaces it. Power users can
    // still access it via the Advanced panel.
    batchBar.innerHTML = '';
    return;
    // eslint-disable-next-line no-unreachable
    const llmStatus = llm.status();

    if (batchState.running) {
      const pct = batchState.total > 0
        ? Math.round((batchState.done / batchState.total) * 100)
        : 0;
      const elapsed = (Date.now() - batchState.started) / 1000;
      const rate = batchState.done > 0 ? elapsed / batchState.done : 0;
      const remaining = rate * (batchState.total - batchState.done);
      const eta = remaining > 60
        ? `${Math.round(remaining / 60)} min`
        : `${Math.round(remaining)} s`;
      batchBar.appendChild(h('div', { class: 'batch-strip' }, [
        h('div', { class: 'batch-info' }, [
          h('strong', {}, [`${batchState.done} / ${batchState.total}`]),
          ' · ',
          h('span', { class: 'muted small' }, [
            `eta ~${eta} · `,
            batchState.currentTitle ? `now: ${batchState.currentTitle.slice(0, 60)}` : '…',
          ]),
        ]),
        h('div', { class: 'batch-progress' }, [
          h('div', { class: 'batch-progress-bar', style: { width: `${pct}%` } }),
        ]),
        h('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: () => { batchState.cancelled = true; },
        }, ['Cancel']),
      ]));
      return;
    }

    const candidates = pendingWithoutSuggestion();
    if (candidates.length === 0) {
      // Show a quieter status when nothing is left to suggest.
      if (papers.length > 0 && llmStatus.loaded) {
        batchBar.appendChild(h('div', { class: 'batch-strip-idle muted small' }, [
          'All pending papers already have a suggestion.',
        ]));
      }
      return;
    }

    const btn = h('button', {
      class: 'btn btn-ai',
      type: 'button',
      disabled: !llmStatus.loaded,
      title: llmStatus.loaded ? '' : 'Enable AI in the topbar',
      onclick: runBatch,
    }, [`✨ Suggest all pending (${candidates.length})`]);

    batchBar.appendChild(h('div', { class: 'batch-strip-idle' }, [
      btn,
      h('span', { class: 'muted small' }, [
        ' ≈1–2 s per paper (label only). For a reason on a specific paper, click it and hit Suggest.',
      ]),
    ]));
  }

  async function runBatch() {
    if (batchState.running) return;
    const queue = pendingWithoutSuggestion();
    if (!queue.length) return;
    batchState.running = true;
    batchState.cancelled = false;
    batchState.total = queue.length;
    batchState.done = 0;
    batchState.skipped = 0;
    batchState.errors = 0;
    batchState.started = Date.now();
    renderBatchBar();

    for (const p of queue) {
      if (batchState.cancelled) break;
      // Re-check: paper may have been labelled or suggested manually
      // since we built the queue.
      if (p.triage_label) { batchState.skipped++; batchState.done++; renderBatchBar(); continue; }
      if (p.ai_suggestion) { batchState.skipped++; batchState.done++; renderBatchBar(); continue; }

      batchState.currentTitle = p.title || '(untitled)';
      renderBatchBar();

      try {
        const text = await llm.chat({
          system: BATCH_SYSTEM,
          user: buildBatchPrompt(p),
          temperature: 0.1,
        });
        const parsed = parseLabelOnly(text);
        if (parsed) {
          await fetch('/api/triage/suggestion', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              row_index: p.row_index,
              label: parsed.label,
              reason: parsed.reason,
            }),
          });
          p.ai_suggestion = { label: parsed.label, reason: parsed.reason };
        } else {
          batchState.errors++;
        }
      } catch (err) {
        console.error('batch suggestion failed for row', p.row_index, err);
        batchState.errors++;
      }
      batchState.done++;
      renderList();
      // Don't redraw the entire detail pane every paper; only if this is
      // the currently selected paper.
      if (selectedRow === p.row_index) renderDetail();
      renderBatchBar();
      // Yield so the UI can paint and the user can interact.
      await new Promise((r) => setTimeout(r, 0));
    }

    batchState.running = false;
    batchState.currentTitle = '';
    renderBatchBar();
    renderFilters();
  }

  // ---------------------------------------------------------------------
  // Embedding pre-filter (Phase 2 automation). Reads include/exclude
  // prototype centroids from the papers vector store and auto-decides
  // pending rows where the margin clears the configured thresholds. The
  // borderline band falls through to the existing LLM/manual triage UI.
  // ---------------------------------------------------------------------
  const prefilterState = {
    panelMode: null,         // null | 'training' | 'advanced'
    loading: false,
    counts: null,
    proposed: [],
    borderline: [],
    stats: null,
    tuning: null,
    thresholds: null,
    missed: [],
    error: null,
    message: null,
    aiSortUnlocked: false,
    trainingState: null,
    trainingBatch: [],
    trainingCursor: 0,
    trainingSkipped: new Set(),
    trainingRoundStats: null,
    // Cumulative auto-decisions that cascaded from training decisions this
    // session. Surfaced inline so the student sees their teaching compound.
    cascadeTotals: { applied: 0, last_batch: 0, last_titles: [] },
    advancedMode: null,      // null | 'preview' | 'missed' | 'thresholds'
  };

  // ---- Snowballing strip --------------------------------------------------
  //
  // One button: "Snowball from your N includes". Click → daemon fetches
  // backward citations from every include-labeled paper via OpenAlex,
  // dedupes against existing rows, appends survivors as pending. The
  // existing embed daemon + Stage 2 wizard handle them from there.
  //
  // While running, the strip shows live progress streamed via SSE.
  const snowballState = {
    status: null,
    sseStop: null,
    // Triangulation inline panel state — separate from the daemon-backed
    // snowball flow. Triangulation is a single API call that returns
    // shared-citation hits; we render them inline below the strip.
    triangLoading: false,
    triangResults: null,
    triangError: null,
  };

  async function refreshSnowballStatus() {
    try {
      const s = await fetch('/api/snowball/status').then((r) => r.json());
      snowballState.status = s;
    } catch { snowballState.status = null; }
    renderSnowballBar();
  }

  function startSnowballSse() {
    if (snowballState.sseStop) return;
    const es = new EventSource('/api/snowball/stream');
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data);
        if (event.type === 'status') {
          snowballState.status = { ...snowballState.status, ...event };
        } else if (snowballState.status?.job) {
          // Incrementally apply daemon event counters to the local copy
          // so the strip updates without a round-trip every second.
          if (event.type === 'source_done' || event.type === 'source_skip') {
            snowballState.status.job.sources_done = event.index ?? snowballState.status.job.sources_done;
            if (typeof event.added === 'number') {
              snowballState.status.job.new_added = (snowballState.status.job.new_added || 0) + event.added;
            }
            if (typeof event.fetched === 'number') {
              snowballState.status.job.candidates_fetched = (snowballState.status.job.candidates_fetched || 0) + event.fetched;
            }
          } else if (event.type === 'started') {
            snowballState.status.running = true;
            snowballState.status.job.status = 'running';
          } else if (event.type === 'idle') {
            snowballState.status.running = false;
            snowballState.status.job.status = 'completed';
            snowballState.status.job.new_added = event.new_added ?? snowballState.status.job.new_added;
            snowballState.status.job.dropped_dup = event.dropped_dup ?? snowballState.status.job.dropped_dup;
            // Reload papers because the daemon appended new rows.
            reloadPapers();
          } else if (event.type === 'paused' || event.type === 'paused_idle') {
            snowballState.status.paused = true;
          } else if (event.type === 'resumed') {
            snowballState.status.paused = false;
          }
        }
        renderSnowballBar();
      } catch { /* tolerate partial frames */ }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    snowballState.sseStop = () => { es.close(); snowballState.sseStop = null; };
  }

  async function startSnowball() {
    try {
      const r = await fetch('/api/snowball/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'backward' }),
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      if (r.ok === false) throw new Error(r.reason || 'snowball failed to start');
      startSnowballSse();
      await refreshSnowballStatus();
    } catch (err) {
      // Inline in the strip — no popup.
      snowballState.status = { ...(snowballState.status || {}), last_error: err.message };
      renderSnowballBar();
    }
  }

  async function pauseSnowball() { await fetch('/api/snowball/pause', { method: 'POST' }); await refreshSnowballStatus(); }
  async function resumeSnowball() { await fetch('/api/snowball/resume', { method: 'POST' }); await refreshSnowballStatus(); }
  async function discardSnowball() {
    await fetch('/api/snowball/job', { method: 'DELETE' });
    snowballState.status = null;
    if (snowballState.sseStop) snowballState.sseStop();
    renderSnowballBar();
  }

  function renderSnowballBar() {
    snowballBar.innerHTML = '';
    const c = counts();
    const includeCount = c.include;
    const s = snowballState.status;
    const running = s?.running;
    const paused = s?.paused;
    const job = s?.job;
    const interrupted = job?.status === 'interrupted';

    // Don't render the strip if there's nothing to snowball from.
    if (includeCount === 0 && !job) return;

    let body;
    if (running) {
      const done = job?.sources_done ?? 0;
      const total = job?.sources_total ?? 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      body = h('div', { class: 'snowball-strip running' }, [
        h('div', { class: 'snowball-info' }, [
          h('strong', {}, ['🌨 Snowballing']),
          ' · ',
          h('span', { class: 'muted small' }, [
            `source paper ${done} / ${total} · ${job?.new_added ?? 0} new candidates added · ${job?.dropped_dup ?? 0} duplicates dropped`,
          ]),
        ]),
        h('div', { class: 'batch-progress' }, [
          h('div', { class: 'batch-progress-bar', style: { width: `${pct}%` } }),
        ]),
        h('div', { class: 'snowball-actions' }, [
          paused
            ? h('button', { class: 'btn', type: 'button', onclick: resumeSnowball }, ['Resume'])
            : h('button', { class: 'btn btn-ghost', type: 'button', onclick: pauseSnowball }, ['Pause']),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: discardSnowball }, ['Discard']),
        ]),
      ]);
    } else if (interrupted) {
      body = h('div', { class: 'snowball-strip interrupted' }, [
        h('span', { class: 'muted small' }, [
          `Snowball interrupted at source ${job.sources_done}/${job.sources_total}. `,
          `${job.new_added} new candidates added so far.`,
        ]),
        h('div', { class: 'snowball-actions' }, [
          h('button', { class: 'btn btn-primary', type: 'button', onclick: resumeSnowball }, ['Resume']),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: discardSnowball }, ['Discard']),
        ]),
      ]);
    } else if (job?.status === 'completed') {
      body = h('div', { class: 'snowball-strip done' }, [
        h('span', {}, [
          '🌨 ',
          h('strong', {}, [`${job.new_added} new candidates`]),
          ` added via snowballing (${job.dropped_dup} duplicates dropped). They are now pending — train the classifier above to triage them.`,
        ]),
        h('div', { class: 'snowball-actions' }, [
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { startSnowball(); } }, ['Re-run']),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: discardSnowball }, ['Clear']),
        ]),
      ]);
    } else {
      body = h('div', { class: 'snowball-strip idle' }, [
        h('div', { class: 'snowball-info' }, [
          h('strong', {}, ['🌨 Citation expansion']),
          ' · ',
          h('span', { class: 'muted small' }, [
            `Pull missing papers from your ${includeCount} include paper${includeCount === 1 ? '' : 's'}' references via OpenAlex. Two strategies:`,
          ]),
        ]),
        h('div', { class: 'snowball-actions' }, [
          h('button', {
            class: 'btn',
            type: 'button',
            disabled: includeCount === 0,
            onclick: startSnowball,
            title: 'Fetch every backward citation from each include — bulk expansion. Background daemon, ~minutes for large include sets.',
          }, [`Snowball all (${includeCount} sources, bulk)`]),
          h('button', {
            class: 'btn btn-ghost',
            type: 'button',
            disabled: includeCount === 0 || snowballState.triangLoading,
            onclick: runTriangulation,
            title: 'Surface only references cited by ≥2 of your includes — the canonical missing papers. Inline, one shot.',
          }, [snowballState.triangLoading ? 'Triangulating…' : 'Canonical only (cited by ≥2)']),
        ]),
        s?.last_error
          ? h('div', { class: 'snowball-error small' }, [s.last_error])
          : null,
      ]);
    }
    snowballBar.appendChild(body);
    // Triangulation result panel (inline, below the strip).
    if (snowballState.triangResults || snowballState.triangError || snowballState.triangLoading) {
      snowballBar.appendChild(renderTriangulationPanel());
    }
  }

  async function runTriangulation() {
    snowballState.triangLoading = true;
    snowballState.triangError = null;
    snowballState.triangResults = null;
    renderSnowballBar();
    try {
      const r = await fetch('/api/synthesis/triangulate?topK=30&minCiting=2').then((res) => res.json());
      if (r.error) throw new Error(r.error);
      snowballState.triangResults = r;
    } catch (err) {
      snowballState.triangError = err.message;
    } finally {
      snowballState.triangLoading = false;
      renderSnowballBar();
    }
  }

  async function promoteTriangulationItems(items) {
    try {
      const r = await fetch('/api/synthesis/promote-to-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      // Refresh papers + drop the freshly-added rows from local results.
      await reloadPapers();
      if (snowballState.triangResults) {
        const promoted = new Set(items.map((it) => it.url || it.openalex_id || it.doi));
        snowballState.triangResults.items = snowballState.triangResults.items.filter(
          (it) => !promoted.has(it.url || it.openalex_id || it.doi),
        );
      }
      renderSnowballBar();
    } catch (err) {
      snowballState.triangError = 'Promote failed: ' + err.message;
      renderSnowballBar();
    }
  }

  function renderTriangulationPanel() {
    const panel = h('div', { class: 'triang-panel' });
    if (snowballState.triangLoading) {
      panel.appendChild(h('div', { class: 'triang-loading' }, [
        h('div', { class: 'pf-progress-indeterminate' }, []),
        h('span', { class: 'muted small' }, [
          'Resolving your includes to OpenAlex IDs and counting shared references — one API call per include, takes a minute on large include sets…',
        ]),
      ]));
      return panel;
    }
    if (snowballState.triangError) {
      panel.appendChild(h('div', { class: 'snowball-error small' }, [snowballState.triangError]));
      panel.appendChild(h('button', {
        type: 'button', class: 'btn btn-ghost',
        onclick: () => { snowballState.triangResults = null; snowballState.triangError = null; renderSnowballBar(); },
      }, ['Dismiss']));
      return panel;
    }
    const r = snowballState.triangResults;
    if (!r) return panel;
    if (!r.items.length) {
      panel.appendChild(h('p', { class: 'muted small' }, [
        `${r.sources_resolved}/${r.sources_total} include papers resolved to OpenAlex. `,
        r.reason || 'No references cited by ≥2 of your includes are missing from your corpus.',
      ]));
      panel.appendChild(h('button', {
        type: 'button', class: 'btn btn-ghost',
        onclick: () => { snowballState.triangResults = null; renderSnowballBar(); },
      }, ['Close']));
      return panel;
    }
    panel.appendChild(h('div', { class: 'triang-header' }, [
      h('strong', {}, [`${r.items.length} canonical missing references`]),
      h('span', { class: 'muted small' }, [
        ` · ${r.sources_resolved}/${r.sources_total} includes resolved`,
      ]),
      h('div', { class: 'snowball-actions' }, [
        h('button', {
          type: 'button', class: 'btn btn-primary',
          onclick: () => promoteTriangulationItems(r.items),
        }, [`Add all ${r.items.length} to pending`]),
        h('button', {
          type: 'button', class: 'btn btn-ghost',
          onclick: () => { snowballState.triangResults = null; renderSnowballBar(); },
        }, ['Close']),
      ]),
    ]));
    const list = h('div', { class: 'triangulation-list' });
    for (const it of r.items) {
      list.appendChild(h('div', { class: 'triang-row card' }, [
        h('span', { class: 'triang-count' }, [`${it.citing_count}× cited`]),
        h('div', { class: 'triang-body' }, [
          h('div', { class: 'triang-title' }, [it.title || '(untitled)']),
          h('div', { class: 'triang-meta muted small' }, [
            it.authors ? it.authors.slice(0, 80) : '',
            it.year ? ` · ${it.year}` : '',
            it.venue ? ` · ${it.venue.slice(0, 50)}` : '',
            it.doi ? h('span', {}, [' · ', h('a', { href: `https://doi.org/${it.doi}`, target: '_blank', rel: 'noopener' }, [it.doi])]) : null,
          ]),
          h('div', { class: 'triang-citers muted small' }, [
            `Cited by your includes: ${it.citing_paper_ids.map((p) => `paper_${p}`).join(', ')}`,
          ]),
        ]),
        h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm',
          onclick: () => promoteTriangulationItems([it]),
        }, ['Add as candidate']),
      ]));
    }
    panel.appendChild(list);
    return panel;
  }

  async function refreshTrainingState() {
    try {
      const s = await fetch('/api/triage/training/state').then((r) => r.json());
      prefilterState.trainingState = s;
      prefilterState.aiSortUnlocked = !!s.ai_sort_unlocked;
    } catch (err) {
      prefilterState.trainingState = null;
      prefilterState.aiSortUnlocked = false;
    }
  }

  function renderPrefilterBar() {
    prefilterBar.innerHTML = '';
    const c = counts();
    const state = prefilterState.trainingState;
    const unlocked = prefilterState.aiSortUnlocked;
    const minRequired = state?.min_required ?? 10;
    const decided = state?.decided ?? (c.include + c.exclude + c.maybe);

    // The single primary action. "Train the classifier" handles everything
    // — auto-decide cascades inside the wizard as you label, so there's no
    // separate Preview / Auto-decide / Audit button to choose from on the
    // main strip. Advanced controls hide under a tiny link.
    const trainBtn = h('button', {
      type: 'button',
      class: 'btn btn-ai' + (prefilterState.panelMode === 'training' ? ' active' : ''),
      onclick: () => {
        if (prefilterState.panelMode === 'training') closePrefilterPanel();
        else startTraining();
      },
    }, [
      '✨ ',
      prefilterState.panelMode === 'training' ? 'Close training panel' : 'Help me triage',
    ]);

    const advancedLink = h('a', {
      href: '#',
      class: 'prefilter-advanced-link',
      onclick: (e) => {
        e.preventDefault();
        if (prefilterState.panelMode === 'advanced') closePrefilterPanel();
        else openAdvanced();
      },
    }, [prefilterState.panelMode === 'advanced' ? 'Hide advanced' : 'Advanced ▸']);

    const hint = unlocked
      ? h('span', { class: 'muted small' }, [
          `Trained ${decided} so far. As you label more in the wizard, the classifier auto-decides similar pending papers in the background.`,
        ])
      : h('span', { class: 'muted small' }, [
          `${decided}/${minRequired} decisions made — the classifier needs a few more before it can auto-decide on its own.`,
          (state?.include === 0 ? ' (Still need at least one include.)' : ''),
          (state?.exclude === 0 ? ' (Still need at least one exclude.)' : ''),
        ]);

    prefilterBar.appendChild(h('div', { class: 'prefilter-strip' }, [
      h('div', { class: 'prefilter-info' }, [
        h('span', { class: 'muted small' }, [
          `${c.include} include · ${c.exclude} exclude · ${c.pending} pending`,
        ]),
      ]),
      h('div', { class: 'prefilter-actions' }, [trainBtn]),
      h('div', { class: 'prefilter-hint' }, [hint, ' ', advancedLink]),
    ]));
  }

  function openAdvanced() {
    prefilterState.panelMode = 'advanced';
    prefilterState.advancedMode = null;
    renderPrefilterBar();
    renderPrefilterPanel();
  }

  function closePrefilterPanel() {
    prefilterState.panelMode = null;
    prefilterState.proposed = [];
    prefilterState.borderline = [];
    prefilterState.missed = [];
    prefilterState.error = null;
    prefilterState.message = null;
    prefilterState.trainingBatch = [];
    prefilterState.trainingCursor = 0;
    prefilterState.trainingRoundStats = null;
    renderPrefilterBar();
    renderPrefilterPanel();
  }

  // ---- Active-learning training loop -----------------------------------
  //
  // Single-paper-at-a-time: after every decision the server re-picks
  // against freshly-updated prototypes. No batches, no caching of stale
  // picks. The loop ends when the student clicks Done or the server
  // reports no more pending papers.

  async function startTraining() {
    prefilterState.panelMode = 'training';
    prefilterState.loading = true;
    prefilterState.message = null;
    prefilterState.trainingRoundStats = {
      before: { ...counts() },
      this_round: 0,
    };
    prefilterState.cascadeTotals = { applied: 0, last_batch: 0, last_titles: [] };
    prefilterState.trainingBatch = [];
    prefilterState.trainingCursor = 0;
    renderPrefilterBar();
    renderPrefilterPanel();
    // First call to /step with no decision — just picks the first paper.
    await runTrainingStep(null);
  }

  // Single combined call: record decision (if any), propagate label to the
  // cluster the centroid represented, cascade auto-apply across the rest
  // of pending (server-side when unlocked), pick the next centroid. One
  // round-trip per click.
  async function runTrainingStep(decision) {
    prefilterState.loading = true;
    renderPrefilterPanel();
    try {
      const body = {
        exclude: Array.from(prefilterState.trainingSkipped),
        ...(decision ? {
          row_index: decision.row_index,
          label: decision.label,
          reason: decision.reason || '',
          cluster_members: decision.cluster_members || [],
        } : {}),
      };
      const r = await fetch('/api/triage/training/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);

      if (decision) {
        // Local mirror — keeps the underlying triage list in sync without
        // a separate /api/triage/papers refetch.
        const p = papers.find((x) => x.row_index === decision.row_index);
        if (p) {
          p.triage_label = decision.label;
          p.triage_reason = decision.reason || '';
        }
        prefilterState.trainingRoundStats.this_round++;
      }

      // Surface what happened. Two distinct numbers:
      //   cluster_applied — papers in the centroid's cluster that
      //                     inherited the same label (near-duplicates)
      //   cascade_applied — other pending papers across the corpus that
      //                     the classifier was now confident enough to
      //                     auto-decide (the wider effect)
      if ((r.applied || 0) > 0) {
        prefilterState.cascadeTotals.applied += r.applied;
        prefilterState.cascadeTotals.last_cluster = r.cluster_applied || 0;
        prefilterState.cascadeTotals.last_cascade = r.cascade_applied || 0;
        prefilterState.cascadeTotals.last_batch = r.applied;
        prefilterState.cascadeTotals.last_titles = r.applied_titles || [];
        await reloadPapers();
      }

      prefilterState.trainingState = r.state || prefilterState.trainingState;
      prefilterState.aiSortUnlocked = !!r.state?.ai_sort_unlocked;

      prefilterState.trainingBatch = r.next ? [r.next] : [];
      prefilterState.trainingCursor = 0;
      if (!r.next) {
        prefilterState.message = {
          kind: 'info',
          text: r.next_reason || 'No more pending papers — you are done. The classifier may have decided everything based on what you taught it.',
        };
      } else {
        // Keep banner from previous step alive ONLY if it's the cascade
        // success note (auto-replaces on next step).
        if (r.applied === 0) prefilterState.message = null;
      }
    } catch (err) {
      prefilterState.message = { kind: 'error', text: 'Step failed: ' + err.message };
    }
    prefilterState.loading = false;
    renderFilters();
    renderList();
    renderPrefilterBar();
    renderPrefilterPanel();
    window.litreview?.refreshStatus?.();
  }

  async function trainingDecide(rowIndex, label, reason) {
    // Pass the cluster_members from the current pick so the server can
    // propagate the decision to every near-collision in one round-trip.
    const current = prefilterState.trainingBatch[0];
    await runTrainingStep({
      row_index: rowIndex,
      label,
      reason,
      cluster_members: current?.cluster_members || [rowIndex],
    });
  }

  async function trainingSkip(rowIndex) {
    prefilterState.trainingSkipped.add(rowIndex);
    await runTrainingStep(null);
  }

  async function previewPrefilter() {
    prefilterState.panelMode = 'preview';
    prefilterState.loading = true;
    prefilterState.error = null;
    renderPrefilterBar();
    renderPrefilterPanel();
    try {
      const r = await fetch('/api/triage/prefilter/preview').then((res) => res.json());
      prefilterState.loading = false;
      if (r.error) throw new Error(r.error);
      if (!r.ok) {
        prefilterState.error = r.reason || 'pre-filter unavailable';
      } else {
        prefilterState.counts = r.prototype_counts;
        prefilterState.proposed = r.proposed;
        prefilterState.borderline = r.borderline;
        prefilterState.stats = r.stats || null;
        prefilterState.tuning = r.tuning || null;
        prefilterState.thresholds = r.thresholds || null;
      }
    } catch (err) {
      prefilterState.loading = false;
      prefilterState.error = err.message;
    }
    renderPrefilterPanel();
  }

  async function loadMissedIncludes() {
    prefilterState.panelMode = 'missed';
    prefilterState.loading = true;
    prefilterState.error = null;
    renderPrefilterBar();
    renderPrefilterPanel();
    try {
      const r = await fetch('/api/triage/prefilter/missed?topK=20&minScore=0.55').then((res) => res.json());
      prefilterState.loading = false;
      if (r.error) throw new Error(r.error);
      if (!r.ok) {
        prefilterState.error = r.reason || 'unable to scan excludes';
      } else {
        prefilterState.missed = r.missed;
      }
    } catch (err) {
      prefilterState.loading = false;
      prefilterState.error = err.message;
    }
    renderPrefilterPanel();
  }

  // Click target for "Auto-decide pending (N)" — opens the preview panel,
  // runs preview + apply server-side, leaves the panel populated with the
  // result so the student sees what happened in context (not via a popup).
  async function runAutoTriage() {
    if (counts().pending === 0) return;
    prefilterState.panelMode = 'preview';
    prefilterState.loading = true;
    prefilterState.message = { kind: 'info', text: 'Scoring and applying confident decisions…' };
    renderPrefilterBar();
    renderPrefilterPanel();
    try {
      const r = await fetch('/api/triage/prefilter/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_auto: true }),
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      await reloadPapers();
      // The server returns merged preview+apply: { proposed, borderline,
      // stats, tuning, thresholds, applied, skipped, errors }. Stash it
      // into the preview panel so the student sees exactly what landed,
      // plus the borderline residue and the diagnostic stats inline.
      prefilterState.counts = r.prototype_counts;
      prefilterState.proposed = r.proposed || [];
      prefilterState.borderline = r.borderline || [];
      prefilterState.stats = r.stats || null;
      prefilterState.tuning = r.tuning || null;
      prefilterState.thresholds = r.thresholds || null;
      const applied = r.applied || 0;
      const skipped = r.skipped || 0;
      if (applied > 0) {
        prefilterState.message = {
          kind: 'success',
          text: `Applied ${applied} decision${applied === 1 ? '' : 's'}` +
            (skipped > 0 ? ` (${skipped} skipped — already labeled).` : '.') +
            ` ${prefilterState.borderline.length} pending paper${prefilterState.borderline.length === 1 ? '' : 's'} remain${prefilterState.borderline.length === 1 ? 's' : ''} below the confidence threshold.`,
        };
      } else {
        prefilterState.message = {
          kind: 'warn',
          text: `No papers cleared the current thresholds. ${prefilterState.borderline.length} pending paper${prefilterState.borderline.length === 1 ? '' : 's'} stay${prefilterState.borderline.length === 1 ? 's' : ''} borderline — adjust the thresholds in the panel below or label more bootstrap papers.`,
        };
      }
    } catch (err) {
      prefilterState.message = { kind: 'error', text: 'Auto-decide failed: ' + err.message };
    }
    prefilterState.loading = false;
    renderPrefilterBar();
    renderPrefilterPanel();
  }

  async function reloadPapers() {
    const fresh = await fetch('/api/triage/papers').then((r) => r.json());
    if (!fresh.papers) return;
    papers = fresh.papers;
    // Selected row may have changed label; keep selection if still present.
    if (selectedRow != null && !papers.some((p) => p.row_index === selectedRow)) {
      selectedRow = null;
    }
    if (pendingSort === 'uncertainty') {
      await loadPendingRankings();
    }
    renderFilters();
    renderList();
    renderBatchBar();
    renderPrefilterBar();
    if (selectedRow != null) renderDetail();
    window.litreview?.refreshStatus?.();
  }

  function renderPrefilterPanel() {
    prefilterPanel.innerHTML = '';
    if (!prefilterState.panelMode) return;

    const closeBtn = h('button', {
      type: 'button',
      class: 'btn-icon',
      title: 'Close panel',
      onclick: closePrefilterPanel,
    }, ['×']);

    if (prefilterState.loading) {
      prefilterPanel.appendChild(h('div', { class: 'panel-card' }, [
        h('div', { class: 'panel-card-header' }, [
          h('strong', {}, [prefilterState.panelMode === 'preview' ? 'Preview decisions' : 'Find missed includes']),
          closeBtn,
        ]),
        h('div', { class: 'placeholder' }, ['scoring against prototypes…']),
      ]));
      return;
    }

    if (prefilterState.error) {
      prefilterPanel.appendChild(h('div', { class: 'panel-card' }, [
        h('div', { class: 'panel-card-header' }, [
          h('strong', {}, ['Pre-filter unavailable']),
          closeBtn,
        ]),
        h('p', { class: 'muted' }, [prefilterState.error]),
      ]));
      return;
    }

    if (prefilterState.panelMode === 'training') {
      prefilterPanel.appendChild(renderTrainingCard(closeBtn));
    } else if (prefilterState.panelMode === 'advanced') {
      prefilterPanel.appendChild(renderAdvancedCard(closeBtn));
    }
  }

  function renderAdvancedCard(closeBtn) {
    // The advanced panel is a sub-router — the student picks one of the
    // power tools, the rest are hidden. Keeps the surface compact.
    const adv = prefilterState.advancedMode;

    const tabs = h('div', { class: 'tabs' }, [
      h('button', {
        type: 'button',
        class: 'tab' + (adv === 'preview' ? ' active' : ''),
        onclick: () => { prefilterState.advancedMode = 'preview'; previewPrefilter(); },
      }, ['Preview decisions']),
      h('button', {
        type: 'button',
        class: 'tab' + (adv === 'missed' ? ' active' : ''),
        onclick: () => { prefilterState.advancedMode = 'missed'; loadMissedIncludes(); },
      }, ['Audit excludes']),
      h('button', {
        type: 'button',
        class: 'tab' + (adv === 'llm' ? ' active' : ''),
        onclick: () => { prefilterState.advancedMode = 'llm'; renderPrefilterPanel(); },
      }, ['Slow LLM batch']),
    ]);

    let body;
    if (adv === 'preview') {
      body = renderPreviewCard(h('button', {
        type: 'button', class: 'btn-icon',
        onclick: () => { prefilterState.advancedMode = null; renderPrefilterPanel(); },
      }, ['×']));
    } else if (adv === 'missed') {
      body = renderMissedCard(h('button', {
        type: 'button', class: 'btn-icon',
        onclick: () => { prefilterState.advancedMode = null; renderPrefilterPanel(); },
      }, ['×']));
    } else if (adv === 'llm') {
      body = h('div', { class: 'panel-card' }, [
        h('div', { class: 'panel-card-header' }, [
          h('strong', {}, ['LLM batch suggestion']),
          h('button', {
            type: 'button', class: 'btn-icon',
            onclick: () => { prefilterState.advancedMode = null; renderPrefilterPanel(); },
          }, ['×']),
        ]),
        h('p', { class: 'muted' }, [
          'Run the LLM through every pending paper one at a time using your inclusion criteria. ',
          h('strong', {}, ['Slow']),
          ' — typically 30 min on a cloud provider, several hours on WebLLM. The training wizard usually gets better results in a fraction of the time.',
        ]),
        h('button', {
          type: 'button', class: 'btn btn-primary',
          onclick: () => { closePrefilterPanel(); runBatch(); },
        }, ['Run LLM batch anyway']),
      ]);
    } else {
      body = h('p', { class: 'muted' }, [
        'Pick one of the power tools above. These are for fine control — the regular "Help me triage" flow handles the common case.',
      ]);
    }

    return h('div', { class: 'panel-card advanced-card' }, [
      h('div', { class: 'panel-card-header' }, [
        h('strong', {}, ['Advanced controls']),
        closeBtn,
      ]),
      tabs,
      body,
    ]);
  }

  function renderTrainingCard(closeBtn) {
    const batch = prefilterState.trainingBatch;
    const decidedThisSession = prefilterState.trainingRoundStats?.this_round ?? 0;
    const state = prefilterState.trainingState;

    const header = h('div', { class: 'panel-card-header' }, [
      h('strong', {}, ['✨ Train the classifier']),
      h('div', { class: 'panel-card-actions' }, [
        h('span', { class: 'muted small' }, [
          `${decidedThisSession} decided this session · ${state?.decided ?? 0} total · ${state?.pending ?? 0} pending`,
        ]),
        closeBtn,
      ]),
    ]);

    // Idle / done state — server returned no next paper.
    if (!batch.length && !prefilterState.loading) {
      const aiNowAvailable = !!state?.ai_sort_unlocked;
      return h('div', { class: 'panel-card' }, [
        header,
        renderMessageBanner(prefilterState.message),
        h('p', { class: 'muted' }, [
          'No more pending papers to pick from — every paper has been decided or skipped this session.',
        ]),
        aiNowAvailable ? h('div', { class: 'pf-banner pf-banner-success' }, [
          h('span', { class: 'pf-banner-text' }, [
            '✓ Auto-decide is unlocked. The classifier has enough labeled data to apply your knowledge across the rest.',
          ]),
        ]) : null,
        h('div', { class: 'inline-row' }, [
          aiNowAvailable ? h('button', {
            type: 'button',
            class: 'btn btn-primary',
            onclick: () => { closePrefilterPanel(); runAutoTriage(); },
          }, ['Auto-decide remaining']) : null,
          h('button', {
            type: 'button',
            class: 'btn btn-ghost',
            onclick: closePrefilterPanel,
          }, ['Done']),
        ]),
      ]);
    }

    if (prefilterState.loading && !batch.length) {
      return h('div', { class: 'panel-card' }, [
        header,
        h('div', { class: 'pf-progress-block' }, [
          h('p', { class: 'pf-progress-text' }, [
            'Clustering pending papers and picking the next high-information centroid…',
          ]),
          h('div', { class: 'pf-progress-indeterminate' }, []),
          h('p', { class: 'muted small', style: { marginTop: '8px' } }, [
            `Scoring against ${prefilterState.tuning?.include_sub_prototypes ?? '…'} include + ${prefilterState.tuning?.exclude_sub_prototypes ?? '…'} exclude prototypes`,
          ]),
        ]),
      ]);
    }

    // Current paper to decide on — always batch[0] since we now fetch one
    // at a time. The "cluster_size" tells the student how many near-
    // duplicates their decision will apply to in one click.
    const blind = batch[0];
    const paper = papers.find((p) => p.row_index === blind.row_index) || blind;
    const abstract = paper.abstract || '';
    const authors = paper.authors || '';
    const clusterSize = blind.cluster_size || 1;

    const reasonInput = h('input', {
      type: 'text',
      class: 'training-reason',
      placeholder: 'One short sentence on why (recommended — it helps the classifier learn faster)',
    });

    const decideBtn = (label, kbd, cls) => h('button', {
      type: 'button',
      class: 'btn ' + cls,
      disabled: prefilterState.loading,
      onclick: () => trainingDecide(blind.row_index, label, reasonInput.value),
    }, [`${label[0].toUpperCase() + label.slice(1)}`, ' ', h('span', { class: 'kbd-hint' }, [kbd])]);

    // Surface a "finish remaining" option once the classifier has enough
    // training data to be trustworthy on closer-side-wins. 50 decisions
    // is a conservative threshold; tighter than the unlock at 10 because
    // closer-side-wins forfeits the conservative-thresholds safety net.
    const enoughForFinish = (state?.decided ?? 0) >= 50 &&
      (state?.include ?? 0) >= 5 && (state?.exclude ?? 0) >= 5 &&
      (state?.pending ?? 0) > 0;
    const finishButton = enoughForFinish ? h('div', { class: 'training-finish-row' }, [
      h('p', { class: 'muted small' }, [
        `You've trained on ${state.decided} decisions. The classifier has stable prototypes — you can finish the remaining ${state.pending} pending papers using closer-side-wins (whichever prototype is closer, regardless of confidence margin). Use this once you're satisfied that more labeling won't improve quality.`,
      ]),
      h('button', {
        type: 'button',
        class: 'btn',
        disabled: prefilterState.loading,
        onclick: () => finishRemaining(),
      }, [`Decide all ${state.pending} remaining (closer-side-wins)`]),
    ]) : null;

    const cascade = prefilterState.cascadeTotals;
    let recomputeHint;
    if (prefilterState.loading) {
      recomputeHint = h('div', { class: 'training-loading-block' }, [
        h('span', { class: 'training-recomputing' }, [
          h('span', { class: 'spinner-inline' }, []),
          ' Re-weighting from your last decision and scoring pending papers against prototypes…',
        ]),
        h('div', { class: 'pf-progress-indeterminate' }, []),
      ]);
    } else if (cascade.last_batch > 0) {
      const parts = [];
      if (cascade.last_cluster > 0) {
        parts.push(`${cascade.last_cluster} near-duplicate${cascade.last_cluster === 1 ? '' : 's'} inherited the label`);
      }
      if (cascade.last_cascade > 0) {
        parts.push(`${cascade.last_cascade} other pending paper${cascade.last_cascade === 1 ? '' : 's'} auto-decided across the corpus`);
      }
      recomputeHint = h('span', { class: 'training-cascade' }, [
        `✓ ${parts.join(' · ')} (${cascade.applied} total this session)`,
      ]);
    } else {
      recomputeHint = h('span', { class: 'muted small' }, [
        '✓ classifier weights up to date with your last decision',
      ]);
    }

    return h('div', { class: 'panel-card training-card' }, [
      header,
      renderMessageBanner(prefilterState.message),
      h('div', { class: 'training-livebar' }, [recomputeHint]),
      clusterSize > 1
        ? h('div', { class: 'training-cluster-note' }, [
            h('strong', {}, [`This paper represents ${clusterSize} near-duplicate pending papers.`]),
            ' Your decision will apply to all of them in one click.',
          ])
        : h('div', { class: 'training-cluster-note muted small' }, [
            'No close near-duplicates — this decision will only apply to this paper (the wider cascade may still pick up other confident matches).',
          ]),
      h('div', { class: 'training-paper' }, [
        h('h3', { class: 'training-title' }, [paper.title || '(untitled)']),
        h('div', { class: 'training-meta muted small' }, [
          authors,
          paper.year ? ` · ${paper.year}` : '',
          paper.venue ? ` · ${paper.venue}` : '',
          paper.doi ? h('span', {}, [' · ', h('a', { href: `https://doi.org/${paper.doi}`, target: '_blank', rel: 'noopener' }, [`DOI`])]) : null,
        ]),
        h('div', { class: 'training-abstract' }, [
          abstract || h('em', { class: 'muted' }, ['(No abstract available — decide on title alone, or skip.)']),
        ]),
      ]),
      h('div', { class: 'training-decision-block' }, [
        h('div', { class: 'training-decision-buttons' }, [
          decideBtn('include', 'I', 'btn-primary label-include'),
          decideBtn('exclude', 'E', 'label-exclude'),
          decideBtn('maybe', 'M', 'btn-ghost label-maybe'),
          h('button', {
            type: 'button',
            class: 'btn btn-ghost',
            title: 'Skip this paper — won\'t come back in this session',
            disabled: prefilterState.loading,
            onclick: () => trainingSkip(blind.row_index),
          }, ['Skip']),
        ]),
        reasonInput,
      ]),
      h('p', { class: 'muted small training-hint' }, [
        'Decide blind — no scores or system predictions shown. Each decision re-picks the next paper against your updated knowledge.',
      ]),
      finishButton,
    ]);
  }

  async function finishRemaining() {
    prefilterState.loading = true;
    prefilterState.message = { kind: 'info', text: 'Applying closer-side-wins to remaining pending papers…' };
    renderPrefilterPanel();
    try {
      const r = await fetch('/api/triage/prefilter/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      await reloadPapers();
      await refreshTrainingState();
      // Drop the wizard back to its idle state — there's nothing left to
      // train on after finish.
      prefilterState.trainingBatch = [];
      prefilterState.message = {
        kind: 'success',
        text: `Finished: ${r.applied} decisions applied (${r.applied_include} include, ${r.applied_exclude} exclude` +
          (r.applied_maybe > 0 ? `, ${r.applied_maybe} maybe — papers where include and exclude prototypes tied` : '') +
          '). Review the results and flip anything that looks wrong.',
      };
    } catch (err) {
      prefilterState.message = { kind: 'error', text: 'Finish failed: ' + err.message };
    }
    prefilterState.loading = false;
    renderFilters();
    renderList();
    renderPrefilterBar();
    renderPrefilterPanel();
    window.litreview?.refreshStatus?.();
  }

  function fmtScore(s) { return (s == null || Number.isNaN(s)) ? '—' : s.toFixed(3); }
  function fmtMargin(m) {
    if (m == null) return '—';
    const sign = m >= 0 ? '+' : '';
    return sign + m.toFixed(3);
  }

  function renderMessageBanner(msg) {
    if (!msg) return null;
    return h('div', { class: 'pf-banner pf-banner-' + msg.kind }, [
      h('span', { class: 'pf-banner-text' }, [msg.text]),
      h('button', {
        type: 'button',
        class: 'btn-icon',
        title: 'dismiss',
        onclick: () => { prefilterState.message = null; renderPrefilterPanel(); },
      }, ['×']),
    ]);
  }

  function renderClassifierBlock(tuning, thresholds) {
    if (!tuning && !thresholds) return null;
    const incT = tuning?.include;
    const excT = tuning?.exclude;

    // Threshold inputs — change → save → re-preview. No "save" button:
    // every edit is committed; debounced re-preview keeps it responsive.
    let pendingTimer = null;
    const queueRepreview = () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        applyAndPreviewWithThresholds({
          include_threshold: Number(incInput.value) || 0,
          exclude_threshold: Number(excInput.value) || 0,
          margin_threshold: Number(marInput.value) || 0,
        });
      }, 400);
    };
    const mkInput = (val) => {
      const i = h('input', {
        type: 'number', min: '0', max: '1', step: '0.01',
        value: typeof val === 'number' ? val.toFixed(2) : '0.65',
        class: 'pf-threshold-input',
      });
      i.addEventListener('input', queueRepreview);
      return i;
    };
    const incInput = mkInput(thresholds?.include_threshold);
    const excInput = mkInput(thresholds?.exclude_threshold);
    const marInput = mkInput(thresholds?.margin_threshold);

    const fmtBreakdown = (total, synthetic) => {
      const fromLabels = (total ?? 0) - (synthetic ?? 0);
      if ((synthetic ?? 0) === 0) return null;
      return h('span', { class: 'muted small' }, [
        ` (${fromLabels} from your labels + ${synthetic} from your Setup criteria text)`,
      ]);
    };
    return h('div', { class: 'classifier-block' }, [
      h('div', { class: 'classifier-row' }, [
        h('div', { class: 'classifier-cell' }, [
          h('div', { class: 'classifier-label' }, ['Include sub-prototypes']),
          h('div', { class: 'classifier-value' }, [
            String(tuning?.include_sub_prototypes ?? '—'),
            fmtBreakdown(tuning?.include_sub_prototypes, tuning?.include_synthetic),
            incT?.mode === 'community' ? h('span', { class: 'muted small' }, [
              ` · community-detected · threshold=${incT.threshold?.toFixed(3)} · minSize=${incT.minCommunitySize}`,
            ]) :
            incT?.mode === 'k-nn' ? h('span', { class: 'muted small' }, [
              ` · k-NN fallback (label set <6)`,
            ]) : null,
          ]),
        ]),
        h('div', { class: 'classifier-cell' }, [
          h('div', { class: 'classifier-label' }, ['Exclude sub-prototypes']),
          h('div', { class: 'classifier-value' }, [
            String(tuning?.exclude_sub_prototypes ?? '—'),
            fmtBreakdown(tuning?.exclude_sub_prototypes, tuning?.exclude_synthetic),
            excT?.mode === 'community' ? h('span', { class: 'muted small' }, [
              ` · community-detected · threshold=${excT.threshold?.toFixed(3)} · minSize=${excT.minCommunitySize}`,
            ]) :
            excT?.mode === 'k-nn' ? h('span', { class: 'muted small' }, [
              ` · k-NN fallback (label set <6)`,
            ]) : null,
          ]),
        ]),
      ]),
      h('div', { class: 'classifier-thresholds' }, [
        h('span', { class: 'classifier-label' }, ['Thresholds (edit to re-preview):']),
        h('label', { class: 'pf-threshold-label' }, [
          h('span', {}, ['margin']),
          marInput,
        ]),
        h('label', { class: 'pf-threshold-label' }, [
          h('span', {}, ['include floor']),
          incInput,
        ]),
        h('label', { class: 'pf-threshold-label' }, [
          h('span', {}, ['exclude floor']),
          excInput,
        ]),
        h('span', { class: 'muted small' }, [
          '(also editable in Setup. Auto-tuned values for community detection come from k-NN over your own labels.)',
        ]),
      ]),
    ]);
  }

  function renderPreviewCard(closeBtn) {
    const proposed = prefilterState.proposed;
    const borderline = prefilterState.borderline;
    const stats = prefilterState.stats;
    const incCount = proposed.filter((p) => p.decision === 'include').length;
    const excCount = proposed.filter((p) => p.decision === 'exclude').length;

    const applyAllBtn = h('button', {
      type: 'button',
      class: 'btn btn-primary',
      disabled: proposed.length === 0 || prefilterState.loading,
      onclick: () => applyProposed(proposed),
    }, [proposed.length > 0 ? `Apply ${proposed.length}` : 'Nothing to apply']);

    const rows = proposed.length === 0
      ? [h('p', { class: 'muted' }, ['No pending papers cleared the confidence thresholds. Everything pending falls through to manual / LLM review.'])]
      : proposed.map((p) => h('div', { class: 'prefilter-proposed-row' }, [
          h('span', { class: 'suggestion-chip suggestion-' + p.decision }, [p.decision]),
          h('span', { class: 'prefilter-row-title' }, [p.title || '(untitled)']),
          h('span', { class: 'prefilter-row-scores muted small' }, [
            `inc ${fmtScore(p.include_score)} · exc ${fmtScore(p.exclude_score)} · margin ${fmtMargin(p.margin)}`,
          ]),
          h('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            onclick: () => applyProposed([p]),
          }, ['Apply only this']),
          h('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            onclick: () => {
              selectRow(p.row_index);
              filter = 'pending';
              renderFilters();
              renderList();
            },
          }, ['Open']),
        ]));

    const borderHeader = borderline.length > 0
      ? h('div', { class: 'prefilter-borderline-header muted small' }, [
          `${borderline.length} pending paper${borderline.length === 1 ? '' : 's'} stayed borderline (low margin or low absolute score). Review manually or with the LLM batch suggestion.`,
        ])
      : null;

    return h('div', { class: 'panel-card' }, [
      h('div', { class: 'panel-card-header' }, [
        h('strong', {}, [`Preview: ${proposed.length} confident, ${borderline.length} borderline`]),
        h('div', { class: 'panel-card-actions' }, [
          h('span', { class: 'muted small' }, [
            `would auto-include ${incCount} / auto-exclude ${excCount}`,
          ]),
          applyAllBtn,
          closeBtn,
        ]),
      ]),
      renderMessageBanner(prefilterState.message),
      renderClassifierBlock(prefilterState.tuning, prefilterState.thresholds),
      stats ? renderStatsBlock(stats, prefilterState.proposed.concat(prefilterState.borderline), proposed.length === 0) : null,
      h('div', { class: 'prefilter-rows' }, rows),
      borderHeader,
    ]);
  }

  function renderStatsBlock(stats, allScored, noneConfident) {
    if (!stats) return null;
    const fmt = (v) => v == null ? '—' : v.toFixed(3);

    const marginRows = stats.margin_sweep.map((m) => {
      // Highlight the row matching the current margin threshold.
      const isCurrent = Math.abs(m.margin - prefilterState.proposed
        .concat(prefilterState.borderline).length > 0
        ? prefilterState.proposed.length > 0
          ? 0 : 0 : 0); // (unused; kept for future)
      return h('tr', {}, [
        h('td', { class: 'mono' }, [`margin > ${m.margin.toFixed(2)}`]),
        h('td', {}, [String(m.would_include)]),
        h('td', {}, [String(m.would_exclude)]),
        h('td', { class: 'mono' }, [String(m.total)]),
        h('td', {}, [
          m.total === 0 ? null : h('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            title: `Save thresholds and re-preview with margin=${m.margin.toFixed(2)}`,
            onclick: () => applyAndPreviewWithThresholds({ margin_threshold: m.margin }),
          }, ['Try']),
        ]),
      ]);
    });

    const floorRows = stats.floor_sweep.map((f) => h('tr', {}, [
      h('td', { class: 'mono' }, [`floor > ${f.floor.toFixed(2)}`]),
      h('td', {}, [String(f.would_include)]),
      h('td', {}, [String(f.would_exclude)]),
      h('td', { class: 'mono' }, [String(f.total)]),
      h('td', {}, [
        f.total === 0 ? null : h('button', {
          type: 'button',
          class: 'btn btn-ghost btn-sm',
          title: `Save thresholds and re-preview with both floors=${f.floor.toFixed(2)}`,
          onclick: () => applyAndPreviewWithThresholds({
            include_threshold: f.floor,
            exclude_threshold: f.floor,
          }),
        }, ['Try']),
      ]),
    ]));

    return h('div', { class: 'stats-block' }, [
      noneConfident ? h('div', { class: 'stats-hint' }, [
        '⚠️ No papers cleared the current thresholds. Use the tables below to pick values that match your corpus.',
      ]) : null,
      h('div', { class: 'stats-grid' }, [
        h('div', { class: 'stats-summary' }, [
          h('h4', {}, [`Score distribution (${stats.n_scored} pending papers)`]),
          h('table', { class: 'simple-table stats-table' }, [
            h('thead', {}, [h('tr', {}, [
              h('th', {}, ['']),
              h('th', {}, ['min']),
              h('th', {}, ['p25']),
              h('th', {}, ['median']),
              h('th', {}, ['p75']),
              h('th', {}, ['max']),
            ])]),
            h('tbody', {}, [
              h('tr', {}, [
                h('td', {}, ['margin (inc−exc)']),
                h('td', { class: 'mono' }, [fmt(stats.margin.min)]),
                h('td', { class: 'mono' }, [fmt(stats.margin.p25)]),
                h('td', { class: 'mono' }, [fmt(stats.margin.median)]),
                h('td', { class: 'mono' }, [fmt(stats.margin.p75)]),
                h('td', { class: 'mono' }, [fmt(stats.margin.max)]),
              ]),
              h('tr', {}, [
                h('td', {}, ['include score']),
                h('td', { class: 'mono' }, [fmt(stats.include_score.min)]),
                h('td', { class: 'mono' }, ['—']),
                h('td', { class: 'mono' }, [fmt(stats.include_score.median)]),
                h('td', { class: 'mono' }, ['—']),
                h('td', { class: 'mono' }, [fmt(stats.include_score.max)]),
              ]),
              h('tr', {}, [
                h('td', {}, ['exclude score']),
                h('td', { class: 'mono' }, [fmt(stats.exclude_score.min)]),
                h('td', { class: 'mono' }, ['—']),
                h('td', { class: 'mono' }, [fmt(stats.exclude_score.median)]),
                h('td', { class: 'mono' }, ['—']),
                h('td', { class: 'mono' }, [fmt(stats.exclude_score.max)]),
              ]),
            ]),
          ]),
          h('p', { class: 'muted small' }, [
            'Tip: same-genre English text rarely scores below ~0.45. If median include score is around 0.55, an absolute floor of 0.65 will never fire — lower it. Margin distribution tells you whether prototypes are actually separated.',
          ]),
        ]),
        h('div', { class: 'stats-sweep' }, [
          h('h4', {}, ['If you loosened the margin threshold…']),
          h('table', { class: 'simple-table stats-table' }, [
            h('thead', {}, [h('tr', {}, [
              h('th', {}, ['threshold']),
              h('th', {}, ['→ include']),
              h('th', {}, ['→ exclude']),
              h('th', {}, ['total']),
              h('th', {}, ['']),
            ])]),
            h('tbody', {}, marginRows),
          ]),
          h('h4', {}, ['If you lowered the absolute floors…']),
          h('table', { class: 'simple-table stats-table' }, [
            h('thead', {}, [h('tr', {}, [
              h('th', {}, ['threshold']),
              h('th', {}, ['→ include']),
              h('th', {}, ['→ exclude']),
              h('th', {}, ['total']),
              h('th', {}, ['']),
            ])]),
            h('tbody', {}, floorRows),
          ]),
        ]),
      ]),
    ]);
  }

  async function applyAndPreviewWithThresholds(patch) {
    // Persist the new threshold(s) globally then re-run preview so the user
    // sees what their corpus looks like with the new bar. Doesn't auto-apply.
    try {
      const cur = await fetch('/api/triage/thresholds').then((r) => r.json());
      const next = { ...cur, ...patch };
      await fetch('/api/triage/thresholds', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
    } catch (err) {
      prefilterState.message = { kind: 'error', text: 'Failed to update thresholds: ' + err.message };
      renderPrefilterPanel();
      return;
    }
    await previewPrefilter();
  }

  function renderMissedCard(closeBtn) {
    const missed = prefilterState.missed;
    const rows = missed.length === 0
      ? [h('p', { class: 'muted' }, ['No suspicious excludes. Anything you marked exclude looks genuinely off-topic from the model\'s point of view.'])]
      : missed.map((m) => h('div', { class: 'prefilter-proposed-row' }, [
          h('span', { class: 'suggestion-chip suggestion-include' }, [`inc ${fmtScore(m.include_score)}`]),
          h('span', { class: 'prefilter-row-title' }, [m.title || '(untitled)']),
          h('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            onclick: async () => {
              await fetch('/api/triage/decision', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ row_index: m.row_index, label: 'include', reason: `flipped from exclude (suspicious match: inc ${fmtScore(m.include_score)})` }),
              });
              await reloadPapers();
              await loadMissedIncludes();
            },
          }, ['Flip to include']),
          h('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            onclick: () => {
              selectRow(m.row_index);
              filter = 'exclude';
              renderFilters();
              renderList();
            },
          }, ['Open']),
        ]));

    return h('div', { class: 'panel-card' }, [
      h('div', { class: 'panel-card-header' }, [
        h('strong', {}, [`Topically-close excludes: ${missed.length}`]),
        closeBtn,
      ]),
      h('div', { class: 'muted small' }, [
        'Excluded papers ranked by topical similarity to your include prototype. ',
        h('strong', {}, ['Most of these are correctly excluded']),
        ' — your inclusion criteria probably distinguish them from your includes in a way the embedding can\'t see (e.g. surveys vs. empirical work, technical vs. regulatory angle). Scan for genuine mistakes — anything that surprises you here might be a real flip. The rest is expected.',
      ]),
      h('div', { class: 'prefilter-rows' }, rows),
    ]);
  }

  async function applyProposed(items) {
    if (!items.length) return;
    prefilterState.loading = true;
    renderPrefilterPanel();
    try {
      const r = await fetch('/api/triage/prefilter/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisions: items.map((p) => ({
            row_index: p.row_index,
            decision: p.decision,
            include_score: p.include_score,
            exclude_score: p.exclude_score,
            margin: p.margin,
          })),
        }),
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      await reloadPapers();
      // Re-preview so applied rows fall off; surface result inline.
      await previewPrefilter();
      const applied = r.applied || 0;
      const skipped = r.skipped || 0;
      prefilterState.message = {
        kind: applied > 0 ? 'success' : 'warn',
        text: applied > 0
          ? `Applied ${applied} decision${applied === 1 ? '' : 's'}` +
            (skipped > 0 ? ` (${skipped} skipped — already labeled).` : '.')
          : 'Nothing applied — rows may already have been labeled by another tab.',
      };
      renderPrefilterPanel();
    } catch (err) {
      prefilterState.loading = false;
      prefilterState.message = { kind: 'error', text: 'Apply failed: ' + err.message };
      renderPrefilterPanel();
    }
  }

  function renderAiBox(box, p) {
    box.innerHTML = '';
    box.className = 'ai-suggestion-box';
    const llmStatus = llm.status();

    const sugg = p.ai_suggestion;
    const header = h('div', { class: 'ai-box-header' }, [
      h('strong', {}, ['✨ AI suggestion']),
      h('button', {
        type: 'button',
        class: 'btn btn-ai',
        disabled: !llmStatus.loaded || suggestInflight === p.row_index,
        title: llmStatus.loaded ? '' : 'Enable AI in the topbar',
        onclick: () => requestSuggestion(p),
      }, [sugg ? 'Re-run' : 'Suggest']),
    ]);
    box.appendChild(header);

    if (suggestInflight === p.row_index) {
      box.appendChild(h('div', { class: 'ai-streaming' }, [
        h('span', { class: 'spinner' }, []),
        ' thinking… ',
        h('span', { class: 'ai-stream-buffer' }, []),
      ]));
      return;
    }

    if (!sugg) {
      if (!llmStatus.loaded) {
        box.appendChild(h('p', { class: 'muted small' }, ['Enable AI in the topbar to get triage suggestions.']));
      } else {
        box.appendChild(h('p', { class: 'muted small' }, ['No suggestion yet. Click Suggest above.']));
      }
      return;
    }

    box.appendChild(h('div', { class: 'ai-result' }, [
      h('span', { class: 'suggestion-chip suggestion-' + sugg.label }, [sugg.label]),
      h('span', { class: 'ai-reason' }, [sugg.reason]),
    ]));
    if (p.triage_label !== sugg.label) {
      box.appendChild(h('div', { class: 'ai-actions' }, [
        h('button', {
          type: 'button',
          class: 'btn btn-primary',
          onclick: () => decide(p.row_index, sugg.label, sugg.reason),
        }, [`Accept (Enter): set ${sugg.label}`]),
      ]));
    }
  }

  async function requestSuggestion(p) {
    if (suggestInflight != null) return;
    suggestInflight = p.row_index;
    renderDetail();
    const buf = detailEl.querySelector('.ai-stream-buffer');

    const prompt = buildPrompt(p);
    let full = '';
    try {
      full = await llm.chat({
        system: SYSTEM,
        user: prompt,
        temperature: 0.3,
        onToken: (_d, total) => {
          if (buf) buf.textContent = total.slice(-160);
        },
      });
    } catch (err) {
      suggestInflight = null;
      detailEl.querySelector('.ai-suggestion-box')?.replaceWith(makeErrorBox(err.message));
      return;
    }
    suggestInflight = null;

    const parsed = parseLabelReason(full);
    if (!parsed) {
      const box = detailEl.querySelector('.ai-suggestion-box');
      if (box) {
        box.innerHTML = '';
        box.appendChild(h('p', { class: 'error-text' }, [
          'Could not parse model output. Raw: ', h('pre', { class: 'small' }, [full.slice(0, 200)]),
        ]));
      }
      return;
    }

    // Persist suggestion + update local state
    await fetch('/api/triage/suggestion', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        row_index: p.row_index,
        label: parsed.label,
        reason: parsed.reason,
      }),
    });
    p.ai_suggestion = { label: parsed.label, reason: parsed.reason };
    renderDetail();
    renderList();
  }

  function makeErrorBox(msg) {
    return h('div', { class: 'ai-suggestion-box' }, [
      h('strong', {}, ['✨ AI suggestion']),
      h('p', { class: 'error-text small' }, ['Error: ' + msg]),
    ]);
  }

  function buildPrompt(p) {
    return `Topic title: ${topicTitle || '(unspecified)'}
Topic description: ${topicDesc || '(unspecified)'}

Inclusion and exclusion criteria:
${criteriaMd.slice(0, 2400)}

Paper:
Title: ${p.title}
Authors: ${p.authors}
Year: ${p.year}
Venue: ${p.venue}
Abstract: ${(p.abstract || '').slice(0, 1800)}

Decide. Respond in exactly this format:
LABEL: include
REASON: one short sentence`;
  }

  function buildBatchPrompt(p) {
    return `Topic: ${topicTitle || '(unspecified)'}
${topicDesc ? `Description: ${topicDesc}\n` : ''}
Inclusion/exclusion criteria:
${criteriaMd.slice(0, 1500)}

Paper:
${p.title}
${p.authors}, ${p.year}${p.venue ? `, ${p.venue}` : ''}
${(p.abstract || '').slice(0, 1500)}

Answer with one word: include, exclude, or maybe.
Answer:`;
  }

  function parseLabelOnly(text) {
    const m = String(text || '').toLowerCase().match(/\b(include|exclude|maybe)\b/);
    return m ? { label: m[1], reason: '' } : null;
  }

  function parseLabelReason(text) {
    const labelMatch = text.match(/LABEL\s*:\s*(include|exclude|maybe)/i);
    const reasonMatch = text.match(/REASON\s*:\s*([^\n]+)/i);
    if (!labelMatch) return null;
    return {
      label: labelMatch[1].toLowerCase(),
      reason: (reasonMatch?.[1] || '').trim(),
    };
  }

  async function decide(rowIndex, label, reason) {
    try {
      const res = await fetch('/api/triage/decision', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_index: rowIndex, label, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const p = papers.find((x) => x.row_index === rowIndex);
      if (p) {
        p.triage_label = label;
        p.triage_reason = reason || '';
        p.paper_id = data.paper_id || '';
      }
      renderFilters();
      renderList();
      renderBatchBar();
      // Every user decision retrains the classifier — refresh the gating
      // state so the AI-sort buttons unlock the instant the threshold is
      // crossed via normal manual labelling.
      refreshTrainingState().then(renderPrefilterBar).catch(() => renderPrefilterBar());
      // Decisions shift the prototype centroids, which re-orders the
      // active-learning view. Refresh in the background; cheap on a small
      // queue and the rankings drift slowly anyway.
      if (pendingSort === 'uncertainty') {
        loadPendingRankings().then(renderList).catch(() => {});
      }
      // Auto-advance to next pending
      if (label) {
        advanceToNextPending(rowIndex);
      } else {
        renderDetail();
      }
      window.litreview?.refreshStatus?.();
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  }

  function advanceToNextPending(currentRow) {
    // From the visible list, find the next pending after currentRow.
    // If filter shows only 'pending' rows, this collapses naturally as
    // the row leaves the filter set.
    const vp = visiblePapers();
    if (!vp.length) {
      selectedRow = null;
      renderDetail();
      return;
    }
    let nextRow = vp.find((p) => p.row_index > currentRow);
    if (!nextRow) nextRow = vp[0];
    selectRow(nextRow.row_index);
  }

  // Keyboard shortcuts. We only skip when the user is typing in a text
  // input/textarea/select. Otherwise the listener applies regardless of
  // which element holds focus, since renders inside this view frequently
  // detach focus to <body> and we still want shortcuts to work.
  function onKey(e) {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const p = papers.find((x) => x.row_index === selectedRow);
    const key = e.key.toLowerCase();
    switch (key) {
      case 'i':
        if (!p) return;
        e.preventDefault();
        decide(p.row_index, 'include', '');
        break;
      case 'e':
        if (!p) return;
        e.preventDefault();
        decide(p.row_index, 'exclude', '');
        break;
      case 'm':
        if (!p) return;
        e.preventDefault();
        decide(p.row_index, 'maybe', '');
        break;
      case 'j':
      case 'arrowdown':
        e.preventDefault();
        navigate(1);
        break;
      case 'k':
      case 'arrowup':
        e.preventDefault();
        navigate(-1);
        break;
      case 'enter':
        if (p?.ai_suggestion && p.triage_label !== p.ai_suggestion.label) {
          e.preventDefault();
          decide(p.row_index, p.ai_suggestion.label, p.ai_suggestion.reason);
        }
        break;
    }
  }

  function navigate(delta) {
    const vp = visiblePapers();
    if (!vp.length) return;
    if (selectedRow == null) {
      selectRow(vp[0].row_index);
      return;
    }
    const idx = vp.findIndex((p) => p.row_index === selectedRow);
    const next = vp[Math.max(0, Math.min(vp.length - 1, idx + delta))];
    if (next) selectRow(next.row_index);
  }

  window.addEventListener('keydown', onKey);

  // Re-render AI surfaces if the model state changes
  const unsubscribeLlm = llm.subscribe(() => {
    if (selectedRow != null) renderDetail();
    renderBatchBar();
  });

  // Load gating state (decided count, AI-sort unlock) before first paint
  // so the strip already shows the right buttons.
  await refreshTrainingState();
  await refreshSnowballStatus();
  // If a snowball was running or interrupted before this view loaded,
  // start listening for live events.
  if (snowballState.status?.running || snowballState.status?.job?.status === 'running') {
    startSnowballSse();
  }
  renderFilters();
  renderList();
  renderBatchBar();
  renderPrefilterBar();
  renderSnowballBar();
  // Pick the first pending paper to start
  const initialList = visiblePapers();
  if (initialList.length) selectRow(initialList[0].row_index);
  else renderDetail();
  listEl.focus();

  // Returned cleanup runs when the user navigates away from this view.
  return () => {
    window.removeEventListener('keydown', onKey);
    if (typeof unsubscribeLlm === 'function') unsubscribeLlm();
    if (snowballState.sseStop) snowballState.sseStop();
    batchState.cancelled = true;
    batchState.running = false;
    root.classList.remove('view-triage');
  };
}
