// public/views/structured.mjs
//
// Debug + inspection view for the v2 structured-data pipeline. Hand-rolled,
// not a production form — its job is to let you trigger the new extractors
// and watch what they produce against your real corpus before the proper
// Stage 4 / Stage 7 UI rewrite lands in M5.b.
//
// Sections:
//
//   1. Snapshot  — counts per table; quick check that ingestion / extraction
//                  has actually written rows.
//   2. Corpus    — list of papers from `papers` table (post-ingest). Click
//                  a paper to see its full structured record.
//   3. Paper view — for a selected paper: identification, categories,
//                   paper_field entries, name_usage by kind, results,
//                   claims. Buttons: "Re-extract structured fields",
//                   "Re-ingest chunks".
//   4. Detect    — runs all 11 detectors, shows the combined ranked list
//                  with cross-type tagging.
//   5. Query     — the structured query bar; runs the parsed query and
//                  shows matching papers.
//   6. Recommend — paste a shortlist, get recommendations.
//
// All API calls hit /api/v2/* — they don't touch the v1 prose-drafter flow.

import { h } from '../lib/dom.mjs';

export async function renderStructured(root) {
  root.innerHTML = '';
  root.classList.add('view-structured');

  // Layout: tabs at top, content below.
  const tabs = h('div', { class: 'structured-tabs' });
  const content = h('div', { class: 'structured-content' });
  root.appendChild(tabs);
  root.appendChild(content);

  const TABS = [
    { id: 'snapshot',  label: 'Snapshot',  render: renderSnapshotTab },
    { id: 'coverage',  label: 'Coverage',  render: renderCoverageTab },
    { id: 'corpus',    label: 'Corpus',    render: renderCorpusTab },
    { id: 'detect',    label: 'Detect',    render: renderDetectTab },
    { id: 'query',     label: 'Query',     render: renderQueryTab },
    { id: 'recommend', label: 'Recommend', render: renderRecommendTab },
    { id: 'log',       label: 'Log',       render: renderLogTab },
  ];
  let active = TABS[0].id;
  function rebuildTabs() {
    tabs.innerHTML = '';
    for (const t of TABS) {
      const btn = h('button', {
        type: 'button',
        class: 'structured-tab' + (t.id === active ? ' active' : ''),
        onclick: () => { active = t.id; rebuildTabs(); rebuildContent(); },
      }, [t.label]);
      tabs.appendChild(btn);
    }
  }
  function rebuildContent() {
    content.innerHTML = 'Loading…';
    const tab = TABS.find((t) => t.id === active);
    tab.render(content).catch((err) => {
      content.innerHTML = '';
      content.appendChild(h('div', { class: 'banner banner-warn' }, [`Failed: ${err?.message || err}`]));
    });
  }
  rebuildTabs();
  rebuildContent();
}

// ─────────────────────────────────────────────────────────────────────────
// Tab: coverage  (per-field populated / unknown / missing %)
// ─────────────────────────────────────────────────────────────────────────

