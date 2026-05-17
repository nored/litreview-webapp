// Topbar AI helper: status pill + modal that lets the student pick a
// provider and configure it.
//   Local (WebLLM)        — Node-side llama.cpp; user picks the model
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
  llm.refreshLocalRegistry();
  llm.refreshLocalStatus();
  refresh();

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

  // ---- Local-LLM panel (server-side llama.cpp) ----
  function renderWebllmPanel() {
    const s = llm.status();
    const wrap = h('div', { class: 'provider-panel' });

    wrap.appendChild(h('p', { class: 'muted small' }, [
      'Runs on the server (Node + llama.cpp, GPU-accelerated). First selection of a model downloads weights to ',
      h('code', {}, ['project/data/_models/']),
      ', cached after. The chosen model survives server restart.',
    ]));

    if (s.loading) {
      const pct = Math.round((s.progress?.progress ?? 0) * 100);
      wrap.appendChild(h('div', { class: 'progress' }, [
        h('div', { class: 'progress-bar', style: { width: `${pct}%` } }),
      ]));
      wrap.appendChild(h('p', { class: 'muted small' }, [s.progress?.text ?? 'starting…']));
    }

    if (s.error) wrap.appendChild(h('p', { class: 'error-text small' }, [`Error: ${s.error}`]));

    const registry = llm.getLocalRegistry();
    if (registry.length === 0) {
      wrap.appendChild(h('p', { class: 'muted small' }, ['Loading model registry…']));
      llm.refreshLocalRegistry();
      return wrap;
    }
    const list = h('ul', { class: 'model-list' });
    for (const m of registry) {
      const isActive = s.loaded && s.modelId === m.id;
      list.appendChild(h('li', { class: 'model-row' + (isActive ? ' active' : '') }, [
        h('div', { class: 'model-meta' }, [
          h('div', { class: 'model-name' }, [m.label]),
          h('div', { class: 'model-note muted small' }, [`~${m.size_gb} GB · ${m.speed} · ${m.description}`]),
        ]),
        h('button', {
          class: 'btn ' + (isActive ? '' : 'btn-primary'),
          disabled: isActive || s.loading,
          onclick: async () => { try { await llm.selectLocalModel(m.id); } catch (e) { console.error(e); } },
        }, [isActive ? 'active' : (s.loaded ? 'switch' : 'load')]),
      ]));
    }
    wrap.appendChild(list);
    return wrap;
  }

  // ---- OpenAI-compatible panel ----
  function renderOpenAiPanel() {
    const wrap = h('div', { class: 'provider-panel' });
    const cfg = llm.getRemoteConfig().openai;

    wrap.appendChild(h('p', { class: 'muted small' }, [
      'API key and base URL are stored at ',
      h('code', {}, ['project/data/_credentials.json']),
      ' on this machine; never sent anywhere except the endpoint below.',
    ]));

    const baseUrlInput = h('input', { type: 'text', value: cfg.base_url || '', placeholder: 'https://api.openai.com/v1' });
    const apiKeyInput  = h('input', { type: 'password', autocomplete: 'new-password', placeholder: cfg.configured ? '(set; type to replace)' : 'sk-… (or leave empty for local servers)' });
    const modelInput   = h('input', { type: 'text', value: cfg.model || '', placeholder: 'e.g. gpt-4o-mini' });
    const status       = h('span', { class: 'small' });

    // Preset chip row + per-preset instructions, embedded directly in the
    // configuration panel so the student sees the exact install steps and
    // the right base URL at the moment they're about to fill the form.
    const presetsRow = h('div', { class: 'provider-presets' });
    const instructionsBox = h('div', { class: 'provider-instructions' });

    let activePreset = detectPreset(cfg.base_url || '');

    function pickPreset(id) {
      activePreset = id;
      const p = PRESETS_OPENAI[id];
      if (p?.baseUrl) baseUrlInput.value = p.baseUrl;
      renderPresets();
    }

    function renderPresets() {
      presetsRow.innerHTML = '';
      presetsRow.appendChild(h('span', { class: 'small muted' }, ['Configure for:']));
      for (const [id, p] of Object.entries(PRESETS_OPENAI)) {
        presetsRow.appendChild(h('button', {
          type: 'button',
          class: 'preset-chip' + (activePreset === id ? ' active' : ''),
          onclick: () => pickPreset(id),
        }, [p.label]));
      }
      instructionsBox.innerHTML = '';
      const p = PRESETS_OPENAI[activePreset];
      if (p?.render) instructionsBox.appendChild(p.render());
    }
    renderPresets();

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

    wrap.appendChild(presetsRow);
    wrap.appendChild(instructionsBox);
    wrap.appendChild(field('Base URL', baseUrlInput, ''));
    wrap.appendChild(field('API key',  apiKeyInput,  ''));
    wrap.appendChild(field('Model',    modelInput,   ''));
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

    wrap.appendChild(h('div', { class: 'provider-instructions' }, [
      h('h4', {}, ['Setup']),
      h('ol', {}, [
        h('li', {}, [
          'Get an API key at ',
          h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, ['console.anthropic.com/settings/keys']),
          '. Starts with ', h('code', {}, ['sk-ant-']), '.',
        ]),
        h('li', {}, ['Paste it into the API key field below.']),
        h('li', {}, [
          'Pick a model — recommended values:',
          h('ul', {}, [
            h('li', {}, [h('code', {}, ['claude-haiku-4-5']), ' — cheap and fast, fine for triage and search-query suggestions.']),
            h('li', {}, [h('code', {}, ['claude-sonnet-4-6']), ' — balanced. Good default for note drafting.']),
            h('li', {}, [h('code', {}, ['claude-opus-4-7']), ' — best reasoning, use for synthesis and catalogue.']),
          ]),
        ]),
        h('li', {}, ['Click Save.']),
      ]),
      h('p', { class: 'muted small' }, [
        'The key never leaves your machine; it\'s stored at ',
        h('code', {}, ['project/data/_credentials.json']),
        ' (file mode 0600) and used only by the local server to talk to api.anthropic.com.',
      ]),
    ]));

    const apiKeyInput = h('input', { type: 'password', autocomplete: 'new-password', placeholder: cfg.configured ? '(set; type to replace)' : 'sk-ant-…' });
    const modelInput  = h('input', { type: 'text', value: cfg.model || '', placeholder: 'claude-haiku-4-5' });
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
    wrap.appendChild(field('Model',   modelInput,  ''));
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

