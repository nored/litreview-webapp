// Stage 5+6 synthesis. Three collapsible sections:
//   1. Gap matrix (heatmap)
//   2. Gap candidates (editable cards, AI generates structured proposals)
//   3. Indicator assessment (7-row scorecard per candidate)

import { h, debounce } from '../lib/dom.mjs';
import * as llm from '../lib/llm.mjs';

const INDICATOR_DEFS = [
  { id: 1, key: 'demonstrated_gap', label: 'Demonstrated gap',
    rule: 'PASS if 3+ databases searched, 50+ included papers, gap maps to empty/sparse cell. PARTIAL if cell has 1-2 papers. FAIL if 3+ papers already address it.' },
  { id: 2, key: 'literature_volume', label: 'Literature volume',
    rule: 'PASS if 50+ papers, 15+ directly relevant. PARTIAL if 30-49 or <15 relevant. FAIL if <30.' },
  { id: 3, key: 'scientific_value', label: 'Scientific value',
    rule: 'PASS if outcome genuinely uncertain, plausible negative result. FAIL if predictable outcome or comparison-table-only.' },
  { id: 4, key: 'external_validation', label: 'External validation',
    rule: 'PASS if specific external source named with 30+ reproducible cases. FAIL if self-constructed ground truth without external anchor.' },
  { id: 5, key: 'falsifiability_reproducibility', label: 'Falsifiability & reproducibility',
    rule: 'PASS if "does X outperform Y under Z" form with explicit success/failure criteria, plus data/code release commitment.' },
  { id: 6, key: 'methodology_fit', label: 'Methodology fit',
    rule: 'PASS if methodology fits and ground truth is independent. FAIL if same person constructs data, trains, evaluates without external check.' },
  { id: 7, key: 'hobby_project_test', label: 'Hobby project test',
    rule: 'PASS if requires sustained engineering, 2+ technical components. FAIL if doable in a weekend or running existing tool on existing dataset.' },
];