async function renderCoverageTab(root) {
  const [r, snap] = await Promise.all([
    fetchJson('/api/v2/coverage'),
    fetchJson('/api/v2/snapshot').catch(() => null),
  ]);
  root.innerHTML = '';
  if (r.error) {
    root.appendChild(h('div', { class: 'banner banner-warn' }, [r.error]));
    return;
  }
  // Embedder-identity drift warning surfaced from snapshot.
  if (snap?.embedder_check && snap.embedder_check.stamped && !snap.embedder_check.match) {
    const s = snap.embedder_check.stamped;
    const c = snap.embedder_check.current;
    root.appendChild(h('div', { class: 'banner banner-warn' }, [
      `Embedder drift: stored vectors written with ${s.model}@${s.dtype} (dim ${s.dim}); current embedder is ${c.model}@${c.dtype} (dim ${c.dim}). `,
      snap.embedder_check.dim_match
        ? 'Same dim, but cosine geometry may have shifted — consider re-embedding.'
        : 'DIM MISMATCH — vectors are not comparable. Wipe _vectors/ before continuing.',
    ]));
  }
  root.appendChild(h('p', { class: 'muted small' }, [
    `${r.eligible_size} eligible papers in v2 store. `,
    'Each field: ',
    h('strong', {}, ['Value']),
    ' = extractor returned a real value · ',
    h('strong', {}, ['False']),
    ' = bool extractor confirmed absence (real outcome) · ',
    h('strong', {}, ['Unknown']),
    ' = extractor ran but confidence too low · ',
    h('strong', {}, ['Missing']),
    ' = extractor never ran. Value+False+Unknown+Missing = total eligible.',
  ]));
  // Structured-fields table.
  const tbl = h('table', { class: 'structured-table' });
  tbl.appendChild(h('thead', {}, [
    h('tr', {}, ['Field', 'Value', 'False', 'Unknown', 'Missing', 'Value %'].map((s) => h('th', {}, [s]))),
  ]));
  const body = h('tbody');
  for (const f of r.fields) {
    const falseSignal = typeof f.false_signal === 'number' ? f.false_signal : 0;
    const realValue = Math.max(0, f.populated - falseSignal);
    body.appendChild(h('tr', {}, [
      h('td', {}, [f.field]),
      h('td', {}, [String(realValue)]),
      h('td', { class: 'muted small' }, [typeof f.false_signal === 'number' ? String(falseSignal) : '—']),
      h('td', { class: 'muted small' }, [String(f.unknown)]),
      h('td', { class: 'muted small' }, [String(f.missing)]),
      h('td', {}, [`${f.populated_pct}%`]),
    ]));
  }
  tbl.appendChild(body);
  root.appendChild(tbl);

  // Multi-row counts.
  root.appendChild(h('h4', {}, ['Named entities + results + claims + citations + chunks']));
  const tbl2 = h('table', { class: 'structured-table' });
  tbl2.appendChild(h('thead', {}, [h('tr', {}, ['Kind', 'Papers with', 'Total rows', 'Mean/paper', 'Coverage %'].map((s) => h('th', {}, [s])))]));
  const b2 = h('tbody');
  for (const ne of r.named_entities) {
    b2.appendChild(h('tr', {}, [
      h('td', {}, ['name_usage:' + ne.kind]),
      h('td', {}, [String(ne.papers_with)]),
      h('td', {}, [String(ne.total)]),
      h('td', { class: 'muted small' }, [String(ne.mean_per_paper)]),
      h('td', {}, [`${ne.coverage_pct}%`]),
    ]));
  }
  b2.appendChild(h('tr', {}, [
    h('td', {}, ['results']),
    h('td', {}, [String(r.results.papers_with_results)]),
    h('td', {}, [String(r.results.total_rows)]),
    h('td', { class: 'muted small' }, [String(r.results.mean_per_paper)]),
    h('td', {}, [`${r.results.coverage_pct}%`]),
  ]));
  b2.appendChild(h('tr', {}, [
    h('td', {}, ['claims']),
    h('td', {}, [String(r.claims.papers_with_claims)]),
    h('td', {}, [String(r.claims.total_rows)]),
    h('td', { class: 'muted small' }, [`stance: ${r.claims.with_stance} (${r.claims.stance_pct}%)`]),
    h('td', {}, [`${r.claims.coverage_pct}%`]),
  ]));
  b2.appendChild(h('tr', {}, [
    h('td', {}, ['citations']),
    h('td', {}, ['—']),
    h('td', {}, [String(r.citations.total)]),
    h('td', { class: 'muted small' }, [`classified: ${r.citations.classified} (${r.citations.classified_pct}%)`]),
    h('td', {}, ['—']),
  ]));
  b2.appendChild(h('tr', {}, [
    h('td', {}, ['chunks']),
    h('td', {}, [String(r.chunks.papers_with_chunks)]),
    h('td', {}, [String(r.chunks.total_chunks)]),
    h('td', { class: 'muted small' }, ['—']),
    h('td', {}, [`${r.chunks.coverage_pct}%`]),
  ]));
  tbl2.appendChild(b2);
  root.appendChild(tbl2);
}

// ─────────────────────────────────────────────────────────────────────────
// Tab: extraction log
// ─────────────────────────────────────────────────────────────────────────

