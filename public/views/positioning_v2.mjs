// public/views/positioning_v2.mjs
//
// Stage 7 v2 — Positioning & catalogue with an OUTPUT-MODE SELECTOR at
// the top. The user picks the kind of artefact they want to produce
// (thesis chapter, related-work section, grant proposal, landscape
// scan, ad-hoc query) and the page reshapes itself.
//
// Modes:
//   * Thesis     — PRISMA flow + indicator scorecard + positioning
//                  statement editor + catalogue draft.
//                  (Currently a passthrough to the legacy v1 stage7;
//                  the v2 reshape lands when the structured store has
//                  enough content to drive these artefacts directly.)
//   * Paper      — Related-work table + gap candidates + a
//                  positioning paragraph generator.
//   * Grant      — Top gap candidates formatted for a grant pitch
//                  + a bibliometric impact summary.
//   * Landscape  — Tabular corpus index + temporal trends +
//                  cross-paper comparisons. The most mature v2 mode.
//   * Custom     — Just the structured-query bar + the combined
//                  detector output for ad-hoc exploration.
//
// Each mode reads from /api/v2/* exclusively. No legacy synthesis state.

import { h } from '../lib/dom.mjs';

const MODES = [
  { id: 'thesis',    label: 'Thesis',    description: 'PRISMA + positioning + catalogue + indicator scorecard.' },
  { id: 'paper',     label: 'Paper',     description: 'Related-work table + positioning paragraph for a paper submission.' },
  { id: 'grant',     label: 'Grant',     description: 'Gap report + bibliometric impact for a grant proposal.' },
  { id: 'landscape', label: 'Landscape', description: 'Corpus inventory + temporal trends + cross-paper comparisons.' },
  { id: 'custom',    label: 'Custom',    description: 'Structured-query bar + ad-hoc detector output.' },
];

const MODE_KEY = 'litreview:positioning:mode';

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

export async function renderPositioningV2(root) {
  root.innerHTML = '';
  root.classList.add('view-positioning-v2');

  const state = {
    mode: localStorage.getItem(MODE_KEY) || 'landscape',
  };

  const header = h('div', { class: 'pos2-header' }, [
    h('h2', {}, ['Positioning · v2']),
    h('p', { class: 'muted' }, [
      'Choose the kind of output you need. Every mode draws from the same structured store; only the rendering changes.',
    ]),
  ]);
  root.appendChild(header);

  const modeSelector = h('div', { class: 'pos2-modes' });
  for (const m of MODES) {
    const btn = h('button', {
      type: 'button',
      class: 'pos2-mode' + (state.mode === m.id ? ' active' : ''),
      onclick: () => {
        state.mode = m.id;
        localStorage.setItem(MODE_KEY, m.id);
        rebuildModes();
        renderContent();
      },
    }, [
      h('div', { class: 'pos2-mode-label' }, [m.label]),
      h('div', { class: 'pos2-mode-desc muted small' }, [m.description]),
    ]);
    modeSelector.appendChild(btn);
  }
  root.appendChild(modeSelector);
  function rebuildModes() {
    for (const child of modeSelector.children) {
      const id = child.querySelector('.pos2-mode-label').textContent.toLowerCase();
      child.classList.toggle('active', id === state.mode);
    }
  }

  const content = h('div', { class: 'pos2-content' });
  root.appendChild(content);

  function renderContent() {
    content.innerHTML = '';
    const handler = MODE_HANDLERS[state.mode];
    if (handler) handler(content);
    else content.appendChild(h('p', { class: 'muted small' }, ['Mode not implemented yet.']));
  }
  renderContent();
}

// ─────────────────────────────────────────────────────────────────────────
// Mode: Landscape (the most fleshed-out v2 mode for now)
// ─────────────────────────────────────────────────────────────────────────

