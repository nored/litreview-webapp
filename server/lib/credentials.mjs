// Per-project credentials store. Stored in data/_credentials.json so it's
// separate from topic.md (which is content the student may share).
// Read-only via the API for security; the UI shows a "set" badge + preview,
// not the full key. PUT writes a new value or removes it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../paths.mjs';
import { ensureDir } from '../storage.mjs';

const FILE = path.join(DATA_DIR, '_credentials.json');

export async function read() {
  try {
    const text = await fs.readFile(FILE, 'utf8');
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function write(data) {
  await ensureDir(DATA_DIR);
  await fs.writeFile(FILE, JSON.stringify(data, null, 2), 'utf8');
  // Tighten permissions where possible.
  try { await fs.chmod(FILE, 0o600); } catch {}
}

export function preview(value) {
  if (!value) return null;
  const v = String(value);
  if (v.length <= 8) return '…';
  return v.slice(0, 4) + '…' + v.slice(-3);
}