async function renderLogTab(root) {
  root.innerHTML = '';
  let allEntries = [];
  let onlyFailures = false;

  const checkbox = h('input', {
    type: 'checkbox',
    onchange: (e) => { onlyFailures = e.target.checked; rerender(); },
  });
  const filter = h('label', { class: 'small' }, [checkbox, ' Only failures']);
  const list = h('div', { class: 'structured-log-list' });
  root.appendChild(filter);
  root.appendChild(list);

  function rerender() {
    list.innerHTML = '';
    const entries = onlyFailures ? allEntries.filter((e) => (e.errors || []).length > 0) : allEntries;
    if (!entries.length) {
      list.appendChild(h('p', { class: 'muted small' }, [onlyFailures ? 'No failures.' : 'No log entries yet.']));
      return;
    }
    for (const e of entries) {
      const failed = (e.errors || []).length > 0;
      const item = h('div', { class: 'structured-log-item ' + (failed ? 'log-failed' : 'log-ok') }, [
        h('div', {}, [
          h('strong', {}, [e.paper_id || '(unknown)']),
          h('span', { class: 'muted small' }, [` · ${e.finished_at || e.started_at} · ${e.elapsed_ms}ms`]),
        ]),
        failed
          ? h('ul', { class: 'muted small' }, e.errors.map((err) => h('li', {}, [err])))
          : null,
      ]);
      list.appendChild(item);
    }
  }

  list.innerHTML = 'Loading…';
  const r = await fetchJson('/api/v2/extraction-log');
  if (r.error) {
    list.innerHTML = '';
    list.appendChild(h('div', { class: 'banner banner-warn' }, [r.error]));
    return;
  }
  allEntries = r.entries || [];
  rerender();
}

// ─────────────────────────────────────────────────────────────────────────
// Tab: snapshot
// ─────────────────────────────────────────────────────────────────────────

