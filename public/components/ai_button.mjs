// "✨ Suggest" button. Disabled when no model is loaded. Streams output to a
// caller-provided handler. Shows a small inline spinner during inference.

import { h } from '../lib/dom.mjs';
import * as llm from '../lib/llm.mjs';

export function aiSuggestButton({ label = '✨ Suggest', system, buildPrompt, onResult, onToken, temperature = 0.7 } = {}) {
  const btn = h('button', {
    class: 'btn btn-ai',
    type: 'button',
  }, [label]);

  let inflight = null;

  function refresh() {
    const s = llm.status();
    if (inflight) {
      btn.disabled = true;
      return;
    }
    if (!s.loaded) {
      btn.disabled = true;
      btn.title = s.available
        ? 'Enable AI in the topbar to use this'
        : 'WebGPU is not available in this browser';
    } else {
      btn.disabled = false;
      btn.title = '';
    }
  }

  llm.subscribe(refresh);
  refresh();

  btn.addEventListener('click', async () => {
    if (inflight) return;
    btn.classList.add('busy');
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> thinking…';

    try {
      const prompt = await buildPrompt();
      inflight = llm.chat({
        system,
        user: prompt,
        temperature,
        onToken,
      });
      const full = await inflight;
      onResult?.(full);
    } catch (err) {
      console.error('ai suggest failed:', err);
      onResult?.(null, err);
    } finally {
      btn.innerHTML = original;
      btn.classList.remove('busy');
      inflight = null;
      refresh();
    }
  });

  return btn;
}
