// public/views/corpus_shape_v2.mjs
//
// Stage 5 v2 — "Corpus shape" as a detector dashboard + corpus index.
//
// Replaces the prose / matrix-rendering v1 stage 5 with a thin UI on
// top of /api/v2/detect. Output is grouped by detector *category*
// (gap / network / temporal / novelty) and ranked by salience within
// each. Every candidate carries drill-down to its contributing papers
// and (where applicable) to its source chunks via the structured-paper
// endpoint.
//
// Tabs:
//   * Gap          — the 7 typed gap detectors
//   * Network      — citation centrality, MPA, co-citation, bib coupling
//   * Temporal     — emerging / declining / accelerating axes
//   * Novelty      — LOF + n-gram novelty rankings
//   * Corpus index — tabular browse over name_usage (datasets / tech /
//                    frameworks / authors) with paper counts
//
// Settings drawer (top-right) toggles citation-weighted reranking.

import { h } from '../lib/dom.mjs';
import { GAP_DEFINITIONS, MILES_2017_REFERENCE, diagnoseMissingInputs } from '../lib/gap_definitions.mjs';

const CATEGORY_LABELS = {
  gap: 'Gaps',
  network: 'Network',
  temporal: 'Temporal',
  novelty: 'Novelty',
};

const GAP_TYPE_LABELS = {
  evidence: 'Evidence',
  knowledge: 'Knowledge',
  practical: 'Practical',
  methodological: 'Methodological',
  empirical: 'Empirical',
  theoretical: 'Theoretical',
  population: 'Population',
};

const NETWORK_TYPE_LABELS = {
  citation_centrality: 'Citation centrality',
  main_path: 'Main path',
  co_citation: 'Co-citation',
  bibliographic_coupling: 'Bibliographic coupling',
};

const TYPE_LABELS = {
  ...GAP_TYPE_LABELS,
  ...NETWORK_TYPE_LABELS,
  temporal_trends: 'Temporal trends',
  lof_novelty: 'LOF novelty',
  ngram_novelty: 'N-gram novelty',
};

const TYPE_CATEGORY = {
  evidence: 'gap', knowledge: 'gap', practical: 'gap', methodological: 'gap',
  empirical: 'gap', theoretical: 'gap', population: 'gap',
  citation_centrality: 'network', main_path: 'network',
  co_citation: 'network', bibliographic_coupling: 'network',
  temporal_trends: 'temporal',
  lof_novelty: 'novelty', ngram_novelty: 'novelty',
};

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

