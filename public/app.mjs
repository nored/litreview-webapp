// Tiny client-side router and view harness.

import { renderSetup } from './views/setup.mjs';
import { renderStage1 } from './views/stage1.mjs';
import { renderStage2 } from './views/stage2.mjs';
import { renderStage3 } from './views/stage3.mjs';
import { renderStage4 } from './views/stage4.mjs';
import { renderStage5 } from './views/stage5.mjs';
import { renderStage7 } from './views/stage7.mjs';
import { renderPlaceholder } from './views/placeholder.mjs';
import { mountAiStatus } from './components/ai_status.mjs';

const ROUTES = {
  '#/setup': () => renderSetup(viewEl),
  '#/stage1': () => renderStage1(viewEl),
  '#/stage2': () => renderStage2(viewEl),
  '#/stage3': () => renderStage3(viewEl),
  '#/stage4': () => renderStage4(viewEl),
  '#/stage5': () => renderStage5(viewEl),
  '#/stage6': () => { location.hash = '#/stage5'; return null; },
  '#/stage7': () => renderStage7(viewEl),
};

const viewEl = document.getElementById('view');
const sidebar = document.getElementById('sidebar');

async function refreshSidebarStatus() {
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
      stage5: status.stage5.done,
      stage7: status.stage7.done,
    };
    sidebar.querySelectorAll('a[data-stage]').forEach((link) => {
      const key = link.dataset.stage;
      if (key in map) {
        link.dataset.status = map[key] ? 'done' : 'pending';
      } else {
        link.dataset.status = 'pending';
      }
    });
  } catch {
    /* ignore status errors */
  }
}

function activateNav() {
  const route = location.hash || '#/setup';
  sidebar.querySelectorAll('a[data-stage]').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === route);
  });
}

// Each view may return a cleanup function (e.g. to remove window-level
// keyboard listeners). The router invokes it before rendering the next view
// so listeners do not leak across stages.
let currentCleanup = null;

async function render() {
  const route = location.hash || '#/setup';
  if (!location.hash) {
    location.hash = '#/setup';
    return;
  }
  activateNav();
  const handler = ROUTES[route] ?? ROUTES['#/setup'];

  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch (e) { console.warn('view cleanup error:', e); }
    currentCleanup = null;
  }

  viewEl.innerHTML = '';
  viewEl.className = 'view'; // reset any view-specific classes
  const result = await handler();
  if (typeof result === 'function') currentCleanup = result;
  refreshSidebarStatus();
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', () => {
  const aiSlot = document.querySelector('.topbar-actions');
  if (aiSlot) mountAiStatus(aiSlot);
  refreshSidebarStatus();
  render();
});

// Expose a simple bus for views that want to trigger a status refresh after save.
window.litreview = {
  refreshStatus: refreshSidebarStatus,
};
