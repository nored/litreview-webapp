// The conveyor — the new opinionated default home view.
//
// Renders the pipeline state as a vertical thread of event cards:
//   - completed milestones above (small, green, ✓)
//   - soft warnings inline (yellow, dismissable-feeling but persistent)
//   - the one active step prominent in the middle with a big button
//   - hard gates (refusals) as red banners that block everything below
//   - locked future steps as ghost cards
//
// The user reads top-to-bottom and the next action is unambiguous. No
// sidebar, no tabs. Power users can flip to Advanced view (legacy
// sidebar with all 7 stage URLs) via the topbar link.
//
// This view refetches the conveyor state on every navigation back to
// `#/` and on focus, so completing work in a stage view and returning
// here lands you on whatever's next without manual refresh.

import { h } from '../lib/dom.mjs';

export async function renderConveyor(root) {
  root.innerHTML = '<h1 class="conveyor-title">Literature review</h1><div class="placeholder">checking pipeline state…</div>';

  let data;
  try {
    data = await fetch('/api/conveyor/next').then((r) => r.json());
    if (data.error) throw new Error(data.error);
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('h1', { class: 'conveyor-title' }, ['Literature review']));
    root.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('strong', {}, ['Could not load pipeline state. ']),
      err.message,
    ]));
    return;
  }

  const { events, current_idx, summary } = data;

  root.innerHTML = '';
  root.classList.add('view-conveyor');

  // Header — a quiet status strip, not a title bar. Tells the user
  // where they are in the project without screaming.
  root.appendChild(renderHeader(summary, events));

  // Thread of event cards. Stacked vertically; each card knows its own
  // status and renders accordingly.
  const thread = h('div', { class: 'conveyor-thread' });
  events.forEach((event, idx) => {
    thread.appendChild(renderEventCard(event, idx, current_idx, summary));
  });
  root.appendChild(thread);

  // Refetch when the user comes back to this view (e.g. after doing
  // something in a stage view) — keeps the thread current.
  const onFocus = () => {
    if (location.hash === '' || location.hash === '#/') renderConveyor(root);
  };
  window.addEventListener('focus', onFocus);
  return () => window.removeEventListener('focus', onFocus);
}

// ---------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------

function renderHeader(summary, events) {
  const allDone = events.length > 0 && events[events.length - 1].id === 'idle';
  const hasGate = events.some((e) => e.status === 'gate');

  let phaseLabel;
  if (allDone) phaseLabel = '✓ Deliverables ready';
  else if (hasGate) phaseLabel = 'Blocked — see the gate below';
  else phaseLabel = 'In progress';

  return h('div', { class: 'conveyor-header' }, [
    h('div', { class: 'conveyor-status' }, [
      h('span', { class: 'conveyor-status-phase' }, [phaseLabel]),
      h('span', { class: 'muted small' }, [
        summary?.records_identified
          ? ` · ${summary.records_identified.toLocaleString()} records · ${summary.notes_valid || 0} valid notes`
          : '',
        summary?.accepted
          ? ` · ${summary.accepted} accepted · ${summary.refinable} refinable`
          : '',
      ]),
    ]),
    h('h1', { class: 'conveyor-title' }, ['Literature review']),
  ]);
}

// ---------------------------------------------------------------------
// Event card
// ---------------------------------------------------------------------

function renderEventCard(event, idx, currentIdx, summary) {
  const isCurrent = idx === currentIdx;
  const baseClasses = ['conveyor-event', `conveyor-${event.status}`, `conveyor-kind-${event.kind}`];
  if (isCurrent) baseClasses.push('conveyor-current');

  const card = h('div', { class: baseClasses.join(' ') });

  // Status icon to the left of the title.
  const icon =
    event.status === 'done'   ? '✓' :
    event.status === 'open'   ? '◆' :
    event.status === 'gate'   ? '✗' :
    event.status === 'soft'   ? '!' :
    event.status === 'idle'   ? '★' :
    /* locked */                '○';

  const titleRow = h('div', { class: 'conveyor-event-titlerow' }, [
    h('span', { class: 'conveyor-event-icon' }, [icon]),
    h('div', { class: 'conveyor-event-title' }, [event.title]),
    event.summary
      ? h('div', { class: 'conveyor-event-summary muted small' }, [event.summary])
      : null,
  ]);
  card.appendChild(titleRow);

  if (event.detail && (isCurrent || event.kind === 'gate' || event.kind === 'soft')) {
    card.appendChild(h('div', { class: 'conveyor-event-detail' }, [event.detail]));
  }

  if (event.action && (isCurrent || event.kind === 'soft' || event.status === 'idle' || event.kind === 'gate')) {
    const btnClass = isCurrent
      ? 'btn btn-ai btn-large'
      : (event.kind === 'gate' ? 'btn btn-primary' : 'btn');
    card.appendChild(h('div', { class: 'conveyor-event-action' }, [
      h('a', { class: btnClass, href: event.action.href }, [event.action.label]),
    ]));
  }

  return card;
}