export async function renderCorpusShapeV2(root) {
  root.innerHTML = '';
  root.classList.add('view-corpus-shape-v2');

  const state = {
    activeCategory: 'gap',
    rerank: false,
    detectResult: null,
    loading: false,
    error: null,
  };

  // Toolbar.
  const toolbar = h('div', { class: 'cs2-toolbar' }, [
    h('h2', { class: 'cs2-title' }, ['Corpus shape · v2']),
    h('span', { class: 'muted small' }, [
      'Runs every detector over the v2 store; click a candidate for drill-down.',
    ]),
    h('div', { class: 'cs2-toolbar-controls' }, [
      h('label', { class: 'cs2-rerank-label' }, [
        h('input', {
          type: 'checkbox',
          id: 'cs2-rerank',
          onchange: async (e) => { state.rerank = !!e.target.checked; await runDetectors(); },
        }),
        ' Rerank by citation weight',
      ]),
      h('button', {
        type: 'button', class: 'btn',
        onclick: runDetectors,
      }, ['↻ Re-run detectors']),
    ]),
  ]);
  root.appendChild(toolbar);

  // Category tabs.
  const tabs = h('div', { class: 'cs2-tabs' });
  root.appendChild(tabs);

  // Content area.
  const content = h('div', { class: 'cs2-content' });
  root.appendChild(content);

  // Helpers.
  function rebuildTabs() {
    tabs.innerHTML = '';
    for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
      const btn = h('button', {
        type: 'button',
        class: 'cs2-tab' + (state.activeCategory === key ? ' active' : ''),
        onclick: () => { state.activeCategory = key; rebuildTabs(); renderContent(); },
      }, [label]);
      tabs.appendChild(btn);
    }
    // Special "Corpus index" tab — not a detector category.
    const cixBtn = h('button', {
      type: 'button',
      class: 'cs2-tab' + (state.activeCategory === 'corpus_index' ? ' active' : ''),
      onclick: () => { state.activeCategory = 'corpus_index'; rebuildTabs(); renderContent(); },
    }, ['Corpus index']);
    tabs.appendChild(cixBtn);
  }

  async function runDetectors() {
    state.loading = true;
    state.error = null;
    state.detectResult = null;
    renderContent();
    try {
      const url = '/api/v2/detect?topK=200' + (state.rerank ? '&rerank=1' : '');
      const r = await fetchJson(url);
      if (r.error) {
        state.error = r.error;
      } else {
        state.detectResult = r;
      }
    } catch (e) {
      state.error = e.message;
    }
    state.loading = false;
    renderContent();
  }

  function renderContent() {
    content.innerHTML = '';
    if (state.activeCategory === 'corpus_index') {
      renderCorpusIndex(content);
      return;
    }
    if (state.loading) {
      content.appendChild(h('p', { class: 'muted small cs2-status' }, ['Running detectors…']));
      return;
    }
    if (state.error) {
      content.appendChild(h('div', { class: 'banner banner-warn' }, [state.error]));
      return;
    }
    if (!state.detectResult) {
      content.appendChild(h('p', { class: 'muted small cs2-status' }, [
        'Click "Re-run detectors" to compute. First run can take a few seconds.',
      ]));
      return;
    }
    renderCategoryContent(content, state.activeCategory, state.detectResult);
    renderDismissedPanel(content);
  }

  rebuildTabs();
  renderContent();
  // First detect runs lazily on the user clicking the button —
  // avoids slow page load if the corpus is empty.
}

// ─────────────────────────────────────────────────────────────────────────
// Per-category render
// ─────────────────────────────────────────────────────────────────────────

