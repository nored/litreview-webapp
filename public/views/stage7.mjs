// Stage 7 (UI label "6. Positioning"): the positioning workflow,
// end-to-end. Three things live here now, in this order:
//
//   1. Candidates & shortlist. Generate gap candidates from the corpus,
//      score each against the seven indicators, produce a shortlist of
//      accept / refine / reject verdicts. (Used to live in stage 5;
//      stage 5 is now a read-only "corpus shape" view.)
//
//   2. Catalogue. Generate a multi-chapter thesis topic catalogue from
//      every accept/refine candidate. Each chapter streams in as the
//      LLM writes it. Citation coverage check after generation.
//
//   3. External AI handoff (ZIP, copy master prompt) — for when local
//      AI output is mediocre and you want to paste into Claude.ai or
//      ChatGPT directly.
//
// The two workflows share a state machine (`synthRun` for candidates,
// per-step progress for catalogue) but render into dedicated panel
// containers so AI runs don't trigger a full-page re-render. That fixes
// the "editor resets with every finished element" flicker the previous
// stage 5 had.

import { h } from '../lib/dom.mjs';
import * as llm from '../lib/llm.mjs';

const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

// ---------------------------------------------------------------------
// Module-level: indicators, prompts, helpers (no closure state)
// ---------------------------------------------------------------------

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

const CANDIDATES_SYSTEM = `You are an academic literature-review synthesis assistant. You will see an aggregated summary of a corpus of papers and propose 5 to 10 gap candidates that the student's thesis could address. Output strictly valid JSON, no markdown, no explanation outside the JSON.`;

const ASSESSMENT_SYSTEM = `You are an academic methodology reviewer. You will be given one gap candidate and a corpus summary. Apply the seven thesis quality indicators below. Output strictly valid JSON, no markdown.

Indicators:
1. demonstrated_gap: PASS if 50+ papers searched and gap maps to empty/sparse cell. PARTIAL if cell has 1-2 papers. FAIL if 3+ already address it.
2. literature_volume: PASS if 50+ in corpus and 15+ directly relevant. PARTIAL if 30-49 or <15 relevant. FAIL if <30.
3. scientific_value: PASS if outcome genuinely uncertain with plausible negative result. FAIL if predictable or comparison-table-only.
4. external_validation: PASS if specific external source named with 30+ reproducible cases. FAIL if self-constructed without anchor.
5. falsifiability_reproducibility: PASS if "does X outperform Y under Z" form with success/failure criteria. FAIL otherwise.
6. methodology_fit: PASS if methodology fits and ground truth is independent. FAIL if circular.
7. hobby_project_test: PASS if substantial sustained work with 2+ technical components. FAIL if weekend-doable.`;

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

