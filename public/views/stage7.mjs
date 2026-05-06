// Stage 7 (UI label "6. Positioning"): generate a Thesis Topic Catalogue
// covering ALL accepted/refinable candidates. Single button. The chapters
// stream in as the LLM writes them. No candidate selection — the document
// presents every viable option so the supervisor sees the full picture.
//
// For students whose local AI produces weak output, the same data + prompt
// can be exported as a ZIP for paste-into Claude.ai or ChatGPT, and the
// returned markdown pasted back in.

import { h } from '../lib/dom.mjs';
import * as llm from '../lib/llm.mjs';

const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

export async function renderStage7(root) {
  root.innerHTML = '<h1>6. Positioning · catalogue</h1><div class="placeholder">loading…</div>';

  let bundle, savedMd;
  try {
    [bundle, savedMd] = await Promise.all([
      fetch('/api/catalogue/bundle').then((r) => r.json()),
      fetch('/api/catalogue/state').then((r) => r.json()).then((x) => x.markdown || ''),
    ]);
    if (bundle.error) throw new Error(bundle.error);
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['6. Positioning · catalogue']));
    root.appendChild(h('div', { class: 'banner banner-warn' }, [err.message]));
    return;
  }

  if (!bundle.candidates?.length) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['6. Positioning · catalogue']));
    root.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('strong', {}, ['No accepted or refinable candidates yet. ']),
      'Go to ', h('a', { href: '#/stage5' }, ['stage 5 synthesis']),
      ' and run "Score unscored candidates" so verdicts get assigned. The catalogue covers every candidate that ends up accept or refine.',
    ]));
    return;
  }

  const cataloguePieces = {
    state_of_art: '',
    topics: bundle.candidates.map(() => ''),
    topic_selection: '',
  };
  // Try to load any prior generation so a reload doesn't lose work
  if (savedMd && /^# Thesis Topic Catalogue/m.test(savedMd)) {
    parseSavedMarkdown(savedMd, cataloguePieces);
  }

  let cancelled = false;
  let running = false;
  let currentStep = 0;
  let totalSteps = 1 + bundle.candidates.length + 1;
  let currentLabel = '';
  let startedAt = 0;

  // ===== Layout =====
  root.innerHTML = '';
  root.appendChild(h('h1', {}, ['6. Positioning · catalogue']));
  root.appendChild(h('p', { class: 'lead' }, [
    `Generates a thesis topic catalogue covering ${bundle.candidates.length} viable topic${bundle.candidates.length !== 1 ? 's' : ''}. `,
    'Each topic gets a State-of-the-art-style intro, decomposed research questions with falsifiable thresholds, methodology, thesis structure, risks, and a reading list. ',
    'No candidate selection — the document presents the full picture for your supervisor.',
  ]));

  const summaryEl = h('div', { class: 'panel synth-panel' });
  summaryEl.appendChild(h('h2', {}, ['What will be generated']));
  summaryEl.appendChild(h('div', { class: 'catalogue-summary' }, [
    stat(bundle.corpus_summary.total_papers, 'notes (corpus)'),
    stat(bundle.candidates.length, 'topic chapters (one per accepted/refinable candidate)'),
    stat(bundle.papers.length, 'references (auto-generated from notes)'),
    stat(bundle.prisma.records_identified, 'records identified (PRISMA)'),
  ]));
  summaryEl.appendChild(h('div', { class: 'topic-preview-list' }, [
    h('div', { class: 'note-field-label' }, ['Topic chapters that will be drafted:']),
    ...bundle.candidates.map((c, i) => h('div', { class: 'topic-preview-row' }, [
      h('span', { class: 'paper-id-pill' }, [`#${i + 1}`]),
      h('span', { class: 'badge badge-' + c.overall }, [c.overall]),
      h('strong', {}, [c.title || '(untitled)']),
      c.research_question
        ? h('div', { class: 'small muted topic-preview-q' }, [c.research_question])
        : null,
    ])),
  ]));
  root.appendChild(summaryEl);

  // Action panel
  const actionsEl = h('div', { class: 'panel synth-panel' });
  actionsEl.appendChild(h('h2', {}, ['Generate']));
  const progressHost = h('div', { class: 'synth-progress-host' });
  const generateBtn = h('button', {
    class: 'btn btn-ai', type: 'button',
    disabled: !llm.isLoaded(),
    title: llm.isLoaded() ? '' : 'Configure an AI provider in the topbar',
  }, [`✨ Generate full catalogue (${totalSteps} chapters)`]);
  generateBtn.addEventListener('click', () => generate());
  const exportZipBtn = h('button', { class: 'btn', type: 'button' }, ['📦 Export ZIP for external AI']);
  exportZipBtn.addEventListener('click', exportBundleZip);
  const copyPromptBtn = h('button', { class: 'btn', type: 'button' }, ['📋 Copy master prompt']);
  copyPromptBtn.addEventListener('click', copyMasterPrompt);
  actionsEl.appendChild(h('div', { class: 'panel-actions' }, [generateBtn, copyPromptBtn, exportZipBtn]));
  actionsEl.appendChild(h('p', { class: 'small muted' }, [
    'The "ZIP for external AI" path is for when local AI output is mediocre. ',
    'You get a self-contained bundle (prompt + data + notes) you can hand to ',
    h('a', { href: 'https://claude.ai', target: '_blank', rel: 'noopener' }, ['Claude.ai']),
    ', ',
    h('a', { href: 'https://chatgpt.com', target: '_blank', rel: 'noopener' }, ['ChatGPT']),
    ', or any other long-context model. Paste the response back below.',
  ]));
  actionsEl.appendChild(progressHost);
  root.appendChild(actionsEl);

  // Output panel: editable markdown with the result
  const outputEl = h('div', { class: 'panel synth-panel' });
  outputEl.appendChild(h('h2', {}, ['Catalogue (markdown)']));
  outputEl.appendChild(h('p', { class: 'small muted' }, [
    'The generated chapters appear here. Edit freely. Save to write ',
    h('code', {}, ['synthesis/catalogue.md']), '.',
  ]));
  const catalogueTa = h('textarea', {
    rows: 24, class: 'catalogue-textarea',
    placeholder: 'Click Generate above, or paste an external-AI response here.',
  });
  catalogueTa.value = savedMd || '';
  outputEl.appendChild(catalogueTa);
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button',
    onclick: saveCatalogue,
  }, ['Save catalogue']);
  outputEl.appendChild(h('div', { class: 'panel-actions' }, [
    saveBtn,
    h('span', { class: 'small muted', id: 'catalogue-save-status' }, []),
  ]));
  root.appendChild(outputEl);

  function renderProgress() {
    progressHost.innerHTML = '';
    if (!running) return;
    const pct = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = currentStep > 0 ? elapsed / currentStep : 0;
    const remaining = rate * (totalSteps - currentStep);
    const eta = remaining > 60 ? `${Math.round(remaining / 60)} min` : `${Math.round(remaining)} s`;
    progressHost.appendChild(h('div', { class: 'batch-strip synth-progress-strip' }, [
      h('div', { class: 'batch-info' }, [
        h('strong', {}, [`Step ${currentStep} / ${totalSteps}`]),
        ' · ',
        h('span', { class: 'muted small' }, [
          currentLabel,
          currentStep > 0 ? ` · eta ~${eta}` : '',
        ]),
      ]),
      h('div', { class: 'batch-progress' }, [
        h('div', { class: 'batch-progress-bar', style: { width: `${pct}%` } }),
      ]),
      h('button', { class: 'btn btn-ghost', type: 'button',
        onclick: () => { cancelled = true; },
      }, ['Cancel']),
    ]));
  }

  // ===== Generation orchestration =====

  async function generate() {
    if (running) return;
    if (!llm.isLoaded()) {
      alert('Configure an AI provider first');
      return;
    }
    running = true;
    cancelled = false;
    currentStep = 0;
    currentLabel = 'starting…';
    startedAt = Date.now();
    generateBtn.disabled = true;
    renderProgress();

    try {
      // Step 1: state of the art
      currentStep = 1;
      currentLabel = 'state of the art';
      renderProgress();
      cataloguePieces.state_of_art = await llm.chat({
        system: bundle.system_prompt,
        user: stateOfArtPrompt(bundle),
        temperature: 0.4,
        onToken: (_d, full) => {
          cataloguePieces.state_of_art = full;
          updateCatalogueDisplay();
        },
      });
      updateCatalogueDisplay();

      // Step 2..N+1: per-topic chapters
      for (let i = 0; i < bundle.candidates.length; i++) {
        if (cancelled) break;
        currentStep = 2 + i;
        currentLabel = `topic ${i + 1}/${bundle.candidates.length}: ${bundle.candidates[i].title || '(untitled)'}`;
        renderProgress();
        const topicMd = await llm.chat({
          system: bundle.system_prompt,
          user: topicChapterPrompt(bundle, i),
          temperature: 0.4,
          onToken: (_d, full) => {
            cataloguePieces.topics[i] = full;
            updateCatalogueDisplay();
          },
        });
        cataloguePieces.topics[i] = topicMd;
        updateCatalogueDisplay();
      }

      if (!cancelled) {
        // Step N+2: topic selection
        currentStep = totalSteps;
        currentLabel = 'topic selection / recommendation';
        renderProgress();
        cataloguePieces.topic_selection = await llm.chat({
          system: bundle.system_prompt,
          user: topicSelectionPrompt(bundle),
          temperature: 0.3,
          onToken: (_d, full) => {
            cataloguePieces.topic_selection = full;
            updateCatalogueDisplay();
          },
        });
        updateCatalogueDisplay();
      }

      // Persist to disk
      await saveCatalogue(true);
    } catch (err) {
      alert('Generation failed: ' + err.message);
    } finally {
      running = false;
      generateBtn.disabled = false;
      currentLabel = cancelled ? 'cancelled' : 'done';
      renderProgress();
      progressHost.innerHTML = '';
    }
  }

  function updateCatalogueDisplay() {
    catalogueTa.value = compileCatalogue(bundle, cataloguePieces);
  }

  async function saveCatalogue(silent = false) {
    const md = catalogueTa.value || compileCatalogue(bundle, cataloguePieces);
    const status = root.querySelector('#catalogue-save-status');
    if (status) status.textContent = 'saving…';
    try {
      const r = await fetch('/api/catalogue/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: md }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (status) {
        status.textContent = `saved to synthesis/catalogue.md (${md.length.toLocaleString()} chars)`;
        status.className = 'small hint-good';
      }
    } catch (err) {
      if (status) {
        status.textContent = 'save failed: ' + err.message;
        status.className = 'small error-text';
      }
      if (!silent) alert('Save failed: ' + err.message);
    }
  }

  // ===== External handoff =====

  function masterPrompt() {
    return assembleMasterPrompt(bundle);
  }

  async function copyMasterPrompt() {
    const text = masterPrompt();
    try {
      await navigator.clipboard.writeText(text);
      alert(`Master prompt (${text.length.toLocaleString()} chars) copied. ` +
            'Paste into Claude.ai or ChatGPT and ask it to follow the instructions. ' +
            'Then paste the response back into the catalogue textarea.');
    } catch {
      // Fallback: open in a new window for manual copy
      const w = window.open();
      w.document.write('<pre>' + escapeHtml(text) + '</pre>');
    }
  }

  async function exportBundleZip() {
    let JSZip;
    try {
      const mod = await import(JSZIP_URL);
      JSZip = mod.default || mod;
    } catch (e) {
      alert('Could not load JSZip library: ' + e.message);
      return;
    }
    const zip = new JSZip();

    // Master prompt
    zip.file('PROMPT.md', masterPrompt());
    // README
    zip.file('README.md', readmeMd(bundle));
    // Bundle JSON for any tools that want it programmatically
    zip.file('bundle.json', JSON.stringify(bundle, null, 2));
    // The references list (already deterministic)
    zip.file('references.md', bundle.references_md);
    // Project synthesis artifacts (read from disk via API)
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
}

