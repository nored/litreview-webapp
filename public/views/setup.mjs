// Setup view. Structured form for protocol/topic.md with optional AI suggestions.
// Round-trips with the markdown file: parse on load, serialize on save.

import { h, debounce } from '../lib/dom.mjs';
import { parse, serialize, defaults } from '../lib/topic_md.mjs';
import { chipInput } from '../components/chip_input.mjs';
import { aiSuggestButton } from '../components/ai_button.mjs';

const SYSTEM_PROMPT = `You are an academic literature review assistant. You help students configure a thesis literature review pipeline. Be concise, concrete, and field-aware. Output exactly what is asked, no preamble, no explanations, no markdown formatting unless requested.`;

export async function renderSetup(root) {
  const [topicRes, credsRes] = await Promise.all([
    fetch('/api/protocol/topic').then((r) => r.json()),
    fetch('/api/credentials').then((r) => r.json()),
  ]);
  const data = { ...defaults(), ...parse(topicRes.content || '') };

  let dirty = false;
  const status = h('span', { class: 'status-pill saved' }, ['saved']);
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, ['Save']);

  const titleInput = h('input', { type: 'text', value: data.title, placeholder: 'A reproducible title for your topic' });
  const descTextarea = h('textarea', { rows: 5, placeholder: 'State the problem, the angle of attack, and what would make the result scientifically interesting.' }, [data.description]);
  const emailInput = h('input', { type: 'email', value: data.contact_email, placeholder: '[email protected]', required: true });
  const yearMinInput = h('input', { type: 'number', min: '1990', max: '2100', value: String(data.year_min) });
  const yearMaxInput = h('input', { type: 'text', value: data.year_max });

  const numField = (key) => h('input', { type: 'number', min: '0', max: '500', value: String(data[key]) });
  const mscTarget = numField('msc_target_includes');
  const mscMin = numField('msc_minimum_includes');
  const bscTarget = numField('bsc_target_includes');
  const bscMin = numField('bsc_minimum_includes');

  const categoryChips = chipInput({
    values: data.categories,
    placeholder: 'add a category, press Enter',
    onChange: () => markDirty(),
  });
  const methodChips = chipInput({
    values: data.method_families,
    placeholder: 'add a method family, press Enter',
    onChange: () => markDirty(),
  });

  function markDirty() {
    if (!dirty) {
      dirty = true;
      status.className = 'status-pill dirty';
      status.textContent = 'unsaved';
    }
  }

  function collect() {
    return {
      title: titleInput.value.trim(),
      description: descTextarea.value.trim(),
      categories: categoryChips.values,
      method_families: methodChips.values,
      year_min: parseInt(yearMinInput.value, 10) || 2018,
      year_max: yearMaxInput.value.trim() || 'present',
      msc_target_includes: parseInt(mscTarget.value, 10) || 50,
      msc_minimum_includes: parseInt(mscMin.value, 10) || 30,
      bsc_target_includes: parseInt(bscTarget.value, 10) || 30,
      bsc_minimum_includes: parseInt(bscMin.value, 10) || 15,
      contact_email: emailInput.value.trim(),
    };
  }

  async function save() {
    const current = collect();
    saveBtn.disabled = true;
    status.className = 'status-pill saved';
    status.textContent = 'saving…';
    try {
      const md = serialize(current);
      const res = await fetch('/api/protocol/topic', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: md }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      dirty = false;
      status.className = 'status-pill saved';
      status.textContent = 'saved';
      window.litreview?.refreshStatus?.();
    } catch (err) {
      status.className = 'status-pill error';
      status.textContent = 'save failed';
      console.error(err);
    } finally {
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', save);
  [titleInput, descTextarea, emailInput, yearMinInput, yearMaxInput, mscTarget, mscMin, bscTarget, bscMin]
    .forEach((el) => el.addEventListener('input', markDirty));

  // Validation hints
  const emailHint = h('span', { class: 'hint' }, ['used in API politeness headers']);
  const validateEmail = () => {
    const v = emailInput.value.trim();
    if (!v) {
      emailHint.textContent = 'used in API politeness headers';
      emailHint.className = 'hint';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      emailHint.textContent = 'does not look like a valid email';
      emailHint.className = 'hint hint-warn';
    } else {
      emailHint.textContent = 'looks good';
      emailHint.className = 'hint hint-good';
    }
  };
  emailInput.addEventListener('input', validateEmail);
  validateEmail();

  const categoryHint = h('span', { class: 'hint' }, []);
  const updateCategoryHint = () => {
    const n = categoryChips.values.length;
    if (n === 0) {
      categoryHint.textContent = 'add 5 to 12 categories';
      categoryHint.className = 'hint hint-warn';
    } else if (n < 5) {
      categoryHint.textContent = `${n} so far. Aim for 5 to 12.`;
      categoryHint.className = 'hint hint-warn';
    } else if (n > 12) {
      categoryHint.textContent = `${n}. That is many. Consider merging.`;
      categoryHint.className = 'hint hint-warn';
    } else {
      categoryHint.textContent = `${n} categories`;
      categoryHint.className = 'hint hint-good';
    }
  };
  const wrappedCatChange = categoryChips;
  const origCatOnChange = wrappedCatChange.values;
  // hook onChange via the original closure: re-wire by overwriting the chip input's emitter
  // simpler: observe the chip list element via MutationObserver
  new MutationObserver(updateCategoryHint).observe(categoryChips.el, { childList: true, subtree: true });
  updateCategoryHint();

  // AI suggest buttons
  const suggestDescription = aiSuggestButton({
    label: '✨ Suggest from title',
    system: SYSTEM_PROMPT,
    buildPrompt: () => {
      const title = titleInput.value.trim();
      if (!title) {
        alert('Set a title first');
        throw new Error('no title');
      }
      return `The thesis title is: "${title}".

Write a four-sentence topic description for this thesis. State:
1. The problem the thesis addresses.
2. The proposed angle of attack.
3. What makes this scientifically interesting (the unknown).
4. The intended contribution.

Be concrete. No filler. No "this thesis aims to" or "in conclusion". Plain sentences.`;
    },
    onToken: (_delta, full) => {
      descTextarea.value = full;
    },
    onResult: (full) => {
      if (full) {
        descTextarea.value = full.trim();
        markDirty();
      }
    },
  });

  const suggestCategories = aiSuggestButton({
    label: '✨ Suggest categories',
    system: SYSTEM_PROMPT,
    buildPrompt: () => {
      const title = titleInput.value.trim();
      const desc = descTextarea.value.trim();
      if (!title) {
        alert('Set a title first');
        throw new Error('no title');
      }
      return `The thesis is on: "${title}".
${desc ? `Description: ${desc}` : ''}

Suggest 7 to 10 categories that the gap matrix at stage 5 should use as row labels. Categories should distinguish between sub-types of the problem. They should be short snake_case strings. Output one per line, no numbering, no commentary, no bullets. Always include "other" as the last line.`;
    },
    onResult: (full) => {
      if (!full) return;
      const lines = full.split('\n')
        .map((l) => l.replace(/^[\s*\-\d.)]+/, '').trim())
        .map((l) => l.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''))
        .filter((l) => l && l.length < 40 && !l.includes('replace'));
      const unique = [...new Set(lines)].slice(0, 12);
      if (unique.length) {
        if (!unique.includes('other')) unique.push('other');
        categoryChips.values = unique;
        markDirty();
        updateCategoryHint();
      }
    },
  });

  // Layout
  root.innerHTML = '';
  root.appendChild(h('h1', {}, ['Setup']));
  root.appendChild(h('p', { class: 'lead' }, [
    'Configure your project. Saves to ',
    h('code', {}, ['protocol/topic.md']),
    ' on disk and round-trips with the CLI repo.',
  ]));

  const form = h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } }, [
    field('Working thesis title', [titleInput]),
    field('Topic description', [
      descTextarea,
      h('div', { class: 'field-actions' }, [suggestDescription]),
    ], '3 to 5 sentences. What problem, what angle, what makes it interesting. This is not just for the README — it is embedded and used downstream: in Stage 1 to score each search query for topic drift (off-topic queries get flagged), in Stage 2 to anchor the pre-filter against your include/exclude prototypes, and in Stage 5 for gap-detection retrieval. Write it like an abstract: concrete vocabulary, not generic phrasing.'),
    field('Topic categories', [
      categoryChips.el,
      categoryHint,
      h('div', { class: 'field-actions' }, [suggestCategories]),
    ], 'Used as gap-matrix rows. 5 to 12 labels. Distinguish what kind of problem a paper addresses within your topic.'),
    field('Method families', [methodChips.el], 'Used as gap-matrix columns. The defaults work for most empirical theses.'),
    h('div', { class: 'row-2' }, [
      field('Year window from', [yearMinInput]),
      field('to', [yearMaxInput], 'use "present" or a year'),
    ]),
    h('fieldset', { class: 'field' }, [
      h('legend', {}, ['Target literature volume']),
      h('div', { class: 'grid-2' }, [
        labelWrap('MSc target', mscTarget),
        labelWrap('MSc minimum', mscMin),
        labelWrap('BSc target', bscTarget),
        labelWrap('BSc minimum', bscMin),
      ]),
    ]),
    field('Contact email', [emailInput, emailHint], 'goes into the User-Agent header of every API request'),
    renderCredentialsSection(credsRes),
    await renderTriageThresholdsSection(),
    h('div', { class: 'form-actions' }, [saveBtn, status]),
  ]);
  root.appendChild(form);
  root.appendChild(renderResetSection());
}

