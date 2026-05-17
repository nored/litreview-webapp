// extract_stance_v2.mjs
//
// Phase 2: classify the stance of every citation context grobid pre-
// linked. The context is a ±120-char window around the marker; we
// classify into one of {supports, contrasts, extends, background, mentions}.
//
// Per-stage AI provider. Batched: 20 contexts per LLM call. Writes
// stance + stance_provenance_id back into citation_markers.

import * as store from './store.mjs';
import { callLlm, pickAvailableProvider } from './llm_proxy.mjs';

const STANCE_LABELS = ['supports', 'contrasts', 'extends', 'background', 'mentions'];
const BATCH_SIZE = 20;

// Pattern-matcher prompt — the model is explicitly told to scan the
// adjacency window around each citation for specific surface cues
// rather than interpret the sentence's meaning. Adds a distribution
// prior and an anti-default reminder, which together stopped a 3B
// model from collapsing to "mentions" or "supports" defaults.
// Tuned by the user with help from a stronger reference model;
// observed to lift agreement with a strong-model reference from ~5%
// to ~65% on paper 012 batch 1 (same model, temp, grammar).
const STANCE_PROMPT = `You apply five surface-pattern rules to short citation contexts and output a label per context. You are a pattern matcher, scanning the words around each citation for specific surface cues. Do not interpret what the sentence means and do not weigh which category sounds most substantive, only match surface patterns.

TASK: For each numbered citation context, output one entry containing the context number "n" and a label "stance" from the values below. Return exactly one entry per context, in the same order as the input.

PROCEDURE for each context:
  1. Locate the TARGET citation. The target citation is wrapped in double angle brackets like \`<<(Author, Year)>>\` or \`<<(Author et al., Year)>>\`. If a sentence contains multiple citations, ONLY the one wrapped in << >> is the target — any other citations in the same sentence are background context and not what you are classifying. If a sentence has only one citation, those brackets surround that single citation.
  2. Inspect the three words immediately before the opening << and the three words immediately after the closing >>. This adjacency window is what the rules check.
  3. Apply the five rules below in priority order. Stop at the first rule that matches the surface pattern.
  4. Output the entry. Do not justify, do not explain, do not output prose.

PRIOR ON EXPECTED DISTRIBUTION. In typical literature-review prose, citations break down roughly as follows: mentions around half of all citations, background around a third, supports under ten percent, extends and contrasts rare. If your output contains more than a third supports, you are over-firing supports and the surface-pattern adjacency check is failing.

ANTI-DEFAULT REMINDER. Supports is not a fallback for any factual-sounding sentence with a citation at the end. The dominant failure mode in this task is treating any non-trivial assertion as supports. Most citations in this corpus are mentions (tool and library attribution) or background (definitional and field-level teaching). Before assigning supports, verify that a quantified marker, a named experimental finding, or an explicit reliance verb sits within three words of the citation. If no such marker is adjacent, the citation is not supports.

Stance values, applied in priority order, first match wins. Each rule is a surface-pattern test, evaluate the patterns visually rather than reasoning about what the sentence means:

  - mentions:   the citation appears in parentheses immediately after a capitalized name of a software library, tool, dataset, model, product, or named technique (pattern: "Name (Cite)"), or the citation sits inside an enumeration introduced by "such as", "including", "e.g.,", "for example", "cf.", or appears inside a comma-separated list of named techniques or tools. Whenever this surface pattern is present, classify as mentions, do not evaluate the surrounding sentence for claims or contrasts.

  - extends:    a build-on verb sits within three words of the citation and takes it as object (pattern: "we extend (Cite)", "based on (Cite)", "we adapt (Cite)", "building on the method of (Cite)", "starting from (Cite)", "we follow (Cite)", "we port (Cite)"). Sentence-level build-on vocabulary that is not adjacent to the citation does not trigger this stance.

  - contrasts:  a limitation verb or contrast cue sits within three words of the citation and applies to the cited work (pattern: "(Cite) fails to", "(Cite) is limited by", "(Cite) does not", "however, (Cite)", "in contrast to (Cite)", "X is refuted by (Cite)"). Sentence-level contrast vocabulary that is not adjacent to the citation does not trigger this stance, including phrases like "contrary to X" or "X proves inadequate" when the citation sits at the end of the sentence away from the cue.

  - supports:   a quantified result, named experimental finding, or explicit reliance verb sits within three words of the citation (pattern: "achieves 95% (Cite)", "we use the result of (Cite)", "as shown by (Cite)", "as demonstrated in (Cite)", "according to (Cite)", "the finding that X (Cite)"). A bare factual-sounding statement followed by a citation at the end of the sentence does not trigger this stance.

  - background: none of the above surface patterns are present and the citation provides authority for a definitional, historical, conceptual, or field-level statement. This is the placement for sentences that explain, summarise, define, or contextualise a topic or concept and cite a reference for that teaching.

Anti-default rules:
  - mentions wins on the artifact pattern: tool and library enumerations always go to mentions even when the surrounding sentence reads pedagogically. The pattern "Python libraries such as X (Cite), Y (Cite), Z (Cite)" is mentions for all three citations.
  - adjacency means within three words of the citation or inside the same clause as the citation. Cues that appear earlier in the sentence and are separated from the citation by other content do not count for contrasts, extends, or supports.
  - supports is not a fallback for any factual-sounding sentence. A factual statement followed by a parenthetical citation goes to background unless an adjacent quantified marker or reliance verb is present.
  - contrasts is not triggered by sentence-level contrast vocabulary. A sentence that contrasts two entities and cites a third work does not qualify as contrasts.
  - when in doubt between supports and background, choose background. When in doubt between supports and mentions and a named artifact appears anywhere near the citation, choose mentions.`;

