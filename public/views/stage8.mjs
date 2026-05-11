// Stage 8 (UI label "7. Loop close"): closed-loop remediation. Surfaces
// every unresolved signal across the pipeline as a concrete action card.
// Each card is verb-led ("Triage 12 pending hits", "Draft 8 missing
// notes") with a deep-link to the stage that resolves it. No new
// analyses run here — this is pure aggregation over signals other
// modules already compute.

import { h } from '../lib/dom.mjs';

export async function renderStage8(root) {
  root.innerHTML = '<h1>7. Loop close</h1><div class="placeholder">computing signals…</div>';
  let data;
  try {
    const r = await fetch('/api/loop/signals');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
    if (data.error) throw new Error(data.error);
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['7. Loop close']));
    root.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('strong', {}, ['Could not load signals. ']),
      err.message,
    ]));
    return;
  }

  const { signals, counts } = data;

  root.innerHTML = '';
  root.appendChild(h('h1', {}, ['7. Loop close']));
  root.appendChild(h('p', { class: 'lead' }, [
    'Concrete actions needed before the literature review is ready to defend. ',
    'Every card links back to the stage that resolves it. Re-run after acting on a few cards — signals refresh from disk each time.',
  ]));

  // ===== Scorecard =====
  const scorecard = h('div', { class: 'loop-scorecard' }, [
    scoreTile('red', counts.red, 'blocking'),
    scoreTile('yellow', counts.yellow, 'quality concerns'),
    scoreTile('green', counts.green, 'opportunities'),
    scoreTile('total', counts.total, counts.total === 0 ? 'all clear' : 'total signals'),
  ]);
  root.appendChild(scorecard);

  if (counts.total === 0) {
    root.appendChild(h('div', { class: 'banner banner-success' }, [
      h('strong', {}, ['Nothing flagged. ']),
      'Pending hits triaged, notes drafted and valid, candidates scored, catalogue covers must-cites. ',
      'If anything still feels off, regenerate the catalogue, re-run snowballing, or run "Recheck coverage" on stage 6.',
    ]));
    root.appendChild(refreshButton(root));
    return;
  }

  // ===== Action cards, grouped by category =====
  const grouped = groupByCategory(signals);
  for (const [cat, list] of grouped) {
    const sec = h('div', { class: 'loop-section' });
    sec.appendChild(h('h2', {}, [CATEGORY_LABELS[cat] || cat]));
    for (const sig of list) sec.appendChild(renderCard(sig));
    root.appendChild(sec);
  }

  root.appendChild(refreshButton(root));
}

function scoreTile(severity, count, label) {
  return h('div', { class: `loop-score-tile loop-score-${severity}` }, [
    h('div', { class: 'loop-score-count' }, [String(count)]),
    h('div', { class: 'loop-score-label' }, [label]),
  ]);
}

const CATEGORY_LABELS = {
  triage: 'Triage',
  download: 'Download',
  notes: 'Notes',
  synthesis: 'Synthesis',
  catalogue: 'Catalogue',
  corpus: 'Corpus shape',
};

const CATEGORY_ORDER = ['triage', 'download', 'notes', 'synthesis', 'corpus', 'catalogue'];

function groupByCategory(signals) {
  const byCat = new Map();
  for (const s of signals) {
    if (!byCat.has(s.category)) byCat.set(s.category, []);
    byCat.get(s.category).push(s);
  }
  // Order categories by the canonical pipeline order; unknown categories
  // tail off the end alphabetically.
  const ordered = [];
  for (const k of CATEGORY_ORDER) {
    if (byCat.has(k)) {
      ordered.push([k, byCat.get(k)]);
      byCat.delete(k);
    }
  }
  for (const [k, v] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    ordered.push([k, v]);
  }
  return ordered;
}

function renderCard(sig) {
  const sevLabel =
    sig.severity === 'red' ? 'blocking' :
    sig.severity === 'yellow' ? 'quality' :
    'opportunity';
  const headerChildren = [
    h('span', { class: `loop-card-sev loop-sev-${sig.severity}` }, [sevLabel]),
    h('strong', { class: 'loop-card-title' }, [sig.title]),
  ];
  const card = h('div', { class: `loop-card loop-card-${sig.severity}` });
  card.appendChild(h('div', { class: 'loop-card-header' }, headerChildren));
  if (sig.detail) card.appendChild(h('div', { class: 'loop-card-detail' }, [sig.detail]));
  if (sig.examples && sig.examples.length > 0) {
    card.appendChild(h('details', { class: 'loop-card-examples' }, [
      h('summary', { class: 'small muted' }, [`Examples (${sig.examples.length})`]),
      h('ul', {}, sig.examples.map((e) => h('li', { class: 'small' }, [e]))),
    ]));
  }
  if (sig.action) {
    card.appendChild(h('div', { class: 'loop-card-actions' }, [
      h('a', { class: 'btn', href: sig.action.href }, [sig.action.label]),
    ]));
  }
  return card;
}

function refreshButton(root) {
  const btn = h('button', { class: 'btn', type: 'button',
    onclick: () => renderStage8(root),
  }, ['↻ Refresh signals']);
  return h('div', { class: 'loop-refresh' }, [btn]);
}