function renderCategoryContent(root, category, detectResult) {
  // Pick candidates for this category, grouped by type.
  const groups = {};
  for (const [type, report] of Object.entries(detectResult.byType || {})) {
    if (TYPE_CATEGORY[type] !== category) continue;
    groups[type] = report.candidates || [];
  }

  // Adaptive threshold line so the user can see why few candidates
  // appear on small corpora.
  if (detectResult.thresholds) {
    const t = detectResult.thresholds;
    root.appendChild(h('p', { class: 'muted small cs2-thresholds' }, [
      `Corpus auto-tuned (N=${t.corpus_size}): min-row-total=${t.minRowTotal} · orphan-ratio=${t.orphanRatio} · min-cluster=${t.minClusterSize} · min-papers/group=${t.minPapersPerGroup} · topK=${t.topK}`,
    ]));
  }

  // Gap-category taxonomy header (Miles 2017). Lets the user defend the
  // framing in print and see exactly what each detector counts.
  if (category === 'gap') {
    const ref = MILES_2017_REFERENCE;
    root.appendChild(h('details', { class: 'cs2-taxonomy' }, [
      h('summary', { class: 'muted small' }, [
        'Taxonomy: ', h('strong', {}, [ref.short]), ' — click for source + per-gap definitions',
      ]),
      h('p', { class: 'muted small' }, [
        ref.long, ' Source: ',
        h('a', { href: ref.link, target: '_blank' }, ['academia.edu PDF']),
        '. See also: ',
        ref.see_also.filter((s) => s.link).map((s) => h('a', { href: s.link, target: '_blank', class: 'cs2-ref-link' }, [s.cite])),
      ]),
    ]));
  }

  // Network tab gets a citation-context classification control.
  if (category === 'network') {
    root.appendChild(renderCitationContextControl());
  }

  // Stale-detection / precondition / coherence warnings — corpus-wide,
  // shown on every tab so the user can't miss them. Stale severity
  // decays with time: extractions seconds ago are urgent; days ago is
  // only a soft note. Old "extracted yesterday, detected today" is
  // not actually stale.
  if (detectResult.was_stale) {
    const extAt = detectResult.last_extracted_at ? new Date(detectResult.last_extracted_at) : null;
    const detAt = detectResult.last_detected_at ? new Date(detectResult.last_detected_at) : null;
    const ageMs = extAt && detAt ? (extAt - detAt) : 0;
    const ageHours = ageMs / 3_600_000;
    if (ageHours < 0.01) {
      // Extraction is essentially concurrent with this detect run — no banner.
    } else if (ageHours < 1) {
      root.appendChild(h('div', { class: 'banner banner-warn' }, [
        `Detector results are stale: extraction completed ${formatAge(ageMs)} after the last detect run. Re-run detect for fresh candidates.`,
      ]));
    } else if (ageHours < 24) {
      root.appendChild(h('div', { class: 'banner banner-info' }, [
        `Extraction is ${formatAge(ageMs)} ahead of the last detect run. Consider re-running.`,
      ]));
    } else {
      root.appendChild(h('p', { class: 'muted small' }, [
        `(note: extraction ran ${formatAge(ageMs)} after the last detect — re-run if you need fresh candidates.)`,
      ]));
    }
  }
  if (detectResult.precondition_warnings?.length) {
    const list = h('ul', { class: 'muted small' });
    for (const w of detectResult.precondition_warnings) {
      for (const issue of w.issues) {
        list.appendChild(h('li', {}, [`${w.type}: ${issue}`]));
      }
    }
    root.appendChild(h('div', { class: 'banner banner-info' }, [
      h('strong', {}, ['Some detectors no-opped on this corpus:']),
      list,
    ]));
  }
  if (detectResult.rerank_note) {
    root.appendChild(h('p', { class: 'muted small' }, [detectResult.rerank_note]));
  }
  if (detectResult.coherence_warnings?.length) {
    const list = h('ul', { class: 'muted small' });
    for (const cw of detectResult.coherence_warnings) {
      const link = cw.paper_id
        ? h('a', {
            href: '#/stage4',
            class: 'cs2-coherence-link',
            onclick: () => { try { localStorage.setItem('cs2:lastClickedPaperId', cw.paper_id); } catch { /* ignore */ } },
          }, [cw.paper_id])
        : null;
      list.appendChild(h('li', {}, [
        link ? [link, ' — '] : '',
        cw.message,
      ].flat().filter(Boolean)));
    }
    root.appendChild(h('div', { class: 'banner banner-info' }, [
      h('strong', {}, ['Conflicting signals (review which applies):']),
      list,
    ]));
  }

  const types = Object.keys(groups);
  if (types.length === 0) {
    root.appendChild(h('p', { class: 'muted small' }, [`No detectors in the "${category}" category.`]));
    return;
  }

  // Summary chips. Each chip is keyed by type so we can decrement on
  // dismiss without re-fetching the whole detect result.
  const summary = h('div', { class: 'cs2-summary' });
  const chipByType = new Map();
  const countByType = new Map();
  for (const type of types) {
    countByType.set(type, groups[type].length);
    const chip = h('span', { class: 'chip' }, [
      `${TYPE_LABELS[type] || type}: ${groups[type].length}`,
    ]);
    chipByType.set(type, chip);
    summary.appendChild(chip);
  }
  root.appendChild(summary);

  function onCandidateDismissed(c) {
    const next = (countByType.get(c.type) || 1) - 1;
    countByType.set(c.type, next);
    const chip = chipByType.get(c.type);
    if (chip) chip.textContent = `${TYPE_LABELS[c.type] || c.type}: ${next}`;
  }

  // Per-type sections.
  for (const type of types) {
    const cands = groups[type];
    const def = (category === 'gap') ? GAP_DEFINITIONS[type] : null;
    if (cands.length === 0) {
      const empty = h('details', { class: 'cs2-type' }, [
        h('summary', {}, [
          h('span', { class: 'cs2-type-label' }, [TYPE_LABELS[type] || type]),
          h('span', { class: 'muted small' }, [' (no candidates)']),
        ]),
      ]);
      if (def) {
        empty.appendChild(renderGapDefinition(def));
        // Diagnose why-nothing-found from the most recent coverage snapshot.
        empty.appendChild(renderNoCandidatesDiagnosis(type));
      }
      root.appendChild(empty);
      continue;
    }
    const block = h('details', { class: 'cs2-type', open: cands.length <= 3 ? 'open' : undefined });
    const bulkBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-tiny cs2-bulk-dismiss',
      title: 'Dismiss every candidate in this detector type at once.',
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const remaining = block.querySelectorAll('.cs2-cand');
        if (remaining.length === 0) return;
        if (!confirm(`Dismiss all ${remaining.length} ${TYPE_LABELS[type] || type} candidate(s)?`)) return;
        bulkBtn.disabled = true;
        bulkBtn.textContent = 'Dismissing…';
        for (const c of cands) {
          await fetch('/api/v2/dismiss-candidate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              detector_type: c.type, signature: c.signature,
              reason: 'bulk-dismiss',
              content: { cell: c.cell, description: c.description, salience: c.salience },
            }),
          });
          onCandidateDismissed(c);
        }
        // Clear DOM children of cards.
        for (const el of remaining) el.remove();
        bulkBtn.disabled = false;
        bulkBtn.textContent = 'Dismiss all';
      },
    }, ['Dismiss all']);
    block.appendChild(h('summary', {}, [
      h('span', { class: 'cs2-type-label' }, [TYPE_LABELS[type] || type]),
      h('span', { class: 'muted small' }, [` (${cands.length})`]),
      bulkBtn,
    ]));
    if (def) block.appendChild(renderGapDefinition(def));
    for (const c of cands) block.appendChild(renderCandidate(c, { onDismissed: onCandidateDismissed }));
    root.appendChild(block);
  }
}

