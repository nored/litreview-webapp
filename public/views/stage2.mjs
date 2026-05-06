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

  // Layout shell
  root.innerHTML = '';
  root.classList.add('view-triage');

  const filterBar = h('div', { class: 'triage-filter-bar' });
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
    if (filter === 'pending') return papers.filter((p) => !p.triage_label);
    return papers.filter((p) => p.triage_label === filter);
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
      const row = h('div', {
        class: 'paper-row label-' + (p.triage_label || 'pending') +
               (selectedRow === p.row_index ? ' selected' : ''),
        dataset: { rowIndex: String(p.row_index) },
        onclick: () => selectRow(p.row_index),
      }, [
        h('span', { class: 'paper-row-marker' }, []),
        h('div', { class: 'paper-row-body' }, [
          h('div', { class: 'paper-row-title' }, [p.title || '(untitled)']),
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
    batchBar.innerHTML = '';
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

  renderFilters();
  renderList();
  renderBatchBar();
  // Pick the first pending paper to start
  const initialList = visiblePapers();
  if (initialList.length) selectRow(initialList[0].row_index);
  else renderDetail();
  listEl.focus();

  // Returned cleanup runs when the user navigates away from this view.
  return () => {
    window.removeEventListener('keydown', onKey);
    if (typeof unsubscribeLlm === 'function') unsubscribeLlm();
    batchState.cancelled = true;
    batchState.running = false;
    root.classList.remove('view-triage');
  };
}
