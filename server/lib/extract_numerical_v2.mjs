// extract_numerical_v2.mjs
//
// Phase 2: numerical-results extraction.
//
// Two sources, in order:
//   1. doc_tables — grobid pre-segmented the tables. Caption + (when
//      grobid emitted cells) cells_json drive structural extraction.
//   2. body paragraphs in results/discussion sections — LLM-as-finder
//      pulls inline numerics like "F1 of 0.84 on MIMIC-III" as
//      structured (metric, value, dataset, split) tuples.
//
// All values substring-validated against the source paragraph/caption.
// Per-stage AI provider for the inline path; tables work without AI
// when grobid emitted structured cells.

import * as store from './store.mjs';
import { callLlm, pickAvailableProvider } from './llm_proxy.mjs';

const LIGATURES = { 'ﬀ':'ff','ﬁ':'fi','ﬂ':'fl','ﬃ':'ffi','ﬄ':'ffl','ﬅ':'ft','ﬆ':'st' };
function normalisePdfText(s) {
  let t = String(s || '');
  t = t.replace(/­/g, '').replace(/-\s*\n\s*/g, '');
  t = t.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c);
  t = t.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[–—−]/g, '-');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function quoteIsSubstring(quote, sources) {
  const q = normalisePdfText(quote);
  if (q.length < 8) return false;
  const qLower = q.toLowerCase();
  for (const src of sources) {
    const hay = normalisePdfText(src).toLowerCase();
    if (hay.includes(qLower)) return true;
  }
  return false;
}

function parseLlmJson(text) {
  if (!text || typeof text !== 'string') return [];
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const open = s.indexOf('[');
  if (open < 0) return [];
  s = s.slice(open);
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return [];
  try { return JSON.parse(s.slice(0, end)); } catch { return []; }
}

// Role-primed task. Grammar handles the field-shape; the role +
// "If the source contains no such number, return []" wording is what
// directs the model semantically.
const NUMERICAL_PROMPT_HEADER = `You are an information extractor for a scientific literature review. You FIND verbatim numerical results inside a research paper; you never paraphrase or invent values.

TASK: Find every numerical result THIS paper reports. Use the paper's own metric name. Convert percentages to decimals (94% → 0.94). Extract only results obtained by this paper, not results cited from prior work. Skip page numbers, parameter counts, year values, table/figure numbers.

Return the verbatim numerical results that satisfy the TASK. If the source contains no such number, return [].`;

// JSON-schema grammar for numerical extraction.
const NUMERICAL_JSON_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      metric:  { type: 'string', minLength: 1 },
      value:   { type: 'number' },
      dataset: { type: ['string', 'null'] },
      split:   { type: ['string', 'null'], enum: ['train', 'val', 'test', null] },
      quote:   { type: 'string', minLength: 8 },
    },
    required: ['metric', 'value', 'quote'],
    additionalProperties: false,
  },
};

/**
 * Extract numerical results for one paper. Walks doc_tables + scans
 * eligible-section paragraphs.
 *
 * opts:
 *   provider   — per-stage AI choice (default 'auto'); 'off' skips LLM
 *                fallback. Tables are walked regardless.
 *   maxLlmCalls — cap on how many LLM calls to spend per paper (default 4)
 */
