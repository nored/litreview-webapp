// Stage 5 (UI label "5. Corpus shape"): a read-only overview of what
// the corpus actually looks like. Matrix heatmap up top, then outliers,
// contradiction audit, and the recurring-limitations list. No LLM
// workflow, no candidate generation — that all moved to stage 6
// (positioning · catalogue) where it sits directly before the chapters
// it feeds.
//
// The student arrives here to *understand* their corpus before they
// commit to a topic, not to drive a workflow. The matrix is the visual
// anchor; everything else is a layer of signal on top of it.

import { h } from '../lib/dom.mjs';
import * as llm from '../lib/llm.mjs';

export async function renderStage5(root) {
  root.innerHTML = '<h1>5. Corpus shape</h1><div class="placeholder">loading…</div>';

  let agg, topicMd;
  try {
    [agg, topicMd] = await Promise.all([
      fetch('/api/synthesis/aggregate').then((r) => r.json()),
      fetch('/api/protocol/topic').then((r) => r.json()).then((x) => x.content || ''),
    ]);
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['5. Corpus shape']));
    root.appendChild(h('div', { class: 'banner banner-warn' }, [err.message]));
    return;
  }

  const topicTitle = (topicMd.match(/title:\s*(.+)/) || [])[1]?.trim() || '';

  if (agg.count === 0) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['5. Corpus shape']));
    root.appendChild(h('p', { class: 'lead' }, [
      'No notes yet. Complete some ', h('a', { href: '#/stage4' }, ['stage 4 deep reads']),
      ' first — corpus shape reads from the note frontmatter and gap-opened sections.',
    ]));
    return;
  }

  root.innerHTML = '';
  root.appendChild(h('h1', {}, ['5. Corpus shape']));
  root.appendChild(h('p', { class: 'lead' }, [
    `Read-only overview of ${agg.count} note${agg.count === 1 ? '' : 's'} on `,
    h('strong', {}, [topicTitle || '(unspecified topic)']),
    '. Use this to decide whether your corpus is ready for the positioning step. ',
    'Gap candidate generation + assessment now lives in ',
    h('a', { href: '#/stage7' }, ['stage 6 — positioning']),
    '.',
  ]));

  root.appendChild(renderMatrixSection(agg));
  root.appendChild(renderMethodLattice(agg));
  root.appendChild(renderLimitationsPanel());
}

// ---------------------------------------------------------------------
// Method × novelty lattice — second view of the corpus, perpendicular
// to the gap matrix. The gap matrix says "which topical cells are
// empty?"; the lattice says "which methods produce strong-novelty work
// vs incremental work, and which methods rely on self-constructed
// ground truth?". Defensibility-focused: a student picking a topic
// wants to know whether the methods in their corpus produce credible,
// externally-validated, novel work.
// ---------------------------------------------------------------------

const NOVELTY_COLS = ['strong', 'moderate', 'incremental', 'unclear'];