// Render the Miles 2017 definition + the structured-store signals the
// detector reads from. Goes inline at the top of each gap-type section.
function renderGapDefinition(def) {
  return h('div', { class: 'cs2-gap-def' }, [
    h('p', { class: 'cs2-gap-def-text' }, [def.definition]),
    h('p', { class: 'muted small' }, [
      h('strong', {}, ['Detector logic: ']), def.detector_logic,
    ]),
    h('p', { class: 'muted small' }, [
      h('strong', {}, ['Reads from: ']),
      def.signals.map((s, i) => [i ? ' · ' : '', h('code', {}, [s])]).flat(),
    ]),
  ]);
}

// When a detector returns no candidates, diagnose why from a coverage
// snapshot. Best-effort: fetches /api/v2/coverage on demand and caches.
let _coverageCache = null;
let _coverageFetch = null;
async function fetchCoverage() {
  if (_coverageCache) return _coverageCache;
  if (_coverageFetch) return _coverageFetch;
  _coverageFetch = fetch('/api/v2/coverage').then((r) => r.json()).then((j) => {
    _coverageCache = j;
    return j;
  }).catch(() => null);
  return _coverageFetch;
}
function renderNoCandidatesDiagnosis(gapType) {
  const wrap = h('div', { class: 'cs2-gap-diagnosis muted small' }, ['(checking why...)']);
  fetchCoverage().then((cov) => {
    if (!cov) { wrap.textContent = ''; return; }
    const issues = diagnoseMissingInputs(gapType, cov);
    if (issues.length === 0) {
      wrap.innerHTML = '';
      wrap.appendChild(h('em', {}, ['Inputs look populated; the corpus simply does not contain this gap pattern at the current threshold.']));
      return;
    }
    wrap.innerHTML = '';
    wrap.appendChild(h('strong', {}, ['Why no candidates: ']));
    wrap.appendChild(h('ul', {}, issues.map((s) => h('li', {}, [s]))));
  });
  return wrap;
}