// Build the `CONTEXTS:` body for one batch. Each entry shows the
// numbered context with the TARGET citation wrapped in << ... >> so
// the model can tell which citation in a multi-citation sentence the
// number refers to. Exported so dump_prompts.mjs can produce
// identical text for inspection.
//
// `batch` is an array of { context_text, surface_text }. If
// surface_text isn't found in context_text (parser mismatch), the
// entry is emitted unmarked — the model falls back to whatever
// disambiguation it can manage.
function buildStanceSourceText(batch) {
  return batch.map((r, idx) => {
    const ctx = String(r.context_text || '').slice(0, 600).replace(/\s+/g, ' ');
    const surface = String(r.surface_text || '').trim();
    let highlighted = ctx;
    if (surface && ctx.includes(surface)) {
      // Replace only the first occurrence; if the same surface_text
      // appears more than once in the sentence (rare), other markers
      // for it would also need highlighting via separate batch rows.
      highlighted = ctx.replace(surface, `<<${surface}>>`);
    }
    return `[${idx + 1}] ${highlighted}`;
  }).join('\n\n');
}

// Build a per-batch JSON-schema grammar that enforces:
//   - one entry per context (minItems = maxItems = batch.length)
//   - the "n" integer is restricted to 1..batch.length
//   - the "stance" string is restricted to the 5-value enum
// The grammar makes "[]" unreachable, so the model can no longer bail
// out the way it did under a permissive array schema.
function buildStanceSchema(n) {
  return {
    type: 'array',
    minItems: n,
    maxItems: n,
    items: {
      type: 'object',
      properties: {
        n:      { type: 'integer', minimum: 1, maximum: n },
        stance: { type: 'string', enum: STANCE_LABELS },
      },
      required: ['n', 'stance'],
      additionalProperties: false,
    },
  };
}
// Backwards-compat export (callers reading the schema for inspection).
const STANCE_JSON_SCHEMA = buildStanceSchema(20);

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

/**
 * Classify citation stance for all (or one paper's) markers. Operates
 * on citation_markers rows where stance IS NULL — idempotent re-runs
 * skip already-classified rows unless `opts.force` is true.
 *
 * opts:
 *   paperId   — restrict to one paper; default: all papers
 *   provider  — per-stage AI choice; default 'auto'
 *   force     — re-classify even when stance is already set
 *   maxRows   — cap total markers to classify per call (default 1000)
 */