async function renderSnapshotTab(root) {
  const data = await fetchJson('/api/v2/snapshot');
  root.innerHTML = '';
  if (data.error) {
    root.appendChild(h('div', { class: 'banner banner-warn' }, [data.error]));
    return;
  }
  root.appendChild(h('h2', {}, ['v2 Store snapshot']));
  root.appendChild(h('p', { class: 'muted small' }, [
    'Row counts across the SQLite store. ',
    h('button', { type: 'button', class: 'btn', onclick: async () => {
      const r = await fetchJson('/api/v2/sync', { method: 'POST' });
      alert('Sync: ' + JSON.stringify(r));
      renderSnapshotTab(root);
    } }, ['Sync papers from triage CSV']),
  ]));
  const tbl = h('table', { class: 'structured-table' });
  const tbody = h('tbody');
  for (const [k, v] of Object.entries(data.counts)) {
    tbody.appendChild(h('tr', {}, [h('td', {}, [k]), h('td', {}, [String(v)])]));
  }
  tbl.appendChild(tbody);
  root.appendChild(tbl);

  if (data.paper_field_breakdown?.length) {
    root.appendChild(h('h3', {}, ['paper_field breakdown']));
    const tbl2 = h('table', { class: 'structured-table' });
    const tbody2 = h('tbody');
    for (const r of data.paper_field_breakdown) {
      tbody2.appendChild(h('tr', {}, [h('td', {}, [r.field_name]), h('td', {}, [String(r.n)])]));
    }
    tbl2.appendChild(tbody2);
    root.appendChild(tbl2);
  }
  if (data.name_usage_by_kind?.length) {
    root.appendChild(h('h3', {}, ['name_usage by kind']));
    const tbl3 = h('table', { class: 'structured-table' });
    const tbody3 = h('tbody');
    for (const r of data.name_usage_by_kind) {
      tbody3.appendChild(h('tr', {}, [h('td', {}, [r.kind]), h('td', {}, [String(r.n)])]));
    }
    tbl3.appendChild(tbody3);
    root.appendChild(tbl3);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Tab: corpus list + per-paper drill-down
// ─────────────────────────────────────────────────────────────────────────

async function renderCorpusTab(root) {
  root.innerHTML = '';
  root.appendChild(h('h2', {}, ['Corpus (v2)']));
  const corpusList = h('div', { class: 'structured-corpus-list' });
  const detail = h('div', { class: 'structured-corpus-detail' });
  const split = h('div', { class: 'structured-split' }, [corpusList, detail]);
  root.appendChild(split);

  detail.innerHTML = '<p class="muted small">Select a paper from the list to view its structured record.</p>';

  // Run a query for all papers (limited).
  const r = await fetchJson('/api/v2/query?q=year>0&limit=500&orderBy=year_desc');
  if (r.error) {
    corpusList.appendChild(h('div', { class: 'banner banner-warn' }, [r.error]));
    return;
  }
  if (!r.papers || r.papers.length === 0) {
    corpusList.appendChild(h('p', { class: 'muted small' }, ['No papers yet. Run sync + extract first.']));
    return;
  }
  for (const p of r.papers) {
    const row = h('button', {
      type: 'button',
      class: 'structured-corpus-row',
      onclick: () => loadPaperDetail(p.paper_id, detail),
    }, [
      h('div', { class: 'structured-corpus-row-id' }, [p.paper_id]),
      h('div', { class: 'structured-corpus-row-title' }, [p.title || '(no title)']),
      h('div', { class: 'structured-corpus-row-year muted small' }, [String(p.year || '')]),
    ]);
    corpusList.appendChild(row);
  }
}

async function loadPaperDetail(paperId, detail) {
  detail.innerHTML = '<p class="muted small">Loading…</p>';
  const data = await fetchJson('/api/v2/papers/' + encodeURIComponent(paperId) + '/structured');
  detail.innerHTML = '';
  if (data.error) {
    detail.appendChild(h('div', { class: 'banner banner-warn' }, [data.error]));
    return;
  }
  // Header with actions.
  detail.appendChild(h('h3', {}, [data.paper.paper_id + ' — ' + (data.paper.title || '(no title)')]));
  detail.appendChild(h('div', { class: 'muted small' }, [
    `${data.paper.year || '?'} · ${data.paper.venue || ''} · ${data.paper.doi || ''} · chunks: ${data.chunk_count}`,
  ]));
  const actions = h('div', { class: 'structured-actions' }, [
    h('button', { type: 'button', class: 'btn', onclick: async () => {
      const r = await fetchJson('/api/v2/papers/' + encodeURIComponent(paperId) + '/ingest', { method: 'POST' });
      alert('Ingest: ' + JSON.stringify(r));
      loadPaperDetail(paperId, detail);
    } }, ['↻ Re-ingest chunks']),
    h('button', { type: 'button', class: 'btn btn-ai', onclick: async () => {
      detail.appendChild(h('p', { class: 'muted small' }, ['Running extractors… this can take ~15-20s per paper.']));
      const r = await fetchJson('/api/v2/papers/' + encodeURIComponent(paperId) + '/extract', { method: 'POST', body: '{}' });
      alert('Extract: ' + JSON.stringify({ elapsed_ms: r.elapsed_ms, errors: r.errors?.length || 0 }));
      loadPaperDetail(paperId, detail);
    } }, ['✨ Re-extract structured fields']),
  ]);
  detail.appendChild(actions);

  // Categories.
  if (data.categories?.length) {
    detail.appendChild(h('h4', {}, ['Categories']));
    detail.appendChild(h('div', { class: 'structured-chips' }, data.categories.map((c) => h('span', { class: 'chip' }, [c]))));
  }
  // paper_field rows.
  if (data.fields?.length) {
    detail.appendChild(h('h4', {}, ['Fields']));
    const tbl = h('table', { class: 'structured-table' });
    const head = h('thead', {}, [
      h('tr', {}, ['Field','Value','Type','Mechanism','Confidence','Source'].map((s) => h('th', {}, [s]))),
    ]);
    const body = h('tbody');
    for (const f of data.fields) {
      body.appendChild(h('tr', {}, [
        h('td', {}, [f.field_name]),
        h('td', {}, [String(f.field_value ?? '')]),
        h('td', {}, [f.field_type]),
        h('td', { class: 'muted small' }, [f.mechanism || '']),
        h('td', { class: 'muted small' }, [
          typeof f.confidence === 'number' ? f.confidence.toFixed(2) : '',
        ]),
        h('td', { class: 'muted small' }, [
          f.chunk_id ? `${f.chunk_id} · p.${f.page ?? '?'}` : '',
        ]),
      ]));
    }
    tbl.appendChild(head); tbl.appendChild(body); detail.appendChild(tbl);
  }
  // Named entities by kind.
  if (data.names_by_kind) {
    for (const [kind, items] of Object.entries(data.names_by_kind)) {
      if (!items.length) continue;
      detail.appendChild(h('h4', {}, [`Named: ${kind}`]));
      detail.appendChild(h('div', { class: 'structured-chips' }, items.map((it) =>
        h('span', { class: 'chip', title: `${it.mechanism || ''} ${it.score?.toFixed?.(2) || ''}` }, [
          it.preferred_label || it.canonical,
          ...(it.raw && it.raw !== it.canonical ? [h('span', { class: 'muted small' }, [` (${it.raw})`])] : []),
        ]))));
    }
  }
  // Results.
  if (data.results?.length) {
    detail.appendChild(h('h4', {}, ['Results']));
    const tbl = h('table', { class: 'structured-table' });
    const head = h('thead', {}, [
      h('tr', {}, ['Metric','Value','Dataset','Split','Page'].map((s) => h('th', {}, [s]))),
    ]);
    const body = h('tbody');
    for (const r of data.results) {
      body.appendChild(h('tr', {}, [
        h('td', {}, [r.metric]),
        h('td', {}, [String(r.value)]),
        h('td', {}, [r.dataset || '']),
        h('td', {}, [r.split || '']),
        h('td', { class: 'muted small' }, [String(r.page || '')]),
      ]));
    }
    tbl.appendChild(head); tbl.appendChild(body); detail.appendChild(tbl);
  }
  // Claims.
  if (data.claims?.length) {
    detail.appendChild(h('h4', {}, [`Claims (${data.claims.length})`]));
    for (const c of data.claims) {
      detail.appendChild(h('div', { class: 'structured-claim' }, [
        h('div', { class: 'muted small' }, [
          `[${c.claim_type}] stance=${c.stance || '?'} p.${c.page || '?'}`,
        ]),
        h('div', { class: 'structured-claim-text' }, [`"${c.text}"`]),
      ]));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Tab: detectors
// ─────────────────────────────────────────────────────────────────────────

async function renderDetectTab(root) {
  root.innerHTML = '';
  root.appendChild(h('h2', {}, ['Detectors']));
  const controls = h('div', { class: 'structured-controls' });
  const rerankToggle = h('label', {}, [
    h('input', { type: 'checkbox', id: 'rerank-toggle' }),
    ' Rerank by citation-weighted salience',
  ]);
  const runBtn = h('button', { type: 'button', class: 'btn btn-ai', onclick: run }, ['Run all detectors']);
  controls.appendChild(runBtn);
  controls.appendChild(rerankToggle);
  root.appendChild(controls);
  const out = h('div', { class: 'structured-detect-out' });
  root.appendChild(out);

  async function run() {
    out.innerHTML = '<p class="muted small">Running…</p>';
    const rr = document.getElementById('rerank-toggle')?.checked ? '&rerank=1' : '';
    const r = await fetchJson('/api/v2/detect?topK=50' + rr);
    out.innerHTML = '';
    if (r.error) { out.appendChild(h('div', { class: 'banner banner-warn' }, [r.error])); return; }
    out.appendChild(h('p', { class: 'muted small' }, [
      `Total: ${r.summary.total} across ${Object.keys(r.summary.per_type).length} detector types.`,
    ]));
    const perType = h('div', { class: 'structured-pertype' });
    for (const [type, count] of Object.entries(r.summary.per_type)) {
      perType.appendChild(h('span', { class: 'chip' }, [`${type}: ${count}`]));
    }
    out.appendChild(perType);
    out.appendChild(h('h3', {}, ['Combined (top 50)']));
    for (const c of r.combined) {
      out.appendChild(h('div', { class: 'structured-cand' }, [
        h('div', { class: 'structured-cand-head' }, [
          h('span', { class: 'chip' }, [c.type]),
          h('span', { class: 'muted small' }, [` s=${(c.salience || 0).toFixed(2)}`]),
        ]),
        h('div', { class: 'structured-cand-desc' }, [c.description || JSON.stringify(c.cell)]),
        h('details', {}, [
          h('summary', { class: 'muted small' }, ['statistic + provenance']),
          h('pre', { class: 'structured-json' }, [JSON.stringify({ cell: c.cell, statistic: c.statistic, contributing_papers: c.contributing_papers }, null, 2)]),
        ]),
      ]));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Tab: structured query
// ─────────────────────────────────────────────────────────────────────────

async function renderQueryTab(root) {
  root.innerHTML = '';
  root.appendChild(h('h2', {}, ['Structured query']));
  root.appendChild(h('p', { class: 'muted small' }, [
    'Examples: ',
    h('code', {}, ['dataset:mimic-iii AND method_family:deep_learning']),
    ' · ',
    h('code', {}, ['results.f1>0.8']),
    ' · ',
    h('code', {}, ['category:privacy AND tech:bert-base']),
  ]));
  const input = h('input', { type: 'text', class: 'structured-query-input', placeholder: 'enter query…' });
  const btn = h('button', { type: 'button', class: 'btn btn-ai', onclick: run }, ['Run']);
  const form = h('div', { class: 'structured-query-form' }, [input, btn]);
  root.appendChild(form);
  const out = h('div', { class: 'structured-query-out' });
  root.appendChild(out);

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  async function run() {
    const q = input.value.trim();
    if (!q) return;
    out.innerHTML = '<p class="muted small">Running…</p>';
    const r = await fetchJson('/api/v2/query?q=' + encodeURIComponent(q));
    out.innerHTML = '';
    if (r.error) { out.appendChild(h('div', { class: 'banner banner-warn' }, [r.error])); return; }
    out.appendChild(h('p', { class: 'muted small' }, [`${r.papers.length} paper(s) matched.`]));
    const tbl = h('table', { class: 'structured-table' });
    const head = h('thead', {}, [h('tr', {}, ['ID','Title','Year','DOI'].map((s) => h('th', {}, [s])))]);
    const body = h('tbody');
    for (const p of r.papers) {
      body.appendChild(h('tr', {}, [
        h('td', {}, [p.paper_id]),
        h('td', {}, [p.title || '']),
        h('td', {}, [String(p.year || '')]),
        h('td', { class: 'muted small' }, [p.doi || '']),
      ]));
    }
    tbl.appendChild(head); tbl.appendChild(body); out.appendChild(tbl);
    out.appendChild(h('details', {}, [
      h('summary', { class: 'muted small' }, ['compiled SQL']),
      h('pre', { class: 'structured-json' }, [r.sql.trim()]),
    ]));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Tab: recommendations
// ─────────────────────────────────────────────────────────────────────────

async function renderRecommendTab(root) {
  root.innerHTML = '';
  root.appendChild(h('h2', {}, ['Recommendations']));
  root.appendChild(h('p', { class: 'muted small' }, [
    'Paste a comma-separated list of paper IDs you\'ve already accepted; ',
    'the tool will suggest similar / connected papers from the rest of the corpus.',
  ]));
  const input = h('input', { type: 'text', class: 'structured-query-input', placeholder: 'e.g. 001,002,015' });
  const btn = h('button', { type: 'button', class: 'btn btn-ai', onclick: run }, ['Recommend']);
  root.appendChild(h('div', { class: 'structured-query-form' }, [input, btn]));
  const out = h('div', {});
  root.appendChild(out);

  async function run() {
    const ids = input.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    out.innerHTML = '<p class="muted small">Running…</p>';
    const r = await fetchJson('/api/v2/recommend', { method: 'POST', body: JSON.stringify({ shortlist: ids, topK: 15 }) });
    out.innerHTML = '';
    if (r.error) { out.appendChild(h('div', { class: 'banner banner-warn' }, [r.error])); return; }
    if (!r.recommendations?.length) {
      out.appendChild(h('p', { class: 'muted small' }, [r.reason || 'No recommendations.']));
      return;
    }
    for (const rec of r.recommendations) {
      out.appendChild(h('div', { class: 'structured-cand' }, [
        h('div', {}, [
          h('strong', {}, [rec.paper_id + ' · ' + (rec.title || '')]),
          h('span', { class: 'muted small' }, [` score=${rec.score.toFixed(3)}`]),
        ]),
        h('div', { class: 'muted small' }, [
          `claim_similarity=${rec.signals.claim_similarity.toFixed(2)} · citation_pull=${rec.signals.citation_pull.toFixed(2)} · raw_citations_from_shortlist=${rec.signals.raw_citations_from_shortlist}`,
        ]),
      ]));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const fetchOpts = { ...opts };
  if (fetchOpts.body && !fetchOpts.headers) {
    fetchOpts.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(url, fetchOpts);
  try { return await r.json(); }
  catch (e) { return { error: 'invalid response: ' + (await r.text()).slice(0, 200) }; }
}