function renderCandidate(c, opts = {}) {
  const wrap = h('div', { class: 'cs2-cand' });
  // Inline dismiss form: tiny form opens below the head when × is clicked.
  // No blocking prompt(); reason is optional.
  const form = h('div', { class: 'cs2-dismiss-form', style: 'display: none;' });
  const reasonInput = h('input', { type: 'text', class: 'cs2-dismiss-reason', placeholder: 'reason (optional)' });
  const confirmBtn = h('button', { type: 'button', class: 'btn btn-tiny' }, ['Confirm dismiss']);
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-tiny' }, ['Cancel']);
  confirmBtn.addEventListener('click', async () => {
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    // 10s timeout so a dropped request doesn't leave the button stuck.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await fetch('/api/v2/dismiss-candidate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({
          detector_type: c.type, signature: c.signature,
          reason: reasonInput.value.trim(),
          content: { cell: c.cell, description: c.description, salience: c.salience, statistic: c.statistic },
        }),
      }).then((r) => r.json());
      if (r.error) { alert('Dismiss failed: ' + r.error); confirmBtn.disabled = false; return; }
      wrap.remove();
      if (typeof opts.onDismissed === 'function') opts.onDismissed(c);
    } catch (err) {
      alert(err.name === 'AbortError' ? 'Dismiss timed out — try again.' : ('Dismiss failed: ' + err.message));
      confirmBtn.disabled = false;
    } finally {
      clearTimeout(timer);
    }
  });
  cancelBtn.addEventListener('click', () => { form.style.display = 'none'; });
  form.appendChild(reasonInput);
  form.appendChild(confirmBtn);
  form.appendChild(cancelBtn);

  const dismissBtn = h('button', {
    type: 'button', class: 'cs2-cand-dismiss',
    title: 'Dismiss this candidate (considered & rejected). Re-detected variants of the same gap stay hidden.',
    onclick: () => { form.style.display = form.style.display === 'none' ? 'flex' : 'none'; },
  }, ['× dismiss']);
  wrap.appendChild(h('div', { class: 'cs2-cand-head' }, [
    h('span', { class: 'cs2-cand-sal muted small' }, [`s=${(c.salience || 0).toFixed(2)}`]),
    h('span', { class: 'cs2-cand-desc' }, [c.description || JSON.stringify(c.cell)]),
    dismissBtn,
  ]));
  wrap.appendChild(form);
  // Drill-down details.
  const drillTrigger = h('details', { class: 'cs2-cand-drill' });
  drillTrigger.appendChild(h('summary', { class: 'muted small' }, ['Drill-down']));
  drillTrigger.appendChild(h('pre', { class: 'cs2-cand-json' }, [
    JSON.stringify({ cell: c.cell, statistic: c.statistic }, null, 2),
  ]));
  // Contributing papers list with click-to-open.
  const contributingIds = flattenContributing(c.contributing_papers);
  if (contributingIds.length > 0) {
    const papersList = h('div', { class: 'cs2-papers-list' });
    papersList.appendChild(h('strong', { class: 'muted small' }, ['Papers']));
    for (const pid of contributingIds.slice(0, 20)) {
      papersList.appendChild(h('a', {
        href: `#/stage4`,
        class: 'cs2-paper-link',
        onclick: () => { window.localStorage.setItem('cs2:lastClickedPaperId', pid); },
      }, [pid]));
    }
    if (contributingIds.length > 20) {
      papersList.appendChild(h('span', { class: 'muted small' }, [` (+${contributingIds.length - 20} more)`]));
    }
    drillTrigger.appendChild(papersList);
  }
  wrap.appendChild(drillTrigger);
  return wrap;
}

