// extract_claims_v2.mjs
//
// LLM-as-finder for typed claims, per-stage AI provider switch,
// substring-validated against the source paragraph. Replaces the v1
// bool_signals + claims cascade.
//
// Claim taxonomy folds the former boolean signals (first_in_area,
// releases_code, baseline_comparison, reports_uncertainty,
// challenges_existing) into the same machinery as the six original
// claim types (contribution, finding, limitation, future_work,
// framework, method). All extraction is generative under substring
// constraint — the LLM finds quotes, never writes them.
//
// Per-stage AI provider:
//   off            — skip; no claims extracted
//   webllm         — browser-driven path (deferred; not implemented here)
//   openai / anthropic — server-side via callLlm
//   share-to-chat  — manual paste (deferred)

import * as store from './store.mjs';
import { callLlm, pickAvailableProvider } from './llm_proxy.mjs';

// All claim types, with eligible canonical_section_types per type. The
// LLM only sees paragraphs from those sections, which keeps prompts
// focused and the substring-validation pool small.
// Each entry carries the full TASK line (with a concrete clarifying
// question) and a per-type Return close. Pattern matches the
// hand-tuned contribution prompt that was observed to produce the
// right output for Qwen 3B at temp 0:
//
//   TASK: Find the exact statement of <thing> — <clarification>.
//         <clarifying question that makes it concrete>?
//
//   Return <focused outcome>.
//
// Vague TASKs ("find a statement that …") cause the model to fill the
// schema with plausible-looking but wrong sentences. The clarifying
// question + per-type Return close keeps the model on target.
const CLAIM_TYPES = {
  contribution: {
    sections: ['abstract', 'introduction', 'conclusion'],
    task:   'Find the exact statement of the paper\'s main contribution(s) — what new artefact, insight, or method this work adds. What have the authors actually done?',
    ret:    'Return the statement of the paper\'s main contribution.',
    max: 3,
  },
  finding: {
    sections: ['abstract', 'results', 'discussion', 'conclusion'],
    task:   'Find the exact statement of a specific empirical or analytical finding obtained by this paper — what an experiment or analysis demonstrated. What did the authors actually measure or observe?',
    ret:    'Return each finding statement.',
    max: 5,
  },
  limitation: {
    sections: ['limitations', 'discussion', 'conclusion', 'future_work'],
    task:   'Find the exact statement of a limitation, caveat, or threat to validity that the AUTHORS THEMSELVES acknowledge about their own work. Do not include limitations of prior work. What does this paper admit it cannot do or has not solved?',
    ret:    'Return each acknowledged limitation.',
    max: 5,
  },
  future_work: {
    sections: ['conclusion', 'future_work', 'discussion'],
    task:   'Find the exact statement of a direction for future work, an open question, or a follow-up the authors leave unresolved. What do the authors say still needs to be done?',
    ret:    'Return each future-work direction.',
    max: 5,
  },
  framework: {
    sections: ['introduction', 'background', 'related_work', 'methods'],
    task:   'Find the exact statement naming a specific theoretical or conceptual framework that the authors build on or position their work against. Which named framework, theory, or model does this paper use as its scaffolding?',
    ret:    'Return each named framework.',
    max: 3,
  },
  method: {
    sections: ['abstract', 'methods', 'experimental_setup'],
    task:   'Find the exact statement of the paper\'s primary methodological approach. How do the authors actually do their work? Otherwise [].',
    ret:    'Return the primary methodological approach.',
    max: 2,
  },
  first_in_area: {
    sections: ['abstract', 'introduction', 'conclusion'],
    task:   'Find the exact statement claiming this paper is the FIRST to address or accomplish something. Look for phrases like "to the best of our knowledge, the first…", "we are the first to…", "no prior work has…". Otherwise [].',
    ret:    'Return each first-in-area claim.',
    max: 2,
  },
  releases_code: {
    sections: ['abstract', 'introduction', 'methods', 'conclusion', 'appendix'],
    task:   'Find the exact statement declaring that the paper releases source code, model weights, or an implementation publicly. URLs to github / gitlab / huggingface / zenodo are strong evidence. Otherwise [].',
    ret:    'Return each code-release statement.',
    max: 2,
  },
  baseline_comparison: {
    sections: ['methods', 'experimental_setup', 'results', 'discussion'],
    task:   'Find the exact statement where the paper compares its own method to baselines, prior work, or state-of-the-art systems. Which competing approach or system is named in the comparison? Otherwise [].',
    ret:    'Return each baseline-comparison statement.',
    max: 3,
  },
  reports_uncertainty: {
    sections: ['methods', 'results'],
    task:   'Find the exact statement where the paper reports a measure of statistical uncertainty: confidence intervals, standard errors, error bars, p-values, credible intervals, or bootstrap. Has the paper quantified how confident it is?',
    ret:    'Return each uncertainty-quantification statement.',
    max: 2,
  },
  challenges_existing: {
    sections: ['abstract', 'introduction', 'related_work', 'discussion'],
    task:   'Find the exact statement where this paper challenges, disputes, contradicts, or rejects an existing approach, finding, or assumption from prior work. Which existing claim does this paper push back against? Otherwise [].',
    ret:    'Return each challenge.',
    max: 3,
  },
};

