// Stage 4: Deep read. Three-pane layout — paper list / PDF viewer /
// structured note form. Per-section ✨ suggest buttons. Saves to
// notes/paper_NNN.md in canonical schema format.

import { h, debounce } from '../lib/dom.mjs';
import * as llm from '../lib/llm.mjs';

const SECTION_LABELS = {
  problem_statement: 'Problem statement',
  method_summary: 'Method summary',
  ground_truth_and_evaluation: 'Ground truth and evaluation',
  stated_limitations: 'Stated limitations',
  gaps_this_paper_opens: 'Gaps this paper opens',
  relevance_to_the_thesis_topic: 'Relevance to the thesis topic',
};

const SECTION_PROMPT_HINTS = {
  problem_statement: 'In 2-3 sentences, what problem does this paper address, in the authors\' own framing?',
  method_summary: 'In 2-4 sentences, how does the paper solve the problem? Cover input, model, output. Do not quote.',
  ground_truth_and_evaluation: 'Describe the data used for evaluation. State whether ground truth is external or self-constructed. Case count and metrics.',
  stated_limitations: 'Summarize the limitations the authors acknowledge. 2-3 sentences.',
  gaps_this_paper_opens: 'Three to six specific gap statements. Each is one sentence. Form: "the paper does not address X" or "the paper restricts itself to Y, leaving Z unexamined". Be specific.',
  relevance_to_the_thesis_topic: 'In 2-3 sentences, how does this paper relate to the thesis topic? State whether the thesis must cite this paper and why.',
};

const SYSTEM_BASE = (topic) => `You are an academic literature-review assistant helping a student write structured notes on research papers. The student's thesis topic is: "${topic}". Be concise, concrete, and faithful to the paper. Write in plain consecutive sentences, no markdown formatting, no bullet lists in the body, no preamble like "this paper" or "in conclusion".`;

// Single-call full-note draft. The model returns:
//   1. A small block of structured key:value lines for required frontmatter
//      fields the validator checks (category, method.family, novelty,
//      primary contribution, relevance).
//   2. The six body sections of the literature-review note.
// We parse both out, route the structured fields to fm.* and the body
// sections to note.body.*. Saves the student from filling the same data
// twice when the abstract already implies it.
const FULL_BODY_SYSTEM = (topic, categories, methodFamilies) => `${SYSTEM_BASE(topic)}

You will be given a paper. Output two parts.

PART 1: Structured key:value lines, exactly these keys, exactly this order, one per line:

CATEGORY: <comma-separated, choose 1-3 from: ${categories.join(', ')}, other>
METHOD_FAMILY: <choose one: ${methodFamilies.join(', ')}, other>
METHOD_SPECIFIC: <short name of the model or technique, e.g. "transformer encoder", "GPT-4 prompt", "static analysis with rule set">
PRIMARY_CONTRIBUTION: <one sentence>
NOVELTY_STRENGTH: <one of: strong, moderate, incremental, unclear>
RELEVANCE_TO_TOPIC: <one of: core, adjacent, peripheral>

PART 2: Six body sections with these exact headings, in order:

## Problem statement
## Method summary
## Ground truth and evaluation
## Stated limitations
## Gaps this paper opens
## Relevance to the thesis topic

After each heading, write 1-4 paragraphs of plain prose. No bullets. No quotes from the paper. No preamble.`;

const SECTION_HEADINGS_FOR_PARSE = [
  ['Problem statement',           'problem_statement'],
  ['Method summary',              'method_summary'],
  ['Ground truth and evaluation', 'ground_truth_and_evaluation'],
  ['Stated limitations',          'stated_limitations'],
  ['Gaps this paper opens',       'gaps_this_paper_opens'],
  ['Relevance to the thesis topic','relevance_to_the_thesis_topic'],
];

function buildFullBodyPrompt(paper, fm) {
  return `Paper:
Title: ${paper.title}
Authors: ${paper.authors}
Year: ${paper.year}
Venue: ${paper.venue}
Abstract: ${(paper.abstract || '').slice(0, 3000)}

Notes-in-progress (use as context, do not contradict):
- Primary contribution: ${fm?.claims?.primary_contribution || '(not stated)'}
- Method family: ${fm?.method?.family || '(not stated)'}
- Ground truth source: ${fm?.ground_truth?.source || '(not stated)'}

Output all six sections now, with the headings exactly as specified.`;
}

