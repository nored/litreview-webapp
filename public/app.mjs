// Tiny client-side router and view harness.
//
// Default mode is "the conveyor" — the home route `#/` renders a guided
// thread that decides what the user should do next. Sidebar is hidden.
//
// Legacy mode is opt-in via the topbar "Advanced view" toggle, which
// flips a localStorage flag (`litreview.advanced = '1'`). When set, the
// sidebar reappears with all seven stage links and bookmarkable stage
// URLs continue to work as before. Both modes can use the same stage
// view code; only the chrome changes.

import { renderConveyor } from './views/conveyor.mjs';
import { renderSetup } from './views/setup.mjs';
import { renderStage1 } from './views/stage1.mjs';
import { renderStage2 } from './views/stage2.mjs';
import { renderStage3 } from './views/stage3.mjs';
import { renderStage4 } from './views/stage4.mjs';
import { renderStage5 } from './views/stage5.mjs';
import { renderStage7 } from './views/stage7.mjs';
import { renderStage8 } from './views/stage8.mjs';
import { mountAiStatus } from './components/ai_status.mjs';

const ROUTES = {
  '#/':       () => renderConveyor(viewEl),
  '#/setup':  () => renderSetup(viewEl),
  '#/stage1': () => renderStage1(viewEl),
  '#/stage2': () => renderStage2(viewEl),
  '#/stage3': () => renderStage3(viewEl),
  '#/stage4': () => renderStage4(viewEl),
  '#/stage5': () => renderStage5(viewEl),
  '#/stage6': () => { location.hash = '#/stage5'; return null; },
  '#/stage7': () => renderStage7(viewEl),
  '#/stage8': () => renderStage8(viewEl),
};

const viewEl = document.getElementById('view');
const sidebar = document.getElementById('sidebar');

const LS_ADVANCED = 'litreview.advanced';

function isAdvancedMode() {
  try { return localStorage.getItem(LS_ADVANCED) === '1'; } catch { return false; }
}
function setAdvancedMode(on) {
  try {
    if (on) localStorage.setItem(LS_ADVANCED, '1');
    else localStorage.removeItem(LS_ADVANCED);
  } catch { /* ignore */ }
  applyAdvancedMode();
}

// Show/hide the sidebar based on mode. In conveyor mode the sidebar
// disappears entirely; the view fills the available space. In advanced
// mode it returns with the seven stage links.
function applyAdvancedMode() {
  const advanced = isAdvancedMode();
  document.body.classList.toggle('mode-advanced', advanced);
  document.body.classList.toggle('mode-conveyor', !advanced);
}

async function refreshSidebarStatus() {
  if (!isAdvancedMode()) return;  // sidebar is hidden anyway
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const status = await res.json();
    const setupDone = status.setup.topic && status.setup.queries && status.setup.criteria;
    const map = {
      setup: setupDone,
      stage1: status.stage1.done,
      stage2: status.stage2.done,
      stage3: status.stage3.done,
      stage4: status.stage4?.done,
      stage5: status.stage5.done,
      stage7: status.stage7.done,
    };
    sidebar.querySelectorAll('a[data-stage]').forEach((link) => {
      const key = link.dataset.stage;
      link.dataset.status = map[key] ? 'done' : 'pending';
    });
  } catch {
    /* ignore status errors */
  }
}

const TITLES = {
  '#/':       'Literature review',
  '#/setup':  'Setup',
  '#/stage1': '1. Search',
  '#/stage2': '2. Triage',
  '#/stage3': '3. Download',
  '#/stage4': '4. Deep read',
  '#/stage5': '5. Corpus shape',
  '#/stage7': '6. Positioning & catalogue',
  '#/stage8': '7. Loop close',
};