async function renderLandscapeMode(root) {
  root.appendChild(h('h3', {}, ['Corpus landscape']));
  root.appendChild(h('p', { class: 'muted small' }, [
    'Inventory of what the corpus actually contains: datasets, frameworks, tech stack items used + temporal trends.',
  ]));

  // Section 1 — Inventory (datasets, tech, frameworks).
  const inventorySection = h('section', { class: 'pos2-section' });
  inventorySection.appendChild(h('h4', {}, ['Inventory']));
  inventorySection.appendChild(h('p', { class: 'muted small' }, ['Loading…']));
  root.appendChild(inventorySection);

  // Section 2 — Temporal trends.
  const trendsSection = h('section', { class: 'pos2-section' });
  trendsSection.appendChild(h('h4', {}, ['Temporal trends']));
  trendsSection.appendChild(h('p', { class: 'muted small' }, ['Loading…']));
  root.appendChild(trendsSection);

  // Section 3 — Central papers (citation centrality).
  const centralSection = h('section', { class: 'pos2-section' });
  centralSection.appendChild(h('h4', {}, ['Central papers']));
  centralSection.appendChild(h('p', { class: 'muted small' }, ['Loading…']));
  root.appendChild(centralSection);

  // Section 4 — External comparison (Phase 6.d).
  const externalSection = h('section', { class: 'pos2-section' });
  externalSection.appendChild(h('h4', {}, ['External corpus comparison']));
  externalSection.appendChild(h('p', { class: 'muted small' }, [
    'Pulls a same-topic OpenAlex sample, clusters jointly with your corpus, ',
    'and flags clusters that are dense in the field but sparse in your include set.',
  ]));
  const queriesInput = h('input', {
    type: 'text',
    class: 'pos2-external-queries',
    placeholder: 'optional: comma-separated query overrides (default: derived from topic.md)',
  });
  externalSection.appendChild(queriesInput);
  externalSection.appendChild(h('button', {
    type: 'button', class: 'btn',
    onclick: () => {
      const raw = queriesInput.value || '';
      const queries = raw.split(',').map((s) => s.trim()).filter(Boolean);
      runExternalComparison(externalSection, { queries });
    },
  }, ['Run comparison']));
  root.appendChild(externalSection);

  // Fire the always-on sections in parallel.
  await Promise.all([
    loadInventory(inventorySection),
    loadTemporalTrends(trendsSection),
    loadCentralPapers(centralSection),
  ]);
}