function renderMethodLattice(agg) {
  // Build per-method buckets keyed by novelty_strength.
  const methods = (agg.methods || []).slice().sort((a, b) => {
    const ca = (agg.by_method[a] || []).length;
    const cb = (agg.by_method[b] || []).length;
    return cb - ca;
  });
  if (methods.length === 0) return h('div');

  // Per-method aggregates: count by novelty bucket + ext-GT count +
  // self-constructed-GT count + must-cite count.
  const perMethod = {};
  for (const m of methods) {
    perMethod[m] = {
      total: 0,
      byNovelty: { strong: [], moderate: [], incremental: [], unclear: [] },
      extGt: 0,
      selfGt: 0,
      mustCite: 0,
    };
  }
  for (const p of Object.values(agg.by_paper || {})) {
    const m = p.method_family || 'other';
    if (!perMethod[m]) continue;
    perMethod[m].total++;
    const nov = NOVELTY_COLS.includes(p.novelty_strength) ? p.novelty_strength : 'unclear';
    perMethod[m].byNovelty[nov].push(p.paper_id);
    if (p.ground_truth_external) perMethod[m].extGt++;
    if (p.quality_flags?.self_constructed_ground_truth) perMethod[m].selfGt++;
    if (p.must_cite) perMethod[m].mustCite++;
  }

  // Max for color intensity scaling — peak count over any cell.
  let maxCell = 1;
  for (const m of methods) {
    for (const n of NOVELTY_COLS) {
      const c = perMethod[m].byNovelty[n].length;
      if (c > maxCell) maxCell = c;
    }
  }

  const table = h('table', { class: 'gap-matrix method-lattice' });
  const thead = h('thead');
  const headerRow = h('tr', {}, [h('th', {}, ['method ↓ / novelty →'])]);
  for (const n of NOVELTY_COLS) headerRow.appendChild(h('th', { class: 'col-head' }, [n]));
  headerRow.appendChild(h('th', { class: 'col-head' }, ['total']));
  headerRow.appendChild(h('th', { class: 'col-head' }, ['ext-GT']));
  headerRow.appendChild(h('th', { class: 'col-head' }, ['self-GT']));
  headerRow.appendChild(h('th', { class: 'col-head' }, ['must-cite']));
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = h('tbody');
  for (const m of methods) {
    const row = h('tr', {}, [h('th', { class: 'row-head' }, [m])]);
    for (const n of NOVELTY_COLS) {
      const ids = perMethod[m].byNovelty[n];
      const intensity = ids.length === 0 ? 0 : Math.min(1, ids.length / maxCell);
      // Strong = green tinted, incremental = amber tinted, unclear = grey.
      // Moderate = neutral blue (matrix default).
      let bg = '';
      if (ids.length > 0) {
        const alpha = (0.10 + 0.40 * intensity).toFixed(3);
        if (n === 'strong')      bg = `rgba(31, 122, 61, ${alpha})`;
        else if (n === 'incremental') bg = `rgba(210, 152, 0, ${alpha})`;
        else if (n === 'unclear') bg = `rgba(120, 120, 120, ${alpha})`;
        else bg = `rgba(31, 111, 235, ${alpha})`;
      }
      row.appendChild(h('td', {
        class: 'matrix-cell ' + (ids.length === 0 ? 'cell-empty' : 'cell-filled'),
        style: { background: bg },
        title: ids.length === 0 ? 'no papers' : ids.map((id) => `paper_${id}`).join(', '),
      }, [
        ids.length === 0 ? '—' :
        h('div', {}, [
          h('div', { class: 'cell-count' }, [String(ids.length)]),
          h('div', { class: 'cell-ids small muted' }, [
            ids.slice(0, 5).map((id) => id).join(', ') + (ids.length > 5 ? '…' : ''),
          ]),
        ]),
      ]));
    }
    row.appendChild(h('td', { class: 'matrix-cell row-total' }, [String(perMethod[m].total)]));
    row.appendChild(h('td', {
      class: 'matrix-cell row-total ' + (perMethod[m].extGt === 0 ? 'lattice-zero-extgt' : ''),
      title: perMethod[m].extGt === 0 ? 'no externally-validated work for this method' : '',
    }, [String(perMethod[m].extGt)]));
    row.appendChild(h('td', {
      class: 'matrix-cell row-total ' + (perMethod[m].selfGt >= perMethod[m].total / 2 && perMethod[m].total > 1 ? 'lattice-high-selfgt' : ''),
      title: perMethod[m].selfGt >= perMethod[m].total / 2 && perMethod[m].total > 1
        ? `≥50% of this method's papers use self-constructed ground truth — methodological red flag`
        : '',
    }, [String(perMethod[m].selfGt)]));
    row.appendChild(h('td', { class: 'matrix-cell row-total' }, [String(perMethod[m].mustCite)]));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  // Audit lines below the lattice — surface the actionable signals.
  const noExtGt = methods.filter((m) => perMethod[m].total > 0 && perMethod[m].extGt === 0);
  const highSelfGt = methods.filter((m) => perMethod[m].total > 1 && perMethod[m].selfGt >= perMethod[m].total / 2);
  const strongNoveltyLeaders = methods
    .map((m) => ({ method: m, strong: perMethod[m].byNovelty.strong.length }))
    .filter((x) => x.strong > 0)
    .sort((a, b) => b.strong - a.strong)
    .slice(0, 3);
  const incrementalSaturated = methods
    .map((m) => ({
      method: m,
      total: perMethod[m].total,
      incremental: perMethod[m].byNovelty.incremental.length,
    }))
    .filter((x) => x.total >= 3 && x.incremental / x.total >= 0.5)
    .sort((a, b) => b.incremental - a.incremental)
    .slice(0, 3);

  const audit = h('div', { class: 'lattice-audit' });
  if (strongNoveltyLeaders.length > 0) {
    audit.appendChild(h('div', { class: 'lattice-audit-line small' }, [
      h('strong', {}, ['Strong-novelty leaders: ']),
      strongNoveltyLeaders.map((x) => `${x.method} (${x.strong})`).join(', '),
    ]));
  }
  if (incrementalSaturated.length > 0) {
    audit.appendChild(h('div', { class: 'lattice-audit-line small lattice-audit-warn' }, [
      h('strong', {}, ['Incremental-saturated methods: ']),
      incrementalSaturated.map((x) => `${x.method} (${x.incremental}/${x.total})`).join(', '),
      ' — methods where ≥50% of work is marked incremental; entering this space risks producing more of the same.',
    ]));
  }
  if (noExtGt.length > 0) {
    audit.appendChild(h('div', { class: 'lattice-audit-line small lattice-audit-warn' }, [
      h('strong', {}, ['Methods with no externally-validated work: ']),
      noExtGt.join(', '),
      ' — defensibility risk; an external validation source becomes the differentiator.',
    ]));
  }
  if (highSelfGt.length > 0) {
    audit.appendChild(h('div', { class: 'lattice-audit-line small lattice-audit-warn' }, [
      h('strong', {}, ['Methods leaning on self-constructed ground truth: ']),
      highSelfGt.join(', '),
      ' — circular-validation risk; methodology-fit indicator will likely fail without an independent anchor.',
    ]));
  }

  return h('div', { class: 'panel synth-panel' }, [
    h('h2', {}, [`Method × novelty lattice · ${methods.length} method${methods.length === 1 ? '' : 's'}`]),
    h('p', { class: 'small muted' }, [
      'Rows: method families. Columns: novelty class. Right-hand columns: external-GT, self-constructed-GT, must-cite counts. ',
      'Green = strong novelty, blue = moderate, amber = incremental, grey = unclear. Hover a cell for the paper-id list. ',
      'This view is perpendicular to the gap matrix above: it asks "what kind of work is each method producing?", not "what topic does each cover?".',
    ]),
    h('div', { class: 'matrix-wrap' }, [table]),
    audit,
  ]);
}

// ---------------------------------------------------------------------
// Matrix heatmap (the visual anchor — first thing on the page)
// ---------------------------------------------------------------------

function renderMatrixSection(agg) {
  const cats = agg.categories.length ? agg.categories : ['other'];
  const methods = agg.methods.length ? agg.methods : ['other'];
  const maxCount = Math.max(1, ...Object.values(agg.matrix).map((arr) => arr.length));

  const table = h('table', { class: 'gap-matrix' });
  const thead = h('thead');
  const headerRow = h('tr', {}, [h('th', {}, [' '])]);
  for (const m of methods) headerRow.appendChild(h('th', { class: 'col-head' }, [m]));
  headerRow.appendChild(h('th', { class: 'col-head' }, ['total']));
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = h('tbody');
  for (const cat of cats) {
    const tr = h('tr', {}, [h('th', { class: 'row-head' }, [cat])]);
    let rowTotal = 0;
    for (const m of methods) {
      const ids = agg.matrix[`${cat}|${m}`] || [];
      rowTotal += ids.length;
      const intensity = ids.length === 0 ? 0 : Math.min(1, ids.length / maxCount);
      tr.appendChild(h('td', {
        class: 'matrix-cell ' + (ids.length === 0 ? 'cell-empty' : 'cell-filled'),
        style: { background: ids.length === 0 ? '' : `rgba(31, 111, 235, ${0.08 + 0.4 * intensity})` },
        title: ids.length === 0 ? 'empty cell' : ids.map((id) => `paper_${id}`).join(', '),
      }, [
        ids.length === 0 ? '—' :
        h('div', {}, [
          h('div', { class: 'cell-count' }, [String(ids.length)]),
          h('div', { class: 'cell-ids small muted' }, [ids.map((id) => id).slice(0, 6).join(', ') + (ids.length > 6 ? '…' : '')]),
        ]),
      ]));
    }
    tr.appendChild(h('td', { class: 'matrix-cell row-total' }, [String(rowTotal)]));
    tbody.appendChild(tr);
  }
  const totalsRow = h('tr', {}, [h('th', { class: 'row-head' }, ['total'])]);
  methods.forEach((m) => totalsRow.appendChild(h('th', { class: 'col-total' }, [String((agg.by_method[m] || []).length)])));
  totalsRow.appendChild(h('th', { class: 'col-total' }, [String(agg.count)]));
  tbody.appendChild(totalsRow);
  table.appendChild(tbody);

  const empties = [];
  for (const cat of cats) for (const m of methods) {
    if (!(agg.matrix[`${cat}|${m}`]?.length)) empties.push(`${cat} × ${m}`);
  }
  const sparse = [];
  for (const [k, ids] of Object.entries(agg.matrix)) {
    if (ids.length >= 1 && ids.length <= 2) sparse.push({ key: k, count: ids.length, ids });
  }

  // Compact stats row directly under the matrix — no clicks to expand.
  const stats = h('div', { class: 'matrix-summary' }, [
    h('div', { class: 'stat' }, [
      h('div', { class: 'stat-value' }, [String(empties.length)]),
      h('div', { class: 'stat-label muted small' }, ['empty cells']),
    ]),
    h('div', { class: 'stat' }, [
      h('div', { class: 'stat-value' }, [String(sparse.length)]),
      h('div', { class: 'stat-label muted small' }, ['sparse (1-2 papers)']),
    ]),
    h('div', { class: 'stat' }, [
      h('div', { class: 'stat-value' }, [String(agg.flag_counts.self_constructed_ground_truth)]),
      h('div', { class: 'stat-label muted small' }, ['self-constructed GT']),
    ]),
    h('div', { class: 'stat' }, [
      h('div', { class: 'stat-value' }, [String(agg.must_cite_count)]),
      h('div', { class: 'stat-label muted small' }, ['must-cite papers']),
    ]),
    h('div', { class: 'stat' }, [
      h('div', { class: 'stat-value' }, [String(agg.external_ground_truth_count)]),
      h('div', { class: 'stat-label muted small' }, ['external GT']),
    ]),
  ]);

  // Outliers + contradictions live in compact lines under the matrix.
  // Outliers loads lazily; contradictions is on-demand (paraphrase mining
  // is fast but only useful if the student wants to audit).
  const outlierLine = renderOutlierLine();
  const contradictionLine = renderContradictionLine();

  return h('div', { class: 'panel synth-panel' }, [
    h('h2', {}, [`Gap matrix · ${agg.count} papers · ${cats.length} × ${methods.length} cells`]),
    h('p', { class: 'small muted' }, [
      'Cell colour ∝ paper count. Empty and sparse (1–2 papers) cells are the obvious unexplored intersections. Hover for the paper-id list.',
    ]),
    h('div', { class: 'matrix-wrap' }, [table]),
    stats,
    outlierLine,
    contradictionLine,
  ]);
}

// ---------------------------------------------------------------------
// Outlier line — lazy load, click to expand titles
// ---------------------------------------------------------------------

function renderOutlierLine() {
  const wrap = h('div', { class: 'matrix-outlier-line muted small' }, [
    '⚑ checking outliers…',
  ]);
  (async () => {
    try {
      const r = await fetch('/api/synthesis/outliers?topK=10&minDistance=0.15').then((res) => res.json());
      wrap.innerHTML = '';
      if (r.error) {
        wrap.appendChild(h('span', { class: 'muted small' }, ['Outlier check failed: ' + r.error]));
        return;
      }
      if (!r.items?.length) {
        wrap.appendChild(h('span', { class: 'muted small' }, [
          '✓ All ', String(r.include_count || 0), ' include papers cluster tightly — no outliers detected.',
        ]));
        return;
      }
      const labelSpan = h('span', { class: 'matrix-outlier-label' }, [
        `⚑ ${r.items.length} outlier${r.items.length === 1 ? '' : 's'} among ${r.include_count} include papers`,
      ]);
      const toggleBtn = h('button', { type: 'button', class: 'btn-link' }, ['show titles']);
      const list = h('ul', { class: 'matrix-outlier-list muted small', style: { display: 'none' } });
      for (const it of r.items) {
        list.appendChild(h('li', {}, [
          h('code', {}, [`paper_${it.paper_id}`]),
          ' · d=' + it.distance.toFixed(3) + ' · ',
          it.title || '(untitled)',
        ]));
      }
      toggleBtn.addEventListener('click', () => {
        const showing = list.style.display !== 'none';
        list.style.display = showing ? 'none' : '';
        toggleBtn.textContent = showing ? 'show titles' : 'hide';
      });
      wrap.appendChild(labelSpan);
      wrap.appendChild(h('span', {}, [' · ']));
      wrap.appendChild(toggleBtn);
      wrap.appendChild(list);
    } catch {
      wrap.innerHTML = '';
      wrap.appendChild(h('span', { class: 'muted small' }, ['Outlier check unavailable']));
    }
  })();
  return wrap;
}

// ---------------------------------------------------------------------
// Contradiction audit — on-demand, paraphrase-mined pairs that the
// student can spot-check with the LLM. Surface-level intellectual
// tension detector.
// ---------------------------------------------------------------------

function renderContradictionLine() {
  const wrap = h('div', { class: 'matrix-contradiction-line muted small' });
  const scanBtn = h('button', { type: 'button', class: 'btn-link' }, ['run scan']);
  wrap.appendChild(h('span', {}, [
    '🔍 Audit your include corpus for intellectual contradictions · ',
    scanBtn,
  ]));
  const resultsHost = h('div', { class: 'contradiction-results' });
  wrap.appendChild(resultsHost);

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = 'scanning…';
    resultsHost.innerHTML = '';
    resultsHost.appendChild(h('div', { class: 'pf-progress-indeterminate' }, []));
    try {
      const r = await fetch('/api/synthesis/contradictions?minSimilarity=0.75&maxPairs=20').then((res) => res.json());
      if (r.error) throw new Error(r.error);
      resultsHost.innerHTML = '';
      if (!r.pairs.length) {
        resultsHost.appendChild(h('p', { class: 'muted small' }, [
          `Scanned ${r.total_notes} include notes — no similar pairs above 0.75 cosine. Either internally consistent at the surface level, or notes are too sparse to flag anything.`,
        ]));
        scanBtn.textContent = 're-run scan';
        scanBtn.disabled = false;
        return;
      }
      resultsHost.appendChild(h('p', { class: 'muted small' }, [
        `${r.pairs.length} topically-similar pair${r.pairs.length === 1 ? '' : 's'} flagged from ${r.total_notes} include notes. `,
        'Click Check on a pair you suspect to ask the AI helper whether they actually contradict.',
      ]));
      for (const pair of r.pairs) renderContradictionPair(resultsHost, pair);
      scanBtn.textContent = 're-run scan';
      scanBtn.disabled = false;
    } catch (err) {
      resultsHost.innerHTML = '';
      resultsHost.appendChild(h('p', { class: 'error-text small' }, ['Contradiction scan failed: ' + err.message]));
      scanBtn.textContent = 're-run scan';
      scanBtn.disabled = false;
    }
  });
  return wrap;
}