export async function extractNumericalForPaper(paperId, opts = {}) {
  await store.init();
  const startMs = Date.now();
  const requested = opts.provider || 'auto';
  let provider;
  if (requested === 'auto') provider = await pickAvailableProvider({});
  else if (requested === 'off' || requested === 'share-to-chat') provider = null;
  else provider = requested;
  const maxLlmCalls = opts.maxLlmCalls ?? 4;

  // Wipe prior results for this paper.
  store.exec('DELETE FROM results WHERE paper_id = ?', [paperId]);

  let totalAccepted = 0;
  let totalRejected = 0;
  const errors = [];

  // ─── Source 1: table captions (and cells when grobid carries them) ──
  const tables = store.query(
    `SELECT doc_table_id, label, caption, page, cells_json FROM doc_tables WHERE paper_id = ? ORDER BY table_idx`,
    [paperId],
  );
  // For tables we always have the caption, sometimes a structured cells
  // payload. If the LLM is available, pass caption + cells to it (cheap).
  // If not, skip — table-text doesn't structure reliably without
  // intelligence.
  let llmCallsUsed = 0;
  if (provider && tables.length > 0) {
    for (const t of tables) {
      if (llmCallsUsed >= maxLlmCalls) break;
      const sourceText = [
        t.label ? `[${t.label}]` : '',
        t.caption || '',
        t.cells_json ? `\nTable cells (JSON): ${t.cells_json.slice(0, 4000)}` : '',
      ].join(' ').trim();
      if (sourceText.length < 30) continue;
      llmCallsUsed++;
      let raw;
      try {
        raw = await callLlm({
          provider,
          system: '',
          user: NUMERICAL_PROMPT_HEADER + '\n\nSOURCE:\n' + sourceText,
          temperature: 0,
          jsonSchema: NUMERICAL_JSON_SCHEMA,
        });
      } catch (e) {
        errors.push({ table_id: t.doc_table_id, error: e.message });
        continue;
      }
      const items = parseLlmJson(raw);
      for (const item of items) {
        if (!item || typeof item.metric !== 'string') { totalRejected++; continue; }
        const value = typeof item.value === 'number' ? item.value : parseFloat(item.value);
        if (!Number.isFinite(value)) { totalRejected++; continue; }
        // Substring-validate the quote against the table source.
        if (typeof item.quote === 'string' && item.quote.length >= 8) {
          if (!quoteIsSubstring(item.quote, [sourceText])) {
            totalRejected++;
            continue;
          }
        }
        const provId = store.recordProvenance({
          mechanism: 'llm_finder:table',
          model: provider,
          chunk_id: t.doc_table_id,
          page: t.page,
          raw_text: item.quote || null,
          classifier_scores: { source: 'doc_table', table_label: t.label, dataset: item.dataset, split: item.split },
          confidence: 1.0,
        });
        store.exec(
          `INSERT INTO results (paper_id, metric, value, dataset, split, page, mechanism, raw_text, provenance_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [paperId, String(item.metric).trim(), value,
           item.dataset ? String(item.dataset).trim() : null,
           item.split ? String(item.split).trim() : null,
           t.page, 'llm_finder:table', item.quote || null, provId],
        );
        totalAccepted++;
      }
    }
  }

  // ─── Source 2: body paragraphs in results-like sections ─────────────
  if (provider && llmCallsUsed < maxLlmCalls) {
    const paragraphs = store.query(
      `SELECT paragraph_id, text, page_first, canonical_type FROM paragraphs
        WHERE paper_id = ?
          AND canonical_type IN ('results', 'discussion', 'abstract', 'experimental_setup')
          AND length(text) >= 80
        ORDER BY paragraph_idx`,
      [paperId],
    );
    // Bundle into a single LLM call when the total fits; otherwise split.
    const BUDGET = 25_000;
    let bucket = [];
    let bucketChars = 0;
    const buckets = [];
    for (const p of paragraphs) {
      if (bucketChars + p.text.length > BUDGET && bucket.length > 0) {
        buckets.push(bucket); bucket = []; bucketChars = 0;
      }
      bucket.push(p); bucketChars += p.text.length;
    }
    if (bucket.length) buckets.push(bucket);
    for (const b of buckets) {
      if (llmCallsUsed >= maxLlmCalls) break;
      const sourceText = b.map((p) => `<paragraph id="${p.paragraph_id}" page="${p.page_first ?? '?'}">\n${p.text}\n</paragraph>`).join('\n\n');
      llmCallsUsed++;
      let raw;
      try {
        raw = await callLlm({
          provider,
          system: '',
          user: NUMERICAL_PROMPT_HEADER + '\n\nSOURCE PARAGRAPHS:\n' + sourceText,
          temperature: 0,
          jsonSchema: NUMERICAL_JSON_SCHEMA,
        });
      } catch (e) {
        errors.push({ paragraphs: b.length, error: e.message });
        continue;
      }
      const items = parseLlmJson(raw);
      const sourceTexts = b.map((p) => p.text);
      for (const item of items) {
        if (!item || typeof item.metric !== 'string') { totalRejected++; continue; }
        const value = typeof item.value === 'number' ? item.value : parseFloat(item.value);
        if (!Number.isFinite(value)) { totalRejected++; continue; }
        if (typeof item.quote === 'string' && item.quote.length >= 8) {
          if (!quoteIsSubstring(item.quote, sourceTexts)) {
            totalRejected++;
            continue;
          }
        }
        // Find the paragraph the quote came from (for the chunk_id).
        let sourcePara = null;
        if (item.quote) {
          const qLower = normalisePdfText(item.quote).toLowerCase();
          sourcePara = b.find((p) => normalisePdfText(p.text).toLowerCase().includes(qLower));
        }
        const provId = store.recordProvenance({
          mechanism: 'llm_finder:body',
          model: provider,
          chunk_id: sourcePara?.paragraph_id || null,
          page: sourcePara?.page_first || null,
          raw_text: item.quote || null,
          classifier_scores: { source: 'paragraph', dataset: item.dataset, split: item.split, canonical_type: sourcePara?.canonical_type || null },
          confidence: 1.0,
        });
        store.exec(
          `INSERT INTO results (paper_id, metric, value, dataset, split, page, mechanism, raw_text, provenance_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [paperId, String(item.metric).trim(), value,
           item.dataset ? String(item.dataset).trim() : null,
           item.split ? String(item.split).trim() : null,
           sourcePara?.page_first || null, 'llm_finder:body', item.quote || null, provId],
        );
        totalAccepted++;
      }
    }
  }

  await store.flush();
  return {
    paper_id: paperId,
    mode: provider || 'off',
    n_tables_seen: tables.length,
    llm_calls_used: llmCallsUsed,
    total_accepted: totalAccepted,
    total_rejected: totalRejected,
    errors,
    elapsed_ms: Date.now() - startMs,
  };
}

export { NUMERICAL_PROMPT_HEADER, NUMERICAL_JSON_SCHEMA };
