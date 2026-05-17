// Persistent stage rail under the topbar.
//
// Always-visible row of pipeline-stage chips (Setup → Search → Triage →
// Download → Deep read → Corpus shape → Positioning → Loop close). Each
// chip carries a status icon (✓ done, ◆ current, · idle/locked) and is
// a direct link to its stage route. The rail renders on every route —
// home/conveyor and heavy-editor takeovers alike — so the student can
// jump anywhere without flipping advanced view or hunting menus.
//
// Status sources:
//   - GET /api/status      — per-stage `done` booleans
//   - GET /api/conveyor/next — the top action's href identifies the
//                             "current" stage (highlighted with ◆)
//
// "Active" (current route) is derived from `location.hash` so the chip
// for the page you're on glows even if it's not the system-picked
// current stage.

import { h } from '../lib/dom.mjs';

const STAGES = [
  { key: 'setup',  href: '#/setup',  label: 'Setup' },
  { key: 'stage1', href: '#/stage1', label: 'Search' },
  { key: 'stage2', href: '#/stage2', label: 'Triage' },
  { key: 'stage3', href: '#/stage3', label: 'Download' },
  { key: 'stage4', href: '#/stage4', label: 'Deep read' },
  { key: 'stage5', href: '#/stage5', label: 'Corpus' },
  { key: 'stage7', href: '#/stage7', label: 'Positioning' },
  { key: 'stage8', href: '#/stage8', label: 'Loop close' },
  { key: 'structured', href: '#/structured', label: 'v2 Data' },
];

function isStageDone(status, key) {
  if (!status) return false;
  if (key === 'setup') {
    const s = status.setup || {};
    return !!(s.topic && s.queries && s.criteria);
  }
  return !!status[key]?.done;
}

export async function renderStageRail(root) {
  if (!root) return;

  // Fetch endpoints in parallel; failures degrade quietly to
  // "every chip neutral" rather than breaking the page. The
  // embed-daemon status surfaces as a small heartbeat badge so the
  // student knows when their notes are about to be retrievable.
  const [status, conveyor, embed] = await Promise.all([
    fetch('/api/status').then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/conveyor/next').then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/embed/status').then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);

  const currentEvent = conveyor?.current_idx >= 0
    ? conveyor.events?.[conveyor.current_idx]
    : null;
  const currentHref = currentEvent?.href || null;
  const activeHref = location.hash || '#/';

  root.innerHTML = '';
  for (const stage of STAGES) {
    const done = isStageDone(status, stage.key);
    const isCurrent = stage.href === currentHref;
    const isActive = stage.href === activeHref;

    const classes = ['rail-chip'];
    if (done) classes.push('rail-chip-done');
    if (isCurrent) classes.push('rail-chip-current');
    if (isActive) classes.push('rail-chip-active');

    const icon =
      isCurrent ? '◆' :
      done      ? '✓' :
                  '·';

    const chip = h('a', {
      href: stage.href,
      class: classes.join(' '),
      title: isCurrent ? `Current step: ${stage.label}`
           : done      ? `${stage.label} (done) — click to revisit`
                       : stage.label,
    }, [
      h('span', { class: 'rail-chip-icon' }, [icon]),
      h('span', { class: 'rail-chip-label' }, [stage.label]),
    ]);
    root.appendChild(chip);
  }

  // Embed-daemon heartbeat. Shows queue depth + running spinner when
  // the daemon is busy embedding new chunks. Stays invisible when
  // queue is empty so it doesn't add noise during quiet periods.
  // Re-fetches every 5s so the value stays fresh without forcing the
  // user to navigate between stages.
  const badgeSlot = h('span', { class: 'rail-embed-slot' });
  root.appendChild(badgeSlot);
  function paintBadge(e) {
    badgeSlot.innerHTML = '';
    if (!e) return;
    const busy = e.running || e.queue_size > 0 || e.inflight > 0;
    if (!busy) return;
    const badge = h('span', {
      class: 'rail-embed-badge' + (e.running ? ' running' : ''),
      title: `Embedder ${e.running ? 'running' : 'idle'} · queue ${e.queue_size} · inflight ${e.inflight}`,
    }, [
      h('span', { class: 'rail-embed-dot' }, [e.running ? '●' : '○']),
      h('span', { class: 'rail-embed-count' }, [
        e.queue_size > 0 ? `${e.queue_size} queued` : 'idle',
      ]),
    ]);
    badgeSlot.appendChild(badge);
  }
  paintBadge(embed);
  // Clear any previous interval (re-render replaces root contents).
  if (root.__embedTick) clearInterval(root.__embedTick);
  root.__embedTick = setInterval(async () => {
    if (!root.isConnected) {
      clearInterval(root.__embedTick);
      return;
    }
    try {
      const r = await fetch('/api/embed/status');
      paintBadge(r.ok ? await r.json() : null);
    } catch { /* keep last paint */ }
  }, 5000);
}
