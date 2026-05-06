// Topbar AI helper: status pill + modal that lets the student pick a
// provider and configure it.
//   Local (WebLLM)        — runs in browser, no key, slowest
//   OpenAI-compatible     — proxied through server (Ollama, OpenAI, …)
//   Anthropic Claude      — proxied through server

import { h } from '../lib/dom.mjs';
import * as llm from '../lib/llm.mjs';

export function mountAiStatus(rootEl) {
  let modal = null;

  const button = h('button', {
    class: 'ai-toggle btn btn-ghost',
    type: 'button',
    onclick: openModal,
  }, ['AI: off']);

  rootEl.appendChild(button);
  llm.subscribe(refresh);
  llm.refreshRemoteConfig();
  refresh();

  // Auto-load WebLLM if that's the active provider and we have a saved choice.
  const auto = llm.getAutoLoadPref();
  if (llm.getProvider() === 'webllm' && auto && llm.isWebGPUAvailable() && !llm.status().loaded) {
    llm.loadModel(auto).catch((err) => console.warn('auto-load failed:', err.message));
  }

  function refresh() {
    const s = llm.status();
    button.classList.remove('loading', 'ready', 'error');
    if (s.loading) {
      const pct = Math.round((s.progress?.progress ?? 0) * 100);
      button.textContent = `AI: loading ${pct}%`;
      button.classList.add('loading');
    } else if (s.loaded) {
      const tag =
        s.provider === 'openai' ? 'OpenAI' :
        s.provider === 'anthropic' ? 'Claude' : 'Local';
      button.textContent = `AI: ${tag} · ${s.displayName ?? 'ready'}`;
      button.classList.add('ready');
    } else if (s.error && s.provider === 'webllm') {
      button.textContent = 'AI: error';
      button.classList.add('error');
    } else {
      const label =
        s.provider === 'webllm'
          ? (s.available ? 'AI: off' : 'AI: unavailable')
          : `AI: ${s.provider} (configure)`;
      button.textContent = label;
    }
    if (modal) renderModal();
  }

  function openModal() {
    if (modal) return;
    modal = h('div', {
      class: 'modal-backdrop',
      onclick: (e) => { if (e.target === modal) closeModal(); },
    }, [
      h('div', { class: 'modal modal-wide' }, [
        h('div', { class: 'modal-header' }, [
          h('h2', {}, ['AI helper']),
          h('button', { class: 'btn btn-ghost', onclick: closeModal }, ['×']),
        ]),
        h('div', { class: 'modal-body', id: 'ai-modal-body' }),
      ]),
    ]);
    document.body.appendChild(modal);
    llm.refreshRemoteConfig();
    renderModal();
  }
  function closeModal() { modal?.remove(); modal = null; }

  function renderModal() {
    if (!modal) return;
    const body = modal.querySelector('#ai-modal-body');
    body.innerHTML = '';
    body.appendChild(renderProviderTabs());
    const provider = llm.getProvider();
    if (provider === 'webllm') body.appendChild(renderWebllmPanel());
    else if (provider === 'openai') body.appendChild(renderOpenAiPanel());
    else if (provider === 'anthropic') body.appendChild(renderAnthropicPanel());
  }

  function renderProviderTabs() {
    const cur = llm.getProvider();
    const tabs = [
      { id: 'webllm',    label: 'Local (WebLLM)' },
      { id: 'openai',    label: 'OpenAI-compatible' },
      { id: 'anthropic', label: 'Anthropic Claude' },
    ];
    return h('div', { class: 'tabs' },
      tabs.map((t) => h('button', {
        class: 'tab' + (cur === t.id ? ' active' : ''),
        onclick: () => { llm.setProvider(t.id); renderModal(); refresh(); },
      }, [t.label]))
    );
  }

  // ---- WebLLM panel (existing flow) ----
  function renderWebllmPanel() {
    const s = llm.status();
    const wrap = h('div', { class: 'provider-panel' });

    if (!s.available) {
      wrap.appendChild(h('p', { class: 'muted' }, [
        'WebGPU is not available in this browser. Try Chrome, Edge, or Safari Technology Preview, ',
        'or use a remote provider in the other tabs.',
      ]));
      return wrap;
    }

    wrap.appendChild(h('p', { class: 'muted small' }, [
      'Runs entirely in your browser. First load downloads weights (cached after).',
    ]));

    if (s.loading) {
      const pct = Math.round((s.progress?.progress ?? 0) * 100);
      wrap.appendChild(h('div', { class: 'progress' }, [
        h('div', { class: 'progress-bar', style: { width: `${pct}%` } }),
      ]));
      wrap.appendChild(h('p', { class: 'muted small' }, [s.progress?.text ?? 'starting…']));
      return wrap;
    }

    if (s.error) wrap.appendChild(h('p', { class: 'error-text small' }, [`Error: ${s.error}`]));

    const list = h('ul', { class: 'model-list' });
    for (const m of llm.WEBLLM_MODELS) {
      const isActive = s.loaded && s.modelId === m.id;
      list.appendChild(h('li', { class: 'model-row' + (isActive ? ' active' : '') }, [
        h('div', { class: 'model-meta' }, [
          h('div', { class: 'model-name' }, [m.label]),
          h('div', { class: 'model-note muted small' }, [`${m.size} · ${m.note}`]),
        ]),
        h('button', {
          class: 'btn ' + (isActive ? '' : 'btn-primary'),
          disabled: isActive,
          onclick: async () => { try { await llm.loadModel(m.id); } catch (e) { console.error(e); } },
        }, [isActive ? 'active' : (s.loaded ? 'switch' : 'load')]),
      ]));
    }
    wrap.appendChild(list);

    const auto = llm.getAutoLoadPref();
    wrap.appendChild(h('div', { class: 'auto-load-row' }, [
      h('label', { class: 'small muted' }, [
        h('input', {
          type: 'checkbox', checked: !!auto,
          onchange: (e) => {
            if (e.target.checked) { if (s.modelId) llm.setAutoLoadPref(s.modelId); }
            else llm.clearAutoLoadPref();
          },
        }),
        ' Auto-load on every page open',
      ]),
    ]));
    return wrap;
  }

  // ---- OpenAI-compatible panel ----
  function renderOpenAiPanel() {
    const wrap = h('div', { class: 'provider-panel' });
    const cfg = llm.getRemoteConfig().openai;

    wrap.appendChild(h('p', { class: 'muted small' }, [
      'Works with OpenAI, Ollama, OpenRouter, vLLM, Groq, Together, LM Studio, llama.cpp server. ',
      'API key (if any) and base URL are stored at ',
      h('code', {}, ['data/_credentials.json']),
      ' on this machine; never sent anywhere except the configured endpoint.',
    ]));

    const baseUrlInput = h('input', { type: 'text', value: cfg.base_url || '', placeholder: 'https://api.openai.com/v1   (or http://localhost:11434/v1 for Ollama)' });
    const apiKeyInput  = h('input', { type: 'password', autocomplete: 'new-password', placeholder: cfg.configured ? '(set; type to replace)' : 'sk-… or empty for Ollama' });
    const modelInput   = h('input', { type: 'text', value: cfg.model || '', placeholder: 'e.g. gpt-4o-mini, llama3.2:3b, qwen2.5:7b' });
    const status       = h('span', { class: 'small' });

    async function save() {
      status.textContent = 'saving…'; status.className = 'small muted';
      const body = {
        openai_base_url: baseUrlInput.value.trim(),
        openai_model: modelInput.value.trim(),
      };
      if (apiKeyInput.value) body.openai_api_key = apiKeyInput.value;
      const res = await fetch('/api/credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        status.textContent = 'saved'; status.className = 'small hint-good';
        apiKeyInput.value = '';
        await llm.refreshRemoteConfig();
        renderModal();
        refresh();
      } else {
        status.textContent = 'save failed'; status.className = 'small error-text';
      }
    }
    async function probe() {
      // Save the form values first so the probe always tests the latest
      // base_url / api_key / model the student typed. Without this, a user
      // who typed Ollama's URL but didn't click Save would silently probe
      // OpenAI's default endpoint and get a confusing 401.
      status.textContent = 'saving…'; status.className = 'small muted';
      await save();
      status.textContent = 'probing…'; status.className = 'small muted';
      const r = await fetch('/api/llm/probe/openai').then((x) => x.json());
      if (r.ok) {
        const n = r.models.length;
        status.innerHTML = `<span class="hint-good">connected to ${baseUrlInput.value || 'https://api.openai.com/v1'}</span>` +
          (n > 0 ? ` — ${n} model${n > 1 ? 's' : ''} available` : ' — no models pulled yet (try: ollama pull llama3.2:3b)');
      } else {
        const url = baseUrlInput.value || 'https://api.openai.com/v1 (default)';
        status.innerHTML = `<span class="error-text">probe failed: ${r.error}</span> · target: <code>${url}</code>`;
      }
    }

    wrap.appendChild(field('Base URL', baseUrlInput, 'OpenAI default: https://api.openai.com/v1 · Ollama: http://localhost:11434/v1'));
    wrap.appendChild(field('API key',  apiKeyInput,  'Leave blank for keyless endpoints (Ollama, vLLM with no auth)'));
    wrap.appendChild(field('Model',    modelInput,   'For Ollama, pull the model first: `ollama pull llama3.2:3b`'));
    wrap.appendChild(h('div', { class: 'inline-row' }, [
      h('button', { class: 'btn btn-primary', onclick: save }, ['Save']),
      h('button', { class: 'btn', onclick: probe }, ['Test connection']),
      status,
    ]));
    return wrap;
  }

  // ---- Anthropic panel ----
  function renderAnthropicPanel() {
    const wrap = h('div', { class: 'provider-panel' });
    const cfg = llm.getRemoteConfig().anthropic;

    wrap.appendChild(h('p', { class: 'muted small' }, [
      'Anthropic Claude API, proxied through this local server so the API key stays in ',
      h('code', {}, ['data/_credentials.json']),
      '. Never sent anywhere except api.anthropic.com.',
    ]));

    const apiKeyInput = h('input', { type: 'password', autocomplete: 'new-password', placeholder: cfg.configured ? '(set; type to replace)' : 'sk-ant-…' });
    const modelInput  = h('input', { type: 'text', value: cfg.model || '', placeholder: 'e.g. claude-haiku-4-5, claude-sonnet-4-5' });
    const status      = h('span', { class: 'small' });

    async function save() {
      status.textContent = 'saving…'; status.className = 'small muted';
      const body = { anthropic_model: modelInput.value.trim() };
      if (apiKeyInput.value) body.anthropic_api_key = apiKeyInput.value;
      const res = await fetch('/api/credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        status.textContent = 'saved'; status.className = 'small hint-good';
        apiKeyInput.value = '';
        await llm.refreshRemoteConfig();
        renderModal();
        refresh();
      } else {
        status.textContent = 'save failed'; status.className = 'small error-text';
      }
    }

    wrap.appendChild(field('API key', apiKeyInput, ''));
    wrap.appendChild(field('Model',   modelInput,  'Recommended: claude-haiku-4-5 (fast, cheap) or claude-sonnet-4-5 (better quality)'));
    wrap.appendChild(h('div', { class: 'inline-row' }, [
      h('button', { class: 'btn btn-primary', onclick: save }, ['Save']),
      status,
    ]));
    return wrap;
  }

  function field(label, input, hint) {
    return h('div', { class: 'field' }, [
      h('label', {}, [label]),
      input,
      hint ? h('span', { class: 'hint small' }, [hint]) : null,
    ]);
  }
}