async function runExternalComparison(section, opts = {}) {
  // Replace the button + input with a status panel.
  section.querySelectorAll('button, input').forEach((b) => b.remove());
  const status = h('p', { class: 'muted small' }, ['Starting comparison…']);
  section.appendChild(status);
  const body = JSON.stringify(opts.queries?.length ? { queries: opts.queries } : {});
  const startResp = await fetchJson('/api/v2/external-compare', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
  if (startResp.error) {
    status.textContent = 'Failed: ' + startResp.error;
    return;
  }
  status.textContent = 'Running… (this fetches up to 100 OpenAlex papers and embeds them; takes a minute)';
  // Poll for status.
  const poll = setInterval(async () => {
    const s = await fetchJson('/api/v2/external-compare/status');
    if (!s.running && s.last?.result) {
      clearInterval(poll);
      renderExternalResult(section, s.last.result);
    } else if (!s.running && s.last?.error) {
      clearInterval(poll);
      status.textContent = 'Failed: ' + s.last.error;
    } else if (s.last?.result === null && !s.running) {
      // edge case
      clearInterval(poll);
    }
  }, 2000);
}

function renderExternalResult(section, result) {
  section.innerHTML = '';
  section.appendChild(h('h4', {}, ['External corpus comparison']));
  if (result.error) {
    section.appendChild(h('div', { class: 'banner banner-warn' }, [result.error]));
    return;
  }
  const p = result.params || {};
  section.appendChild(h('p', { class: 'muted small' }, [
    `Pulled ${p.external_total} OpenAlex papers (excluding ones already in your corpus); compared against ${p.in_corpus_total} in-corpus papers. Queries used: ${(p.queries_used || []).map((q) => `"${q}"`).join(', ')}.`,
  ]));
  if (result.note) {
    section.appendChild(h('p', { class: 'muted small' }, [result.note]));
  }
  const gaps = result.gap_clusters || [];
  if (gaps.length === 0) {
    section.appendChild(h('p', { class: 'muted small' }, [
      'No external-vs-corpus gap clusters found. Either your corpus covers the field well, or the OpenAlex queries need refining.',
    ]));
    return;
  }
  section.appendChild(h('p', {}, [
    `${gaps.length} cluster(s) dense in OpenAlex but sparse in your corpus — areas the field has explored that you may have missed:`,
  ]));
  for (const c of gaps.slice(0, 10)) {
    section.appendChild(h('div', { class: 'pos2-cand' }, [
      h('div', {}, [
        h('strong', {}, [`${c.external_count} external · ${c.in_corpus_count} in-corpus papers`]),
      ]),
      h('ul', { class: 'pos2-cluster-samples muted small' },
        (c.sample_external || []).map((s) => h('li', {}, [
          `${s.title || '(no title)'}`,
          s.year ? h('span', { class: 'muted small' }, [` (${s.year})`]) : null,
          s.doi ? h('a', { href: 'https://doi.org/' + s.doi, target: '_blank', class: 'muted small' }, [` ${s.doi}`]) : null,
        ])),
      ),
    ]));
  }
}

async function loadInventory(section) {
  section.querySelector('p').remove();
  for (const kind of ['dataset', 'tech', 'framework']) {
    const sub = h('div', { class: 'pos2-inventory-kind' });
    sub.appendChild(h('h5', {}, [kind.charAt(0).toUpperCase() + kind.slice(1) + 's']));
    const list = await fetchJson('/api/v2/corpus-index?kind=' + kind);
    if (list.error || !list.items?.length) {
      sub.appendChild(h('p', { class: 'muted small' }, [list.error || `No ${kind}s extracted yet.`]));
      section.appendChild(sub);
      continue;
    }
    const tbl = h('table', { class: 'structured-table' });
    tbl.appendChild(h('thead', {}, [
      h('tr', {}, ['Name', 'Papers'].map((s) => h('th', {}, [s]))),
    ]));
    const body = h('tbody');
    for (const item of list.items.slice(0, 20)) {
      body.appendChild(h('tr', {}, [
        h('td', {}, [item.preferred_label || item.canonical]),
        h('td', {}, [String(item.paper_count)]),
      ]));
    }
    tbl.appendChild(body);
    sub.appendChild(tbl);
    section.appendChild(sub);
  }
}

async function loadTemporalTrends(section) {
  section.querySelector('p').remove();
  const r = await fetchJson('/api/v2/detect/temporal_trends');
  if (r.error) {
    section.appendChild(h('div', { class: 'banner banner-warn' }, [r.error]));
    return;
  }
  if (!r.candidates?.length) {
    section.appendChild(h('p', { class: 'muted small' }, ['No temporal patterns yet — needs papers with years populated.']));
    return;
  }
  for (const c of r.candidates.slice(0, 12)) {
    const badge = c.cell?.subtype || '?';
    section.appendChild(h('div', { class: 'pos2-trend' }, [
      h('span', { class: 'chip pos2-trend-' + badge }, [badge]),
      h('span', { class: 'pos2-trend-text' }, [c.description]),
    ]));
  }
}

async function loadCentralPapers(section) {
  section.querySelector('p').remove();
  const r = await fetchJson('/api/v2/detect/citation_centrality');
  if (r.error) {
    section.appendChild(h('div', { class: 'banner banner-warn' }, [r.error]));
    return;
  }
  if (!r.candidates?.length) {
    section.appendChild(h('p', { class: 'muted small' }, ['No citation graph yet — needs snowball or OpenAlex citation edges.']));
    return;
  }
  const tbl = h('table', { class: 'structured-table' });
  tbl.appendChild(h('thead', {}, [
    h('tr', {}, ['Paper', 'Year', 'PageRank', 'In-corpus citations'].map((s) => h('th', {}, [s]))),
  ]));
  const body = h('tbody');
  for (const c of r.candidates.slice(0, 15)) {
    const m = c.description.match(/Paper ([^\(]+)\((\d+)\)/);
    body.appendChild(h('tr', {}, [
      h('td', {}, [c.cell.paper_id]),
      h('td', {}, [m ? m[2] : '']),
      h('td', {}, [String(c.statistic.pagerank)]),
      h('td', {}, [String(c.statistic.in_degree)]),
    ]));
  }
  tbl.appendChild(body);
  section.appendChild(tbl);
}

// ─────────────────────────────────────────────────────────────────────────
// Mode: Grant (gap report formatted for a proposal)
// ─────────────────────────────────────────────────────────────────────────

async function renderGrantMode(root) {
  root.appendChild(h('h3', {}, ['Gap report (grant-format)']));
  root.appendChild(h('p', { class: 'muted small' }, [
    'Top gap candidates across all 7 detectors, citation-weighted, formatted as a one-pager you can paste into a proposal.',
  ]));
  const placeholder = h('p', { class: 'muted small' }, ['Running detectors…']);
  root.appendChild(placeholder);
  const r = await fetchJson('/api/v2/detect?topK=15&rerank=1');
  placeholder.remove();
  if (r.error) {
    root.appendChild(h('div', { class: 'banner banner-warn' }, [r.error]));
    return;
  }
  if (!r.combined?.length) {
    root.appendChild(h('p', { class: 'muted' }, ['No gaps detected — needs structured data populated first.']));
    return;
  }
  const intro = h('section', { class: 'pos2-section' });
  intro.appendChild(h('h4', {}, ['Top gaps in the field']));
  intro.appendChild(h('p', {}, [
    `Across ${r.summary.total} candidates in ${Object.keys(r.summary.per_type).length} detector categories, the highest-priority opportunities are:`,
  ]));
  const list = h('ol', { class: 'pos2-grant-list' });
  for (const c of r.combined.slice(0, 8)) {
    list.appendChild(h('li', {}, [
      h('strong', {}, [`[${c.type}] `]),
      c.description,
    ]));
  }
  intro.appendChild(list);
  root.appendChild(intro);
}

// ─────────────────────────────────────────────────────────────────────────
// Mode: Paper (related-work table)
// ─────────────────────────────────────────────────────────────────────────

async function renderPaperMode(root) {
  root.appendChild(h('h3', {}, ['Related-work composition']));
  root.appendChild(h('p', { class: 'muted small' }, [
    'A structured related-work table from the corpus + a gap candidates list to weave into your positioning paragraph.',
  ]));
  // Pull a representative sample by year.
  const sample = await fetchJson('/api/v2/query?q=year>0&limit=30&orderBy=year_desc');
  if (sample.error) {
    root.appendChild(h('div', { class: 'banner banner-warn' }, [sample.error]));
    return;
  }
  if (!sample.papers?.length) {
    root.appendChild(h('p', { class: 'muted' }, ['No papers in the v2 store.']));
    return;
  }
  const tbl = h('table', { class: 'structured-table' });
  tbl.appendChild(h('thead', {}, [
    h('tr', {}, ['Year', 'Paper', 'DOI'].map((s) => h('th', {}, [s]))),
  ]));
  const body = h('tbody');
  for (const p of sample.papers) {
    body.appendChild(h('tr', {}, [
      h('td', {}, [String(p.year || '')]),
      h('td', {}, [p.title || '']),
      h('td', { class: 'muted small' }, [p.doi || '']),
    ]));
  }
  tbl.appendChild(body);
  root.appendChild(tbl);

  // Top 5 gaps to inspire the positioning paragraph.
  const gaps = await fetchJson('/api/v2/detect?topK=5');
  if (!gaps.error && gaps.combined?.length) {
    root.appendChild(h('h4', {}, ['Top gap candidates']));
    for (const c of gaps.combined) {
      root.appendChild(h('div', { class: 'pos2-cand' }, [
        h('strong', {}, [`[${c.type}] `]),
        c.description,
      ]));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Mode: Custom (structured-query + raw detector output)
// ─────────────────────────────────────────────────────────────────────────

async function renderCustomMode(root) {
  root.appendChild(h('h3', {}, ['Custom']));
  root.appendChild(h('p', { class: 'muted small' }, [
    'Structured query bar + all detector output. Build your own view.',
  ]));
  const input = h('input', { type: 'text', class: 'structured-query-input', placeholder: 'e.g. dataset:mimic-iii AND year>=2023' });
  const runBtn = h('button', { type: 'button', class: 'btn btn-ai' }, ['Run query']);
  root.appendChild(h('div', { class: 'structured-query-form' }, [input, runBtn]));
  const out = h('div', {});
  root.appendChild(out);

  async function run() {
    const q = input.value.trim();
    if (!q) return;
    out.innerHTML = '<p class="muted small">Running…</p>';
    const r = await fetchJson('/api/v2/query?q=' + encodeURIComponent(q));
    out.innerHTML = '';
    if (r.error) { out.appendChild(h('div', { class: 'banner banner-warn' }, [r.error])); return; }
    out.appendChild(h('p', { class: 'muted small' }, [`${r.papers.length} hit(s)`]));
    const tbl = h('table', { class: 'structured-table' });
    tbl.appendChild(h('thead', {}, [
      h('tr', {}, ['ID','Title','Year'].map((s) => h('th', {}, [s]))),
    ]));
    const body = h('tbody');
    for (const p of r.papers) {
      body.appendChild(h('tr', {}, [
        h('td', {}, [p.paper_id]),
        h('td', {}, [p.title || '']),
        h('td', {}, [String(p.year || '')]),
      ]));
    }
    tbl.appendChild(body);
    out.appendChild(tbl);
  }
  runBtn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

// ─────────────────────────────────────────────────────────────────────────
// Mode: Thesis — PRISMA flow + indicator scorecard + positioning
// statement + catalogue summary. Reads from the existing /api/positioning
// + /api/synthesis endpoints, which now also draw from the v2 store
// (since v2 ingestion populates papers + paper_authors + categories).
// Full v2-native catalogue generation lands later; this version surfaces
// the artefacts via the working v1 backend without forcing the user to
// leave #/stage7.
// ─────────────────────────────────────────────────────────────────────────

async function renderThesisMode(root) {
  root.appendChild(h('h3', {}, ['Thesis artefacts']));
  root.appendChild(h('p', { class: 'muted small' }, [
    'PRISMA flow (from workflow logs), top gap candidates (from v2 detectors), positioning statement, and a v2 catalogue (verbatim quotes from the structured store).',
  ]));

  const prismaSection  = h('section', { class: 'pos2-section' }, [
    h('h4', {}, ['PRISMA flow']),
    h('p', { class: 'muted small' }, ['Loading…']),
  ]);
  const candidatesSection = h('section', { class: 'pos2-section' }, [
    h('h4', {}, ['Top gap candidates']),
    h('p', { class: 'muted small' }, ['Loading…']),
  ]);
  const positionSection = h('section', { class: 'pos2-section' }, [
    h('h4', {}, ['Positioning statement']),
    h('p', { class: 'muted small' }, ['Loading…']),
  ]);
  const catalogueSection = h('section', { class: 'pos2-section' }, [
    h('h4', {}, ['Catalogue (v2)']),
    h('p', { class: 'muted small' }, ['Loading…']),
  ]);
  root.appendChild(prismaSection);
  root.appendChild(candidatesSection);
  root.appendChild(positionSection);
  root.appendChild(catalogueSection);

  await Promise.all([
    loadPrisma(prismaSection),
    loadTopCandidates(candidatesSection),
    loadPositioning(positionSection),
    loadCatalogueV2(catalogueSection),
  ]);
}

async function loadPrisma(section) {
  section.querySelector('p').remove();
  const r = await fetchJson('/api/positioning/prisma');
  if (r.error) {
    section.appendChild(h('div', { class: 'banner banner-warn' }, [r.error]));
    return;
  }
  const n = r.numbers || {};
  const rows = [
    ['Queries run', n.queries_run],
    ['Records identified', n.records_identified],
    ['After dedup', n.after_dedup],
    ['Manual additions', n.manual_additions],
    ['Screened', n.screened],
    ['Excluded at title/abstract', n.excluded_at_screening],
    ['Full-text assessed', n.full_text_assessed],
    ['Full-text retrieved', n.full_text_retrieved],
    ['Full-text unavailable', n.full_text_unavailable],
    ['Notes written', n.notes_written],
    ['Studies in synthesis', n.studies_in_synthesis],
  ].filter(([, v]) => v != null);
  if (rows.length === 0) {
    section.appendChild(h('p', { class: 'muted small' }, ['No PRISMA data yet — run triage first.']));
    return;
  }
  const list = h('div', { class: 'pos2-prisma' });
  for (const [stage, count] of rows) {
    list.appendChild(h('div', { class: 'pos2-prisma-row' }, [
      h('span', { class: 'pos2-prisma-stage' }, [stage]),
      h('span', { class: 'pos2-prisma-count' }, [String(count)]),
    ]));
  }
  section.appendChild(list);
  if (r.methodology_template) {
    const det = h('details', {});
    det.appendChild(h('summary', { class: 'muted small' }, ['Methodology paragraph (copy/paste)']));
    det.appendChild(h('pre', { class: 'pos2-positioning-pre' }, [r.methodology_template]));
    section.appendChild(det);
  }
}

async function loadTopCandidates(section) {
  section.querySelector('p').remove();
  const r = await fetchJson('/api/v2/detect?rerank=1');
  if (r.error) {
    section.appendChild(h('div', { class: 'banner banner-warn' }, [r.error]));
    return;
  }
  const combined = (r.combined || []).slice(0, 10);
  if (combined.length === 0) {
    section.appendChild(h('p', { class: 'muted small' }, [
      'No detector candidates yet — run extraction on the corpus first.',
    ]));
    return;
  }
  const tbl = h('table', { class: 'structured-table' });
  tbl.appendChild(h('thead', {}, [
    h('tr', {}, ['Type', 'Description', 'Salience', 'Contributing papers'].map((s) => h('th', {}, [s]))),
  ]));
  const body = h('tbody');
  for (const c of combined) {
    body.appendChild(h('tr', {}, [
      h('td', { class: 'muted small' }, [c.type || c.detector || '—']),
      h('td', {}, [(c.description || c.label || c.cell || '').slice(0, 140)]),
      h('td', { class: 'muted small' }, [String(c.salience ?? c.score ?? '').slice(0, 6)]),
      h('td', { class: 'muted small' }, [(c.contributing_paper_ids || c.papers || []).slice(0, 4).join(', ')]),
    ]));
  }
  tbl.appendChild(body);
  section.appendChild(tbl);
}

async function loadPositioning(section) {
  section.querySelector('p').remove();
  const r = await fetchJson('/api/positioning/state');
  if (r.error) {
    section.appendChild(h('div', { class: 'banner banner-warn' }, [r.error]));
    return;
  }
  const txt = (r.statement || r.positioning_statement || r.markdown || '').trim();
  if (!txt) {
    section.appendChild(h('p', { class: 'muted small' }, [
      'No positioning statement saved yet. Edit ',
      h('code', {}, ['project/synthesis/positioning_statement.md']),
      ' to populate.',
    ]));
    return;
  }
  section.appendChild(h('pre', { class: 'pos2-positioning-pre' }, [txt]));
}

async function loadCatalogueV2(section) {
  section.querySelector('p').remove();
  const r = await fetchJson('/api/v2/catalogue');
  if (r.error) {
    section.appendChild(h('div', { class: 'banner banner-warn' }, [r.error]));
    return;
  }
  const chapters = r.chapters || [];
  if (chapters.length === 0) {
    section.appendChild(h('p', { class: 'muted small' }, [
      'No catalogue yet — ingest papers and run extraction (Stage 4) to populate verbatim quotes per body section.',
    ]));
    return;
  }
  section.appendChild(h('p', { class: 'muted small' }, [
    `${chapters.length} chapters · ${chapters.reduce((a, c) => a + c.paper_count, 0)} papers. `,
    h('a', { href: '/api/v2/catalogue.md', download: 'catalogue.md' }, ['Download as Markdown']),
  ]));
  for (const ch of chapters) {
    const det = h('details', { class: 'pos2-catalogue-chapter' });
    det.appendChild(h('summary', {}, [
      h('strong', {}, [ch.category]),
      h('span', { class: 'muted small' }, [` — ${ch.paper_count} papers`]),
    ]));
    for (const section_name of Object.keys(ch.sections || {})) {
      const quotes = ch.sections[section_name];
      if (!quotes || quotes.length === 0) continue;
      det.appendChild(h('h5', { class: 'pos2-catalogue-section' }, [section_name.replace(/_/g, ' ')]));
      const ul = h('ul', { class: 'pos2-catalogue-quotes' });
      for (const q of quotes.slice(0, 5)) {
        ul.appendChild(h('li', {}, [
          h('blockquote', {}, [q.text]),
          h('span', { class: 'muted small' }, [`— ${q.paper_id}${q.page ? `, p. ${q.page}` : ''}`]),
        ]));
      }
      det.appendChild(ul);
    }
    section.appendChild(det);
  }
}

const MODE_HANDLERS = {
  thesis:    renderThesisMode,
  paper:     renderPaperMode,
  grant:     renderGrantMode,
  landscape: renderLandscapeMode,
  custom:    renderCustomMode,
};

// ─────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  try { return await r.json(); }
  catch (e) { return { error: 'invalid response: ' + (await r.text()).slice(0, 200) }; }
}