function renderCitationContextControl() {
  const wrap = h('div', { class: 'cs2-cit-ctx' });
  const status = h('p', { class: 'muted small' }, ['Loading…']);
  wrap.appendChild(h('h4', {}, ['Citation context classification']));
  wrap.appendChild(status);
  async function refresh() {
    const r = await fetchJson('/api/v2/citation-context/status');
    if (r.error) { status.textContent = 'Error: ' + r.error; return; }
    const t = r.totals || {};
    const pct = t.total ? Math.round((t.classified / t.total) * 100) : 0;
    const distBits = (r.distribution || []).map((d) => `${d.context_class}: ${d.n}`).join(' · ');
    status.innerHTML = '';
    status.appendChild(h('span', {}, [
      `${t.classified}/${t.total} citation edges classified (${pct}%). `,
      distBits ? h('span', { class: 'muted small' }, [`Distribution: ${distBits}.`]) : null,
    ]));
  }
  refresh();
  const btn = h('button', { type: 'button', class: 'btn btn-ai' }, ['Classify unclassified edges']);
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Running…';
    const r = await fetch('/api/v2/citation-context/classify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    if (r.error) {
      status.textContent = 'Failed: ' + r.error;
      btn.disabled = false; btn.textContent = 'Classify unclassified edges';
      return;
    }
    const poll = setInterval(async () => {
      const s = await fetchJson('/api/v2/citation-context/status');
      if (!s.running) {
        clearInterval(poll);
        btn.disabled = false; btn.textContent = 'Classify unclassified edges';
        await refresh();
      } else {
        status.textContent = `Running… (${s.totals.classified}/${s.totals.total} so far)`;
      }
    }, 3000);
  });
  wrap.appendChild(btn);
  return wrap;
}

function formatAge(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

async function renderDismissedPanel(root) {
  const wrap = h('details', { class: 'cs2-dismissed-panel' });
  wrap.appendChild(h('summary', { class: 'muted small' }, ['Dismissed candidates ▾']));
  const list = h('div', { class: 'cs2-dismissed-list' });
  wrap.appendChild(list);
  root.appendChild(wrap);
  wrap.addEventListener('toggle', async () => {
    if (!wrap.open || list.dataset.loaded === '1') return;
    list.dataset.loaded = '1';
    list.appendChild(h('p', { class: 'muted small' }, ['Loading…']));
    const r = await fetchJson('/api/v2/dismissed-candidates');
    list.innerHTML = '';
    if (r.error || !r.entries?.length) {
      list.appendChild(h('p', { class: 'muted small' }, [r.error || 'No dismissed candidates.']));
      return;
    }
    for (const e of r.entries) {
      const item = h('div', { class: 'cs2-dismissed-item' });
      item.appendChild(h('span', { class: 'muted small cs2-dismissed-type' }, [`${e.detector_type} · ${e.dismissed_at?.slice(0, 10) || ''}`]));
      // Signature: short summary by default, full text under <details>.
      const sigSummary = e.signature.length > 100 ? e.signature.slice(0, 100) + '…' : e.signature;
      if (e.signature.length > 100) {
        const det = h('details', { class: 'cs2-dismissed-sig' });
        det.appendChild(h('summary', {}, [sigSummary]));
        det.appendChild(h('code', { class: 'cs2-dismissed-sig-full' }, [e.signature]));
        item.appendChild(det);
      } else {
        item.appendChild(h('span', {}, [` ${e.signature}`]));
      }
      // Original candidate content if preserved at dismiss time.
      if (e.content) {
        const det = h('details', { class: 'cs2-dismissed-content' });
        det.appendChild(h('summary', { class: 'muted small' }, ['Original content']));
        det.appendChild(h('pre', { class: 'cs2-dismissed-content-pre' }, [
          typeof e.content === 'string' ? e.content : JSON.stringify(e.content, null, 2),
        ]));
        item.appendChild(det);
      }
      if (e.reason) item.appendChild(h('span', { class: 'muted small' }, [` "${e.reason}"`]));
      const restoreBtn = h('button', {
        type: 'button', class: 'btn btn-ghost btn-tiny',
        onclick: async () => {
          await fetch('/api/v2/dismiss-candidate', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ detector_type: e.detector_type, signature: e.signature }),
          });
          item.style.display = 'none';
        },
      }, ['Restore']);
      item.appendChild(restoreBtn);
      list.appendChild(item);
    }
  });
}

