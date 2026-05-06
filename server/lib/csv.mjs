// Tiny CSV reader/writer. RFC 4180 quoting.

export function writeCsv(rows, fields) {
  const lines = [fields.join(',')];
  for (const row of rows) {
    lines.push(fields.map((f) => quote(row[f])).join(','));
  }
  return lines.join('\n') + '\n';
}

function quote(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function parseCsv(text) {
  const out = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(cur); cur = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      row.push(cur);
      out.push(row);
      row = [];
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur || row.length) {
    row.push(cur);
    out.push(row);
  }
  if (!out.length) return { fields: [], rows: [] };
  const fields = out[0];
  const rows = out.slice(1)
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map((r) => Object.fromEntries(fields.map((f, idx) => [f, r[idx] ?? ''])));
  return { fields, rows };
}