function renderContradictionPair(host, pair) {
  const verdictBox = h('div', { class: 'contradiction-verdict' });
  const checkBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, ['Check with AI']);
  const row = h('div', { class: 'contradiction-row card' }, [
    h('span', { class: 'contradiction-sim' }, [`sim ${pair.similarity.toFixed(3)}`]),
    h('div', { class: 'contradiction-body' }, [
      h('div', { class: 'contradiction-pair-titles' }, [
        h('div', {}, [h('code', {}, [`paper_${pair.a.paper_id}`]), '  ', pair.a.title]),
        h('div', {}, [h('code', {}, [`paper_${pair.b.paper_id}`]), '  ', pair.b.title]),
      ]),
      verdictBox,
    ]),
    checkBtn,
  ]);
  checkBtn.addEventListener('click', async () => {
    if (!llm.isLoaded()) {
      verdictBox.innerHTML = '';
      verdictBox.appendChild(h('span', { class: 'muted small' }, ['Configure an AI provider in the topbar first.']));
      return;
    }
    checkBtn.disabled = true;
    checkBtn.textContent = 'judging…';
    verdictBox.innerHTML = '';
    verdictBox.appendChild(h('div', { class: 'pf-progress-indeterminate' }, []));
    try {
      const promptResp = await fetch('/api/synthesis/contradiction-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair }),
      }).then((res) => res.json());
      if (promptResp.error) throw new Error(promptResp.error);
      const out = await llm.chat({
        system: 'You audit literature reviews for intellectual tensions. Output exactly the requested two lines, no preamble.',
        user: promptResp.prompt,
        temperature: 0.1,
      });
      const parsed = parseContradictionVerdict(out);
      verdictBox.innerHTML = '';
      verdictBox.appendChild(h('span', {
        class: 'contradiction-badge contradiction-' + (parsed.verdict || 'unknown'),
      }, [parsed.verdict || 'unparsed']));
      if (parsed.explanation) {
        verdictBox.appendChild(h('span', { class: 'small muted contradiction-explanation' }, [' ', parsed.explanation]));
      }
    } catch (err) {
      verdictBox.innerHTML = '';
      verdictBox.appendChild(h('span', { class: 'error-text small' }, ['Check failed: ' + err.message]));
    } finally {
      checkBtn.textContent = 'Re-check';
      checkBtn.disabled = false;
    }
  });
  host.appendChild(row);
}

