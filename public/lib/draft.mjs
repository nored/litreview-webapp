// localStorage form draft helper. Saves on every input, prompts on load
// when there's a draft that differs from the server-loaded state.

export function makeDraft(key, getCurrent) {
  const k = `litreview:draft:${key}`;

  function save(payload) {
    try {
      localStorage.setItem(k, JSON.stringify({ payload, ts: Date.now() }));
    } catch {}
  }

  function read() {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clear() {
    try { localStorage.removeItem(k); } catch {}
  }

  return {
    save: () => save(getCurrent()),
    read,
    clear,
  };
}

export function formatRelative(ts) {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}