export async function classifyCitationStance(opts = {}) {
  await store.init();
  const startMs = Date.now();
  const requested = opts.provider || 'auto';
  let provider;
  if (requested === 'auto') provider = await pickAvailableProvider({});
  else if (requested === 'off' || requested === 'share-to-chat') provider = null;
  else provider = requested;

  if (!provider) {
    return {
      mode: requested,
      skipped: 'no_server_side_provider',
      hint: 'pick a model in the AI status modal (WebLLM tab) or configure openai/anthropic in Setup',
    };
  }

  const where = [];
  const args = [];
  if (opts.paperId) { where.push('paper_id = ?'); args.push(opts.paperId); }
  if (!opts.force)  { where.push('stance IS NULL'); }
  where.push('context_text IS NOT NULL');
  where.push('length(context_text) >= 30');
  const sql = `SELECT marker_id, paper_id, reference_id, context_text, surface_text FROM citation_markers
                WHERE ${where.join(' AND ')}
                ORDER BY marker_id
                LIMIT ?`;
  args.push(opts.maxRows ?? 1000);
  const allRows = store.query(sql, args);
  if (allRows.length === 0) {
    return { mode: provider, total: 0, classified: 0, by_stance: {}, elapsed_ms: Date.now() - startMs };
  }

  // De-duplicate by (reference_id, context_text). When the *same*
  // citation surfaces several times in the *same* sentence we collapse
  // to one entry. We do NOT collapse when DIFFERENT citations share a
  // sentence — those need separate classifications, and the prompt
  // disambiguates them by wrapping the target citation in `<<...>>`
  // markers (see buildBatchSourceText below).
  const groupKey = (r) => `${r.reference_id || ''}|${(r.context_text || '').trim()}`;
  const groups = new Map();  // key -> { context_text, surface_text, marker_ids[] }
  for (const r of allRows) {
    const k = groupKey(r);
    if (!groups.has(k)) {
      groups.set(k, { context_text: r.context_text, surface_text: r.surface_text, marker_ids: [] });
    }
    groups.get(k).marker_ids.push(r.marker_id);
  }
  const rows = [...groups.values()];

  let classified = 0;
  let llmCalls = 0;
  const byStance = {};
  const errors = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const sourceText = buildStanceSourceText(batch);
    llmCalls++;
    let raw;
    try {
      raw = await callLlm({
        provider,
        system: '',
        user: STANCE_PROMPT + '\n\nCONTEXTS:\n' + sourceText,
        jsonSchema: buildStanceSchema(batch.length),
        temperature: 0,
      });
    } catch (e) {
      errors.push({ batch_start: i, error: e.message });
      continue;
    }
    const items = parseLlmJson(raw);
    // Map by the LLM-emitted number; tolerate missing entries.
    const byN = new Map();
    for (const it of items) {
      if (it && typeof it === 'object' && Number.isFinite(Number(it.n))) {
        byN.set(Number(it.n), it);
      }
    }
    for (let bi = 0; bi < batch.length; bi++) {
      const row = batch[bi];
      const item = byN.get(bi + 1);
      if (!item) continue;
      const stance = STANCE_LABELS.includes(item.stance) ? item.stance : 'mentions';
      const provId = store.recordProvenance({
        mechanism: 'llm_stance',
        model: provider,
        chunk_id: null,
        page: null,
        raw_text: typeof item.rationale === 'string' ? item.rationale : null,
        classifier_scores: { stance, rationale: item.rationale },
        confidence: 1.0,
      });
      // Fan out the stance to EVERY marker_id in this group (clustered
      // citations sharing a sentence).
      for (const mid of row.marker_ids) {
        store.exec(
          `UPDATE citation_markers SET stance = ?, stance_provenance_id = ? WHERE marker_id = ?`,
          [stance, provId, mid],
        );
        classified++;
      }
      byStance[stance] = (byStance[stance] || 0) + row.marker_ids.length;
    }
  }

  // Count of unique markers across all groups, for the report.
  const totalMarkers = rows.reduce((sum, r) => sum + r.marker_ids.length, 0);
  await store.flush();
  return {
    mode: provider,
    total: totalMarkers,
    classified,
    llm_calls: llmCalls,
    by_stance: byStance,
    errors,
    elapsed_ms: Date.now() - startMs,
  };
}

export { STANCE_LABELS, STANCE_PROMPT, STANCE_JSON_SCHEMA, BATCH_SIZE, buildStanceSchema, buildStanceSourceText };