function parseFullBody(text) {
  const out = {};
  for (let i = 0; i < SECTION_HEADINGS_FOR_PARSE.length; i++) {
    const [heading, key] = SECTION_HEADINGS_FOR_PARSE[i];
    const nextHeadings = SECTION_HEADINGS_FOR_PARSE
      .slice(i + 1)
      .map(([h]) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const stop = nextHeadings ? `(?=##\\s*(?:${nextHeadings}))` : '$';
    const re = new RegExp(`##\\s*${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\n([\\s\\S]*?)${stop}`, 'i');
    const m = text.match(re);
    if (m) out[key] = m[1].trim();
  }
  return out;
}

// Extract the structured key:value lines (PART 1) the model emits before
// the markdown headings. Tolerant: skips lines we don't recognize.
function parseFrontmatterPart(text, categoriesEnum, methodFamiliesEnum) {
  const ALLOWED_NOVELTY = new Set(['strong', 'moderate', 'incremental', 'unclear']);
  const ALLOWED_RELEVANCE = new Set(['core', 'adjacent', 'peripheral']);
  const out = {};

  function getLine(key) {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  }

  const cats = getLine('CATEGORY');
  if (cats) {
    const allowed = new Set([...categoriesEnum, 'other']);
    out.category = cats.split(/[,;]\s*/)
      .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''))
      .filter((s) => s && allowed.has(s));
    if (out.category.length === 0 && cats.toLowerCase().includes('other')) out.category = ['other'];
  }

  const mf = getLine('METHOD_FAMILY');
  if (mf) {
    const v = mf.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    const allowed = new Set([...methodFamiliesEnum, 'other']);
    if (allowed.has(v)) out.methodFamily = v;
  }

  const ms = getLine('METHOD_SPECIFIC');
  if (ms) out.methodSpecific = ms;

  const pc = getLine('PRIMARY_CONTRIBUTION');
  if (pc) out.primaryContribution = pc;

  const nv = getLine('NOVELTY_STRENGTH');
  if (nv) {
    const v = nv.toLowerCase().trim();
    if (ALLOWED_NOVELTY.has(v)) out.novelty = v;
  }

  const rl = getLine('RELEVANCE_TO_TOPIC') || getLine('RELEVANCE');
  if (rl) {
    const v = rl.toLowerCase().trim();
    if (ALLOWED_RELEVANCE.has(v)) out.relevance = v;
  }

  return out;
}

function applyFrontmatterDraft(fm, draft) {
  if (draft.category && draft.category.length > 0) fm.category = draft.category;
  if (draft.methodFamily) fm.method.family = draft.methodFamily;
  if (draft.methodSpecific && !fm.method.specific) fm.method.specific = draft.methodSpecific;
  if (draft.primaryContribution && !fm.claims.primary_contribution) fm.claims.primary_contribution = draft.primaryContribution;
  if (draft.novelty) fm.claims.novelty_strength = draft.novelty;
  if (draft.relevance) fm.relevance.relevance_to_topic = draft.relevance;
}

const NOVELTY_OPTIONS = ['', 'strong', 'moderate', 'incremental', 'unclear'];
const RELEVANCE_OPTIONS = ['', 'core', 'adjacent', 'peripheral'];

