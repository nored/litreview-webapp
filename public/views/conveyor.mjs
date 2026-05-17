// The conveyor — single-screen "what needs you right now" view.
//
// Renders exactly ONE card: the next pending action, or — when nothing
// is pending — an idle marker. No progress bar, no history of completed
// steps, no preview of what's next. The metaphor is the literal one:
// items pass you on a conveyor; you act on what's in front of you; the
// system handles ordering.
//
// Power users access the seven stage routes individually via the
// "Advanced view" topbar toggle. Heavy editors (triage, deep read) take
// over the viewport when opened from here and return to `#/` when done.
//
// Server-side `pickNext()` (server/lib/conveyor.mjs) still returns the
// full event list — the previous renderer used the thread shape. This
// view picks `events[current_idx]` and ignores the rest. Future phases
// will replace the idle marker with the inline deliverables view
// (catalogue / positioning / scorecard / PRISMA).

import { h } from '../lib/dom.mjs';

export async function renderConveyor(root) {
  root.innerHTML = '';
  root.classList.add('view-conveyor');
  root.appendChild(h('div', { class: 'conveyor-loading muted small' }, ['Loading…']));

  let data;
  try {
    data = await fetch('/api/conveyor/next').then((r) => r.json());
    if (data.error) throw new Error(data.error);
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('strong', {}, ['Could not load pipeline state. ']),
      err.message || String(err),
    ]));
    return;
  }

  const { events = [], current_idx = -1 } = data;
  root.innerHTML = '';

  // Migration banner — shown only when there's something to migrate.
  // Context-aware: skipped when the corpus is genuinely empty (no
  // triaged papers yet), since the user hasn't reached the v2-relevant
  // stage. Polling interval cleaned up if the conveyor root is
  // re-rendered or detached.
  const migrationSlot = h('div');
  root.appendChild(migrationSlot);
  let migrationPoll = null;
  function cleanupMigrationPoll() {
    if (migrationPoll) { clearTimeout(migrationPoll); migrationPoll = null; }
  }
  // Detach handler: if the conveyor root is removed from the DOM,
  // clean up the interval.
  const detachObserver = new MutationObserver(() => {
    if (!root.isConnected) { cleanupMigrationPoll(); detachObserver.disconnect(); }
  });
  if (root.parentNode) detachObserver.observe(root.parentNode, { childList: true });

  // Corpus-progress widget — shows where the user stands against
  // target_includes / minimum_includes. Cheap probe; renders inline.
  fetch('/api/v2/target-progress')
    .then((r) => r.ok ? r.json() : null)
    .then((p) => {
      if (!p || (p.target == null && p.minimum == null)) return;
      const target = p.target ?? p.minimum ?? 0;
      const haveColor =
        p.included >= target ? 'good' :
        p.included >= (p.minimum ?? 0) ? 'partial' :
        'short';
      const shortBy = Math.max(0, target - p.included);
      const widget = h('div', { class: `conveyor-target conveyor-target-${haveColor}` }, [
        h('strong', {}, [`${p.included} included`]),
        h('span', { class: 'muted small' }, [
          ` · target ${target}` + (p.minimum != null ? ` · floor ${p.minimum}` : ''),
          shortBy > 0 ? ` · ${shortBy} short of target` : ' · target reached',
        ]),
      ]);
      migrationSlot.appendChild(widget);
    })
    .catch(() => { /* no probe; ignore */ });

  fetch('/api/v2/migration-status')
    .then((r) => r.ok ? r.json() : null)
    .then((m) => {
      if (!m || m.ready || !(m.next_steps || []).length) return;
      // Context-gate: don't show on a genuinely empty project.
      const c = m.counts || {};
      const empty = (c.triaged || 0) === 0 && (c.legacy_notes || 0) === 0;
      if (empty) return;

      const triaged = c.triaged || 0;
      // Rough time estimate: 15s/paper for the extractor pipeline on
      // current laptops, plus ingest + claim-NLI overhead.
      const estSeconds = Math.max(30, triaged * 15);
      const estLabel = estSeconds < 90 ? `~${estSeconds}s` : `~${Math.round(estSeconds / 60)} minutes`;
      const banner = h('div', { class: 'banner banner-info conveyor-migration' }, [
        h('strong', {}, ['v2 setup steps outstanding:']),
        h('ul', { class: 'muted small' }, m.next_steps.map((s) => h('li', {}, [s]))),
        h('p', { class: 'muted small' }, [
          `Will run sync + structured extraction on ${triaged} paper(s). Expected time: ${estLabel}. You can keep using the app — extraction runs in the background.`,
        ]),
        h('button', {
          type: 'button', class: 'btn btn-ai',
          onclick: async (e) => {
            if (e.target.disabled) return;
            if (!confirm(`Run migration on ${triaged} paper(s)?\n\nThis kicks off chunk ingestion + structured extraction across the corpus. Expected duration: ${estLabel}.\n\nThe app stays responsive; you can navigate away and check back.`)) return;
            e.target.disabled = true;
            e.target.textContent = 'Migrating…';
            const r = await fetch('/api/v2/migrate', { method: 'POST' }).then((r) => r.json());
            if (r.error) {
              banner.appendChild(h('div', { class: 'banner banner-warn' }, ['Migrate failed: ' + r.error]));
              e.target.disabled = false;
              e.target.textContent = 'Run migration now';
              return;
            }
            const status = h('span', { class: 'muted small' }, [' Running — poll status…']);
            banner.appendChild(status);
            cleanupMigrationPoll();
            // Adaptive polling: sync stage is fast (seconds), extract
            // stage is slow (minutes). Start at 2s, back off to 10s
            // once we're in the extract stage.
            async function pollOnce() {
              if (!root.isConnected) { cleanupMigrationPoll(); return; }
              const s = await fetch('/api/v2/migrate/status').then((r) => r.json()).catch(() => null);
              if (!s) return;
              if (s.last?.error) {
                cleanupMigrationPoll();
                status.textContent = ` Failed: ${s.last.error}`;
                e.target.disabled = false;
                e.target.textContent = 'Retry migration';
                return;
              }
              status.textContent = ` Stage: ${s.last?.stage || '?'} (progress ${s.last?.progress?.current ?? 0}/${s.last?.progress?.total ?? '?'})`;
              if (!s.running) {
                cleanupMigrationPoll();
                status.textContent = ' Done. Reloading…';
                setTimeout(() => { if (root.isConnected) renderConveyor(root); }, 1000);
                return;
              }
              // Re-schedule with stage-appropriate cadence.
              const nextDelay = s.last?.stage === 'extract' ? 10_000 : 2_000;
              cleanupMigrationPoll();
              migrationPoll = setTimeout(pollOnce, nextDelay);
            }
            pollOnce();
          },
        }, ['Run migration now']),
      ]);
      migrationSlot.appendChild(banner);
    })
    .catch(() => { /* probe not available; ignore */ });

  let card;
  if (current_idx >= 0 && events[current_idx]) {
    card = renderActionCard(events[current_idx]);
  } else {
    const idle = events.find((e) => e.status === 'idle');
    card = idle ? renderIdleCard(idle) : renderEmptyCard();
  }
  root.appendChild(card);

  // Refresh on focus so finishing work in a takeover editor and coming
  // back to `#/` lands on whatever's next without a manual reload.
  const onFocus = () => {
    if (location.hash === '' || location.hash === '#/') renderConveyor(root);
  };
  window.addEventListener('focus', onFocus);
  return () => window.removeEventListener('focus', onFocus);
}

