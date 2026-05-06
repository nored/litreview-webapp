// Reusable chip-list input. Builds a labeled set of removable chips with an
// "add" textbox. Backed by a JS array; emits 'change' events.

import { h } from '../lib/dom.mjs';

export function chipInput({ values = [], placeholder = 'add and press Enter', onChange } = {}) {
  let items = [...values];

  const root = h('div', { class: 'chip-input' });
  const list = h('div', { class: 'chips' });
  const input = h('input', {
    type: 'text',
    class: 'chip-add',
    placeholder,
  });

  function emit() {
    onChange?.([...items]);
  }

  function render() {
    list.innerHTML = '';
    items.forEach((value, idx) => {
      const chip = h('span', { class: 'chip' }, [
        value,
        h('button', {
          type: 'button',
          class: 'chip-remove',
          'aria-label': `remove ${value}`,
          onclick: () => {
            items.splice(idx, 1);
            render();
            emit();
          },
        }, ['×']),
      ]);
      list.appendChild(chip);
    });
  }

  function add(value) {
    const v = value.trim();
    if (!v) return false;
    if (items.includes(v)) return false;
    items.push(v);
    render();
    emit();
    return true;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (add(input.value)) input.value = '';
    } else if (e.key === 'Backspace' && !input.value && items.length) {
      items.pop();
      render();
      emit();
    }
  });

  input.addEventListener('blur', () => {
    if (input.value.trim()) {
      add(input.value);
      input.value = '';
    }
  });

  root.appendChild(list);
  root.appendChild(input);
  render();

  return {
    el: root,
    get values() { return [...items]; },
    set values(next) { items = [...next]; render(); emit(); },
    add,
    focus: () => input.focus(),
  };
}