export async function renderStage4(root) {
  root.innerHTML = '<h1>4. Deep read</h1><div class="placeholder">loading…</div>';

  let papersRes;
  try {
    papersRes = await fetch('/api/notes').then((r) => r.json());
    if (papersRes.error) throw new Error(papersRes.error);
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['4. Deep read']));
    root.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('strong', {}, ['Cannot start deep read. ']),
      err.message,
    ]));
    return;
  }

  const papers = papersRes.papers || [];
  if (papers.length === 0) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['4. Deep read']));
    root.appendChild(h('p', { class: 'lead' }, [
      'No eligible papers yet. Mark papers ',
      h('strong', {}, ['include']), ' or ', h('strong', {}, ['maybe']),
      ' in ', h('a', { href: '#/stage2' }, ['stage 2 triage']), ', wait for them to download in stage 3, then come back here.',
    ]));
    return;
  }

  // Load topic + categories + method families for the form's enum options
  const topicRes = await fetch('/api/protocol/topic').then((r) => r.json());
  const topicMd = topicRes.content || '';
  const topicTitle = (topicMd.match(/title:\s*(.+)/) || [])[1]?.trim() || '';
  const categoriesEnum = parseList(topicMd, 'categories');
  const methodFamiliesEnum = parseList(topicMd, 'method_families');

  // State
  let selectedRow = papers[0]?.paper_id || null;
  let activePaper = null;     // { paper_id, title, ..., abstract }
  let note = null;            // { frontmatter, body }
  let issues = [];
  let dirty = false;
  let saving = false;

  // Layout shell
  root.innerHTML = '';
  root.classList.add('view-deepread');
  const headerEl = h('div', { class: 'deepread-header' }, [
    h('h1', {}, ['4. Deep read']),
    h('p', { class: 'lead' }, [
      `${papers.length} eligible paper${papers.length > 1 ? 's' : ''}. Select one, read the PDF on the left, and use the form on the right. Each section has a ✨ Suggest button.`,
    ]),
  ]);
  const batchBar = h('div', { class: 'dr-batch-bar' });
  const layout = h('div', { class: 'deepread-layout' });
  const listEl = h('div', { class: 'deepread-list' });
  const pdfPaneEl = h('div', { class: 'deepread-pdf' });
  const formPaneEl = h('div', { class: 'deepread-form' });
  layout.appendChild(listEl);
  layout.appendChild(pdfPaneEl);
  layout.appendChild(formPaneEl);
  root.appendChild(headerEl);
  root.appendChild(batchBar);
  root.appendChild(layout);

  // Across-papers batch state. Drafts every eligible paper that doesn't
  // already have a valid note. Saves as it goes; cancellable.
  const drBatch = {
    running: false,
    cancelled: false,
    total: 0,
    done: 0,
    errors: 0,
    errorLog: [],   // [{ paper_id, title, message }] — visible in UI
    started: 0,
    currentTitle: '',
  };

  function papersNeedingDraft() {
    return papers.filter((p) => p.note_status !== 'valid');
  }

  function renderBatchBar() {
    batchBar.innerHTML = '';
    const candidates = papersNeedingDraft();
    if (drBatch.running) {
      const pct = drBatch.total > 0 ? Math.round((drBatch.done / drBatch.total) * 100) : 0;
      const elapsed = (Date.now() - drBatch.started) / 1000;
      const rate = drBatch.done > 0 ? elapsed / drBatch.done : 0;
      const remaining = rate * (drBatch.total - drBatch.done);
      const eta = remaining > 60 ? `${Math.round(remaining / 60)} min` : `${Math.round(remaining)} s`;
      batchBar.appendChild(h('div', { class: 'batch-strip' }, [
        h('div', { class: 'batch-info' }, [
          h('strong', {}, [`${drBatch.done} / ${drBatch.total}`]),
          ' · ',
          h('span', { class: 'muted small' }, [
            `eta ~${eta} · `,
            drBatch.currentTitle ? `now: ${drBatch.currentTitle.slice(0, 60)}` : '…',
            drBatch.errors > 0 ? ` · ${drBatch.errors} error${drBatch.errors > 1 ? 's' : ''}` : '',
          ]),
        ]),
        h('div', { class: 'batch-progress' }, [
          h('div', { class: 'batch-progress-bar', style: { width: `${pct}%` } }),
        ]),
        h('button', { class: 'btn btn-ghost', type: 'button',
          onclick: () => { drBatch.cancelled = true; },
        }, ['Cancel']),
      ]));
      if (drBatch.errorLog.length > 0) batchBar.appendChild(renderBatchErrors());
      return;
    }
    // Idle. If we have errors from a prior run, keep them visible so the
    // student can see what failed before deciding to retry.
    if (drBatch.errorLog.length > 0) batchBar.appendChild(renderBatchErrors());

    if (candidates.length === 0) return; // hidden when nothing to draft
    const llmReady = llm.isLoaded();
    const btn = h('button', {
      class: 'btn btn-ai', type: 'button',
      disabled: !llmReady,
      title: llmReady ? '' : 'Configure an AI provider first (topbar AI pill)',
      onclick: runBatchDraft,
    }, [`✨ Draft body for all ${candidates.length} pending`]);
    batchBar.appendChild(h('div', { class: 'batch-strip-idle' }, [
      btn,
      h('span', { class: 'muted small' }, [
        ' Each paper takes ~30 s with a 7B model. Saves automatically. Safe to leave running.',
      ]),
    ]));
  }

  function renderBatchErrors() {
    const summary = drBatch.errors === 1
      ? '1 paper failed in this batch'
      : `${drBatch.errors} papers failed in this batch`;
    const items = drBatch.errorLog.map((e) =>
      h('li', {}, [
        h('span', { class: 'mono small' }, [`paper_${e.paper_id}`]),
        ' · ',
        h('span', { class: 'small' }, [(e.title || '').slice(0, 80)]),
        h('div', { class: 'error-text small' }, [`  ${e.message}`]),
      ])
    );
    return h('details', { class: 'batch-errors', open: drBatch.errors <= 3 }, [
      h('summary', { class: 'small' }, [
        h('span', { class: 'error-text' }, [summary]),
        ' — click to see why',
      ]),
      h('ul', { class: 'batch-errors-list' }, items),
      h('div', { class: 'small muted' }, [
        h('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: () => { drBatch.errorLog = []; drBatch.errors = 0; renderBatchBar(); },
        }, ['Clear error log']),
      ]),
    ]);
  }

  async function runBatchDraft() {
    if (drBatch.running) return;
    const queue = papersNeedingDraft();
    if (queue.length === 0) return;
    drBatch.running = true;
    drBatch.cancelled = false;
    drBatch.total = queue.length;
    drBatch.done = 0;
    drBatch.errors = 0;
    drBatch.started = Date.now();
    renderBatchBar();

    for (const p of queue) {
      if (drBatch.cancelled) break;
      drBatch.currentTitle = p.title || '(untitled)';
      renderBatchBar();
      try {
        // Load this paper's note and frontmatter
        const res = await fetch(`/api/notes/${p.paper_id}`).then((r) => r.json());
        const targetNote = res.note;
        const targetPaper = res.paper;

        const text = await llm.chat({
          system: FULL_BODY_SYSTEM(topicTitle, categoriesEnum, methodFamiliesEnum),
          user: buildFullBodyPrompt(targetPaper, targetNote.frontmatter),
          temperature: 0.5,
        });
        const parsed = parseFullBody(text);

        // Detect silent failures: Ollama can return 200 with an empty or
        // truncated body when the prompt exceeds context. If the parser
        // got nothing, treat it as an error rather than saving an empty
        // note over a possibly-existing one.
        const sectionsFound = Object.keys(SECTION_LABELS).filter((k) => parsed[k] && parsed[k].trim().length >= 30).length;
        if (sectionsFound < 3) {
          throw new Error(
            `model returned only ${sectionsFound} usable section${sectionsFound !== 1 ? 's' : ''} ` +
            `(response was ${text.length} chars). ` +
            `Likely causes: context length exceeded, model refused, or prompt format mismatch.`
          );
        }

        for (const key of Object.keys(SECTION_LABELS)) {
          if (parsed[key] != null) targetNote.body[key] = parsed[key];
        }
        // Frontmatter fields the AI also produced
        const fmDraft = parseFrontmatterPart(text, categoriesEnum, methodFamiliesEnum);
        applyFrontmatterDraft(targetNote.frontmatter, fmDraft);
        // Save
        const save = await fetch(`/api/notes/${p.paper_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: targetNote }),
        }).then((r) => r.json());
        p.note_status = (save.issues?.length ?? 0) === 0 ? 'valid' : 'draft';

        if (selectedRow === p.paper_id) {
          note = targetNote;
          issues = save.issues || [];
          renderForm();
        }
      } catch (err) {
        console.error('batch draft failed for', p.paper_id, err);
        drBatch.errors++;
        drBatch.errorLog.push({
          paper_id: p.paper_id,
          title: p.title || '(untitled)',
          message: err.message || String(err),
        });
        // Cap log size to keep UI manageable
        if (drBatch.errorLog.length > 30) drBatch.errorLog.shift();
      }
      drBatch.done++;
      renderList();
      renderBatchBar();
      await new Promise((r) => setTimeout(r, 0));
    }

    drBatch.running = false;
    drBatch.currentTitle = '';
    renderBatchBar();
  }

  function renderList() {
    listEl.innerHTML = '';
    papers.forEach((p) => {
      const isSelected = selectedRow === p.paper_id;
      const row = h('div', {
        class: 'dr-row dr-status-' + p.note_status + (isSelected ? ' selected' : ''),
        onclick: async () => {
          if (dirty && !confirm('Unsaved changes will be lost. Continue?')) return;
          selectedRow = p.paper_id;
          await loadSelected();
        },
      }, [
        h('span', { class: 'dr-row-status' }, [
          p.note_status === 'valid' ? '✓' :
          p.note_status === 'draft' ? '✎' : '○',
        ]),
        h('div', { class: 'dr-row-body' }, [
          h('div', { class: 'dr-row-id' }, [`paper_${p.paper_id}`]),
          h('div', { class: 'dr-row-title' }, [p.title || '(untitled)']),
          h('div', { class: 'dr-row-meta muted small' }, [
            shortAuthors(p.authors), p.year ? ` · ${p.year}` : '',
          ]),
        ]),
      ]);
      listEl.appendChild(row);
    });
  }

  function renderPdfPane() {
    pdfPaneEl.innerHTML = '';
    if (!selectedRow) {
      pdfPaneEl.appendChild(h('div', { class: 'placeholder' }, ['Select a paper.']));
      return;
    }
    pdfPaneEl.appendChild(h('embed', {
      src: `/api/pdfs/${selectedRow}#view=FitH`,
      type: 'application/pdf',
      class: 'pdf-embed',
    }));
  }

  function setDirty() {
    if (!dirty) {
      dirty = true;
      updateSaveStatus();
    }
  }

  const saveDebounced = debounce(autoSave, 1500);

  async function autoSave() {
    if (!note || !selectedRow) return;
    if (saving) return;
    if (!dirty) return;
    saving = true;
    updateSaveStatus();
    try {
      const res = await fetch(`/api/notes/${selectedRow}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      issues = data.issues || [];
      dirty = false;
      // Update note_status in the paper list
      const p = papers.find((x) => x.paper_id === selectedRow);
      if (p) {
        p.note_status = issues.length === 0 ? 'valid' : 'draft';
        renderList();
      }
    } catch (err) {
      console.error('save failed:', err);
    } finally {
      saving = false;
      updateSaveStatus();
    }
  }

  let saveStatusEl;
  function updateSaveStatus() {
    if (!saveStatusEl) return;
    if (saving) {
      saveStatusEl.className = 'status-pill saved';
      saveStatusEl.textContent = 'saving…';
    } else if (dirty) {
      saveStatusEl.className = 'status-pill dirty';
      saveStatusEl.textContent = 'unsaved';
    } else {
      saveStatusEl.className = 'status-pill ' + (issues.length ? 'dirty' : 'saved');
      saveStatusEl.textContent = issues.length
        ? `draft (${issues.length} ${issues.length === 1 ? 'issue' : 'issues'})`
        : 'valid';
    }
  }

  async function loadSelected() {
    if (!selectedRow) return;
    formPaneEl.innerHTML = '';
    formPaneEl.appendChild(h('div', { class: 'placeholder' }, ['loading…']));
    const res = await fetch(`/api/notes/${selectedRow}`).then((r) => r.json());
    activePaper = res.paper;
    note = res.note;
    issues = res.issues || [];
    dirty = false;
    renderForm();
    renderPdfPane();
    renderList();
  }

  function renderForm() {
    formPaneEl.innerHTML = '';
    if (!note) {
      formPaneEl.appendChild(h('div', { class: 'placeholder' }, ['Select a paper.']));
      return;
    }

    saveStatusEl = h('span', { class: 'status-pill saved' });
    const saveBtn = h('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: () => { dirty = true; autoSave(); },
    }, ['Save now']);

    let fullDraftInflight = false;
    const draftBodyBtn = h('button', {
      class: 'btn btn-ai', type: 'button',
      title: 'Generate frontmatter values + all six body sections in one call',
    }, ['✨ Draft note']);
    draftBodyBtn.addEventListener('click', async () => {
      if (fullDraftInflight) return;
      if (!llm.isLoaded()) {
        alert('Configure an AI provider first (topbar AI pill).');
        return;
      }
      fullDraftInflight = true;
      const original = draftBodyBtn.innerHTML;
      draftBodyBtn.innerHTML = '<span class="spinner"></span> drafting note…';
      draftBodyBtn.disabled = true;
      try {
        const text = await llm.chat({
          system: FULL_BODY_SYSTEM(topicTitle, categoriesEnum, methodFamiliesEnum),
          user: buildFullBodyPrompt(activePaper, fm),
          temperature: 0.5,
          onToken: (_d, full) => {
            const parsed = parseFullBody(full);
            for (const key of Object.keys(SECTION_LABELS)) {
              const ta = formPaneEl.querySelector(`textarea[data-section="${key}"]`);
              if (ta && parsed[key] != null) ta.value = parsed[key];
            }
          },
        });
        const final = parseFullBody(text);
        const sectionsFound = Object.keys(SECTION_LABELS).filter((k) => final[k] && final[k].trim().length >= 30).length;
        if (sectionsFound < 3) {
          throw new Error(
            `model returned only ${sectionsFound} usable section${sectionsFound !== 1 ? 's' : ''} ` +
            `(response was ${text.length} chars). Likely causes: context length exceeded, ` +
            `model refused, or prompt format mismatch. Try a larger model or clear the abstract field if it's very long.`
          );
        }
        for (const key of Object.keys(SECTION_LABELS)) {
          if (final[key] != null) note.body[key] = final[key];
        }
        // Apply structured frontmatter draft (category, method.family,
        // novelty, relevance, primary_contribution).
        const fmDraft = parseFrontmatterPart(text, categoriesEnum, methodFamiliesEnum);
        applyFrontmatterDraft(fm, fmDraft);

        setDirty(); saveDebounced();
        // Re-render so the frontmatter form fields reflect what the AI
        // just filled in. (Body textareas already updated via streaming.)
        renderForm();
      } catch (err) {
        alert('Draft failed: ' + err.message);
      } finally {
        draftBodyBtn.innerHTML = original;
        draftBodyBtn.disabled = false;
        fullDraftInflight = false;
      }
    });

    const issuesPanel = h('details', { class: 'issues-panel', open: issues.length > 0 && issues.length <= 3 }, [
      h('summary', { class: 'small' }, [
        `Validation: ${issues.length === 0 ? 'all good' : `${issues.length} issue${issues.length > 1 ? 's' : ''}`}`,
      ]),
      h('ul', { class: 'small' }, issues.map((i) => h('li', {}, [i]))),
    ]);

    const fm = note.frontmatter;

    // ===== Frontmatter form =====
    const titleInput = makeText(fm, 'title', setDirty, saveDebounced);
    const venueInput = makeText(fm, 'venue', setDirty, saveDebounced);
    const yearInput = makeNumber(fm, 'year', setDirty, saveDebounced);
    const doiInput = makeText(fm, 'doi', setDirty, saveDebounced);
    const arxivInput = makeText(fm, 'arxiv_id', setDirty, saveDebounced);
    const urlInput = makeText(fm, 'url', setDirty, saveDebounced);
    const readDateInput = makeText(fm, 'read_date', setDirty, saveDebounced);

    // Authors as comma-separated chip-ish input
    const authorsInput = h('input', {
      type: 'text',
      value: (fm.authors || []).join(', '),
      placeholder: 'Comma-separated',
    });
    authorsInput.addEventListener('input', () => {
      fm.authors = authorsInput.value.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
      setDirty(); saveDebounced();
    });

    // Category chips, options pulled from topic.md
    const categoryEditor = makeChipPicker(
      fm.category, [...categoriesEnum, 'other'],
      'Pick a category from your topic',
      (v) => { fm.category = v; setDirty(); saveDebounced(); },
    );

    // Method
    const methodFamilySelect = makeSelect(fm.method, 'family',
      [['', '— pick —'], ...[...methodFamiliesEnum, 'other'].map((v) => [v, v])],
      setDirty, saveDebounced);
    const methodSpecificInput = makeText(fm.method, 'specific', setDirty, saveDebounced);
    const methodInputsEditor = makeChipFreeform(fm.method.inputs, 'add input modality',
      (v) => { fm.method.inputs = v; setDirty(); saveDebounced(); });

    // Ground truth
    const gtSourceInput = makeText(fm.ground_truth, 'source', setDirty, saveDebounced);
    const gtExternalInput = makeBoolean(fm.ground_truth, 'external', setDirty, saveDebounced);
    const gtCaseCountInput = makeNumber(fm.ground_truth, 'case_count', setDirty, saveDebounced);
    const gtReproducibleInput = makeBoolean(fm.ground_truth, 'reproducible', setDirty, saveDebounced);

    // Evaluation
    const evalMetricsEditor = makeChipFreeform(fm.evaluation.metrics, 'add metric',
      (v) => { fm.evaluation.metrics = v; setDirty(); saveDebounced(); });
    const evalBaselineInput = makeBoolean(fm.evaluation, 'baseline_compared', setDirty, saveDebounced);
    const evalUncertaintyInput = makeBoolean(fm.evaluation, 'has_uncertainty_quantification', setDirty, saveDebounced);

    // Claims
    const claimsContribInput = makeText(fm.claims, 'primary_contribution', setDirty, saveDebounced);
    const claimsNoveltySelect = makeSelect(fm.claims, 'novelty_strength',
      NOVELTY_OPTIONS.map((v) => [v, v || '— pick —']),
      setDirty, saveDebounced);

    // Limitations the authors state
    const limitationsEditor = makeChipFreeform(fm.limitations_authors_state, 'add a limitation the authors stated',
      (v) => { fm.limitations_authors_state = v; setDirty(); saveDebounced(); });

    // Quality flags
    const qfBlock = h('div', { class: 'quality-flags' },
      ['self_constructed_ground_truth', 'comparison_table_only', 'hobby_project_scale', 'predictable_outcome'].map((k) =>
        h('label', { class: 'qf-row' }, [
          h('input', {
            type: 'checkbox',
            checked: !!fm.quality_flags[k],
            onchange: (e) => { fm.quality_flags[k] = e.target.checked; setDirty(); saveDebounced(); },
          }),
          ' ', k.replace(/_/g, ' '),
        ])
      )
    );

    // Relevance
    const relTopicSelect = makeSelect(fm.relevance, 'relevance_to_topic',
      RELEVANCE_OPTIONS.map((v) => [v, v || '— pick —']),
      setDirty, saveDebounced);
    const relMustCiteInput = makeBoolean(fm.relevance, 'must_cite', setDirty, saveDebounced);

    // ===== Body sections (textarea + ✨ suggest each) =====
    const bodyBlocks = [];
    for (const key of Object.keys(SECTION_LABELS)) {
      const ta = h('textarea', { rows: 5, value: note.body[key] || '', dataset: { section: key } });
      ta.value = note.body[key] || '';
      ta.addEventListener('input', () => { note.body[key] = ta.value; setDirty(); saveDebounced(); });
      const suggestBtn = h('button', {
        class: 'btn btn-ai', type: 'button',
        title: 'Generate this section using the active AI provider',
      }, ['✨ Suggest']);
      let inflight = false;
      suggestBtn.addEventListener('click', async () => {
        if (inflight) return;
        if (!llm.isLoaded()) {
          alert('Configure an AI provider first (topbar AI pill).');
          return;
        }
        inflight = true;
        const original = suggestBtn.innerHTML;
        suggestBtn.innerHTML = '<span class="spinner"></span> drafting…';
        suggestBtn.disabled = true;
        ta.disabled = true;
        const start = ta.value;
        try {
          const prompt = buildSectionPrompt(key, activePaper, fm);
          const text = await llm.chat({
            system: SYSTEM_BASE(topicTitle),
            user: prompt,
            temperature: 0.5,
            onToken: (_d, full) => { ta.value = full; },
          });
          note.body[key] = (text || ta.value).trim();
          ta.value = note.body[key];
          setDirty(); saveDebounced();
        } catch (err) {
          ta.value = start;
          alert('AI failed: ' + err.message);
        } finally {
          suggestBtn.innerHTML = original;
          suggestBtn.disabled = false;
          ta.disabled = false;
          inflight = false;
        }
      });
      bodyBlocks.push(h('div', { class: 'note-section' }, [
        h('div', { class: 'note-section-header' }, [
          h('h3', {}, [SECTION_LABELS[key]]),
          suggestBtn,
        ]),
        h('p', { class: 'small muted' }, [SECTION_PROMPT_HINTS[key]]),
        ta,
      ]));
    }

    // ===== Final layout =====
    const toolbar = h('div', { class: 'note-toolbar' }, [
      h('div', { class: 'note-toolbar-left' }, [
        h('span', { class: 'paper-id-pill' }, [`paper_${activePaper.paper_id}`]),
        h('span', { class: 'muted small' }, [`${activePaper.triage_label} · ${shortAuthors(activePaper.authors)} · ${activePaper.year || ''}`]),
      ]),
      h('div', { class: 'note-toolbar-right' }, [saveStatusEl, draftBodyBtn, saveBtn]),
    ]);

    formPaneEl.appendChild(toolbar);
    formPaneEl.appendChild(issuesPanel);

    formPaneEl.appendChild(section('Identification', [
      twoCol([labeled('Title', titleInput), labeled('Venue', venueInput)]),
      twoCol([labeled('Year', yearInput), labeled('DOI', doiInput)]),
      twoCol([labeled('arXiv ID', arxivInput), labeled('URL', urlInput)]),
      labeled('Authors', authorsInput),
      labeled('Read date', readDateInput),
    ]));

    formPaneEl.appendChild(section('Category & method', [
      labeled('Category', categoryEditor),
      twoCol([labeled('Method family', methodFamilySelect), labeled('Specific (model / tool)', methodSpecificInput)]),
      labeled('Method inputs', methodInputsEditor),
    ]));

    formPaneEl.appendChild(section('Ground truth', [
      twoCol([labeled('Source', gtSourceInput), labeled('Case count', gtCaseCountInput)]),
      twoCol([labeled('External', gtExternalInput), labeled('Reproducible', gtReproducibleInput)]),
    ]));

    formPaneEl.appendChild(section('Evaluation', [
      labeled('Metrics', evalMetricsEditor),
      twoCol([labeled('Baseline compared', evalBaselineInput), labeled('Uncertainty quantification', evalUncertaintyInput)]),
    ]));

    formPaneEl.appendChild(section('Claims', [
      labeled('Primary contribution', claimsContribInput),
      labeled('Novelty strength', claimsNoveltySelect),
    ]));

    formPaneEl.appendChild(section('Stated limitations', [
      labeled('List of limitations', limitationsEditor),
    ]));

    formPaneEl.appendChild(section('Quality flags', [qfBlock]));

    formPaneEl.appendChild(section('Relevance', [
      twoCol([labeled('Relevance to topic', relTopicSelect), labeled('Must cite', relMustCiteInput)]),
    ]));

    formPaneEl.appendChild(h('h2', { class: 'body-divider' }, ['Body']));
    bodyBlocks.forEach((b) => formPaneEl.appendChild(b));

    updateSaveStatus();
  }

  // Initial load
  await loadSelected();
  renderBatchBar();

  // Re-render the AI buttons when provider state changes
  const unsubLlm = llm.subscribe(() => {
    if (note) renderForm();
    renderBatchBar();
  });

  return () => {
    unsubLlm();
    drBatch.cancelled = true;
    drBatch.running = false;
    root.classList.remove('view-deepread');
  };
}

