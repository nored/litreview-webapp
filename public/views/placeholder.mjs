export function renderPlaceholder(root, title, message) {
  root.innerHTML = `
    <h1>${escapeHtml(title)}</h1>
    <div class="placeholder">${escapeHtml(message)}</div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