// ---------------------------------------------------------------------------
// Provider presets for the OpenAI-compatible panel. Each entry knows the
// preset's base URL (auto-filled into the form) and an instructions render
// fn that shows the exact install steps + what to put in API key / Model.
// ---------------------------------------------------------------------------

const PRESETS_OPENAI = {
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    render: () => instructionsCard('Ollama (local server, GPU-accelerated, free)', [
      ['Install:'],
      ['code-block', [
        '# macOS',
        'brew install ollama',
        '',
        '# Linux',
        'curl -fsSL https://ollama.com/install.sh | sh',
        '',
        '# Windows',
        '# download installer from https://ollama.com',
      ].join('\n')],
      ['Pull a model (one of):'],
      ['code-block', [
        'ollama pull llama3.1:8b      # 4.7 GB, very capable',
        'ollama pull qwen2.5:14b      # 9 GB, strong reasoning',
        'ollama pull mistral:7b       # 4.1 GB, fast',
        'ollama pull phi3:14b         # 7.9 GB',
      ].join('\n')],
      ['Then in the form below:'],
      ['kv', 'Base URL', 'http://localhost:11434/v1 (filled in)'],
      ['kv', 'API key', 'leave empty'],
      ['kv', 'Model', 'the id you pulled, e.g. llama3.1:8b'],
      ['Click Save, then Test connection — should say "endpoint healthy" with your pulled models listed.'],
    ]),
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    render: () => instructionsCard('OpenAI', [
      ['Get an API key at ', linkOut('platform.openai.com/api-keys', 'https://platform.openai.com/api-keys'), '. Starts with ', ['code', 'sk-'], '.'],
      ['Then in the form below:'],
      ['kv', 'Base URL', 'https://api.openai.com/v1 (filled in)'],
      ['kv', 'API key', 'your sk-… key'],
      ['kv', 'Model', 'gpt-4o-mini (cheap), gpt-4o (better), o1-mini (reasoning)'],
    ]),
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    render: () => instructionsCard('OpenRouter (one key, many providers)', [
      ['Get an API key at ', linkOut('openrouter.ai/keys', 'https://openrouter.ai/keys'), '. Starts with ', ['code', 'sk-or-'], '.'],
      ['Then in the form below:'],
      ['kv', 'Base URL', 'https://openrouter.ai/api/v1 (filled in)'],
      ['kv', 'API key', 'your sk-or-… key'],
      ['kv', 'Model', 'vendor/model format, e.g. anthropic/claude-haiku-4-5, meta-llama/llama-3.3-70b-instruct, google/gemini-2.0-flash-exp, mistralai/mistral-large'],
      ['Browse models and pricing: ', linkOut('openrouter.ai/models', 'https://openrouter.ai/models')],
    ]),
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    render: () => instructionsCard('Groq (very fast open-weight inference, free tier)', [
      ['Get an API key at ', linkOut('console.groq.com/keys', 'https://console.groq.com/keys'), '. Starts with ', ['code', 'gsk_'], '.'],
      ['Then in the form below:'],
      ['kv', 'Base URL', 'https://api.groq.com/openai/v1 (filled in)'],
      ['kv', 'API key', 'your gsk_… key'],
      ['kv', 'Model', 'llama-3.3-70b-versatile, mixtral-8x7b-32768, or gemma2-9b-it'],
    ]),
  },
  together: {
    label: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    render: () => instructionsCard('Together AI', [
      ['Get an API key at ', linkOut('api.together.xyz/settings/api-keys', 'https://api.together.xyz/settings/api-keys'), '.'],
      ['Then in the form below:'],
      ['kv', 'Base URL', 'https://api.together.xyz/v1 (filled in)'],
      ['kv', 'API key', 'your Together key'],
      ['kv', 'Model', 'e.g. meta-llama/Llama-3.3-70B-Instruct-Turbo, mistralai/Mixtral-8x22B-Instruct-v0.1'],
    ]),
  },
  lmstudio: {
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    render: () => instructionsCard('LM Studio (local GUI for models)', [
      ['Download from ', linkOut('lmstudio.ai', 'https://lmstudio.ai'), '. Cross-platform.'],
      ['In LM Studio: search for a model in the Discover tab, click Download. Any GGUF works.'],
      ['Open the Developer tab and click Start Server. Default port is 1234.'],
      ['Then in the form below:'],
      ['kv', 'Base URL', 'http://localhost:1234/v1 (filled in)'],
      ['kv', 'API key', 'leave empty'],
      ['kv', 'Model', 'any string — LM Studio serves one model at a time'],
    ]),
  },
  vllm: {
    label: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    render: () => instructionsCard('vLLM (self-hosted high-throughput inference)', [
      ['Install and run:'],
      ['code-block', [
        'pip install vllm',
        'vllm serve meta-llama/Llama-3.1-8B-Instruct --port 8000',
      ].join('\n')],
      ['Then in the form below:'],
      ['kv', 'Base URL', 'http://localhost:8000/v1 (filled in; replace localhost if running on another host)'],
      ['kv', 'API key', 'leave empty (unless you put auth in front)'],
      ['kv', 'Model', 'the model id you passed to vllm serve, e.g. meta-llama/Llama-3.1-8B-Instruct'],
    ]),
  },
  llamacpp: {
    label: 'llama.cpp',
    baseUrl: 'http://localhost:8080/v1',
    render: () => instructionsCard('llama.cpp server (bare-metal local)', [
      ['Build and run:'],
      ['code-block', [
        'git clone https://github.com/ggerganov/llama.cpp',
        'cd llama.cpp && make',
        './server -m /path/to/model.gguf -c 4096 --port 8080',
      ].join('\n')],
      ['Then in the form below:'],
      ['kv', 'Base URL', 'http://localhost:8080/v1 (filled in)'],
      ['kv', 'API key', 'leave empty'],
      ['kv', 'Model', 'any string — only one model loaded at a time'],
    ]),
  },
};

