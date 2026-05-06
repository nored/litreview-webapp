// Stage 1: Search. Edit queries + manual additions, kick off the search,
// watch SSE progress events. On reload or server restart, detect prior job
// state and offer to resume / start over / discard.

import { h } from '../lib/dom.mjs';
import { aiSuggestButton } from '../components/ai_button.mjs';
import { emptyManualAddition } from '../lib/queries_md.mjs';
import { formatRelative } from '../lib/draft.mjs';

const SYSTEM = 'You are an academic literature search assistant. Be concise. Output exactly what is asked, no preamble, no commentary.';

export async function renderStage1(root) {
  const [queriesRes, topicRes, jobRes] = await Promise.all([
    fetch('/api/queries').then((r) => r.json()),
    fetch('/api/protocol/topic').then((r) => r.json()),
    fetch('/api/search/job').then((r) => r.json()),
  ]);
  let queries = [...(queriesRes.queries ?? [])];
  let manual = [...(queriesRes.manual_additions ?? [])];
  let topicMd = topicRes.content || '';
  let dirty = false;

  const status = h('span', { class: 'status-pill saved' }, ['saved']);
  const saveBtn = h('button', { class: 'btn', type: 'button' }, ['Save queries']);
  const runBtn = h('button', { class: 'btn btn-primary', type: 'button' }, ['Run search']);
  const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, ['Cancel']);
  cancelBtn.style.display = 'none';

  const banner = h('div', { class: 'banner-slot' });
  const queryListEl = h('div', { class: 'query-list' });
  const manualListEl = h('div', { class: 'manual-list' });
  const progressEl = h('div', { class: 'search-progress' });
  const summaryEl = h('div', { class: 'search-summary' });

  let progressLogEl = null;
  let progressSummaryEl = null;
  let progressStepEl = null;
  let counts = { arxiv: 0, openalex: 0, semantic_scholar: 0, errors: 0 };

  function markDirty() {
    if (!dirty) {
      dirty = true;
      status.className = 'status-pill dirty';
      status.textContent = 'unsaved';
    }
  }

  function renderQueries() {
    queryListEl.innerHTML = '';
    if (!queries.length) {
      queryListEl.appendChild(h('p', { class: 'muted small' }, ['No queries yet. Add some below or use ✨ Suggest.']));
    }
    let dashedCount = 0;
    queries.forEach((q, i) => {
      const looksSlug = /-{1,}/.test(q) && !/\s/.test(q);
      if (looksSlug) dashedCount++;
      const input = h('input', {
        type: 'text', value: q,
        class: 'query-input' + (looksSlug ? ' query-input-warn' : ''),
        title: looksSlug ? 'looks like a slug. arXiv treats this as one keyword. Click clean to fix.' : '',
      });
      input.addEventListener('input', () => { queries[i] = input.value; markDirty(); });
      const remove = h('button', { class: 'btn btn-ghost', type: 'button', title: 'remove' }, ['×']);
      remove.addEventListener('click', () => {
        queries.splice(i, 1);
        markDirty();
        renderQueries();
      });
      queryListEl.appendChild(h('div', { class: 'query-row' }, [
        h('span', { class: 'query-num' }, [String(i + 1)]),
        input, remove,
      ]));
    });
    // Surface a small action row only when there's something to act on.
    if (queries.length || dashedCount > 0) {
      const actions = h('div', { class: 'query-row-actions' });
      if (dashedCount > 0) {
        const cleanBtn = h('button', {
          class: 'btn', type: 'button',
          title: 'replace dashes/underscores with spaces',
        }, [`Clean ${dashedCount} slug${dashedCount > 1 ? 's' : ''}`]);
        cleanBtn.addEventListener('click', () => {
          queries = queries.map((q) => sanitizeQuery(q)).filter(Boolean);
          markDirty();
          renderQueries();
        });
        actions.appendChild(cleanBtn);
      }
      const clearAll = h('button', {
        class: 'btn btn-ghost', type: 'button',
      }, ['Clear all']);
      clearAll.addEventListener('click', () => {
        if (queries.length && !confirm(`Remove all ${queries.length} queries?`)) return;
        queries = [];
        markDirty();
        renderQueries();
      });
      actions.appendChild(clearAll);
      queryListEl.appendChild(actions);
    }
    const addInput = h('input', {
      type: 'text', class: 'query-add',
      placeholder: 'add a query, press Enter',
    });
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = addInput.value.trim();
        if (v) {
          queries.push(v);
          markDirty();
          renderQueries();
          queryListEl.querySelector('.query-add')?.focus();
        }
      }
    });
    queryListEl.appendChild(addInput);
  }

  function renderManual() {
    manualListEl.innerHTML = '';
    if (!manual.length) {
      manualListEl.appendChild(h('p', { class: 'muted small' }, [
        'No manual additions. Add a paper here only if you already know it should be in the corpus and the search may miss it.',
      ]));
    }
    manual.forEach((m, i) => {
      const update = (k, v) => { manual[i][k] = v; markDirty(); };
      manualListEl.appendChild(h('div', { class: 'card' }, [
        h('div', { class: 'card-header' }, [
          h('span', { class: 'muted small' }, [`Manual addition ${i + 1}`]),
          h('button', {
            class: 'btn btn-ghost', type: 'button',
            onclick: () => { manual.splice(i, 1); markDirty(); renderManual(); },
          }, ['Remove']),
        ]),
        h('div', { class: 'grid-2' }, [
          inputField('Title', m.title, (v) => update('title', v)),
          inputField('Authors', m.authors, (v) => update('authors', v)),
          inputField('Year', m.year, (v) => update('year', v)),
          inputField('Venue', m.venue, (v) => update('venue', v)),
          inputField('DOI', m.doi, (v) => update('doi', v)),
          inputField('URL', m.url, (v) => update('url', v)),
        ]),
        inputField('Reason for inclusion', m.reason, (v) => update('reason', v)),
      ]));
    });
    const addBtn = h('button', { class: 'btn', type: 'button' }, ['+ Add manual paper']);
    addBtn.addEventListener('click', () => {
      manual.push(emptyManualAddition());
      markDirty();
      renderManual();
    });
    manualListEl.appendChild(addBtn);
  }

  async function save() {
    saveBtn.disabled = true;
    status.className = 'status-pill saved';
    status.textContent = 'saving…';
    try {
      const res = await fetch('/api/queries', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries, manual_additions: manual }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      dirty = false;
      status.className = 'status-pill saved';
      status.textContent = 'saved';
      window.litreview?.refreshStatus?.();
    } catch (e) {
      status.className = 'status-pill error';
      status.textContent = 'save failed';
      console.error(e);
    } finally {
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener('click', save);

  function ensureProgressUI(initial = {}) {
    progressEl.innerHTML = '';
    summaryEl.innerHTML = '';
    counts = { arxiv: 0, openalex: 0, semantic_scholar: 0, errors: 0 };
    progressSummaryEl = h('div', { class: 'progress-summary' }, [h('strong', {}, [initial.label || 'running…'])]);
    progressStepEl = h('div', { class: 'progress-step muted small' });
    progressLogEl = h('div', { class: 'progress-log' });
    progressEl.appendChild(progressSummaryEl);
    progressEl.appendChild(progressStepEl);
    progressEl.appendChild(progressLogEl);
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'start':
        progressSummaryEl.innerHTML = `<strong>${event.resumed ? 'Resuming' : 'Running'} ${event.total_queries} queries</strong> · contact <span class="mono">${escapeHtml(event.email)}</span>${event.resumed ? ` · <span class="muted small">${event.completed_pairs} pairs already done</span>` : ''}`;
        break;
      case 'query_start':
        progressStepEl.textContent = `Query ${event.i + 1}/${event.total}: ${event.query}`;
        progressLogEl.appendChild(h('div', { class: 'log-line' }, [
          h('span', { class: 'mono small' }, [`[${event.i + 1}/${event.total}]`]),
          ' ', h('strong', {}, [event.query]),
        ]));
        break;
      case 'source_start':
        progressStepEl.textContent = `Query ${event.i + 1}: ${event.source}…`;
        break;
      case 'source_skipped':
        progressLogEl.appendChild(h('div', { class: 'log-line muted small' }, [
          `  ${event.source}: skipped (already done in prior run)`,
        ]));
        break;
      case 'source_done':
        counts[event.source] = (counts[event.source] || 0) + event.count;
        progressLogEl.appendChild(h('div', { class: 'log-line muted small' }, [
          `  ${event.source}: ${event.count} results`,
        ]));
        break;
      case 'source_error':
        counts.errors++;
        progressLogEl.appendChild(h('div', { class: 'log-line error-text small' }, [
          `  ${event.source} error: ${event.error}`,
        ]));
        break;
      case 'dedup_start':
        progressStepEl.textContent = `Deduplicating ${event.total_raw} rows…`;
        break;
      case 'dedup_done':
        progressLogEl.appendChild(h('div', { class: 'log-line' }, [
          `Deduplication: ${event.total_raw} → ${event.total_deduped}`,
        ]));
        break;
      case 'manual_additions_appended':
        progressLogEl.appendChild(h('div', { class: 'log-line' }, [
          `Manual additions appended: ${event.count}`,
        ]));
        break;
      case 'aborted':
        progressSummaryEl.innerHTML = `<strong style="color:var(--warn)">Search cancelled</strong>`;
        progressStepEl.textContent = '';
        runFinalize();
        break;
      case 'done':
        progressSummaryEl.innerHTML = `<strong style="color:var(--good)">Search complete</strong>`;
        progressStepEl.textContent = '';
        renderSummary(event);
        runFinalize();
        break;
      case 'fatal':
        progressSummaryEl.innerHTML = `<strong style="color:var(--bad)">Search failed</strong>`;
        progressLogEl.appendChild(h('div', { class: 'log-line error-text' }, [event.error]));
        runFinalize();
        break;
      case 'end':
        runFinalize();
        break;
    }
    if (progressLogEl) progressLogEl.scrollTop = progressLogEl.scrollHeight;
  }

  function runFinalize() {
    runBtn.disabled = false;
    cancelBtn.style.display = 'none';
    saveBtn.disabled = false;
    window.litreview?.refreshStatus?.();
    refreshBanner();
  }

  function renderSummary(doneEvent) {
    summaryEl.innerHTML = '';
    summaryEl.appendChild(h('div', { class: 'card' }, [
      h('h3', {}, ['Result']),
      h('div', { class: 'summary-stats' }, [
        stat('Total candidates after dedup', doneEvent.total),
        stat('arXiv hits this run', counts.arxiv),
        stat('OpenAlex hits this run', counts.openalex),
        stat('Semantic Scholar hits this run', counts.semantic_scholar),
        counts.errors > 0 ? stat('API errors', counts.errors, 'warn') : null,
      ]),
      h('p', { class: 'small muted' }, [
        'Saved to ', h('code', {}, ['data/candidates_raw.csv']),
        '. Review and proceed to ',
        h('a', { href: '#/stage2' }, ['stage 2 triage']), '.',
      ]),
    ]));
  }

  function stat(label, value, kind) {
    return h('div', { class: 'stat ' + (kind || '') }, [
      h('div', { class: 'stat-value' }, [String(value)]),
      h('div', { class: 'stat-label muted small' }, [label]),
    ]);
  }

  // SSE streaming
  let activeReader = null;

  async function attachStream() {
    runBtn.disabled = true;
    cancelBtn.style.display = '';
    saveBtn.disabled = true;
    try {
      const res = await fetch('/api/search/stream', { headers: { Accept: 'text/event-stream' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let event;
          try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
          handleEvent(event);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      activeReader = null;
      runFinalize();
    }
  }

  async function startSearch(mode) {
    if (queries.length === 0) {
      alert('Add at least one query before running the search.');
      return;
    }
    if (dirty) await save();
    ensureProgressUI({ label: mode === 'resume' ? 'Resuming…' : 'Starting…' });
    let res;
    try {
      res = await fetch('/api/search/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
    } catch (e) {
      progressEl.innerHTML = '';
      summaryEl.innerHTML = '';
      progressEl.appendChild(h('div', { class: 'banner banner-error' }, [
        'Could not reach the server. Is it still running?',
      ]));
      return;
    }
    if (res.status === 409) {
      // Another search is already running. Refresh the banner so the user
      // sees the live state and can reconnect, instead of a generic error.
      progressEl.innerHTML = '';
      summaryEl.innerHTML = '';
      await refreshBanner();
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      progressEl.innerHTML = '';
      summaryEl.innerHTML = '';
      progressEl.appendChild(h('div', { class: 'banner banner-error' }, [
        err.error || `failed to start search (${res.status})`,
      ]));
      return;
    }
    attachStream();
  }

  runBtn.addEventListener('click', () => startSearch('fresh'));

  cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    await fetch('/api/search/cancel', { method: 'POST' });
    cancelBtn.disabled = false;
  });

  async function refreshBanner() {
    const job = await fetch('/api/search/job').then((r) => r.json());
    banner.innerHTML = '';
    if (!job || job.status === 'none') return;

    if (job.status === 'running') {
      banner.appendChild(h('div', { class: 'banner banner-info' }, [
        h('div', {}, [
          h('strong', {}, ['A search is currently running.']),
          ' Started ', formatRelative(new Date(job.started_at).getTime()), '. ',
          'Reattaching to the live stream.',
        ]),
      ]));
      ensureProgressUI({ label: 'reconnecting…' });
      attachStream();
      return;
    }

    if (job.status === 'interrupted') {
      const completed = job.completed.length;
      const errors = job.errors.length;
      const totalPairs = (job.total_queries || 0) * 3;
      const remaining = Math.max(totalPairs - completed - errors, 0);

      const continueBtn = h('button', { class: 'btn btn-primary', type: 'button' }, ['Continue from where it stopped']);
      const startOverBtn = h('button', { class: 'btn', type: 'button' }, ['Start over']);
      const discardBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, ['Discard everything']);

      continueBtn.addEventListener('click', () => startSearch('resume'));
      startOverBtn.addEventListener('click', () => startSearch('fresh'));
      discardBtn.addEventListener('click', async () => {
        if (!confirm('Discard the previous search log and partial results?')) return;
        await fetch('/api/search/job', { method: 'DELETE' });
        await refreshBanner();
        progressEl.innerHTML = '';
        summaryEl.innerHTML = '';
      });

      banner.appendChild(h('div', { class: 'banner banner-warn' }, [
        h('div', {}, [
          h('strong', {}, ['A previous search was interrupted.']),
          ' ', formatRelative(new Date(job.interrupted_at || job.started_at).getTime()),
          '. ', `${completed} of ${totalPairs} fetches completed`,
          remaining > 0 ? `, ${remaining} still pending.` : '.',
          ' ',
          h('span', { class: 'small muted' }, [
            `(${job.partial_candidate_count} partial results saved.)`,
          ]),
        ]),
        h('div', { class: 'banner-actions' }, [continueBtn, startOverBtn, discardBtn]),
      ]));
      return;
    }

    if (job.status === 'completed') {
      const reRun = h('button', { class: 'btn', type: 'button' }, ['Re-run from scratch']);
      reRun.addEventListener('click', () => {
        if (!confirm('Re-running discards the existing candidates_raw.csv. Proceed?')) return;
        startSearch('fresh');
      });
      banner.appendChild(h('div', { class: 'banner banner-success' }, [
        h('div', {}, [
          h('strong', {}, ['Search completed.']),
          ' ', formatRelative(new Date(job.finished_at || job.started_at).getTime()), '. ',
          `${job.final_candidate_count} candidates in `,
          h('code', {}, ['data/candidates_raw.csv']),
          '.',
        ]),
        h('div', { class: 'banner-actions' }, [reRun]),
      ]));
      return;
    }
  }

  // AI: suggest queries from topic
  const suggestQueriesBtn = aiSuggestButton({
    label: '✨ Suggest queries from topic',
    system: SYSTEM,
    buildPrompt: () => {
      const titleMatch = topicMd.match(/title:\s*(.+)/);
      const descMatch = topicMd.match(/description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/);
      const title = titleMatch?.[1]?.trim() ?? '';
      const desc = descMatch?.[1]?.split('\n').map((l) => l.replace(/^[ \t]{2}/, '')).join('\n').trim() ?? '';
      if (!title) {
        alert('Set a thesis title in Setup first');
        throw new Error('no title');
      }
      return `Thesis topic: "${title}".
${desc ? `Description: ${desc}` : ''}

Generate 10 search queries for academic literature databases (arXiv, OpenAlex, Semantic Scholar). Mix three styles: 2-3 tight to the exact topic, 4-5 covering different angles or synonyms, 2-3 broader queries that catch adjacent or transferable methodology.

Format rules, follow exactly:
- Each query is 3 to 7 plain English words.
- Words are separated by single spaces only.
- No hyphens, no dashes, no slugs, no kebab-case, no underscores.
- No quotes, no punctuation, no special characters.
- Lowercase.
- One query per line. No numbering, no bullets, no commentary.

Example of acceptable: machine learning code review
Example of unacceptable: machine-learning-code-review`;
    },
    onResult: (full) => {
      if (!full) return;
      const suggestions = full.split('\n')
        .map((l) => sanitizeQuery(l))
        .filter((l) => l && l.length < 100);
      if (!suggestions.length) return;
      // If queries already exist, ask whether to replace or append.
      let next;
      if (queries.length) {
        const append = confirm(
          `Got ${suggestions.length} suggestions. ` +
          `OK to append to your ${queries.length} existing queries.\n` +
          `Cancel to replace them instead.`
        );
        next = append
          ? [...new Set([...queries, ...suggestions])]
          : suggestions;
      } else {
        next = suggestions;
      }
      queries = next;
      markDirty();
      renderQueries();
    },
  });

  // Layout
  root.innerHTML = '';
  root.appendChild(h('h1', {}, ['1. Search']));
  root.appendChild(h('p', { class: 'lead' }, [
    'Configure the query bank, then run the search across arXiv, OpenAlex, and Semantic Scholar. ',
    'Output: ', h('code', {}, ['data/candidates_raw.csv']),
    ' and ', h('code', {}, ['data/search_log.jsonl']), '.',
  ]));
  root.appendChild(banner);

  root.appendChild(h('section', { class: 'panel' }, [
    h('div', { class: 'panel-header' }, [
      h('h2', {}, ['Query bank']),
      h('div', { class: 'panel-actions' }, [suggestQueriesBtn, saveBtn, status]),
    ]),
    h('p', { class: 'small muted' }, ['Eight to twelve queries works well. Each runs against all three sources.']),
    queryListEl,
  ]));

  root.appendChild(h('section', { class: 'panel' }, [
    h('div', { class: 'panel-header' }, [h('h2', {}, ['Manual additions'])]),
    h('p', { class: 'small muted' }, ['Optional. Papers added by hand that the automated search may miss.']),
    manualListEl,
  ]));

  root.appendChild(h('section', { class: 'panel' }, [
    h('div', { class: 'panel-header' }, [
      h('h2', {}, ['Run']),
      h('div', { class: 'panel-actions' }, [runBtn, cancelBtn]),
    ]),
    h('p', { class: 'small muted' }, [
      'Saves queries, then queries each source for each query string with rate limiting. Progress streams below. The page is safe to leave open during a run, and safe to reload — you will be asked whether to resume.',
    ]),
    progressEl,
    summaryEl,
  ]));

  renderQueries();
  renderManual();
  refreshBanner();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Normalize a candidate query string. Strips bullets/numbering, converts
// dashes/underscores to spaces (slug → words), collapses whitespace.
// Used both on AI output and on save-time cleanup of human input.
function sanitizeQuery(s) {
  return String(s ?? '')
    .replace(/^[\s*\-•·\d.)]+/, '')   // leading bullets/numbers
    .replace(/^["'`]|["'`]$/g, '')     // wrapping quotes
    .replace(/[-_]+/g, ' ')            // dashes & underscores → spaces
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .toLowerCase();
}

function inputField(label, value, onInput) {
  const input = h('input', { type: 'text', value: value ?? '', placeholder: label.toLowerCase() });
  input.addEventListener('input', () => onInput(input.value));
  return h('label', { class: 'label-wrap' }, [
    h('span', { class: 'small' }, [label]), input,
  ]);
}
