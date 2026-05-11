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
}

// Topbar "← Overview" button. Mounted at DOMContentLoaded; shows only
// when we're inside a stage view (i.e. NOT on `#/`). The brand is also
// a home link, but this is the loud, obvious escape hatch.
let overviewBtn = null;
function mountOverviewLink() {
  const slot = document.querySelector('.topbar-actions');
  if (!slot) return;
  overviewBtn = document.createElement('a');
  overviewBtn.href = '#/';
  overviewBtn.className = 'topbar-overview-link';
  overviewBtn.textContent = '← Overview';
  overviewBtn.title = 'Back to the guided overview';
  // Insert at the start of topbar-actions so it sits left of the AI pill.
  slot.insertBefore(overviewBtn, slot.firstChild);
  applyOverviewVisibility();
}
function applyOverviewVisibility() {
  if (!overviewBtn) return;
  const onHome = !location.hash || location.hash === '#/';
  overviewBtn.style.display = onHome ? 'none' : '';
}

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