// ---- Helpers ----

function buildSectionPrompt(sectionKey, paper, fm) {
  const hint = SECTION_PROMPT_HINTS[sectionKey];
  return `Paper:
Title: ${paper.title}
Authors: ${paper.authors}
Year: ${paper.year}
Venue: ${paper.venue}
Abstract: ${(paper.abstract || '').slice(0, 2400)}

Existing notes for context:
- Primary contribution: ${fm?.claims?.primary_contribution || '(not yet stated)'}
- Method family: ${fm?.method?.family || '(not yet stated)'}
- Ground truth source: ${fm?.ground_truth?.source || '(not yet stated)'}

Section to write: ${SECTION_LABELS[sectionKey]}
Instruction: ${hint}

Write only that section. Plain prose, no headings, no bullets, no preamble. Two to four short paragraphs maximum.`;
}

function shortAuthors(s) {
  if (!s) return '';
  const parts = String(s).split(/,\s*/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} & ${parts[1]}`;
  return `${parts[0]} et al.`;
}

function parseList(md, key) {
  const re = new RegExp(`${key}:\\s*\\n((?:[ \\t]*-[ \\t]*\\S.*\\n?)+)`);
  const m = md.match(re);
  if (!m) return [];
  return (m[1].match(/-\s*([^\n]+)/g) || [])
    .map((s) => s.replace(/^-\s*/, '').trim())
    .filter((s) => s && !/^replace_with/.test(s));
}

function makeText(obj, key, onChange, onChangeLater) {
  const input = h('input', { type: 'text', value: obj[key] ?? '' });
  input.addEventListener('input', () => { obj[key] = input.value; onChange(); onChangeLater?.(); });
  return input;
}
function makeNumber(obj, key, onChange, onChangeLater) {
  const input = h('input', { type: 'number', value: String(obj[key] ?? '') });
  input.addEventListener('input', () => {
    obj[key] = parseInt(input.value, 10) || 0;
    onChange(); onChangeLater?.();
  });
  return input;
}
function makeBoolean(obj, key, onChange, onChangeLater) {
  const input = h('input', { type: 'checkbox', checked: !!obj[key] });
  input.addEventListener('change', () => { obj[key] = input.checked; onChange(); onChangeLater?.(); });
  return h('label', { class: 'inline-bool' }, [input, ' ', obj[key] ? 'true' : 'false']);
}
function makeSelect(obj, key, options, onChange, onChangeLater) {
  const select = h('select', {});
  for (const [val, label] of options) {
    const opt = h('option', { value: val }, [label]);
    if (obj[key] === val) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => { obj[key] = select.value; onChange(); onChangeLater?.(); });
  return select;
}

function makeChipPicker(values, options, placeholder, onChange) {
  let items = [...(values || [])];
  const wrap = h('div', { class: 'chip-input' });
  const list = h('div', { class: 'chips' });
  const select = h('select', { class: 'chip-add' });
  select.appendChild(h('option', { value: '' }, [placeholder]));
  for (const o of options) select.appendChild(h('option', { value: o }, [o]));
  function render() {
    list.innerHTML = '';
    items.forEach((v, i) => {
      list.appendChild(h('span', { class: 'chip' }, [
        v,
        h('button', { class: 'chip-remove', type: 'button',
          onclick: () => { items.splice(i, 1); render(); onChange([...items]); },
        }, ['×']),
      ]));
    });
    select.value = '';
  }
  select.addEventListener('change', () => {
    const v = select.value;
    if (!v || items.includes(v)) return;
    items.push(v);
    render();
    onChange([...items]);
  });
  wrap.appendChild(list);
  wrap.appendChild(select);
  render();
  return wrap;
}

function makeChipFreeform(values, placeholder, onChange) {
  let items = [...(values || [])];
  const wrap = h('div', { class: 'chip-input' });
  const list = h('div', { class: 'chips' });
  const input = h('input', { type: 'text', class: 'chip-add', placeholder });
  function render() {
    list.innerHTML = '';
    items.forEach((v, i) => {
      list.appendChild(h('span', { class: 'chip' }, [
        v,
        h('button', { class: 'chip-remove', type: 'button',
          onclick: () => { items.splice(i, 1); render(); onChange([...items]); },
        }, ['×']),
      ]));
    });
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = input.value.trim();
      if (!v || items.includes(v)) { input.value = ''; return; }
      items.push(v);
      input.value = '';
      render();
      onChange([...items]);
    }
  });
  wrap.appendChild(list);
  wrap.appendChild(input);
  render();
  return wrap;
}

function section(title, children) {
  return h('section', { class: 'note-fieldset' }, [
    h('h3', {}, [title]),
    ...children,
  ]);
}
function labeled(label, control) {
  return h('label', { class: 'note-field' }, [
    h('span', { class: 'note-field-label' }, [label]),
    control,
  ]);
}
function twoCol(children) {
  return h('div', { class: 'note-row-2' }, children);
}