export async function renderStage5(root) {
  root.innerHTML = '<h1>5. Synthesis</h1><div class="placeholder">loading…</div>';

  let agg, state, indicators, topicMd;
  try {
    [agg, state, indicators, topicMd] = await Promise.all([
      fetch('/api/synthesis/aggregate').then((r) => r.json()),
      fetch('/api/synthesis/state').then((r) => r.json()),
      fetch('/api/synthesis/indicators').then((r) => r.json()).then((x) => x.indicators),
      fetch('/api/protocol/topic').then((r) => r.json()).then((x) => x.content || ''),
    ]);
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['5. Synthesis']));
    root.appendChild(h('div', { class: 'banner banner-warn' }, [err.message]));
    return;
  }

  const topicTitle = (topicMd.match(/title:\s*(.+)/) || [])[1]?.trim() || '';
  const topicDesc = ((topicMd.match(/description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/) || [])[1] || '')
    .split('\n').map((l) => l.replace(/^[ \t]{2}/, '')).join('\n').trim();

  if (agg.count === 0) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['5. Synthesis']));
    root.appendChild(h('p', { class: 'lead' }, [
      'No notes yet. Complete some ', h('a', { href: '#/stage4' }, ['stage 4 deep reads']),
      ' first — synthesis runs over the structured note frontmatter and gap-opened sections.',
    ]));
    return;
  }

  let dirty = false;
  const saveDebounced = debounce(saveState, 800);

  async function saveState() {
    if (!dirty) return;
    try {
      const res = await fetch('/api/synthesis/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('synthesis save failed:', err);
        return;
      }
      dirty = false;
      // Re-read state to pick up server-computed overall verdicts
      state = await fetch('/api/synthesis/state').then((r) => r.json());
      // Targeted re-render of just the candidate cards so save doesn't disrupt the user's typing
    } catch (err) {
      console.error(err);
    }
  }

  function setDirty() { dirty = true; saveDebounced(); }

  // One unified workflow state object. Read by renderCandidatesSection /
  // renderProgressStrip, so it must exist BEFORE the first render call.
  const synthRun = {
    running: false,
    cancelled: false,
    phase: '',           // 'generating' | 'assessing' | 'done' | ''
    stepIndex: 0,
    stepTotal: 0,
    currentLabel: '',
    error: '',
    started: 0,
  };

  root.innerHTML = '';
  root.appendChild(h('h1', {}, ['5. Synthesis']));
  root.appendChild(h('p', { class: 'lead' }, [
    `Operates on ${agg.count} note frontmatter and gap-opened sections — never re-reads PDFs. `,
    `Topic: `, h('strong', {}, [topicTitle || '(unspecified)']),
  ]));

  root.appendChild(renderMatrixSection(agg));
  root.appendChild(renderCandidatesSection());
  root.appendChild(renderAssessmentSection());

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

    return h('details', { class: 'panel synth-panel', open: true }, [
      h('summary', {}, [h('h2', {}, [`Gap matrix · ${agg.count} papers, ${cats.length} × ${methods.length} cells`])]),
      h('p', { class: 'small muted' }, [
        'Cell colour ∝ paper count. Empty cells and 1-2 paper cells are the obvious gap candidates. ',
        'Hover a cell for the full paper-id list.',
      ]),
      h('div', { class: 'matrix-wrap' }, [table]),
      h('div', { class: 'matrix-summary' }, [
        h('div', { class: 'stat' }, [
          h('div', { class: 'stat-value' }, [String(empties.length)]),
          h('div', { class: 'stat-label muted small' }, ['empty cells']),
        ]),
        h('div', { class: 'stat' }, [
          h('div', { class: 'stat-value' }, [String(sparse.length)]),
          h('div', { class: 'stat-label muted small' }, ['sparse cells (1-2)']),
        ]),
        h('div', { class: 'stat' }, [
          h('div', { class: 'stat-value' }, [String(agg.flag_counts.self_constructed_ground_truth)]),
          h('div', { class: 'stat-label muted small' }, ['self-constructed GT (methodological flag)']),
        ]),
        h('div', { class: 'stat' }, [
          h('div', { class: 'stat-value' }, [String(agg.must_cite_count)]),
          h('div', { class: 'stat-label muted small' }, ['must-cite papers']),
        ]),
      ]),
    ]);
  }

  // One unified workflow:
  //  step 1: generate candidates (1 LLM call)
  //  step 2..N+1: assess each candidate against the 7 indicators (1 call/candidate)
  // The progress strip below the toolbar shows the current step, the
  // currently-processing item, and an overall progress bar. Cancellable.
  function renderCandidatesSection() {
    const wrap = h('details', { class: 'panel synth-panel', open: true });
    wrap.appendChild(h('summary', {}, [h('h2', {}, [`Gap candidates · ${state.candidates.length}`])]));

    // Count candidates without any verdict assigned. Surfacing "Score
    // unscored (N)" is a separate action so existing candidates from a
    // prior run can be evaluated without generating new ones.
    const unscored = state.candidates.filter((c) =>
      INDICATOR_DEFS.every((ind) => !c.indicators[ind.key]?.verdict)
    );

    const toolbar = h('div', { class: 'panel-actions' });
    if (unscored.length > 0) {
      const scoreBtn = h('button', {
        class: 'btn btn-ai', type: 'button',
        disabled: !llm.isLoaded() || synthRun.running,
        title: llm.isLoaded() ? '' : 'Configure an AI provider in the topbar',
      }, [`✨ Score ${unscored.length} unscored candidate${unscored.length > 1 ? 's' : ''}`]);
      scoreBtn.addEventListener('click', () => assessUnscored(unscored));
      toolbar.appendChild(scoreBtn);
    }
    const generateBtn = h('button', {
      class: 'btn ' + (unscored.length > 0 ? '' : 'btn-ai'), type: 'button',
      disabled: !llm.isLoaded() || synthRun.running,
      title: llm.isLoaded() ? '' : 'Configure an AI provider in the topbar',
    }, [state.candidates.length === 0
      ? '✨ Generate & assess'
      : '✨ Generate more candidates']);
    generateBtn.addEventListener('click', generateAndAssessAll);
    const addManualBtn = h('button', { class: 'btn', type: 'button',
      disabled: synthRun.running,
      onclick: () => {
        state.candidates.push(emptyCandidate(state.candidates.length + 1));
        setDirty();
        wrap.replaceWith(renderCandidatesSection());
      },
    }, ['+ Add manual']);
    toolbar.appendChild(generateBtn);
    toolbar.appendChild(addManualBtn);
    wrap.appendChild(toolbar);

    // Progress strip
    const stripHost = h('div', { class: 'synth-progress-host' });
    renderProgressStrip(stripHost);
    wrap.appendChild(stripHost);

    if (state.candidates.length === 0 && !synthRun.running) {
      wrap.appendChild(h('p', { class: 'muted small' }, [
        'No candidates yet. Click "✨ Generate & assess" to have the AI propose gap candidates from your aggregated note data and score each against the seven indicators in one go. Add one manually if you prefer.',
      ]));
    }

    state.candidates.forEach((c, i) => wrap.appendChild(renderCandidateCard(c, i)));
    return wrap;
  }

  function renderProgressStrip(host) {
    host.innerHTML = '';
    if (!synthRun.running && !synthRun.error && synthRun.phase !== 'done') return;
    const pct = synthRun.stepTotal > 0 ? Math.round((synthRun.stepIndex / synthRun.stepTotal) * 100) : 0;
    if (synthRun.phase === 'done') {
      const accepted  = state.candidates.filter((c) => c.overall === 'accept').length;
      const refinable = state.candidates.filter((c) => c.overall === 'refine').length;
      const rejected  = state.candidates.filter((c) => c.overall === 'reject').length;
      host.appendChild(h('div', { class: 'banner banner-success synth-progress-strip' }, [
        h('strong', {}, ['Done. ']),
        ` ${accepted} accepted · ${refinable} refinable · ${rejected} rejected. `,
        h('span', { class: 'small muted' }, ['Review below; the shortlist below auto-reflects verdicts.']),
        h('button', { class: 'btn btn-ghost', type: 'button',
          style: { marginLeft: 'auto' },
          onclick: () => { synthRun.phase = ''; renderProgressStrip(host); },
        }, ['Dismiss']),
      ]));
      return;
    }
    if (synthRun.error) {
      host.appendChild(h('div', { class: 'banner banner-error synth-progress-strip' }, [
        h('strong', {}, ['Failed: ']), synthRun.error,
        h('button', { class: 'btn btn-ghost', type: 'button',
          style: { marginLeft: 'auto' },
          onclick: () => { synthRun.error = ''; renderProgressStrip(host); },
        }, ['Dismiss']),
      ]));
      return;
    }
    // Running
    const elapsed = (Date.now() - synthRun.started) / 1000;
    const rate = synthRun.stepIndex > 0 ? elapsed / synthRun.stepIndex : 0;
    const remaining = rate * (synthRun.stepTotal - synthRun.stepIndex);
    const eta = remaining > 60 ? `${Math.round(remaining / 60)} min` : `${Math.round(remaining)} s`;
    host.appendChild(h('div', { class: 'batch-strip synth-progress-strip' }, [
      h('div', { class: 'batch-info' }, [
        h('strong', {}, [`Step ${synthRun.stepIndex} / ${synthRun.stepTotal}`]),
        ' · ',
        h('span', { class: 'muted small' }, [
          synthRun.phase === 'generating' ? 'generating candidates…' :
          synthRun.phase === 'assessing'  ? `assessing: ${synthRun.currentLabel?.slice(0, 60) ?? ''}` :
          synthRun.currentLabel,
          synthRun.stepIndex > 0 ? ` · eta ~${eta}` : '',
        ]),
      ]),
      h('div', { class: 'batch-progress' }, [
        h('div', { class: 'batch-progress-bar', style: { width: `${pct}%` } }),
      ]),
      h('button', { class: 'btn btn-ghost', type: 'button',
        onclick: () => { synthRun.cancelled = true; },
      }, ['Cancel']),
    ]));
  }

  async function generateAndAssessAll() {
    if (synthRun.running) return;
    if (!llm.isLoaded()) {
      alert('Configure an AI provider first');
      return;
    }
    synthRun.running = true;
    synthRun.cancelled = false;
    synthRun.phase = 'generating';
    synthRun.stepIndex = 0;
    synthRun.stepTotal = 1; // will grow once we know how many candidates the model produced
    synthRun.currentLabel = 'pulling corpus summary…';
    synthRun.error = '';
    synthRun.started = Date.now();
    re_render();

    let summary;
    try {
      // Step 1: generate candidates
      synthRun.currentLabel = 'asking model for candidates…';
      re_render();
      summary = await fetch('/api/synthesis/llm-summary').then((r) => r.json());
      const text = await llm.chat({
        system: CANDIDATES_SYSTEM,
        user: buildCandidatesPrompt(summary, topicTitle, topicDesc),
        temperature: 0.3,
      });
      const candidates = parseCandidatesJson(text);
      if (!candidates.length) {
        throw new Error('Model did not return parseable candidates. Try a stronger model (Claude / GPT-4o) — small local models often fail at structured JSON.');
      }
      // Add the new candidates with empty indicator slots
      const startIdx = state.candidates.length;
      for (const c of candidates) {
        state.candidates.push({ ...emptyCandidate(state.candidates.length + 1), ...c });
      }
      setDirty();

      synthRun.phase = 'assessing';
      synthRun.stepIndex = 1;          // step 1 (generate) is done
      synthRun.stepTotal = 1 + candidates.length;
      re_render();

      // Step 2..N+1: assess each
      for (let i = 0; i < candidates.length; i++) {
        if (synthRun.cancelled) break;
        const cardIdx = startIdx + i;
        const c = state.candidates[cardIdx];
        synthRun.stepIndex = 1 + i;
        synthRun.currentLabel = `${i + 1}/${candidates.length}: ${c.title || '(untitled)'}`;
        re_render();

        try {
          const text = await llm.chat({
            system: ASSESSMENT_SYSTEM,
            user: buildAssessmentPrompt(c, summary, topicTitle),
            temperature: 0.2,
          });
          const verdicts = parseAssessmentJson(text);
          for (const ind of INDICATOR_DEFS) {
            if (verdicts[ind.key]) c.indicators[ind.key] = verdicts[ind.key];
          }
          setDirty();
        } catch (err) {
          console.error('assess failed for', c.title, err);
          // Don't bail; continue with the rest
        }

        // Save after each candidate to keep state durable
        await saveStateNow();
        re_render();
      }
      synthRun.stepIndex = synthRun.stepTotal;
      synthRun.phase = 'done';
    } catch (err) {
      synthRun.error = err.message || String(err);
      synthRun.phase = '';
    } finally {
      synthRun.running = false;
      synthRun.cancelled = false;
      re_render();
    }
  }

  // Synchronous-ish save: PUT and re-fetch so server-computed `overall` is
  // applied before the UI redraws.
  async function saveStateNow() {
    try {
      await fetch('/api/synthesis/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      state = await fetch('/api/synthesis/state').then((r) => r.json());
      dirty = false;
    } catch (err) {
      console.error('save failed:', err);
    }
  }

  function renderCandidateCard(c, idx) {
    const card = h('div', { class: 'candidate-card overall-' + (c.overall || 'pending') });
    const title = h('input', { type: 'text', value: c.title || '', class: 'candidate-title', placeholder: 'Short title' });
    title.addEventListener('input', () => { c.title = title.value; setDirty(); });

    const remove = h('button', { class: 'btn btn-ghost', type: 'button',
      onclick: () => {
        if (!confirm('Remove this candidate?')) return;
        state.candidates.splice(idx, 1);
        setDirty();
        re_render();
      },
    }, ['Remove']);

    card.appendChild(h('div', { class: 'candidate-header' }, [
      h('span', { class: 'paper-id-pill' }, [`#${idx + 1}`]),
      title,
      h('span', { class: 'candidate-overall' }, [c.overall || 'unassessed']),
      remove,
    ]));

    card.appendChild(textareaField('Statement (one sentence)', c, 'statement'));

    // Evidence: list of paper_id + note pairs
    const evidence = h('div', { class: 'evidence-list' });
    function renderEvidence() {
      evidence.innerHTML = '';
      (c.evidence || []).forEach((e, ei) => {
        const idIn = h('input', { type: 'text', value: e.paper_id || '', placeholder: 'paper_id', class: 'paper-id-input' });
        idIn.addEventListener('input', () => { e.paper_id = idIn.value; setDirty(); });
        const noteIn = h('input', { type: 'text', value: e.note || '', placeholder: 'why this paper supports the gap', class: 'evidence-note' });
        noteIn.addEventListener('input', () => { e.note = noteIn.value; setDirty(); });
        const rm = h('button', { class: 'btn btn-ghost', type: 'button',
          onclick: () => { c.evidence.splice(ei, 1); setDirty(); renderEvidence(); },
        }, ['×']);
        evidence.appendChild(h('div', { class: 'evidence-row' }, [idIn, noteIn, rm]));
      });
      const addBtn = h('button', { class: 'btn', type: 'button',
        onclick: () => { (c.evidence ??= []).push({ paper_id: '', note: '' }); setDirty(); renderEvidence(); },
      }, ['+ Add evidence']);
      evidence.appendChild(addBtn);
    }
    renderEvidence();
    card.appendChild(h('div', { class: 'candidate-field' }, [
      h('div', { class: 'note-field-label' }, ['Evidence (paper IDs + one-line notes)']),
      evidence,
    ]));

    card.appendChild(textField('Research question', c, 'research_question', 'A falsifiable question. e.g. "does X outperform Y under condition Z"'));
    card.appendChild(textField('External validation source', c, 'external_validation_source', 'A specific named source with case count, e.g. "CVE database query, ~80 entries 2020-2024"'));
    card.appendChild(textareaField('Methodology fit', c, 'methodology_fit'));
    card.appendChild(textareaField('Hobby project test', c, 'hobby_project_test'));

    // Per-candidate AI assessment button
    const assessBtn = h('button', { class: 'btn btn-ai', type: 'button',
      disabled: !llm.isLoaded(),
      onclick: () => assessCandidate(c, idx),
    }, ['✨ Assess against indicators']);
    card.appendChild(h('div', { class: 'candidate-field' }, [assessBtn]));

    // Indicator scorecard
    const scoreTable = h('table', { class: 'indicator-table' });
    INDICATOR_DEFS.forEach((ind) => {
      const v = c.indicators[ind.key] || { verdict: '', justification: '' };
      const row = h('tr', { class: 'verdict-row verdict-' + (v.verdict || 'none') });
      row.appendChild(h('th', {}, [
        h('span', { class: 'small muted' }, [`${ind.id}.`]),
        ' ', ind.label,
      ]));
      const verdictSelect = h('select', {});
      for (const opt of ['', 'PASS', 'PARTIAL', 'FAIL']) {
        const o = h('option', { value: opt }, [opt || '—']);
        if (v.verdict === opt) o.selected = true;
        verdictSelect.appendChild(o);
      }
      verdictSelect.addEventListener('change', () => {
        c.indicators[ind.key] = c.indicators[ind.key] || {};
        c.indicators[ind.key].verdict = verdictSelect.value;
        setDirty();
        // Visual update without full rerender
        row.className = 'verdict-row verdict-' + (verdictSelect.value || 'none');
      });
      row.appendChild(h('td', {}, [verdictSelect]));
      const justInput = h('input', { type: 'text', value: v.justification || '', placeholder: ind.rule });
      justInput.addEventListener('input', () => {
        c.indicators[ind.key] = c.indicators[ind.key] || {};
        c.indicators[ind.key].justification = justInput.value;
        setDirty();
      });
      row.appendChild(h('td', {}, [justInput]));
      scoreTable.appendChild(row);
    });
    card.appendChild(scoreTable);
    return card;
  }

  function renderAssessmentSection() {
    const wrap = h('details', { class: 'panel synth-panel' });
    wrap.appendChild(h('summary', {}, [h('h2', {}, ['Shortlist (auto-computed from verdicts)'])]));
    const accepted = state.candidates.filter((c) => c.overall === 'accept');
    const refinable = state.candidates.filter((c) => c.overall === 'refine');
    const rejected = state.candidates.filter((c) => c.overall === 'reject');
    if (state.candidates.length === 0) {
      wrap.appendChild(h('p', { class: 'muted small' }, ['No candidates yet.']));
      return wrap;
    }
    if (accepted.length === 0 && refinable.length === 0 && rejected.length === 0) {
      wrap.appendChild(h('p', { class: 'muted small' }, ['No verdicts entered yet — assess candidates above.']));
      return wrap;
    }
    const list = h('div', { class: 'shortlist-list' });
    function group(label, items, kind) {
      if (!items.length) return;
      list.appendChild(h('h3', { class: 'shortlist-heading shortlist-' + kind }, [`${label} (${items.length})`]));
      items.forEach((c, i) =>
        list.appendChild(h('div', { class: 'shortlist-row shortlist-' + kind }, [
          h('strong', {}, [`${i + 1}. ${c.title || '(untitled)'}`]),
          c.research_question ? ` — ${c.research_question}` : '',
        ]))
      );
    }
    group('Accepted', accepted, 'accept');
    group('Refinable', refinable, 'refine');
    group('Rejected', rejected, 'reject');
    wrap.appendChild(list);
    return wrap;
  }

  function re_render() {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['5. Synthesis']));
    root.appendChild(h('p', { class: 'lead' }, [
      `Operates on ${agg.count} note frontmatter and gap-opened sections — never re-reads PDFs. `,
      `Topic: `, h('strong', {}, [topicTitle || '(unspecified)']),
    ]));
    root.appendChild(renderMatrixSection(agg));
    root.appendChild(renderCandidatesSection());
    root.appendChild(renderAssessmentSection());
  }

  // Score a list of existing unscored candidates against the 7 indicators.
  // Same progress strip as generateAndAssessAll, just skips the generate step.
  async function assessUnscored(targets) {
    if (synthRun.running || !targets?.length) return;
    if (!llm.isLoaded()) {
      alert('Configure an AI provider first');
      return;
    }
    synthRun.running = true;
    synthRun.cancelled = false;
    synthRun.phase = 'assessing';
    synthRun.stepIndex = 0;
    synthRun.stepTotal = targets.length;
    synthRun.currentLabel = 'pulling corpus summary…';
    synthRun.error = '';
    synthRun.started = Date.now();
    re_render();

    try {
      const summary = await fetch('/api/synthesis/llm-summary').then((r) => r.json());
      for (let i = 0; i < targets.length; i++) {
        if (synthRun.cancelled) break;
        const c = targets[i];
        synthRun.stepIndex = i + 1;
        synthRun.currentLabel = `${i + 1}/${targets.length}: ${c.title || '(untitled)'}`;
        re_render();
        try {
          const text = await llm.chat({
            system: ASSESSMENT_SYSTEM,
            user: buildAssessmentPrompt(c, summary, topicTitle),
            temperature: 0.2,
          });
          const verdicts = parseAssessmentJson(text);
          for (const ind of INDICATOR_DEFS) {
            if (verdicts[ind.key]) c.indicators[ind.key] = verdicts[ind.key];
          }
          setDirty();
          await saveStateNow();
        } catch (err) {
          console.error('assess failed for', c.title, err);
        }
        re_render();
      }
      synthRun.phase = 'done';
    } catch (err) {
      synthRun.error = err.message || String(err);
      synthRun.phase = '';
    } finally {
      synthRun.running = false;
      synthRun.cancelled = false;
      re_render();
    }
  }

  // Per-candidate re-roll. Used after edits to refresh just that candidate's
  // verdicts without re-running the entire workflow.
  async function assessCandidate(c, idx) {
    if (!llm.isLoaded()) {
      alert('Configure an AI provider first');
      return;
    }
    try {
      const summary = await fetch('/api/synthesis/llm-summary').then((r) => r.json());
      const text = await llm.chat({
        system: ASSESSMENT_SYSTEM,
        user: buildAssessmentPrompt(c, summary, topicTitle),
        temperature: 0.2,
      });
      const verdicts = parseAssessmentJson(text);
      for (const ind of INDICATOR_DEFS) {
        if (verdicts[ind.key]) c.indicators[ind.key] = verdicts[ind.key];
      }
      setDirty();
      await saveStateNow();
      re_render();
    } catch (err) {
      alert('Assess failed: ' + err.message);
    }
  }
}