function flattenContributing(cp) {
  if (!cp) return [];
  if (Array.isArray(cp)) {
    const out = [];
    for (const item of cp) {
      if (typeof item === 'string') out.push(item);
      else if (item && typeof item.paper_id === 'string') out.push(item.paper_id);
    }
    return out;
  }
  if (typeof cp === 'object') {
    const out = [];
    for (const arr of Object.values(cp)) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) if (typeof item === 'string') out.push(item);
    }
    return out;
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────
// Corpus index tab — datasets / tech / frameworks / authors
// ─────────────────────────────────────────────────────────────────────────

async function renderCorpusIndex(root) {
  root.appendChild(h('p', { class: 'muted small' }, [
    'Every canonical entity that appears in the corpus, grouped by kind.',
  ]));
  const placeholder = h('p', { class: 'muted small cs2-status' }, ['Loading…']);
  root.appendChild(placeholder);

  // Pull row counts + lists via the structured-query endpoint.
  // We don't have a dedicated endpoint for this yet (M5.c could add
  // /api/v2/corpus-index) — for now we use the query + snapshot
  // endpoints to get the data.
  const snap = await fetchJson('/api/v2/snapshot');
  if (snap.error) {
    placeholder.remove();
    root.appendChild(h('div', { class: 'banner banner-warn' }, [snap.error]));
    return;
  }
  placeholder.remove();

  // Counts by kind (already in the snapshot).
  const kinds = snap.name_usage_by_kind || [];
  if (kinds.length === 0) {
    root.appendChild(h('p', { class: 'muted small' }, [
      'No named entities extracted yet. Run the structured-field extractor for each paper first.',
    ]));
    return;
  }

  for (const k of kinds) {
    const section = h('section', { class: 'cs2-corpus-kind' });
    section.appendChild(h('h3', {}, [
      k.kind.charAt(0).toUpperCase() + k.kind.slice(1) + ` (${k.n})`,
    ]));
    section.appendChild(h('p', { class: 'muted small' }, ['Loading list…']));
    root.appendChild(section);

    // Pull the per-canonical paper counts via a structured query.
    // We add a tiny endpoint inline by querying papers per canonical name.
    // For now: pull all name_usage rows of this kind (limited) and aggregate
    // client-side via the structured query interface.
    const qStr = `${k.kind}:*`;   // not real syntax; we use snapshot data instead
    const list = await fetchJson('/api/v2/corpus-index?kind=' + encodeURIComponent(k.kind));
    section.querySelector('p').remove();
    if (list.error) {
      section.appendChild(h('p', { class: 'muted small' }, [list.error]));
      continue;
    }
    const tbl = h('table', { class: 'structured-table' });
    tbl.appendChild(h('thead', {}, [
      h('tr', {}, ['Canonical','Label','Papers','Sample raw'].map((s) => h('th', {}, [s]))),
    ]));
    const body = h('tbody');
    for (const item of (list.items || []).slice(0, 60)) {
      body.appendChild(h('tr', {}, [
        h('td', {}, [item.canonical]),
        h('td', {}, [item.preferred_label || '']),
        h('td', {}, [String(item.paper_count)]),
        h('td', { class: 'muted small' }, [(item.sample_raws || []).slice(0, 3).join(' / ')]),
      ]));
    }
    tbl.appendChild(body);
    section.appendChild(tbl);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  try { return await r.json(); }
  catch (e) { return { error: 'invalid response: ' + (await r.text()).slice(0, 200) }; }
}