function parseContradictionVerdict(text) {
  const verdictMatch = String(text || '').match(/VERDICT\s*:\s*(contradict|agree|nuance|unrelated)/i);
  const explanationMatch = String(text || '').match(/EXPLANATION\s*:\s*([^\n]+)/i);
  return {
    verdict: verdictMatch ? verdictMatch[1].toLowerCase() : '',
    explanation: explanationMatch ? explanationMatch[1].trim() : '',
  };
}

// ---------------------------------------------------------------------
// Recurring-limitations panel — read-only display. The "promote to
// candidate" affordance moved with the candidate workflow to stage 7.
// ---------------------------------------------------------------------

function renderLimitationsPanel() {
  const wrap = h('details', { class: 'panel synth-panel' });
  wrap.appendChild(h('summary', {}, [
    h('h2', {}, ['Recurring limitations']),
    h('span', { class: 'small muted summary-hint' }, [
      ' — themes the corpus itself admits',
    ]),
  ]));
  const body = h('div', {}, [h('p', { class: 'muted small' }, ['loading…'])]);
  wrap.appendChild(body);
  (async () => {
    try {
      const r = await fetch('/api/synthesis/limitations?scope=include').then((res) => res.json());
      body.innerHTML = '';
      if (r.error) throw new Error(r.error);
      if (!r.total_limitations) {
        body.appendChild(h('p', { class: 'muted small' }, [
          'No "stated limitations" filled in your note frontmatter yet. As you complete deep-reads in stage 4, this list populates automatically.',
        ]));
        return;
      }
      const recurring = (r.clusters || []).filter((c) => !c.singleton);
      body.appendChild(h('p', { class: 'muted small' }, [
        `${r.total_limitations} stated limitations across the corpus · `,
        `${recurring.length} recurring theme${recurring.length === 1 ? '' : 's'} (≥2 papers each).`,
        recurring.length > 0 ? ' Stage 6 can seed gap candidates from these.' : '',
      ]));
      if (recurring.length === 0) return;
      const list = h('ul', { class: 'limitations-cluster-list' });
      for (const c of recurring) {
        list.appendChild(h('li', {}, [
          h('span', { class: 'paper-id-pill' }, [`${c.paper_count}×`]),
          h('strong', {}, [' ' + (c.central_text || '(unlabelled)').slice(0, 180)]),
          h('div', { class: 'small muted' }, [
            'Papers: ',
            c.paper_ids.slice(0, 6).map((p) => `paper_${p}`).join(', '),
            c.paper_ids.length > 6 ? '…' : '',
          ]),
        ]));
      }
      body.appendChild(list);
    } catch (err) {
      body.innerHTML = '';
      body.appendChild(h('p', { class: 'error-text small' }, ['Failed to load: ' + err.message]));
    }
  })();
  return wrap;
}