// Five stance axes for each accepted claim. Drives clustering in Phase 3.
// We rely on the LLM to assign stance alongside the quote — substring
// validation only constrains the quote, the stance label sits in the
// classifier_scores subtree as a hint.
const STANCE_LABELS = ['asserts', 'validates', 'theorises', 'challenges', 'extends'];

// ─────────────────────────────────────────────────────────────────────────
// PDF-text normalisation (shared with grobid output — handles ligatures,
// soft hyphens, smart quotes, hyphenated line breaks).
// ─────────────────────────────────────────────────────────────────────────

const LIGATURES = { 'ﬀ':'ff','ﬁ':'fi','ﬂ':'fl','ﬃ':'ffi','ﬄ':'ffl','ﬅ':'ft','ﬆ':'st' };
function normalisePdfText(s) {
  let t = String(s || '');
  t = t.replace(/­/g, '');
  t = t.replace(/-\s*\n\s*/g, '');
  t = t.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c);
  t = t.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[–—−]/g, '-');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

const MIN_QUOTE_LEN = 12;

function findSourceParagraph(quote, paragraphs) {
  const q = normalisePdfText(quote);
  if (q.length < MIN_QUOTE_LEN) return null;
  const qLower = q.toLowerCase();
  for (const p of paragraphs) {
    const hay = normalisePdfText(p.text);
    if (hay.includes(q)) return p;
    if (hay.toLowerCase().includes(qLower)) return p;
  }
  // Last-resort: 80-char prefix match (handles LLM truncation / merged sentences).
  if (q.length > 80) {
    const head = q.slice(0, 80).toLowerCase();
    for (const p of paragraphs) {
      if (normalisePdfText(p.text).toLowerCase().includes(head)) return p;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────

// Role-primed prompt. Grammar handles output shape; the role priming
// and the explicit "Return …" close are what direct the model toward
// the right semantic target. Earlier minimisation that dropped both
// produced low-precision picks at temp 0 — the model fills the schema
// quota with the first plausible-looking sentence. The role priming +
// "If none exist, return []" reminder restores quality without giving
// the model an easy bail-out (because the grammar still constrains the
// shape and stance enum).
function buildPrompt(claimType, cfg, paragraphs) {
  const lines = [];
  lines.push('You are an information extractor for a scientific literature review. You FIND verbatim quotes inside a research paper; you never paraphrase, summarise, or invent text.');
  lines.push('');
  lines.push(`TASK: ${cfg.task}`);
  lines.push('');
  lines.push(cfg.ret);
  lines.push('');
  lines.push('PARAGRAPHS:');
  for (const p of paragraphs) {
    lines.push(`<paragraph id="${p.paragraph_id}" section="${p.canonical_type}" page="${p.page_first ?? '?'}">`);
    lines.push(p.text);
    lines.push('</paragraph>');
  }
  return lines.join('\n');
}

// JSON-schema grammar shared by every claim_type. Constrains output to
// an array of {quote, paragraph_id, stance}; stance is enum-restricted
// at the token level. No minItems/maxItems — let the paper dictate
// count.
const CLAIM_JSON_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      quote:        { type: 'string', minLength: MIN_QUOTE_LEN },
      paragraph_id: { type: 'string' },
      stance:       { type: 'string', enum: STANCE_LABELS },
    },
    required: ['quote', 'paragraph_id', 'stance'],
    additionalProperties: false,
  },
};

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

// ─────────────────────────────────────────────────────────────────────────
// Per-paper extraction
// ─────────────────────────────────────────────────────────────────────────