// ---------------------------------------------------------------------
// Card variants
// ---------------------------------------------------------------------

function renderActionCard(event) {
  const card = h('div', { class: `conveyor-card conveyor-card-${event.status || 'open'}` });
  card.appendChild(h('div', { class: 'conveyor-card-eyebrow' }, [
    event.status === 'gate' ? 'Blocked' : 'Next',
  ]));
  card.appendChild(h('h2', { class: 'conveyor-card-title' }, [event.title || 'Next action']));
  if (event.summary) {
    card.appendChild(h('div', { class: 'conveyor-card-summary' }, [event.summary]));
  }
  if (event.detail) {
    card.appendChild(h('p', { class: 'conveyor-card-detail' }, [event.detail]));
  }
  if (event.action) {
    const btnClass = event.status === 'gate' ? 'btn btn-primary btn-large' : 'btn btn-ai btn-large';
    card.appendChild(h('div', { class: 'conveyor-card-action' }, [
      h('a', { class: btnClass, href: event.action.href }, [event.action.label]),
    ]));
  }
  return card;
}

function renderIdleCard(event) {
  const card = h('div', { class: 'conveyor-card conveyor-card-idle' });
  card.appendChild(h('div', { class: 'conveyor-card-eyebrow' }, ['All caught up']));
  card.appendChild(h('h2', { class: 'conveyor-card-title' }, [event.title || 'Pick an output mode']));
  if (event.summary) {
    card.appendChild(h('div', { class: 'conveyor-card-summary' }, [event.summary]));
  }
  card.appendChild(h('p', { class: 'conveyor-card-detail' }, [
    'The pipeline has nothing pending. Choose how to present what the corpus produced:',
  ]));

  // Phase C — surface the v2 positioning output modes directly on the
  // idle card. Each mode is a one-click jump to /stage7 with the mode
  // pre-selected via the localStorage key positioning_v2 reads on load.
  const modeGrid = h('div', { class: 'conveyor-modes' });
  const MODES = [
    { id: 'thesis',    label: 'Thesis',    desc: 'PRISMA + positioning + catalogue + top gap candidates.' },
    { id: 'paper',     label: 'Paper',     desc: 'Related-work table + positioning paragraph.' },
    { id: 'grant',     label: 'Grant',     desc: 'Top gap candidates formatted for a proposal.' },
    { id: 'landscape', label: 'Landscape', desc: 'Corpus inventory + temporal trends + central papers.' },
    { id: 'custom',    label: 'Custom',    desc: 'Structured query bar + ad-hoc detector output.' },
  ];
  let lastMode = null;
  try { lastMode = localStorage.getItem('litreview:positioning:mode') || null; } catch { /* ignore */ }
  for (const m of MODES) {
    const cls = 'conveyor-mode-card' + (lastMode === m.id ? ' conveyor-mode-card-last' : '');
    const btn = h('a', {
      class: cls,
      href: '#/stage7',
      onclick: () => {
        try { localStorage.setItem('litreview:positioning:mode', m.id); } catch { /* ignore */ }
      },
    }, [
      h('div', { class: 'conveyor-mode-label' }, [m.label]),
      h('div', { class: 'conveyor-mode-desc muted small' }, [m.desc]),
      lastMode === m.id ? h('div', { class: 'conveyor-mode-recent muted small' }, ['↻ last used']) : null,
    ]);
    modeGrid.appendChild(btn);
  }
  card.appendChild(modeGrid);

  // Secondary actions: explore corpus shape, or use the structured-query
  // / recommend tools directly.
  card.appendChild(h('div', { class: 'conveyor-card-action conveyor-idle-secondary' }, [
    h('a', { class: 'btn', href: '#/stage5' }, ['Explore corpus shape']),
    h('a', { class: 'btn', href: '#/structured' }, ['Open v2 data view']),
  ]));
  return card;
}

function renderEmptyCard() {
  const card = h('div', { class: 'conveyor-card conveyor-card-empty' });
  card.appendChild(h('div', { class: 'conveyor-card-eyebrow' }, ['Status']));
  card.appendChild(h('h2', { class: 'conveyor-card-title' }, ['Nothing pending']));
  card.appendChild(h('p', { class: 'conveyor-card-detail' }, [
    'No action queued and no deliverables yet. Switch to Advanced view in the topbar to access individual stages.',
  ]));
  return card;
}