// ---- Helpers ----

function textField(label, obj, key, placeholder) {
  const wrap = h('div', { class: 'candidate-field' });
  wrap.appendChild(h('div', { class: 'note-field-label' }, [label]));
  const input = h('input', { type: 'text', value: obj[key] || '', placeholder: placeholder || '' });
  input.addEventListener('input', () => { obj[key] = input.value; });
  wrap.appendChild(input);
  return wrap;
}
function textareaField(label, obj, key) {
  const wrap = h('div', { class: 'candidate-field' });
  wrap.appendChild(h('div', { class: 'note-field-label' }, [label]));
  const ta = h('textarea', { rows: 2, value: obj[key] || '' });
  ta.value = obj[key] || '';
  ta.addEventListener('input', () => { obj[key] = ta.value; });
  wrap.appendChild(ta);
  return wrap;
}

function emptyCandidate(idx) {
  return {
    title: `Gap candidate ${idx}`,
    statement: '',
    evidence: [],
    research_question: '',
    external_validation_source: '',
    methodology_fit: '',
    hobby_project_test: '',
    indicators: Object.fromEntries(
      INDICATOR_DEFS.map((i) => [i.key, { verdict: '', justification: '' }])
    ),
    overall: '',
  };
}

const CANDIDATES_SYSTEM = `You are an academic literature-review synthesis assistant. You will see an aggregated summary of a corpus of papers and propose 5 to 10 gap candidates that the student's thesis could address. Output strictly valid JSON, no markdown, no explanation outside the JSON.`;