// Stage 2 embedding pre-filter thresholds. Stored in
// project/data/_triage_thresholds.json, separate from topic.md so the
// CLI tool doesn't need to know about them.
async function renderTriageThresholdsSection() {
  let current;
  try {
    current = await fetch('/api/triage/thresholds').then((r) => r.json());
  } catch {
    current = { include_threshold: 0.65, exclude_threshold: 0.65, margin_threshold: 0.10 };
  }

  const status = h('span', { class: 'hint small' }, ['']);

  function makeSlider(key, min, max, hint) {
    const valueLabel = h('span', { class: 'mono' }, [Number(current[key]).toFixed(2)]);
    const slider = h('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: '0.01',
      value: String(current[key]),
      style: { width: '180px' },
    });
    slider.addEventListener('input', () => {
      current[key] = Number(slider.value);
      valueLabel.textContent = Number(slider.value).toFixed(2);
      status.className = 'hint small';
      status.textContent = '';
    });
    return h('div', { class: 'threshold-row' }, [
      h('div', { class: 'threshold-row-head' }, [
        h('span', { class: 'threshold-label' }, [keyLabel(key)]),
        slider,
        valueLabel,
      ]),
      h('span', { class: 'hint small' }, [hint]),
    ]);
  }

  const incRow = makeSlider(
    'include_threshold', 0.50, 0.95,
    'Minimum cosine to the include prototype required to auto-include.',
  );
  const excRow = makeSlider(
    'exclude_threshold', 0.50, 0.95,
    'Minimum cosine to the exclude prototype required to auto-exclude.',
  );
  const marRow = makeSlider(
    'margin_threshold', 0.00, 0.40,
    'How much closer to the winning prototype the candidate must be. Filters out "this paper is on-topic for both" cases.',
  );

  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, ['Save thresholds']);
  saveBtn.addEventListener('click', async () => {
    try {
      saveBtn.disabled = true;
      const r = await fetch('/api/triage/thresholds', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(current),
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      status.className = 'hint hint-good small';
      status.textContent = 'saved';
    } catch (err) {
      status.className = 'hint hint-warn small';
      status.textContent = 'save failed: ' + err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  const resetBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, ['Reset to defaults']);
  resetBtn.addEventListener('click', async () => {
    current = { include_threshold: 0.65, exclude_threshold: 0.65, margin_threshold: 0.10 };
    // Re-render the inputs so the user sees the change. Cheapest route:
    // re-fire the input events on each slider.
    const sliders = wrapper.querySelectorAll('input[type=range]');
    sliders[0].value = '0.65';
    sliders[1].value = '0.65';
    sliders[2].value = '0.10';
    sliders.forEach((s) => s.dispatchEvent(new Event('input')));
  });

  const wrapper = h('fieldset', { class: 'field' }, [
    h('legend', {}, ['Triage pre-filter thresholds']),
    h('p', { class: 'hint' }, [
      'Embedding pre-filter scores pending papers against your include/exclude prototype centroids in Stage 2. ',
      'Cosine scores in same-genre English text live roughly in 0.4–0.95; the noise floor is ~0.55, so values below 0.65 are unreliable as decision floors.',
    ]),
    incRow,
    excRow,
    marRow,
    h('div', { class: 'form-actions' }, [saveBtn, resetBtn, status]),
  ]);
  return wrapper;
}

function keyLabel(key) {
  return ({
    include_threshold: 'Include floor',
    exclude_threshold: 'Exclude floor',
    margin_threshold: 'Margin',
  })[key] || key;
}

function renderResetSection() {
  const status = h('span', { class: 'hint small' }, []);
  const keepEmail = h('input', { type: 'checkbox', checked: true });
  const keepCreds = h('input', { type: 'checkbox', checked: true });

  const btn = h('button', {
    class: 'btn btn-danger', type: 'button',
    onclick: async () => {
      const msg =
        'This wipes ALL stage data:\n' +
        '  • search results, triage decisions, AI suggestions\n' +
        '  • downloaded PDFs, deep-read notes, synthesis artifacts\n' +
        '  • job manifests for in-flight runs\n\n' +
        'It also resets your topic, queries, and inclusion criteria to defaults.\n\n' +
        (keepEmail.checked ? 'Email will be preserved.\n' : 'Email will be cleared.\n') +
        (keepCreds.checked ? 'API key will be preserved.\n' : 'API key will be cleared.\n') +
        '\nProceed? Type RESET below to confirm.';
      const typed = prompt(msg, '');
      if (typed !== 'RESET') {
        if (typed != null) alert('Not reset (you must type RESET exactly).');
        return;
      }
      btn.disabled = true;
      status.className = 'hint small';
      status.textContent = 'resetting…';
      try {
        const res = await fetch('/api/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confirm: true,
            keep_email: keepEmail.checked,
            keep_credentials: keepCreds.checked,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        status.className = 'hint hint-good small';
        status.textContent = 'reset complete. Reloading…';
        // Refresh sidebar status, then reload the setup view.
        window.litreview?.refreshStatus?.();
        setTimeout(() => location.reload(), 500);
      } catch (err) {
        status.className = 'hint hint-warn small';
        status.textContent = 'reset failed: ' + err.message;
        btn.disabled = false;
      }
    },
  }, ['Reset for new topic']);

  return h('fieldset', { class: 'field danger-zone' }, [
    h('legend', {}, ['Danger zone']),
    h('p', { class: 'hint' }, [
      'Reset everything for a new thesis topic. ',
      'Wipes search results, triage, downloaded PDFs, notes, and synthesis output. ',
      'Resets the topic, queries, and inclusion criteria to defaults.',
    ]),
    h('div', { class: 'reset-options' }, [
      h('label', { class: 'small' }, [keepEmail, ' Keep contact email']),
      h('label', { class: 'small' }, [keepCreds, ' Keep API keys']),
    ]),
    h('div', { class: 'reset-actions' }, [btn, status]),
  ]);
}

function renderCredentialsSection(creds) {
  const ssState = creds?.semantic_scholar_api_key || { set: false };
  const ssInput = h('input', {
    type: 'password',
    autocomplete: 'new-password',
    placeholder: ssState.set ? `set (${ssState.preview}). enter a new key to replace.` : 'sk-…  (paste here to add)',
    spellcheck: false,
  });
  const ssStatus = h('span', { class: 'hint ' + (ssState.set ? 'hint-good' : '') },
    [ssState.set ? `key is set (${ssState.preview})` : 'no key set']);
  const saveKeyBtn = h('button', { class: 'btn', type: 'button' }, ['Save key']);
  const removeKeyBtn = h('button', {
    class: 'btn btn-ghost', type: 'button',
    style: { display: ssState.set ? '' : 'none' },
  }, ['Remove key']);

  saveKeyBtn.addEventListener('click', async () => {
    const v = ssInput.value.trim();
    if (!v) return;
    saveKeyBtn.disabled = true;
    try {
      const res = await fetch('/api/credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ semantic_scholar_api_key: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Re-fetch to update the masked preview
      const fresh = await fetch('/api/credentials').then((r) => r.json());
      const s = fresh.semantic_scholar_api_key;
      ssInput.value = '';
      ssInput.placeholder = s.set ? `set (${s.preview}). enter a new key to replace.` : 'sk-…';
      ssStatus.textContent = s.set ? `key is set (${s.preview})` : 'no key set';
      ssStatus.className = 'hint ' + (s.set ? 'hint-good' : '');
      removeKeyBtn.style.display = s.set ? '' : 'none';
    } catch (err) {
      alert('Could not save key: ' + err.message);
    } finally {
      saveKeyBtn.disabled = false;
    }
  });

  removeKeyBtn.addEventListener('click', async () => {
    if (!confirm('Remove the saved Semantic Scholar API key?')) return;
    await fetch('/api/credentials', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ semantic_scholar_api_key: '' }),
    });
    ssInput.value = '';
    ssInput.placeholder = 'sk-…  (paste here to add)';
    ssStatus.textContent = 'no key set';
    ssStatus.className = 'hint';
    removeKeyBtn.style.display = 'none';
  });

  return h('fieldset', { class: 'field' }, [
    h('legend', {}, ['Optional API keys']),
    h('p', { class: 'hint' }, [
      'Stored locally in ',
      h('code', {}, ['project/data/_credentials.json']),
      ' (file mode 600). Never sent anywhere except the matching API.',
    ]),
    h('div', { class: 'field' }, [
      h('label', {}, ['Semantic Scholar API key']),
      h('div', { class: 'inline-row' }, [ssInput, saveKeyBtn, removeKeyBtn]),
      h('div', {}, [ssStatus]),
      h('span', { class: 'hint' }, [
        'Without a key, Semantic Scholar rate-limits aggressively (often 429). ',
        h('a', { href: 'https://www.semanticscholar.org/product/api', target: '_blank', rel: 'noopener' }, ['Request a free key']),
        '.',
      ]),
    ]),
  ]);
}

function field(label, children, hint) {
  return h('div', { class: 'field' }, [
    h('label', {}, [label]),
    ...children,
    hint ? h('span', { class: 'hint' }, [hint]) : null,
  ]);
}

function labelWrap(label, input) {
  return h('label', { class: 'label-wrap' }, [
    h('span', {}, [label]),
    input,
  ]);
}