// ===== Helpers =====

function stat(value, label) {
  return h('div', { class: 'stat' }, [
    h('div', { class: 'stat-value' }, [String(value)]),
    h('div', { class: 'stat-label muted small' }, [label]),
  ]);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
  // Best-effort: pull the State of the art and individual topic sections back.
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

// ===== Prompts =====

function stateOfArtPrompt(bundle) {
  return `Topic: ${bundle.topic.title}
Description: ${bundle.topic.description}

Corpus summary (${bundle.corpus_summary.total_papers} notes):
- Categories: ${bundle.corpus_summary.categories.join(', ')}
- Method families: ${bundle.corpus_summary.methods.join(', ')}
- Matrix counts (cat|method → n): ${JSON.stringify(bundle.corpus_summary.matrix_counts)}
- Quality flag counts: ${JSON.stringify(bundle.corpus_summary.flag_counts)}
- Relevance distribution: ${JSON.stringify(bundle.corpus_summary.relevance_distribution)}

Papers (compact):
${JSON.stringify(bundle.papers, null, 0).slice(0, 60000)}

Write the "State of the art" chapter (3-5 paragraphs, ~500-700 words). Cover:
- The corpus mapped against vulnerability/topic categories and method-feature combinations.
- How many cells are empty vs sparse; which empty cells are structurally meaningful (define the gap structure).
- Cross-paper observations: where multiple papers leave the same problem open.
- Structural problems with how ground truth is constructed in the field.
- A summary of how many gap candidates emerged and how they organise into topics.

Cite papers as [paper_NNN] inline. Use plain consecutive sentences, no bullets, no preamble.`;
}

function topicChapterPrompt(bundle, idx) {
  const c = bundle.candidates[idx];
  const evidence = (c.evidence || []).map((e) => e.paper_id).filter(Boolean);
  const competitorPapers = bundle.papers.filter((p) =>
    evidence.includes(p.id) || evidence.includes(`paper_${p.id}`),
  );

  return `Topic: ${bundle.topic.title}

Candidate for this chapter:
- title: ${c.title}
- statement: ${c.statement}
- research_question: ${c.research_question}
- external_validation_source: ${c.external_validation_source}
- methodology_fit: ${c.methodology_fit}
- hobby_project_test: ${c.hobby_project_test}

Evidence papers (cite these in the body):
${JSON.stringify(competitorPapers.map((p) => ({
  id: p.id, citation: p.citation, contribution: p.primary_contribution,
  gaps: p.gaps_opened?.slice(0, 600) ?? '',
})), null, 0)}

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
  return `Topic: ${bundle.topic.title}

Topic chapters that will appear before this one:
${bundle.candidates.map((c, i) => `Topic ${i + 1}. ${c.title} (overall: ${c.overall})\n  RQ: ${c.research_question || '(none)'}`).join('\n')}

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
- \`PROMPT.md\` — paste this directly into Claude.ai / ChatGPT. It contains the instructions, structure, voice rules, and all corpus data.
- \`bundle.json\` — same data as machine-readable JSON, in case you script it.
- \`references.md\` — the deterministic references list. Append this to your output.
- \`candidates.json\` — synthesis state with indicator verdicts.
- \`aggregate.json\` — corpus aggregate (matrix, paper summaries).

## How to use

1. Open Claude.ai or ChatGPT.
2. Open \`PROMPT.md\` and paste its full contents into the chat.
3. The model will produce a markdown document covering all ${bundle.candidates.length} viable topics.
4. Save the response.
5. In the LitReview app, paste the response into the catalogue textarea on stage 6 and click "Save catalogue".

## Topic
${bundle.topic.title}

## Coverage
- ${bundle.candidates.length} viable candidates (accept/refine)
- ${bundle.corpus_summary.total_papers} notes in corpus
- ${bundle.papers.length} references
`;
}