/**
 * Extract typed claims for one paper. Per-stage AI provider:
 *   - opts.provider = 'off' | 'webllm' | 'openai' | 'anthropic' | 'share-to-chat' | 'auto'
 *   - 'auto' picks the strongest server-side provider available.
 * Returns { paper_id, by_type: { type: count }, total_accepted, total_rejected, errors, mode }.
 */
export async function extractClaimsForPaper(paperId, opts = {}) {
  await store.init();
  const startMs = Date.now();
  const requested = opts.provider || 'auto';
  let provider;
  if (requested === 'auto') provider = await pickAvailableProvider({});
  else if (requested === 'off' || requested === 'share-to-chat') provider = null;
  else provider = requested;

  if (!provider) {
    return {
      paper_id: paperId,
      mode: requested,
      skipped: 'no_server_side_provider',
      hint: 'pick a model in the AI status modal (WebLLM tab) or configure openai/anthropic in Setup',
    };
  }

  // Pull paragraphs grouped by canonical_type.
  const paragraphs = store.query(
    `SELECT paragraph_id, canonical_type, text, page_first, paragraph_idx
       FROM paragraphs WHERE paper_id = ?
        AND length(text) >= 80
      ORDER BY paragraph_idx`,
    [paperId],
  );
  if (paragraphs.length === 0) {
    return { paper_id: paperId, error: 'no_paragraphs', hint: 'run grobid ingest first' };
  }

  // Wipe prior LLM-extracted claims for this paper.
  store.exec(`DELETE FROM claims WHERE paper_id = ? AND mechanism LIKE 'llm_finder%'`, [paperId]);

  const byType = {};
  let totalAccepted = 0;
  let totalRejected = 0;
  const errors = [];

  for (const [claimType, cfg] of Object.entries(CLAIM_TYPES)) {
    if (Array.isArray(opts.only) && !opts.only.includes(claimType)) continue;
    // Filter paragraphs strictly to eligible sections. The previous
    // version included 'other'-classified paragraphs as a fallback,
    // which leaked the entire paper body into extractors whose target
    // claim type genuinely isn't present (e.g. asking "find baselines"
    // on a paper with no methods section). That bug caused systematic
    // false positives.
    const eligible = paragraphs.filter((p) => cfg.sections.includes(p.canonical_type));
    if (eligible.length === 0) continue;
    // Cap input size — 30k chars is plenty for a small batch, cheap for cloud LLM.
    const TRIM = 30_000;
    let totalChars = 0;
    const trimmed = [];
    for (const p of eligible) {
      if (totalChars + p.text.length > TRIM) break;
      trimmed.push(p);
      totalChars += p.text.length;
    }
    const prompt = buildPrompt(claimType, cfg, trimmed);
    let raw;
    try {
      raw = await callLlm({
        provider,
        system: '',
        user: prompt,
        temperature: 0,
        jsonSchema: CLAIM_JSON_SCHEMA,
      });
    } catch (e) {
      errors.push({ claim_type: claimType, error: e.message });
      continue;
    }
    const items = parseLlmJson(raw);
    if (!Array.isArray(items) || items.length === 0) continue;

    // Substring-validate each quote against the eligible paragraph set.
    for (const item of items.slice(0, cfg.max)) {
      if (!item || typeof item.quote !== 'string') { totalRejected++; continue; }
      const source = findSourceParagraph(item.quote, trimmed);
      if (!source) { totalRejected++; continue; }
      const stance = STANCE_LABELS.includes(item.stance) ? item.stance : 'asserts';
      const provId = store.recordProvenance({
        mechanism: 'llm_finder',
        model: provider,
        chunk_id: source.paragraph_id,
        page: source.page_first,
        raw_text: item.quote,
        classifier_scores: { stance, llm_paragraph_id: item.paragraph_id || null, claim_type: claimType },
        confidence: 1.0,
        llm_response: item.quote,
      });
      store.exec(
        `INSERT INTO claims (paper_id, text, page, stance, claim_type, chunk_id, mechanism, provenance_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [paperId, item.quote, source.page_first, stance, claimType,
         source.paragraph_id, 'llm_finder', provId],
      );
      byType[claimType] = (byType[claimType] || 0) + 1;
      totalAccepted++;
    }
  }
  await store.flush();
  return {
    paper_id: paperId,
    mode: provider,
    by_type: byType,
    total_accepted: totalAccepted,
    total_rejected: totalRejected,
    errors,
    elapsed_ms: Date.now() - startMs,
  };
}

export { CLAIM_TYPES, STANCE_LABELS, buildPrompt, CLAIM_JSON_SCHEMA };