// Linear stage order. Used to render the "next stage" strip at the
// bottom of every non-overview view. The top strip always goes back to
// overview (`#/`), so we don't need a prev mapping — the overview is
// the natural anchor.
const STAGE_ORDER = [
  '#/setup', '#/stage1', '#/stage2', '#/stage3', '#/stage4',
  '#/stage5', '#/stage7', '#/stage8',
];
function nextStage(route) {
  const i = STAGE_ORDER.indexOf(route);
  if (i < 0) return null;
  return STAGE_ORDER[i + 1] || null; // null = no next; we'll send back to overview
}

function activateNav() {
  const route = location.hash || '#/';
  sidebar.querySelectorAll('a[data-stage]').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === route);
  });
}

let currentCleanup = null;

async function render() {
  const route = location.hash || '#/';
  if (!location.hash) {
    location.hash = '#/';
    return;
  }
  activateNav();
  const handler = ROUTES[route] ?? ROUTES['#/'];

  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch (e) { console.warn('view cleanup error:', e); }
    currentCleanup = null;
  }

  viewEl.innerHTML = '';
  viewEl.className = 'view';
  document.title = (TITLES[route] ? TITLES[route] + ' · ' : '') + 'Literature Review Pipeline';
  const result = await handler();
  if (typeof result === 'function') currentCleanup = result;
  refreshSidebarStatus();
  applyOverviewVisibility();
  injectStageNavStrips(route);
}

// Top + bottom navigation strips for stage views. The top strip is
// always "↑ Back to overview" — the overview is the canonical anchor.
// The bottom strip points at the next stage in linear order, or back
// to the overview if there is no next stage. Both strips briefly pulse
// on mount as a hint that they're clickable (one-shot CSS animation).
function injectStageNavStrips(route) {
  if (!route || route === '#/') return;
  const next = nextStage(route);
  const nextHref = next || '#/';
  const nextLabel = next ? `Next: ${TITLES[next] || next}` : '✓ Done — back to overview';

  // Top: back to overview.
  const top = document.createElement('a');
  top.href = '#/';
  top.className = 'stage-nav-strip stage-nav-top';
  top.innerHTML = `<span class="stage-nav-arrow">↑</span><span>Back to overview</span>`;

  // Bottom: next stage (or back to overview when done).
  const bottom = document.createElement('a');
  bottom.href = nextHref;
  bottom.className = 'stage-nav-strip stage-nav-bottom';
  bottom.innerHTML = `<span>${nextLabel}</span><span class="stage-nav-arrow">↓</span>`;

  viewEl.insertBefore(top, viewEl.firstChild);
  viewEl.appendChild(bottom);
}

// Note: the topbar "← Overview" button was removed once stage views
// gained their own top/bottom navigation strips. The brand text in the
// header stays a home link as a quiet fallback. Keeping these stubs so
// the existing call sites don't need to change.
function mountOverviewLink() { /* no-op — strips replace this */ }
function applyOverviewVisibility() { /* no-op */ }

// Topbar "Advanced view" toggle. Mounted on DOMContentLoaded.
function mountAdvancedToggle() {
  const slot = document.querySelector('.topbar-actions');
  if (!slot) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'topbar-advanced-toggle';
  btn.textContent = isAdvancedMode() ? '✕ Advanced view' : '⚙ Advanced view';
  btn.title = 'Toggle the seven-stage sidebar view. Default is the guided conveyor.';
  btn.addEventListener('click', () => {
    setAdvancedMode(!isAdvancedMode());
    btn.textContent = isAdvancedMode() ? '✕ Advanced view' : '⚙ Advanced view';
    refreshSidebarStatus();
  });
  slot.appendChild(btn);
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', () => {
  applyAdvancedMode();
  const aiSlot = document.querySelector('.topbar-actions');
  if (aiSlot) mountAiStatus(aiSlot);
  mountOverviewLink();
  mountAdvancedToggle();
  refreshSidebarStatus();
  render();
});

// Expose a simple bus for views that want to trigger a status refresh after save.
window.litreview = {
  refreshStatus: refreshSidebarStatus,
};