function buildCandidatesPrompt(summary, topicTitle, topicDesc) {
  return `Topic: ${topicTitle}
${topicDesc ? `Topic description: ${topicDesc}` : ''}

Corpus summary (${summary.count} papers):
- Categories: ${summary.categories.join(', ')}
- Method families: ${summary.methods.join(', ')}
- Matrix paper counts (cat|method → n): ${JSON.stringify(summary.matrix_counts)}
- Methodological flag counts: ${JSON.stringify(summary.flag_counts)}
- Relevance distribution: ${JSON.stringify(summary.relevance_distribution)}

Per-paper compact view (id, year, category, method family/specific, novelty, relevance, ground-truth source/external, quality flags, primary contribution, gaps the paper opens):
${JSON.stringify(summary.papers, null, 0).slice(0, 80000)}

Propose 5 to 10 gap candidates. Each gap must be a thesis-scale research question grounded in the corpus. Look for:
- Empty or sparse cells in the matrix.
- Cross-paper themes in the gaps_opened sections.
- Methodological gaps (high count of self-constructed ground truth means external validation is the gap).
- Domain transfer gaps (methodology shown in adjacent domain but not in this topic).

Output JSON of the form:

{
  "candidates": [
    {
      "title": "Short title",
      "statement": "One-sentence description of what the field has not addressed",
      "evidence": [{"paper_id": "001", "note": "what the paper does and does not cover"}, ...],
      "research_question": "A falsifiable question of the form 'does X outperform Y under Z' or equivalent",
      "external_validation_source": "Specific named source with estimated case count",
      "methodology_fit": "1-2 sentences on why the methodology fits and avoids circular ground truth",
      "hobby_project_test": "1 sentence on why the work cannot be done in a weekend"
    },
    ...
  ]
}`;
}

function parseCandidatesJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const obj = JSON.parse(match[0]);
    return Array.isArray(obj.candidates) ? obj.candidates : [];
  } catch {
    return [];
  }
}

const ASSESSMENT_SYSTEM = `You are an academic methodology reviewer. You will be given one gap candidate and a corpus summary. Apply the seven thesis quality indicators below. Output strictly valid JSON, no markdown.

Indicators:
1. demonstrated_gap: PASS if 50+ papers searched and gap maps to empty/sparse cell. PARTIAL if cell has 1-2 papers. FAIL if 3+ already address it.
2. literature_volume: PASS if 50+ in corpus and 15+ directly relevant. PARTIAL if 30-49 or <15 relevant. FAIL if <30.
3. scientific_value: PASS if outcome genuinely uncertain with plausible negative result. FAIL if predictable or comparison-table-only.
4. external_validation: PASS if specific external source named with 30+ reproducible cases. FAIL if self-constructed without anchor.
5. falsifiability_reproducibility: PASS if "does X outperform Y under Z" form with success/failure criteria. FAIL otherwise.
6. methodology_fit: PASS if methodology fits and ground truth is independent. FAIL if circular.
7. hobby_project_test: PASS if substantial sustained work with 2+ technical components. FAIL if weekend-doable.`;

function buildAssessmentPrompt(c, summary, topicTitle) {
  return `Topic: ${topicTitle}
Corpus: ${summary.count} papers, methodological flags ${JSON.stringify(summary.flag_counts)}.

Gap candidate:
- title: ${c.title}
- statement: ${c.statement}
- evidence: ${JSON.stringify(c.evidence || [])}
- research_question: ${c.research_question}
- external_validation_source: ${c.external_validation_source}
- methodology_fit: ${c.methodology_fit}
- hobby_project_test: ${c.hobby_project_test}

Output JSON of the form:

{
  "demonstrated_gap":            {"verdict": "PASS" | "PARTIAL" | "FAIL", "justification": "one short sentence"},
  "literature_volume":           {"verdict": "...", "justification": "..."},
  "scientific_value":            {"verdict": "...", "justification": "..."},
  "external_validation":         {"verdict": "...", "justification": "..."},
  "falsifiability_reproducibility": {"verdict": "...", "justification": "..."},
  "methodology_fit":             {"verdict": "...", "justification": "..."},
  "hobby_project_test":          {"verdict": "...", "justification": "..."}
}`;
}

function parseAssessmentJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}