// Guess which preset matches an already-saved base URL so the chip
// highlights the right one when the modal re-opens.
function detectPreset(baseUrl) {
  if (!baseUrl) return 'ollama';
  for (const [id, p] of Object.entries(PRESETS_OPENAI)) {
    if (p.baseUrl === baseUrl) return id;
  }
  // Heuristic fallbacks for partial matches.
  if (/openai\.com/i.test(baseUrl)) return 'openai';
  if (/openrouter/i.test(baseUrl)) return 'openrouter';
  if (/groq/i.test(baseUrl)) return 'groq';
  if (/together/i.test(baseUrl)) return 'together';
  if (/:11434/.test(baseUrl)) return 'ollama';
  if (/:1234/.test(baseUrl)) return 'lmstudio';
  if (/:8000/.test(baseUrl)) return 'vllm';
  if (/:8080/.test(baseUrl)) return 'llamacpp';
  return 'openai';
}

// Build an instructions card from a compact spec. Each item is either:
//   - string                            → a paragraph
//   - ['code-block', text]              → a fenced code block
//   - ['kv', label, value]              → a key/value row
//   - ['code', text]                    → inline code
//   - array of nested specs/strings     → paragraph with mixed content
function instructionsCard(title, items) {
  const children = [h('h4', {}, [title])];
  for (const item of items) {
    children.push(renderSpec(item));
  }
  return h('div', { class: 'instructions-card' }, children);
}

function renderSpec(item) {
  if (typeof item === 'string') return h('p', {}, [item]);
  if (!Array.isArray(item)) return item; // already an h() node
  if (item[0] === 'code-block') {
    return h('pre', { class: 'code-block' }, [h('code', {}, [item[1]])]);
  }
  if (item[0] === 'code') {
    return h('code', {}, [item[1]]);
  }
  if (item[0] === 'kv') {
    return h('div', { class: 'kv-row' }, [
      h('span', { class: 'kv-label' }, [item[1]]),
      h('span', { class: 'kv-value' }, [item[2]]),
    ]);
  }
  // Mixed inline content
  return h('p', {}, item.map(renderSpec));
}

function linkOut(label, href) {
  return h('a', { href, target: '_blank', rel: 'noopener' }, [label]);
}