function truncate(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

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

// ---------------------------------------------------------------------
// Stage 7 entry point
// ---------------------------------------------------------------------

export async function renderStage7(root) {
  root.innerHTML = '<h1>6. Positioning</h1><div class="placeholder">loading…</div>';

  let agg, state, savedMd, topicMd;
  try {
    [agg, state, savedMd, topicMd] = await Promise.all([
      fetch('/api/synthesis/aggregate').then((r) => r.json()),
      fetch('/api/synthesis/state').then((r) => r.json()),
      fetch('/api/catalogue/state').then((r) => r.json()).then((x) => x.markdown || ''),
      fetch('/api/protocol/topic').then((r) => r.json()).then((x) => x.content || ''),
    ]);
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['6. Positioning']));
    root.appendChild(h('div', { class: 'banner banner-warn' }, [err.message]));
    return;
  }

  const topicTitle = (topicMd.match(/title:\s*(.+)/) || [])[1]?.trim() || '';
  const topicDesc = ((topicMd.match(/description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/) || [])[1] || '')
    .split('\n').map((l) => l.replace(/^[ \t]{2}/, '')).join('\n').trim();

  if (agg.count === 0) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['6. Positioning']));
    root.appendChild(h('p', { class: 'lead' }, [
      'No notes yet. Complete some ', h('a', { href: '#/stage4' }, ['stage 4 deep reads']),
      ' first — positioning needs structured note frontmatter to score candidates against.',
    ]));
    return;
  }

  // ===== State =====
  let dirty = false;
  const synthRun = {
    running: false,
    cancelled: false,
    phase: '',
    stepIndex: 0,
    stepTotal: 0,
    currentLabel: '',
    error: '',
    started: 0,
  };
  let catalogueGen = {
    running: false,
    cancelled: false,
    step: 0,
    total: 0,
    label: '',
    started: 0,
  };
  // cataloguePieces is the per-chapter markdown. Loaded from savedMd if a
  // previous run wrote a catalogue to disk.
  const cataloguePieces = {
    state_of_art: '',
    topics: [],   // sized to bundle.candidates.length when bundle arrives
    topic_selection: '',
  };
  let bundle = null;       // catalogue bundle (re-fetched whenever shortlist changes)

  // ===== Layout =====
  root.innerHTML = '';
  root.appendChild(h('h1', {}, ['6. Positioning']));
  root.appendChild(h('p', { class: 'lead' }, [
    `Two steps, top-down: build a shortlist of viable thesis topics, then generate a catalogue chapter for each. `,
    `Corpus: ${agg.count} notes · topic: `,
    h('strong', {}, [topicTitle || '(unspecified)']),
  ]));

  // Dedicated panel containers — each panel updates its own slot so an
  // AI run doesn't trigger a full-page re-render. Cardrefs let us patch
  // a single candidate card in place when its verdicts come back.
  const panels = {
    candidatesPrimary: h('div'),
    shortlist: h('div'),
    indicatorSummary: h('div'),
    candidatesEditor: h('div'),
    candidatesAdvanced: h('div'),
    prisma: h('div'),
    positioning: h('div'),
    catalogueSummary: h('div'),
    catalogueGenerator: h('div'),
    catalogueOutput: h('div'),
    coverage: h('div'),
    handoff: h('div'),
  };
  // Saved positioning markdown — loaded once on init, edited in the
  // textarea, persisted back to /api/positioning/state.
  let savedPositioningMd = '';
  let positioningSelectedIdx = 0;  // which candidate to template from
  // Per-card DOM refs — keyed by candidate position. Lets us replace
  // just one card's element when its verdicts update.
  const cardRefs = new Map();

  // Slot anchor for re-rendering individual panels.
  root.appendChild(h('section', { class: 'stage-section', id: 'sec-candidates' }, [
    h('h2', { class: 'stage-section-title' }, ['1 · Candidates & shortlist']),
    panels.candidatesPrimary,
    panels.shortlist,
    panels.indicatorSummary,
    panels.candidatesEditor,
    panels.candidatesAdvanced,
  ]));
  root.appendChild(h('section', { class: 'stage-section', id: 'sec-prisma' }, [
    h('h2', { class: 'stage-section-title' }, ['2 · PRISMA flow']),
    panels.prisma,
  ]));
  root.appendChild(h('section', { class: 'stage-section', id: 'sec-positioning' }, [
    h('h2', { class: 'stage-section-title' }, ['3 · Positioning statement']),
    panels.positioning,
  ]));
  root.appendChild(h('section', { class: 'stage-section', id: 'sec-catalogue' }, [
    h('h2', { class: 'stage-section-title' }, ['4 · Catalogue']),
    panels.catalogueSummary,
    panels.catalogueGenerator,
    panels.catalogueOutput,
    panels.coverage,
  ]));
  root.appendChild(h('section', { class: 'stage-section', id: 'sec-handoff' }, [
    h('h2', { class: 'stage-section-title' }, ['5 · External AI handoff']),
    panels.handoff,
  ]));

  // ===== Save helpers =====

  function setDirty() { dirty = true; }

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
      console.error('synthesis save failed:', err);
    }
  }

  // ===== Granular patches (no full re-render) =====

  function patchPrimary() { panels.candidatesPrimary.replaceChildren(renderPrimaryPanel()); }
  function patchShortlist() {
    // Shortlist + indicator summary are the two read-only artifacts
    // that share the same source of truth (candidate verdicts), so
    // they patch together — saves call-site bookkeeping.
    panels.shortlist.replaceChildren(renderShortlistPanel());
    panels.indicatorSummary.replaceChildren(renderIndicatorSummary());
  }
  function patchCandidatesEditor() {
    panels.candidatesEditor.replaceChildren(renderCandidatesEditor());
  }
  function patchAdvanced() { panels.candidatesAdvanced.replaceChildren(renderAdvancedTools()); }
  function patchCard(idx) {
    const c = state.candidates[idx];
    const oldEl = cardRefs.get(idx);
    if (!c || !oldEl || !oldEl.isConnected) return;
    const newEl = renderCandidateCard(c, idx);
    oldEl.replaceWith(newEl);
    cardRefs.set(idx, newEl);
  }
  function patchCatalogueSummary() { panels.catalogueSummary.replaceChildren(renderCatalogueSummary()); }
  function patchCatalogueGenerator() { panels.catalogueGenerator.replaceChildren(renderCatalogueGenerator()); }
  function patchCatalogueOutput() { panels.catalogueOutput.replaceChildren(renderCatalogueOutput()); }
  function patchCoverage(report) { panels.coverage.replaceChildren(renderCoverage(report)); }

  // Full re-render only when structure changes (candidates added/removed,
  // shortlist verdicts shuffled the editor's order, etc.).
  function refreshAll() {
    patchPrimary();
    patchShortlist();
    patchCandidatesEditor();
    patchAdvanced();
    patchCatalogueSummary();
    patchCatalogueGenerator();
    patchCatalogueOutput();
  }

  // ===== Candidate workflow =====

  function countCandidates() {
    return {
      total: state.candidates.length,
      unscored: state.candidates.filter(isUnscored).length,
      accepted: state.candidates.filter((c) => c.overall === 'accept').length,
      refinable: state.candidates.filter((c) => c.overall === 'refine').length,
      rejected: state.candidates.filter((c) => c.overall === 'reject').length,
    };
  }
  function isUnscored(c) {
    return INDICATOR_DEFS.every((ind) => !c.indicators[ind.key]?.verdict);
  }
  function shortlistReady() {
    const cc = countCandidates();
    return (cc.accepted + cc.refinable) > 0;
  }

  function renderPrimaryPanel() {
    const cc = countCandidates();
    const llmReady = llm.isLoaded();

    const status = h('div', { class: 'synth-status' }, [
      h('span', { class: 'synth-status-pill' }, [
        h('strong', {}, [String(agg.count)]),
        h('span', { class: 'muted small' }, [' notes']),
      ]),
      h('span', { class: 'synth-status-sep' }, ['·']),
      h('span', { class: 'synth-status-pill' }, [
        h('strong', {}, [String(cc.total)]),
        h('span', { class: 'muted small' }, [' candidates']),
      ]),
      h('span', { class: 'synth-status-sep' }, ['·']),
      h('span', { class: 'synth-status-pill' }, [
        h('strong', { class: 'shortlist-accept-color' }, [String(cc.accepted)]),
        h('span', { class: 'muted small' }, [' accept']),
        h('span', { class: 'muted small' }, [` · ${cc.refinable} refine · ${cc.rejected} reject`]),
      ]),
    ]);

    const action = decidePrimaryAction(cc);
    const btn = h('button', {
      class: 'btn btn-ai btn-large',
      type: 'button',
      disabled: !llmReady || synthRun.running || action.disabled,
      title: !llmReady
        ? 'Configure an AI provider in the topbar first'
        : (action.tooltip || ''),
      onclick: action.fn || (() => {}),
    }, [action.label]);

    const progressHost = h('div', { class: 'synth-progress-host' });
    renderProgressStrip(progressHost);

    return h('div', { class: 'panel synth-primary-panel' }, [
      status,
      h('div', { class: 'synth-primary-action' }, [
        btn,
        action.subtext
          ? h('div', { class: 'small muted synth-primary-subtext' }, [action.subtext])
          : null,
      ]),
      progressHost,
    ]);
  }

  function decidePrimaryAction(cc) {
    if (cc.total === 0) {
      return {
        label: '✨ Build my shortlist',
        subtext: 'One click: seed candidates from corpus limitations, ask the model for fresh ones, then assess every candidate against the seven indicators. Catalogue generation lives below.',
        fn: () => buildShortlistAuto(),
      };
    }
    if (cc.unscored > 0) {
      return {
        label: `✨ Score ${cc.unscored} unscored candidate${cc.unscored === 1 ? '' : 's'}`,
        subtext: 'Existing candidates need verdicts. Run the indicator assessment.',
        fn: () => assessUnscored(state.candidates.filter(isUnscored)),
      };
    }
    if (!shortlistReady()) {
      return {
        label: 'All candidates rejected · override or generate more',
        subtext: 'Every candidate scored as reject. Override a verdict in the editor below, or open Advanced tools and click "Generate more candidates".',
        disabled: true,
      };
    }
    return {
      label: '✓ Shortlist ready — see catalogue section below',
      subtext: 'Step 1 complete. Scroll to "2 · Catalogue" to generate the chapters.',
      disabled: true,
    };
  }

  async function buildShortlistAuto() {
    if (synthRun.running) return;
    if (!llm.isLoaded()) { alert('Configure an AI provider first'); return; }
    try {
      const r = await fetch('/api/synthesis/limitations?scope=include').then((res) => res.json());
      if (r.clusters) {
        const recurring = r.clusters.filter((c) => !c.singleton);
        for (const c of recurring) {
          state.candidates.push({
            ...emptyCandidate(state.candidates.length + 1),
            title: `Gap: ${truncate(c.central_text, 60)}`,
            statement: `Recurring limitation across ${c.paper_count} included papers: "${c.central_text}". This represents an unaddressed gap acknowledged by the corpus itself.`,
            evidence: c.sample_limitations.slice(0, 5).map((s) => ({
              paper_id: s.paper_id, note: s.text,
            })),
          });
        }
        if (recurring.length > 0) {
          setDirty();
          await saveStateNow();
        }
      }
    } catch { /* silent */ }
    await generateAndAssessAll();
  }

  function renderProgressStrip(host) {
    host.innerHTML = '';
    if (!synthRun.running && !synthRun.error && synthRun.phase !== 'done') return;
    const pct = synthRun.stepTotal > 0 ? Math.round((synthRun.stepIndex / synthRun.stepTotal) * 100) : 0;
    if (synthRun.phase === 'done') {
      const cc = countCandidates();
      host.appendChild(h('div', { class: 'banner banner-success synth-progress-strip' }, [
        h('strong', {}, ['Step 1 done. ']),
        ` ${cc.accepted} accepted · ${cc.refinable} refinable · ${cc.rejected} rejected. `,
        h('span', { class: 'small muted' }, ['Section 2 below is now active.']),
        h('button', { class: 'btn btn-ghost', type: 'button',
          style: { marginLeft: 'auto' },
          onclick: () => { synthRun.phase = ''; patchPrimary(); },
        }, ['Dismiss']),
      ]));
      return;
    }
    if (synthRun.error) {
      host.appendChild(h('div', { class: 'banner banner-error synth-progress-strip' }, [
        h('strong', {}, ['Failed: ']), synthRun.error,
        h('button', { class: 'btn btn-ghost', type: 'button',
          style: { marginLeft: 'auto' },
          onclick: () => { synthRun.error = ''; patchPrimary(); },
        }, ['Dismiss']),
      ]));
      return;
    }
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
    if (!llm.isLoaded()) { alert('Configure an AI provider first'); return; }
    synthRun.running = true;
    synthRun.cancelled = false;
    synthRun.phase = 'generating';
    synthRun.stepIndex = 0;
    synthRun.stepTotal = 1;
    synthRun.currentLabel = 'pulling corpus summary…';
    synthRun.error = '';
    synthRun.started = Date.now();
    patchPrimary();

    let summary;
    try {
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
      const startIdx = state.candidates.length;
      for (const c of candidates) {
        state.candidates.push({ ...emptyCandidate(state.candidates.length + 1), ...c });
      }
      setDirty();
      patchCandidatesEditor();   // structure changed: new cards appeared

      synthRun.phase = 'assessing';
      synthRun.stepIndex = 1;
      synthRun.stepTotal = 1 + candidates.length;
      patchPrimary();

      for (let i = 0; i < candidates.length; i++) {
        if (synthRun.cancelled) break;
        const cardIdx = startIdx + i;
        const c = state.candidates[cardIdx];
        synthRun.stepIndex = 1 + i;
        synthRun.currentLabel = `${i + 1}/${candidates.length}: ${c.title || '(untitled)'}`;
        patchPrimary();

        try {
          const aText = await llm.chat({
            system: ASSESSMENT_SYSTEM,
            user: buildAssessmentPrompt(c, summary, topicTitle),
            temperature: 0.2,
          });
          const verdicts = parseAssessmentJson(aText);
          for (const ind of INDICATOR_DEFS) {
            if (verdicts[ind.key]) c.indicators[ind.key] = verdicts[ind.key];
          }
          setDirty();
          await saveStateNow();
          patchCard(cardIdx);     // patch only this one card — no flicker
          patchShortlist();       // shortlist count may have changed
        } catch (err) {
          console.error('assess failed for', c.title, err);
        }
      }
      synthRun.stepIndex = synthRun.stepTotal;
      synthRun.phase = 'done';
    } catch (err) {
      synthRun.error = err.message || String(err);
      synthRun.phase = '';
    } finally {
      synthRun.running = false;
      synthRun.cancelled = false;
      patchPrimary();
      patchShortlist();
      // Catalogue summary depends on the shortlist — refresh it so the
      // chapter count + topic preview is current.
      await refreshBundleAndCatalogue();
    }
  }

  async function assessUnscored(targets) {
    if (synthRun.running || !targets?.length) return;
    if (!llm.isLoaded()) { alert('Configure an AI provider first'); return; }
    synthRun.running = true;
    synthRun.cancelled = false;
    synthRun.phase = 'assessing';
    synthRun.stepIndex = 0;
    synthRun.stepTotal = targets.length;
    synthRun.currentLabel = 'pulling corpus summary…';
    synthRun.error = '';
    synthRun.started = Date.now();
    patchPrimary();

    try {
      const summary = await fetch('/api/synthesis/llm-summary').then((r) => r.json());
      for (let i = 0; i < targets.length; i++) {
        if (synthRun.cancelled) break;
        const c = targets[i];
        synthRun.stepIndex = i + 1;
        synthRun.currentLabel = `${i + 1}/${targets.length}: ${c.title || '(untitled)'}`;
        patchPrimary();
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
          // Patch the specific card by reference. targets[i] is the same
          // object reference as state.candidates[idx], so locate index.
          const idx = state.candidates.indexOf(c);
          if (idx >= 0) patchCard(idx);
          patchShortlist();
        } catch (err) {
          console.error('assess failed for', c.title, err);
        }
      }
      synthRun.phase = 'done';
    } catch (err) {
      synthRun.error = err.message || String(err);
      synthRun.phase = '';
    } finally {
      synthRun.running = false;
      synthRun.cancelled = false;
      patchPrimary();
      patchShortlist();
      await refreshBundleAndCatalogue();
    }
  }

  async function assessCandidate(c, idx) {
    if (!llm.isLoaded()) { alert('Configure an AI provider first'); return; }
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
      patchCard(idx);
      patchShortlist();
      patchPrimary();
      await refreshBundleAndCatalogue();
    } catch (err) {
      alert('Assess failed: ' + err.message);
    }
  }

  async function seedFromLimitations() {
    try {
      const r = await fetch('/api/synthesis/limitations?scope=include').then((res) => res.json());
      if (r.error) throw new Error(r.error);
      const recurring = (r.clusters || []).filter((c) => !c.singleton);
      if (!recurring.length) {
        alert(r.total_limitations === 0
          ? 'No "stated limitations" filled in your note frontmatter yet — nothing to seed from.'
          : `Found ${r.total_limitations} limitations but no recurring clusters (≥2 papers). Singletons skipped.`);
        return;
      }
      for (const c of recurring) {
        state.candidates.push({
          ...emptyCandidate(state.candidates.length + 1),
          title: `Gap: ${truncate(c.central_text, 60)}`,
          statement: `Recurring limitation across ${c.paper_count} included papers: "${c.central_text}". This represents an unaddressed gap acknowledged by the corpus itself.`,
          evidence: c.sample_limitations.slice(0, 5).map((s) => ({
            paper_id: s.paper_id,
            note: s.text,
          })),
        });
      }
      setDirty();
      await saveStateNow();
      patchCandidatesEditor();
      patchPrimary();
    } catch (err) {
      alert('Seed from limitations failed: ' + err.message);
    }
  }

  // ===== Shortlist + editor + advanced =====

  function renderShortlistPanel() {
    const cc = countCandidates();
    if (cc.total === 0) return h('div');
    const wrap = h('div', { class: 'panel synth-shortlist-panel' });
    wrap.appendChild(h('h3', {}, ['Shortlist']));
    const accepted = state.candidates.filter((c) => c.overall === 'accept');
    const refinable = state.candidates.filter((c) => c.overall === 'refine');
    const rejected = state.candidates.filter((c) => c.overall === 'reject');
    if (accepted.length === 0 && refinable.length === 0 && rejected.length === 0) {
      wrap.appendChild(h('p', { class: 'muted small' }, [
        'Candidates exist but none have verdicts yet. Click the primary button above, or assign verdicts manually in the editor below.',
      ]));
      return wrap;
    }
    const list = h('div', { class: 'shortlist-list' });
    function group(label, items, kind) {
      if (!items.length) return;
      list.appendChild(h('h3', { class: 'shortlist-heading shortlist-' + kind }, [
        `${label} (${items.length})`,
      ]));
      items.forEach((c, i) => list.appendChild(h('div', { class: 'shortlist-row shortlist-' + kind }, [
        h('strong', {}, [`${i + 1}. ${c.title || '(untitled)'}`]),
        c.research_question ? ` — ${c.research_question}` : '',
      ])));
    }
    group('Accepted', accepted, 'accept');
    group('Refinable', refinable, 'refine');
    group('Rejected', rejected, 'reject');
    wrap.appendChild(list);
    return wrap;
  }

  // Read-only indicator scorecard, one row per candidate × seven
  // indicator columns + overall. Same data as the per-candidate editor
  // below but flattened into a single auditable table — supervisor can
  // see the whole picture without opening each card.
  function renderIndicatorSummary() {
    const cc = countCandidates();
    // Only render if there's at least one candidate AND at least one
    // candidate has a verdict — empty table is noise.
    if (cc.total === 0) return h('div');
    const hasAnyVerdict = state.candidates.some((c) =>
      INDICATOR_DEFS.some((ind) => c.indicators?.[ind.key]?.verdict),
    );
    if (!hasAnyVerdict) return h('div');

    const wrap = h('div', { class: 'panel synth-panel indicator-summary-panel' });
    wrap.appendChild(h('h3', {}, ['Indicator scorecard']));

    // Aggregate counts header so the supervisor sees totals at a glance.
    let totalPass = 0, totalPartial = 0, totalFail = 0;
    for (const c of state.candidates) {
      for (const ind of INDICATOR_DEFS) {
        const v = c.indicators?.[ind.key]?.verdict;
        if (v === 'PASS') totalPass++;
        else if (v === 'PARTIAL') totalPartial++;
        else if (v === 'FAIL') totalFail++;
      }
    }
    wrap.appendChild(h('p', { class: 'small muted' }, [
      `${totalPass} PASS · ${totalPartial} PARTIAL · ${totalFail} FAIL across ${cc.total} candidate${cc.total === 1 ? '' : 's'} × 7 indicators. `,
      'Hover any chip for the justification. Edit verdicts in the candidate editor below.',
    ]));

    const table = h('table', { class: 'indicator-summary-table' });

    // Short labels for the seven indicators — full names are too wide
    // for a horizontal row.
    const SHORT_LABELS = {
      demonstrated_gap: 'Gap',
      literature_volume: 'Volume',
      scientific_value: 'Value',
      external_validation: 'Ext. val.',
      falsifiability_reproducibility: 'Falsif.',
      methodology_fit: 'Methods',
      hobby_project_test: 'Hobby',
    };

    const thead = h('thead');
    const headerRow = h('tr', {}, [
      h('th', { class: 'isum-candidate-col' }, ['Candidate']),
      ...INDICATOR_DEFS.map((ind) => h('th', {
        class: 'isum-indicator-head',
        title: ind.rule,
      }, [
        h('span', { class: 'small muted' }, [`${ind.id}.`]),
        ' ',
        SHORT_LABELS[ind.key] || ind.label,
      ])),
      h('th', { class: 'isum-overall-col' }, ['Overall']),
    ]);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = h('tbody');
    state.candidates.forEach((c, idx) => {
      const row = h('tr');
      row.appendChild(h('td', { class: 'isum-candidate' }, [
        h('span', { class: 'paper-id-pill' }, [`#${idx + 1}`]),
        h('strong', {}, [' ' + (c.title || '(untitled)').slice(0, 80)]),
      ]));
      for (const ind of INDICATOR_DEFS) {
        const v = c.indicators?.[ind.key] || { verdict: '', justification: '' };
        const verdictClass = v.verdict ? v.verdict.toLowerCase() : 'none';
        row.appendChild(h('td', { class: 'isum-cell' }, [
          h('span', {
            class: `isum-chip isum-chip-${verdictClass}`,
            title: v.justification || `${ind.label} — ${ind.rule}`,
          }, [v.verdict || '—']),
        ]));
      }
      const overall = c.overall || '';
      row.appendChild(h('td', { class: 'isum-overall' }, [
        h('span', { class: 'badge badge-' + (overall || 'pending') }, [overall || 'pending']),
      ]));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);

    const tableWrap = h('div', { class: 'isum-table-wrap' }, [table]);
    wrap.appendChild(tableWrap);
    return wrap;
  }

  function renderCandidatesEditor() {
    const cc = countCandidates();
    const hasShortlist = (cc.accepted + cc.refinable + cc.rejected) > 0;
    const wrap = h('details', {
      class: 'panel synth-panel synth-editor-panel',
      open: !hasShortlist && cc.total > 0 ? true : false,
    });
    wrap.appendChild(h('summary', {}, [
      h('h3', {}, [`Candidate editor · ${cc.total}`]),
      h('span', { class: 'small muted summary-hint' }, [
        cc.total === 0
          ? ' (empty — use the button above to populate)'
          : (hasShortlist ? ' (click to expand and edit)' : ' (review the generated drafts)'),
      ]),
    ]));
    if (cc.total === 0) {
      wrap.appendChild(h('p', { class: 'muted small' }, [
        'No candidates yet. The big button above generates them.',
      ]));
      return wrap;
    }
    cardRefs.clear();
    state.candidates.forEach((c, i) => {
      const el = renderCandidateCard(c, i);
      cardRefs.set(i, el);
      wrap.appendChild(el);
    });
    return wrap;
  }

  function renderCandidateCard(c, idx) {
    const card = h('div', { class: 'candidate-card overall-' + (c.overall || 'pending') });
    const title = h('input', { type: 'text', value: c.title || '', class: 'candidate-title', placeholder: 'Short title' });
    title.addEventListener('input', () => { c.title = title.value; setDirty(); });

    const remove = h('button', { class: 'btn btn-ghost', type: 'button',
      onclick: async () => {
        if (!confirm('Remove this candidate?')) return;
        state.candidates.splice(idx, 1);
        setDirty();
        await saveStateNow();
        patchCandidatesEditor();
        patchShortlist();
        patchPrimary();
        await refreshBundleAndCatalogue();
      },
    }, ['Remove']);

    card.appendChild(h('div', { class: 'candidate-header' }, [
      h('span', { class: 'paper-id-pill' }, [`#${idx + 1}`]),
      title,
      h('span', { class: 'candidate-overall' }, [c.overall || 'unassessed']),
      remove,
    ]));

    card.appendChild(textareaField('Statement (one sentence)', c, 'statement'));

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

    const assessBtn = h('button', { class: 'btn btn-ai', type: 'button',
      disabled: !llm.isLoaded(),
      onclick: () => assessCandidate(c, idx),
    }, ['✨ Assess against indicators']);
    card.appendChild(h('div', { class: 'candidate-field' }, [assessBtn]));

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
      verdictSelect.addEventListener('change', async () => {
        c.indicators[ind.key] = c.indicators[ind.key] || {};
        c.indicators[ind.key].verdict = verdictSelect.value;
        setDirty();
        row.className = 'verdict-row verdict-' + (verdictSelect.value || 'none');
        await saveStateNow();
        patchShortlist();
        patchPrimary();
        // Update overall on the card header
        const overallSpan = card.querySelector('.candidate-overall');
        const updated = state.candidates[idx];
        if (overallSpan && updated) overallSpan.textContent = updated.overall || 'unassessed';
        card.className = 'candidate-card overall-' + (updated?.overall || 'pending');
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

  function renderAdvancedTools() {
    const cc = countCandidates();
    const wrap = h('details', { class: 'panel synth-panel synth-advanced-panel' });
    wrap.appendChild(h('summary', {}, [
      h('h3', {}, ['Advanced tools']),
      h('span', { class: 'small muted summary-hint' }, [
        ' — manual editing, regeneration, seeding from limitations',
      ]),
    ]));

    const actions = h('div', { class: 'panel-actions advanced-actions' });
    actions.appendChild(h('button', {
      class: 'btn', type: 'button',
      disabled: !llm.isLoaded() || synthRun.running,
      onclick: () => generateAndAssessAll(),
    }, [cc.total === 0 ? '✨ Generate & assess' : '✨ Generate more candidates']));
    actions.appendChild(h('button', {
      class: 'btn', type: 'button',
      disabled: synthRun.running,
      onclick: () => seedFromLimitations(),
    }, ['↳ Seed from corpus limitations']));
    actions.appendChild(h('button', {
      class: 'btn', type: 'button',
      disabled: synthRun.running,
      onclick: async () => {
        state.candidates.push(emptyCandidate(state.candidates.length + 1));
        setDirty();
        await saveStateNow();
        patchCandidatesEditor();
        patchPrimary();
      },
    }, ['+ Add manual candidate']));
    if (cc.total > 0) {
      actions.appendChild(h('button', {
        class: 'btn', type: 'button',
        disabled: !llm.isLoaded() || synthRun.running,
        onclick: () => assessUnscored(state.candidates),
      }, ['↻ Re-score everything']));
    }
    wrap.appendChild(actions);
    return wrap;
  }

  // ===== PRISMA flow panel =====

  async function loadPrisma() {
    panels.prisma.replaceChildren(h('div', { class: 'placeholder' }, ['computing PRISMA numbers…']));
    try {
      const resp = await fetch('/api/positioning/prisma').then((r) => r.json());
      if (resp.error) throw new Error(resp.error);
      panels.prisma.replaceChildren(renderPrismaFlow(resp.numbers || resp, resp.methodology_template));
    } catch (err) {
      panels.prisma.replaceChildren(h('div', { class: 'panel synth-panel' }, [
        h('p', { class: 'error-text small' }, ['PRISMA numbers unavailable: ' + err.message]),
      ]));
    }
  }

  function renderPrismaFlow(n, methodologyTemplate) {
    const panel = h('div', { class: 'panel synth-panel' });
    panel.appendChild(h('p', { class: 'small muted' }, [
      'Reporting flow from search → screening → eligibility → inclusion. ',
      'These numbers go into the catalogue\'s methodology paragraph and into the supervisor handoff.',
    ]));
    panel.appendChild(prismaFlowDiagram(n));

    // Top exclusion reasons surfaced inline — useful for the methodology
    // section and for spotting biased exclusion patterns.
    if (Array.isArray(n.top_exclusion_reasons) && n.top_exclusion_reasons.length > 0) {
      panel.appendChild(h('div', { class: 'prisma-reasons-block' }, [
        h('div', { class: 'note-field-label' }, ['Top exclusion reasons']),
        h('ul', { class: 'prisma-reasons-list small' },
          n.top_exclusion_reasons.map((r) => h('li', {}, [
            h('strong', {}, [String(r.count)]),
            ' · ',
            r.reason || '(unspecified)',
          ])),
        ),
      ]));
    }

    // Ready-to-paste methodology paragraph. The server templates it
    // from the same numbers, so it stays in sync without an LLM call.
    if (methodologyTemplate) {
      const copyStatus = h('span', { class: 'small muted' });
      const copyBtn = h('button', { class: 'btn btn-ghost', type: 'button',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(methodologyTemplate);
            copyStatus.textContent = 'copied';
            copyStatus.className = 'small hint-good';
          } catch (e) {
            copyStatus.textContent = 'copy failed: ' + e.message;
            copyStatus.className = 'small error-text';
          }
        },
      }, ['📋 Copy']);
      panel.appendChild(h('div', { class: 'prisma-methodology-block' }, [
        h('div', { class: 'note-field-label' }, ['Methodology paragraph (drop into thesis)']),
        h('div', { class: 'prisma-methodology-text' }, [methodologyTemplate]),
        h('div', { class: 'panel-actions' }, [copyBtn, copyStatus]),
      ]));
    }
    return panel;
  }

  function prismaFlowDiagram(n) {
    const wrap = h('div', { class: 'prisma-flow' });
    wrap.appendChild(prismaBox({
      kind: 'main', label: 'Identification',
      number: n.records_identified,
      unit: 'records identified',
      detail: `from ${n.queries_run} database quer${n.queries_run === 1 ? 'y' : 'ies'}` +
              (n.manual_additions ? ` · +${n.manual_additions} manual addition${n.manual_additions === 1 ? '' : 's'}` : ''),
    }));
    wrap.appendChild(prismaArrow());
    wrap.appendChild(prismaBox({
      kind: 'main', label: 'After deduplication',
      number: n.after_dedup,
      unit: 'unique records',
    }));
    wrap.appendChild(prismaArrow());
    wrap.appendChild(h('div', { class: 'prisma-split' }, [
      prismaBox({
        kind: 'main', label: 'Screening',
        number: n.screened,
        unit: 'records screened',
      }),
      h('div', { class: 'prisma-side-wrap' }, [
        h('div', { class: 'prisma-side-arrow' }, ['→']),
        prismaBox({
          kind: 'exclude', label: 'Excluded at screening',
          number: n.excluded_at_screening,
          unit: 'records',
        }),
      ]),
    ]));
    wrap.appendChild(prismaArrow());
    wrap.appendChild(h('div', { class: 'prisma-split' }, [
      prismaBox({
        kind: 'main', label: 'Eligibility',
        number: n.full_text_assessed,
        unit: 'full-text articles assessed',
      }),
      h('div', { class: 'prisma-side-wrap' }, [
        h('div', { class: 'prisma-side-arrow' }, ['→']),
        prismaBox({
          kind: 'exclude', label: 'Full-text unavailable',
          number: n.full_text_unavailable,
          unit: 'records',
        }),
      ]),
    ]));
    wrap.appendChild(prismaArrow());
    wrap.appendChild(prismaBox({
      kind: 'included', label: 'Included in qualitative synthesis',
      number: n.studies_in_synthesis,
      unit: `stud${n.studies_in_synthesis === 1 ? 'y' : 'ies'}`,
      detail: `${n.notes_written} structured note${n.notes_written === 1 ? '' : 's'} written`,
    }));
    return wrap;
  }

  function prismaBox({ kind, label, number, unit, detail }) {
    return h('div', { class: `prisma-box prisma-box-${kind}` }, [
      h('div', { class: 'prisma-box-label' }, [label]),
      h('div', { class: 'prisma-box-number' }, [String(number || 0)]),
      h('div', { class: 'prisma-box-unit' }, [unit || '']),
      detail ? h('div', { class: 'prisma-box-detail small muted' }, [detail]) : null,
    ]);
  }

  function prismaArrow() {
    return h('div', { class: 'prisma-arrow' }, ['↓']);
  }

  // ===== Positioning statement panel =====
  // The CLI template's stage-7 deliverable: a structured 1-pager that
  // captures the chosen topic in supervisor-presentable form. The web
  // catalogue covers every viable topic; the positioning statement is
  // the focused commitment ("here's the one I'm pursuing and why").
  //
  // Implementation: the student picks one accept/refinable candidate
  // from a dropdown; we templated the structured markdown from existing
  // data (no LLM). They edit, save, and the markdown lives at
  // synthesis/positioning_statement.md.

  function patchPositioning() {
    panels.positioning.replaceChildren(renderPositioningPanel());
  }

  function renderPositioningPanel() {
    if (!bundle || !bundle.candidates?.length) {
      return h('div', { class: 'panel synth-panel' }, [
        h('p', { class: 'muted small' }, [
          'Positioning statement becomes available once your shortlist has at least one accept or refine candidate (see section 1).',
        ]),
      ]);
    }

    const wrap = h('div', { class: 'panel synth-panel positioning-panel' });
    wrap.appendChild(h('p', { class: 'small muted' }, [
      'Pick the candidate you\'re committing to. We auto-fill a structured statement from existing data — topic, gap, RQ, methodology, indicator verdicts. Edit freely, then save. Output lives at ',
      h('code', {}, ['synthesis/positioning_statement.md']), '.',
    ]));

    // Candidate dropdown — accept + refine candidates only.
    const select = h('select', { class: 'positioning-candidate-select' });
    bundle.candidates.forEach((c, i) => {
      const label = `#${i + 1} · [${c.overall || 'unscored'}] ${(c.title || '(untitled)').slice(0, 90)}`;
      const opt = h('option', { value: String(i) }, [label]);
      if (i === positioningSelectedIdx) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      positioningSelectedIdx = Number(select.value) || 0;
    });

    const fillBtn = h('button', { class: 'btn btn-ai', type: 'button',
      onclick: () => {
        const c = bundle.candidates[positioningSelectedIdx];
        if (!c) return;
        const md = templatePositioningStatement(c, bundle);
        positioningTa.value = md;
      },
    }, ['✨ Auto-fill template from selected candidate']);

    const toolbar = h('div', { class: 'panel-actions' }, [
      h('label', { class: 'small muted' }, [
        h('span', {}, ['Candidate: ']),
        select,
      ]),
      fillBtn,
    ]);
    wrap.appendChild(toolbar);

    const positioningTa = h('textarea', {
      class: 'positioning-textarea',
      rows: 26,
      placeholder: 'Click "Auto-fill template" above to populate, or paste your own markdown.',
    });
    positioningTa.value = savedPositioningMd || '';
    wrap.appendChild(positioningTa);

    const saveStatus = h('span', { class: 'small muted' });
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button',
      onclick: async () => {
        const md = positioningTa.value;
        saveStatus.textContent = 'saving…';
        try {
          const r = await fetch('/api/positioning/state', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ statement: md }),
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          savedPositioningMd = md;
          saveStatus.textContent = `saved (${md.length.toLocaleString()} chars)`;
          saveStatus.className = 'small hint-good';
        } catch (err) {
          saveStatus.textContent = 'save failed: ' + err.message;
          saveStatus.className = 'small error-text';
        }
      },
    }, ['Save positioning statement']);
    const copyBtn = h('button', { class: 'btn', type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(positioningTa.value);
          saveStatus.textContent = 'copied to clipboard';
          saveStatus.className = 'small hint-good';
        } catch (e) {
          saveStatus.textContent = 'copy failed: ' + e.message;
          saveStatus.className = 'small error-text';
        }
      },
    }, ['📋 Copy']);
    wrap.appendChild(h('div', { class: 'panel-actions' }, [saveBtn, copyBtn, saveStatus]));
    return wrap;
  }

  async function loadPositioning() {
    try {
      const r = await fetch('/api/positioning/state').then((res) => res.json());
      savedPositioningMd = r?.statement || '';
    } catch { /* silent */ }
    patchPositioning();
  }

  // ===== Catalogue panel =====

  async function refreshBundleAndCatalogue() {
    try {
      bundle = await fetch('/api/catalogue/bundle').then((r) => r.json());
      if (bundle.error) {
        bundle = null;
      } else {
        // Resize cataloguePieces.topics to match the new candidate set.
        if (cataloguePieces.topics.length !== (bundle.candidates?.length || 0)) {
          cataloguePieces.topics = (bundle.candidates || []).map(() => '');
        }
      }
    } catch (err) {
      bundle = null;
      console.warn('bundle fetch failed:', err.message);
    }
    patchCatalogueSummary();
    patchCatalogueGenerator();
    patchCatalogueOutput();
    patchPositioning();
  }

  function renderCatalogueSummary() {
    if (!bundle || !bundle.candidates?.length) {
      return h('div', { class: 'panel synth-panel' }, [
        h('p', { class: 'muted small' }, [
          'Catalogue generation activates once your shortlist has at least one accept or refine verdict.',
        ]),
      ]);
    }
    return h('div', { class: 'panel synth-panel' }, [
      h('h3', {}, ['What will be generated']),
      h('div', { class: 'catalogue-summary' }, [
        stat(bundle.corpus_summary.total_papers, 'notes (corpus)'),
        stat(bundle.candidates.length, 'topic chapters'),
        stat(bundle.papers.length, 'references (auto-generated)'),
        stat(bundle.prisma.records_identified, 'records (PRISMA)'),
      ]),
      h('div', { class: 'topic-preview-list' }, [
        h('div', { class: 'note-field-label' }, ['Topic chapters that will be drafted:']),
        ...bundle.candidates.map((c, i) => h('div', { class: 'topic-preview-row' }, [
          h('span', { class: 'paper-id-pill' }, [`#${i + 1}`]),
          h('span', { class: 'badge badge-' + c.overall }, [c.overall]),
          h('strong', {}, [c.title || '(untitled)']),
          c.research_question
            ? h('div', { class: 'small muted topic-preview-q' }, [c.research_question])
            : null,
        ])),
      ]),
    ]);
  }

  function renderCatalogueGenerator() {
    if (!bundle || !bundle.candidates?.length) return h('div');
    const totalSteps = 1 + bundle.candidates.length + 1;
    const wrap = h('div', { class: 'panel synth-panel' });
    wrap.appendChild(h('h3', {}, ['Generate']));
    const progressHost = h('div', { class: 'synth-progress-host' });
    const generateBtn = h('button', {
      class: 'btn btn-ai btn-large', type: 'button',
      disabled: !llm.isLoaded() || catalogueGen.running,
      title: llm.isLoaded() ? '' : 'Configure an AI provider in the topbar',
      onclick: () => generateCatalogue(progressHost),
    }, [catalogueGen.running ? '… generating' : `✨ Generate catalogue (${totalSteps} chapters)`]);
    wrap.appendChild(generateBtn);
    wrap.appendChild(progressHost);
    renderCatalogueProgress(progressHost);
    return wrap;
  }

  function renderCatalogueProgress(host) {
    host.innerHTML = '';
    if (!catalogueGen.running && catalogueGen.step === 0) return;
    const pct = catalogueGen.total > 0 ? Math.round((catalogueGen.step / catalogueGen.total) * 100) : 0;
    const elapsed = (Date.now() - catalogueGen.started) / 1000;
    const rate = catalogueGen.step > 0 ? elapsed / catalogueGen.step : 0;
    const remaining = rate * (catalogueGen.total - catalogueGen.step);
    const eta = remaining > 60 ? `${Math.round(remaining / 60)} min` : `${Math.round(remaining)} s`;
    host.appendChild(h('div', { class: 'batch-strip synth-progress-strip' }, [
      h('div', { class: 'batch-info' }, [
        h('strong', {}, [`Chapter ${catalogueGen.step} / ${catalogueGen.total}`]),
        ' · ',
        h('span', { class: 'muted small' }, [
          catalogueGen.label || '',
          catalogueGen.step > 0 && catalogueGen.running ? ` · eta ~${eta}` : '',
        ]),
      ]),
      h('div', { class: 'batch-progress' }, [
        h('div', { class: 'batch-progress-bar', style: { width: `${pct}%` } }),
      ]),
      catalogueGen.running
        ? h('button', { class: 'btn btn-ghost', type: 'button',
            onclick: () => { catalogueGen.cancelled = true; },
          }, ['Cancel'])
        : null,
    ]));
  }

  function renderCatalogueOutput() {
    if (!bundle || !bundle.candidates?.length) return h('div');
    const wrap = h('div', { class: 'panel synth-panel' });
    wrap.appendChild(h('h3', {}, ['Catalogue (markdown)']));
    wrap.appendChild(h('p', { class: 'small muted' }, [
      'The generated chapters appear here. Edit freely. Save writes ',
      h('code', {}, ['synthesis/catalogue.md']), '.',
    ]));
    const catalogueTa = h('textarea', {
      rows: 24, class: 'catalogue-textarea',
      placeholder: 'Click Generate above, or paste an external-AI response here.',
    });
    catalogueTa.value = savedMd || compileCatalogue(bundle, cataloguePieces);
    wrap.appendChild(catalogueTa);
    const saveStatus = h('span', { class: 'small muted' });
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button',
      onclick: async () => {
        const md = catalogueTa.value;
        saveStatus.textContent = 'saving…';
        try {
          const r = await fetch('/api/catalogue/state', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markdown: md }),
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          savedMd = md;
          saveStatus.textContent = `saved (${md.length.toLocaleString()} chars)`;
          saveStatus.className = 'small hint-good';
        } catch (err) {
          saveStatus.textContent = 'save failed: ' + err.message;
          saveStatus.className = 'small error-text';
        }
      },
    }, ['Save catalogue']);
    const checkCoverageBtn = h('button', { class: 'btn', type: 'button',
      onclick: () => runCoverage(catalogueTa.value),
    }, ['Check citation coverage']);
    wrap.appendChild(h('div', { class: 'panel-actions' }, [saveBtn, checkCoverageBtn, saveStatus]));

    // Wire the streaming target so generation updates this textarea in place.
    bundle._textareaRef = catalogueTa;
    return wrap;
  }

  async function generateCatalogue(progressHost) {
    if (!bundle || catalogueGen.running) return;
    if (!llm.isLoaded()) { alert('Configure an AI provider first'); return; }
    catalogueGen = {
      running: true,
      cancelled: false,
      step: 0,
      total: 1 + bundle.candidates.length + 1,
      label: 'starting…',
      started: Date.now(),
    };
    renderCatalogueProgress(progressHost);

    const updateDisplay = () => {
      const md = compileCatalogue(bundle, cataloguePieces);
      if (bundle._textareaRef) bundle._textareaRef.value = md;
    };

    try {
      catalogueGen.step = 1;
      catalogueGen.label = 'state of the art';
      renderCatalogueProgress(progressHost);
      cataloguePieces.state_of_art = await llm.chat({
        system: bundle.system_prompt,
        user: stateOfArtPrompt(bundle),
        temperature: 0.4,
        onToken: (_d, full) => { cataloguePieces.state_of_art = full; updateDisplay(); },
      });
      updateDisplay();

      for (let i = 0; i < bundle.candidates.length; i++) {
        if (catalogueGen.cancelled) break;
        catalogueGen.step = 2 + i;
        catalogueGen.label = `topic ${i + 1}/${bundle.candidates.length}: ${bundle.candidates[i].title || '(untitled)'}`;
        renderCatalogueProgress(progressHost);
        const topicMdOut = await llm.chat({
          system: bundle.system_prompt,
          user: topicChapterPrompt(bundle, i),
          temperature: 0.4,
          onToken: (_d, full) => { cataloguePieces.topics[i] = full; updateDisplay(); },
        });
        cataloguePieces.topics[i] = topicMdOut;
        updateDisplay();
      }

      if (!catalogueGen.cancelled) {
        catalogueGen.step = catalogueGen.total;
        catalogueGen.label = 'topic selection / recommendation';
        renderCatalogueProgress(progressHost);
        cataloguePieces.topic_selection = await llm.chat({
          system: bundle.system_prompt,
          user: topicSelectionPrompt(bundle),
          temperature: 0.3,
          onToken: (_d, full) => { cataloguePieces.topic_selection = full; updateDisplay(); },
        });
        updateDisplay();
      }

      // Save to disk
      const md = compileCatalogue(bundle, cataloguePieces);
      await fetch('/api/catalogue/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: md }),
      });
      savedMd = md;
      await runCoverage(md);
    } catch (err) {
      alert('Generation failed: ' + err.message);
    } finally {
      catalogueGen.running = false;
      catalogueGen.label = catalogueGen.cancelled ? 'cancelled' : 'done';
      renderCatalogueProgress(progressHost);
      patchCatalogueGenerator();
    }
  }

  async function runCoverage(md) {
    try {
      const r = await fetch('/api/catalogue/coverage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: md }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const report = await r.json();
      patchCoverage(report);
    } catch (err) {
      patchCoverage({ error: err.message });
    }
  }

  function renderCoverage(report) {
    if (!report) return h('div');
    if (report.error) {
      return h('div', { class: 'panel synth-panel' }, [
        h('h3', {}, ['Citation coverage']),
        h('div', { class: 'small error-text' }, ['Coverage check failed: ' + report.error]),
      ]);
    }
    const { stats, missing, cited } = report;
    const tone = stats.must_cite_missing > 0 ? 'banner-warn' : (stats.missing_count > stats.cited_count ? 'banner-warn' : 'banner-success');
    const wrap = h('div', { class: 'panel synth-panel' });
    wrap.appendChild(h('h3', {}, ['Citation coverage']));
    wrap.appendChild(h('div', { class: 'banner ' + tone }, [
      h('strong', {}, [`${stats.cited_count} / ${stats.total_includes} papers cited`]),
      ' — ',
      `${stats.missing_count} missing`,
      stats.must_cite_missing > 0
        ? h('span', { class: 'error-text' }, [` (${stats.must_cite_missing} must-cite)`])
        : '',
    ]));
    if (missing.length > 0) {
      const mustCite = missing.filter((m) => m.must_cite);
      const others = missing.filter((m) => !m.must_cite);
      if (mustCite.length > 0) {
        wrap.appendChild(h('div', { class: 'note-field-label' }, ['Must-cite papers not in catalogue:']));
        wrap.appendChild(h('ul', { class: 'coverage-list' },
          mustCite.map((m) => h('li', {}, [
            h('code', {}, [`paper_${m.paper_id}`]), ' · ',
            h('strong', {}, [m.title || '(untitled)']),
          ])),
        ));
      }
      if (others.length > 0) {
        wrap.appendChild(h('details', {}, [
          h('summary', {}, [`Other uncited papers (${others.length})`]),
          h('ul', { class: 'coverage-list' },
            others.map((m) => h('li', {}, [
              h('code', {}, [`paper_${m.paper_id}`]),
              m.novelty ? h('span', { class: 'small muted' }, [` · novelty: ${m.novelty}`]) : '',
              ' · ', m.title || '(untitled)',
            ])),
          ),
        ]));
      }
    }
    if (cited.length > 0) {
      wrap.appendChild(h('details', {}, [
        h('summary', {}, [`Cited papers (${cited.length})`]),
        h('ul', { class: 'coverage-list small muted' },
          cited.map((c) => h('li', {}, [
            h('code', {}, [`paper_${c.paper_id}`]), ' · ', c.title || '(untitled)',
            c.citation_count > 1 ? ` (×${c.citation_count})` : '',
          ])),
        ),
      ]));
    }
    return wrap;
  }

  function renderHandoffPanel() {
    return h('div', { class: 'panel synth-panel' }, [
      h('p', { class: 'small muted' }, [
        'When local AI output is mediocre, hand the bundle off to a long-context cloud model. ',
        'You get a self-contained prompt + data; paste the response back into the catalogue textarea above.',
      ]),
      h('div', { class: 'panel-actions' }, [
        h('button', { class: 'btn', type: 'button',
          onclick: copyMasterPrompt,
        }, ['📋 Copy master prompt']),
        h('button', { class: 'btn', type: 'button',
          onclick: exportBundleZip,
        }, ['📦 Export ZIP for external AI']),
      ]),
    ]);
  }

  function copyMasterPrompt() {
    if (!bundle) return;
    const text = assembleMasterPrompt(bundle);
    navigator.clipboard.writeText(text).then(() => {
      alert(`Master prompt (${text.length.toLocaleString()} chars) copied.`);
    }).catch(() => {
      const w = window.open();
      w.document.write('<pre>' + escapeHtml(text) + '</pre>');
    });
  }

  async function exportBundleZip() {
    if (!bundle) return;
    let JSZip;
    try {
      const mod = await import(JSZIP_URL);
      JSZip = mod.default || mod;
    } catch (e) {
      alert('Could not load JSZip library: ' + e.message);
      return;
    }
    const zip = new JSZip();
    zip.file('PROMPT.md', assembleMasterPrompt(bundle));
    zip.file('README.md', readmeMd(bundle));
    zip.file('bundle.json', JSON.stringify(bundle, null, 2));
    zip.file('references.md', bundle.references_md);
    try {
      const synthState = await fetch('/api/synthesis/state').then((r) => r.json());
      zip.file('candidates.json', JSON.stringify(synthState, null, 2));
    } catch {}
    try {
      const aggData = await fetch('/api/synthesis/aggregate').then((r) => r.json());
      zip.file('aggregate.json', JSON.stringify(aggData, null, 2));
    } catch {}
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `catalogue-bundle-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ===== Initial paint =====
  refreshAll();
  panels.handoff.replaceChildren(renderHandoffPanel());
  loadPrisma();
  loadPositioning();
  // Try to load any prior generation so a reload doesn't lose work
  if (savedMd && /^# Thesis Topic Catalogue/m.test(savedMd)) {
    // Resize topics array using the catalogue bundle if it loaded
    try { bundle = await fetch('/api/catalogue/bundle').then((r) => r.json()); } catch {}
    if (bundle?.candidates) cataloguePieces.topics = bundle.candidates.map(() => '');
    parseSavedMarkdown(savedMd, cataloguePieces);
    patchCatalogueSummary();
    patchCatalogueGenerator();
    patchCatalogueOutput();
    // Show a coverage report on load if we already have a saved catalogue.
    runCoverage(savedMd);
  } else {
    // No saved catalogue. Fetch bundle once for the catalogue panels (so
    // the chapter count and "what will be generated" preview show up).
    await refreshBundleAndCatalogue();
  }
}

// ===== Catalogue helpers (module-level — no closure state) =====

function stat(value, label) {
  return h('div', { class: 'stat' }, [
    h('div', { class: 'stat-value' }, [String(value)]),
    h('div', { class: 'stat-label muted small' }, [label]),
  ]);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Build a structured positioning-statement markdown from a chosen
// candidate + the catalogue bundle (which carries corpus stats, topic
// metadata, and references). Deterministic — no LLM call. The student
// edits the prose afterward.
function templatePositioningStatement(candidate, bundle) {
  const topic = bundle.topic || {};
  const cs = bundle.corpus_summary || {};
  const c = candidate;

  // Field state — a short paragraph summarising the corpus.
  const matrixCells = cs.matrix_counts ? Object.entries(cs.matrix_counts) : [];
  const empty = matrixCells.filter(([, n]) => n === 0).length;
  const sparse = matrixCells.filter(([, n]) => n >= 1 && n <= 2).length;
  const dense = matrixCells.filter(([, n]) => n >= 5).length;
  const fieldState =
    `The corpus contains ${cs.total_papers || 0} structured notes across ${(cs.categories || []).length} categories and ${(cs.methods || []).length} method families. ` +
    `The category × method matrix shows ${empty} empty cells, ${sparse} sparse cells (1–2 papers each), and ${dense} dense cells (≥5 papers). ` +
    `Methodological flags counted: ${JSON.stringify(cs.flag_counts || {})}.` +
    (cs.must_cite_count ? ` ${cs.must_cite_count} papers are flagged as must-cite. ` : ' ') +
    (cs.external_ground_truth_count ? `${cs.external_ground_truth_count} report external ground truth.` : 'None report external ground truth.');

  // Closest prior work — pull from the candidate's evidence list, then
  // fall back to the corpus papers most similar by category if evidence
  // is thin. Resolved against bundle.papers so we get titles+authors.
  const papersById = {};
  for (const p of bundle.papers || []) papersById[p.id] = p;
  const evidenceIds = (c.evidence || [])
    .map((e) => e.paper_id || e)
    .filter(Boolean)
    .map((id) => String(id).replace(/^paper_/, ''));
  const closestPriorLines = [];
  for (const id of evidenceIds.slice(0, 5)) {
    const p = papersById[id];
    if (!p) continue;
    const line = `- [paper_${p.id}] ${p.citation || ''} — *${p.title || ''}*` +
      (p.primary_contribution ? `. ${p.primary_contribution}` : '');
    closestPriorLines.push(line);
  }
  if (closestPriorLines.length === 0) {
    closestPriorLines.push('- _(no explicit evidence yet — list the 3–5 papers nearest your gap and what each does and does not address.)_');
  }

  // Indicator assessment summary — one bullet per indicator.
  const indicatorLines = [];
  const INDICATOR_LABELS = {
    demonstrated_gap: 'Demonstrated gap',
    literature_volume: 'Literature volume',
    scientific_value: 'Scientific value',
    external_validation: 'External validation',
    falsifiability_reproducibility: 'Falsifiability & reproducibility',
    methodology_fit: 'Methodology fit',
    hobby_project_test: 'Hobby project test',
  };
  for (const [key, label] of Object.entries(INDICATOR_LABELS)) {
    const v = c.indicators?.[key];
    if (!v?.verdict) {
      indicatorLines.push(`- **${label}**: _(not yet assessed)_`);
    } else {
      indicatorLines.push(`- **${label}** — ${v.verdict}${v.justification ? `. ${v.justification}` : ''}`);
    }
  }

  return `# Positioning Statement

## Thesis topic
${topic.title || '_(unspecified)_'}

${topic.description ? topic.description + '\n' : ''}
## Field state
${fieldState}

## Closest prior work
${closestPriorLines.join('\n')}

## Gap statement
${c.statement || '_(fill in: one-sentence description of what the field has not addressed)_'}

## Research question
${c.research_question || '_(fill in: a falsifiable question of the form "does X outperform Y under Z")_'}

## External validation source
${c.external_validation_source || '_(fill in: a specific named source with an estimated case count)_'}

## Methodology overview
${c.methodology_fit || '_(fill in: 1–3 sentences on how the methodology fits and avoids circular ground truth)_'}

## Why this is not a hobby project
${c.hobby_project_test || '_(fill in: 1 sentence explaining what makes this thesis-scale, not weekend-doable)_'}

## Indicator assessment summary
${indicatorLines.join('\n')}
`;
}

function compileCatalogue(bundle, pieces) {
  const out = [];
  out.push(`# Thesis Topic Catalogue`);
  if (bundle.topic.title) out.push(`### ${bundle.topic.title}`);
  out.push('');
  out.push('## 1. State of the art');
  out.push(pieces.state_of_art || '_(not yet drafted)_');
  out.push('');
  pieces.topics.forEach((md, i) => {
    out.push(`## ${i + 2}. Topic ${i + 1}. ${bundle.candidates[i]?.title || '(untitled)'}`);
    out.push(md || '_(not yet drafted)_');
    out.push('');
  });
  out.push(`## ${2 + pieces.topics.length}. Topic selection`);
  out.push(pieces.topic_selection || '_(not yet drafted)_');
  out.push('');
  out.push(bundle.references_md);
  return out.join('\n');
}

function parseSavedMarkdown(md, pieces) {
  const soa = md.match(/##\s+1\.\s+State of the art\s*\n([\s\S]*?)(?=\n##\s+\d+\.|\n## References|$)/i);
  if (soa) pieces.state_of_art = soa[1].trim();
  const sel = md.match(/##\s+\d+\.\s+Topic selection\s*\n([\s\S]*?)(?=\n## References|$)/i);
  if (sel) pieces.topic_selection = sel[1].trim();
  for (let i = 0; i < pieces.topics.length; i++) {
    const re = new RegExp(`##\\s+${i + 2}\\.\\s+Topic ${i + 1}\\.[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+\\d+\\.|\\n## References|$)`, 'i');
    const m = md.match(re);
    if (m) pieces.topics[i] = m[1].trim();
  }
}

function renderSoaSections(sections) {
  const out = [];
  for (const [key, notes] of Object.entries(sections || {})) {
    const headline = key.replace(/_/g, ' ').toUpperCase();
    out.push(`--- ${headline} ---`);
    if (!notes || notes.length === 0) {
      out.push('(no notes retrieved for this sub-aspect)');
      continue;
    }
    for (const n of notes) {
      out.push(renderNoteForPrompt(n));
    }
  }
  return out.join('\n');
}

function renderNoteForPrompt(n) {
  const handle = `[paper_${n.paper_id}]`;
  const head = `${handle} ${n.authors || ''} (${n.year || 'n.d.'}) — "${n.title || ''}"`;
  const sim = typeof n.similarity === 'number' ? ` (sim=${n.similarity.toFixed(2)})` : '';
  const lines = [`${head}${sim}`];
  if (n.primary_contribution) lines.push(`  Primary contribution: ${oneLine(n.primary_contribution, 240)}`);
  const b = n.body || {};
  if (b.problem_statement) lines.push(`  Problem: ${oneLine(b.problem_statement, 280)}`);
  if (b.method_summary) lines.push(`  Method: ${oneLine(b.method_summary, 280)}`);
  if (b.ground_truth_and_evaluation) lines.push(`  Ground truth & evaluation: ${oneLine(b.ground_truth_and_evaluation, 280)}`);
  if (b.stated_limitations) lines.push(`  Limitations: ${oneLine(b.stated_limitations, 280)}`);
  if (b.gaps_this_paper_opens) lines.push(`  Gaps opened: ${oneLine(b.gaps_this_paper_opens, 280)}`);
  return lines.join('\n');
}

function oneLine(s, max = 240) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function stateOfArtPrompt(bundle) {
  const ctx = bundle.note_context?.state_of_art;
  const groundedBlocks = ctx?.sections
    ? renderSoaSections(ctx.sections)
    : '(note retrieval unavailable; rely on the compact paper index below)';
  const paperIndex = bundle.papers.map((p) =>
    `[paper_${p.id}] ${p.citation} — ${p.category || '?'} / ${p.method_family || '?'} — ${p.title}`,
  ).join('\n');

  return `Topic: ${bundle.topic.title}
Description: ${bundle.topic.description}

Corpus summary (${bundle.corpus_summary.total_papers} notes):
- Categories: ${bundle.corpus_summary.categories.join(', ')}
- Method families: ${bundle.corpus_summary.methods.join(', ')}
- Matrix counts (cat|method → n): ${JSON.stringify(bundle.corpus_summary.matrix_counts)}
- Quality flag counts: ${JSON.stringify(bundle.corpus_summary.flag_counts)}
- Relevance distribution: ${JSON.stringify(bundle.corpus_summary.relevance_distribution)}

=== Grounded note excerpts (retrieved by semantic similarity per sub-aspect) ===
${groundedBlocks}

=== Compact paper index (for citation lookup only) ===
${paperIndex.slice(0, 30000)}

Write the "State of the art" chapter (3-5 paragraphs, ~500-700 words). Cover:
- The corpus mapped against vulnerability/topic categories and method-feature combinations.
- How many cells are empty vs sparse; which empty cells are structurally meaningful (define the gap structure).
- Cross-paper observations: where multiple papers leave the same problem open.
- Structural problems with how ground truth is constructed in the field.
- A summary of how many gap candidates emerged and how they organise into topics.

Ground every claim in the grounded excerpts above. When you cite a paper as [paper_NNN], the supporting evidence must appear in the excerpts or compact index. Use plain consecutive sentences, no bullets, no preamble.`;
}

function topicChapterPrompt(bundle, idx) {
  const c = bundle.candidates[idx];
  const ctx = bundle.note_context?.topics?.[idx];

  const retrievedBlock = ctx?.retrieved_notes?.length
    ? ctx.retrieved_notes.map(renderNoteForPrompt).join('\n')
    : '(no retrieval results; falling back to listed evidence only)';
  const evidenceBlock = ctx?.evidence_notes?.length
    ? ctx.evidence_notes.map(renderNoteForPrompt).join('\n')
    : '(no additional explicitly-listed evidence notes)';

  return `Topic: ${bundle.topic.title}

Candidate for this chapter:
- title: ${c.title}
- statement: ${c.statement}
- research_question: ${c.research_question}
- external_validation_source: ${c.external_validation_source}
- methodology_fit: ${c.methodology_fit}
- hobby_project_test: ${c.hobby_project_test}

=== Retrieved notes (top by semantic similarity to the candidate's statement/RQ) ===
${retrievedBlock}

=== Explicitly listed evidence (the student tagged these on this candidate) ===
${evidenceBlock}

Indicator verdicts (use them for the risks paragraph):
${JSON.stringify(c.indicators)}

Write a topic chapter (~700-1000 words). Use exactly these subsection headings:

[Topic intro paragraphs (3-5 sentences each, 2-3 paragraphs total). Motivate why this is the strongest topic / a defensible topic. Name 3-5 papers as [paper_NNN]. Cite the explicit out-of-scope statements those papers make. State the headline thesis question that follows directly.]

### Research question
[Decompose into 2-5 falsifiable angles A1, A2, A3, ... Each angle has a Success threshold and a Failure threshold. Use the format "A1. Headline detection. Does X outperform Y under Z. Success: <quantitative>. Failure: <quantitative>." Each angle is one paragraph.]

### Methodology
[2-3 paragraphs. Input, model, training, evaluation. Cite precedents. State variance commitment (e.g. three independent runs) and what gets released as artefacts.]

### Thesis structure
[1-2 paragraphs walking through IMRAD+ chapters: Introduction, Theory, Literature Review, Methodology, Case Study, Results, Discussion, Conclusion. State what each covers. Include 1 paragraph on risks and mitigations specific to this topic. Include 1 paragraph naming the reading list (which papers this topic cites).]

Tone: confident, declarative, faithful to the supplied evidence. Cite as [paper_NNN]. No bullet lists in body paragraphs. No preamble.`;
}

function topicSelectionPrompt(bundle) {
  const perCand = bundle.note_context?.topic_selection?.per_candidate || [];
  const evidenceLines = bundle.candidates.map((c, i) => {
    const pc = perCand[i];
    const top = pc?.top_note;
    const evidence = top
      ? `strongest note: [paper_${top.paper_id}] ${top.authors || ''} (${top.year || 'n.d.'}) — "${top.title || ''}" — ${oneLine(top.primary_contribution || top.body?.problem_statement || '', 180)}`
      : 'no strong supporting note retrieved';
    return `Topic ${i + 1}. ${c.title} (overall: ${c.overall})\n  RQ: ${c.research_question || '(none)'}\n  ${evidence}`;
  }).join('\n');

  return `Topic: ${bundle.topic.title}

Topic chapters that will appear before this one (with their strongest grounded note):
${evidenceLines}

Indicator-summary across all candidates:
${bundle.candidates.map((c, i) => {
  const passes = Object.values(c.indicators || {}).filter((v) => v.verdict === 'PASS').length;
  const partials = Object.values(c.indicators || {}).filter((v) => v.verdict === 'PARTIAL').length;
  const fails = Object.values(c.indicators || {}).filter((v) => v.verdict === 'FAIL').length;
  return `Topic ${i + 1}: ${passes} PASS, ${partials} PARTIAL, ${fails} FAIL — ${c.overall}`;
}).join('\n')}

Write the "Topic selection" chapter (~300-500 words). Cover:
- Recommend the strongest topic and explain why (point to the indicator profile).
- Name the constraints under which other topics become preferable (background, time budget, validation availability, hardware).
- Name the minimum viable thesis configuration (lightest-weight topic that still defends).
- Close with what the student does next (proposal stages, weeks of work, supervisor checkpoints).

Plain consecutive sentences, no bullets, no preamble.`;
}

function assembleMasterPrompt(bundle) {
  const lines = [];
  lines.push('# Master Prompt: Thesis Topic Catalogue Generation');
  lines.push('');
  lines.push('You are an academic writer drafting a thesis topic catalogue. Your output is a single markdown document covering ALL the candidates listed below.');
  lines.push('');
  lines.push('## Voice and rules');
  lines.push('');
  lines.push(bundle.system_prompt);
  lines.push('');
  lines.push('## Required structure');
  lines.push('');
  lines.push('```');
  lines.push('# Thesis Topic Catalogue');
  lines.push(`### ${bundle.topic.title || '(topic title)'}`);
  lines.push('');
  lines.push('## 1. State of the art');
  lines.push('[3-5 paragraphs covering corpus, gap matrix, methodology gaps, ground-truth issues]');
  lines.push('');
  bundle.candidates.forEach((c, i) => {
    lines.push(`## ${i + 2}. Topic ${i + 1}. ${c.title}`);
    lines.push('[Topic intro paragraphs, citing 3-5 papers as [paper_NNN]]');
    lines.push('### Research question');
    lines.push('[Falsifiable angles A1, A2, ... with Success/Failure thresholds]');
    lines.push('### Methodology');
    lines.push('[Input, model, evaluation, variance commitment]');
    lines.push('### Thesis structure');
    lines.push('[IMRAD+ walkthrough + risks + reading list]');
    lines.push('');
  });
  lines.push(`## ${2 + bundle.candidates.length}. Topic selection`);
  lines.push('[Recommend the strongest, name constraints, minimum viable, next steps]');
  lines.push('');
  lines.push('## References');
  lines.push('[Auto-generated; will be appended after your output]');
  lines.push('```');
  lines.push('');
  lines.push('## Topic and corpus data');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({
    topic: bundle.topic,
    corpus_summary: bundle.corpus_summary,
    prisma: bundle.prisma,
    candidates: bundle.candidates,
  }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Per-paper compact view');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(bundle.papers, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('Output the full catalogue markdown now. No preamble, no commentary.');
  return lines.join('\n');
}

function readmeMd(bundle) {
  return `# Thesis Topic Catalogue — external AI handoff

This bundle contains everything needed to draft a thesis topic catalogue using a long-context LLM (Claude, GPT-4o, Gemini, etc).

## Files
- \`PROMPT.md\` — paste this directly into Claude.ai / ChatGPT.
- \`bundle.json\` — same data as machine-readable JSON.
- \`references.md\` — deterministic references list. Append to your output.
- \`candidates.json\` — synthesis state with indicator verdicts.
- \`aggregate.json\` — corpus aggregate (matrix, paper summaries).

## How to use
1. Open Claude.ai or ChatGPT.
2. Open \`PROMPT.md\` and paste its full contents.
3. Save the response.
4. In the LitReview app, paste into the catalogue textarea on stage 6 and Save.

## Topic
${bundle.topic.title}

## Coverage
- ${bundle.candidates.length} viable candidates
- ${bundle.corpus_summary.total_papers} notes in corpus
- ${bundle.papers.length} references
`;
}
