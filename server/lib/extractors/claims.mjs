// extractors/claims.mjs
//
// Claims extraction. The one place LLM generation lives in the entire
// system. Per-paper, we ask a small local LLM (WebLLM, browser-side) to
// FIND verbatim quotes for specific claim types — never to write or
// synthesise. Every quote the LLM returns is validated as a substring
// of the source chunks before it enters the structured store. Quotes
// that aren't literally present in the chunks are silently rejected.
//
// Six claim types map onto the schema's claim_type enum:
//
//   contribution    — the paper's main contribution
//   finding         — main empirical finding(s)
//   limitation      — limitation the authors themselves state
//   future_work     — future-work statement
//   framework       — theoretical / conceptual framework the paper builds on
//   method          — concise method description
//
// Each type has its own eligible-section set + prompt template + cap on
// how many quotes to extract (1-2 typical).
//
// Pipeline (per claim type):
//
//   1. Pull eligible chunks from SQLite (filtered by section_label).
//   2. Build a prompt for the LLM with the chunks inlined + page tags.
//   3. Call the LLM (browser WebLLM or test stub). The LLM returns
//      a JSON array of { quote, page } objects.
//   4. Substring-validate every quote against the chunks (whitespace
//      tolerant). Reject quotes not literally present.
//   5. For each accepted quote:
//        a. NLI zero-shot classify stance ∈ {asserts, validates,
//           theorises, challenges, extends}.
//        b. Embed the quote via the embedder (for Stage 2 clustering).
//        c. Write a `claims` row + provenance row.
//
// LLM injection point:
//
//   The module exports `prepareClaimsExtraction(paperId)` and
//   `processClaimsResponses(paperId, responses)`. Callers drive the
//   LLM round-trip between them. For browser-driven extraction the
//   client fetches the prompts, runs WebLLM, posts the responses back.
//   For server-driven extraction (e.g. when the student has OpenAI or
//   Anthropic configured), the orchestrator can also use the convenience
//   `extractClaims(paperId, { llmFn })` wrapper which does both steps
//   plus the LLM call inline.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as store from '../store.mjs';
import * as nli from '../nli.mjs';
import * as embedder from '../embedder.mjs';
import { DATA_DIR } from '../../paths.mjs';
import { ensureDir } from '../../storage.mjs';

const CLAIM_VECTORS_PATH = path.join(DATA_DIR, '_vectors', 'claims.jsonl');

// ─────────────────────────────────────────────────────────────────────────
// Claim-type definitions
// ─────────────────────────────────────────────────────────────────────────

const CLAIM_TYPES = {
  contribution: {
    sections: ['abstract', 'conclusion'],
    maxQuotes: 1,
    prompt: 'Find the sentence that states this paper\'s main contribution.',
  },
  finding: {
    sections: ['abstract', 'results', 'conclusion'],
    maxQuotes: 2,
    prompt: 'Find sentences that state the paper\'s main empirical finding(s) — what the experiments demonstrated.',
  },
  limitation: {
    sections: ['limitations', 'discussion', 'conclusion'],
    maxQuotes: 3,
    prompt: 'Find sentences in which the authors themselves explicitly state a limitation, caveat, or threat to validity of their own work. Do not include limitations of prior work.',
  },
  future_work: {
    sections: ['conclusion', 'future_work', 'discussion'],
    maxQuotes: 2,
    prompt: 'Find sentences that state future work, open questions, or directions the authors leave for follow-up research.',
  },
  framework: {
    sections: ['introduction', 'background', 'related_work', 'discussion'],
    maxQuotes: 2,
    prompt: 'Find sentences in which the authors name and rely on a specific theoretical or conceptual framework that grounds their work.',
  },
  method: {
    sections: ['abstract', 'methods', 'experimental_setup'],
    maxQuotes: 1,
    prompt: 'Find the sentence that most concisely describes the paper\'s methodology, system, or technique.',
  },
};

const CLAIM_TYPE_KEYS = Object.keys(CLAIM_TYPES);

const STANCE_LABELS = ['asserts', 'validates', 'theorises', 'challenges', 'extends'];
const STANCE_HYPOTHESIS_TEMPLATE = 'This sentence {} a claim or finding.';
const STANCE_MIN_CONFIDENCE = 0.30;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function eligibleChunks(paperId, sectionLabels, limit = 8) {
  if (!sectionLabels || sectionLabels.length === 0) return [];
  const placeholders = sectionLabels.map(() => '?').join(',');
  return store.query(
    `SELECT c.chunk_id, c.text, c.page_first, c.chunk_idx
       FROM chunks c
       JOIN chunk_section cs ON cs.chunk_id = c.chunk_id
      WHERE c.paper_id = ? AND cs.label IN (${placeholders})
      ORDER BY c.chunk_idx
      LIMIT ?`,
    [paperId, ...sectionLabels, limit],
  );
}

// Normalise PDF-text quirks so the substring check tolerates trivial
// formatting differences between PDF-extracted text and the LLM's
// rendering of a quote. Handled: whitespace runs, non-breaking spaces,
// soft hyphens, ligatures (ﬁ ﬂ ﬀ ﬃ ﬄ), smart quotes, en/em dashes,
// hyphenated line breaks ("re-\nlevant" → "relevant").
const LIGATURES = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'ft',
  'ﬆ': 'st',
};
function normalisePdfText(s) {
  let t = String(s || '');
  // Strip soft hyphens entirely (they're invisible word-break markers).
  t = t.replace(/­/g, '');
  // Stitch hyphenated line breaks: "rele-\nvant" → "relevant".
  t = t.replace(/-\s*\n\s*/g, '');
  // Map ligatures.
  t = t.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c);
  // Normalise quote and dash variants.
  t = t.replace(/[‘’‚‛]/g, "'")
       .replace(/[“”„‟]/g, '"')
       .replace(/[–—−]/g, '-');
  // Non-breaking and other Unicode spaces → ascii space.
  t = t.replace(/[  -​  　]/g, ' ');
  // Collapse runs of whitespace.
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// Strict substring validator. Quote must be a contiguous substring of
// ONE of the chunks after PDF-text normalisation. Returns the source
// chunk row + the page when matched, null otherwise.
function findSourceChunk(quote, chunkRows) {
  const q = normalisePdfText(quote);
  if (q.length < 12) return null;  // too short to be a real claim
  const qLower = q.toLowerCase();
  for (const row of chunkRows) {
    const haystack = normalisePdfText(row.text);
    if (haystack.includes(q)) return row;
    // Case-insensitive fallback — LLM sometimes mis-cases an acronym.
    if (haystack.toLowerCase().includes(qLower)) return row;
  }
  return null;
}

// Build the LLM prompt for one claim type. Chunks inlined as numbered
// blocks with page tags so the LLM can reference pages in its output.
function buildPrompt(claimType, chunkRows) {
  const cfg = CLAIM_TYPES[claimType];
  const parts = [];
  parts.push('You extract verbatim quotes from a research paper. You never paraphrase, summarise, or invent text.');
  parts.push('');
  parts.push('TASK:');
  parts.push(cfg.prompt);
  parts.push('');
  parts.push(`Return at most ${cfg.maxQuotes} quote(s) as a JSON array. Each element: {"quote": "<verbatim text>", "page": <integer page number>}.`);
  parts.push('Each quote MUST be copied verbatim from the chunks below — no edits, no paraphrasing, no abbreviation. If no relevant sentence exists, return an empty array: [].');
  parts.push('');
  parts.push('CHUNKS:');
  for (let i = 0; i < chunkRows.length; i++) {
    const c = chunkRows[i];
    parts.push(`<chunk ${i + 1} page=${c.page_first || '?'}>`);
    parts.push(c.text);
    parts.push(`</chunk ${i + 1}>`);
  }
  parts.push('');
  parts.push('Output the JSON array now. Do not include any preamble or explanation.');
  return parts.join('\n');
}

// Parse the LLM response. Strips Markdown code fences and prose
// preamble, then JSON.parse's. Returns an array of { quote, page };
// items that don't look like quote/page objects are silently dropped.
function parseLLMResponse(text) {
  if (!text || typeof text !== 'string') return [];
  let s = text.trim();
  // Strip ```json ... ``` fences if present.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // Find the first '[' — many small models prepend prose.
  const open = s.indexOf('[');
  if (open < 0) return [];
  s = s.slice(open);
  // Find the matching close. Simple bracket-depth scan; tolerates strings
  // containing brackets only if they're escaped (good enough for the
  // schema we asked for).
  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return [];
  const jsonText = s.slice(0, end);
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const quote = typeof item.quote === 'string' ? item.quote : null;
    const page = typeof item.page === 'number'
      ? item.page
      : (typeof item.page === 'string' ? parseInt(item.page, 10) : null);
    if (!quote) continue;
    out.push({ quote, page: Number.isFinite(page) ? page : null });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 1 — prepare prompts
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the LLM prompts for a paper's claim extraction. Returns an array
 * of { claim_type, prompt, chunk_ids } so the caller can drive the LLM
 * round-trip and post the responses back via processClaimsResponses.
 *
 * Caller contract: invoke the LLM once per item, capture its text
 * response, then call processClaimsResponses with parallel arrays.
 */
export async function prepareClaimsExtraction(paperId, opts = {}) {
  await store.init();
  const which = Array.isArray(opts.only) && opts.only.length
    ? opts.only.filter((t) => t in CLAIM_TYPES)
    : CLAIM_TYPE_KEYS;
  const items = [];
  for (const claimType of which) {
    const cfg = CLAIM_TYPES[claimType];
    const chunks = eligibleChunks(paperId, cfg.sections);
    if (chunks.length === 0) continue;
    items.push({
      claim_type: claimType,
      prompt: buildPrompt(claimType, chunks),
      chunk_ids: chunks.map((c) => c.chunk_id),
      max_quotes: cfg.maxQuotes,
    });
  }
  return { paper_id: paperId, items };
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 2 — validate + classify + persist
// ─────────────────────────────────────────────────────────────────────────

/**
 * Process LLM responses for one paper. `responses` parallels the `items`
 * returned by prepareClaimsExtraction:
 *   responses = [{ claim_type, llm_text }, ...]
 *
 * For each response:
 *   - Parse JSON quotes
 *   - Substring-validate each against the original chunks
 *   - NLI classify stance on accepted quotes
 *   - Embed accepted quotes (topic_embedding goes to a separate vector
 *     store — for M3 we just record it via the embedder API; M4
 *     detectors load embeddings back via embedder + chunk_id keying)
 *   - Write claims row + provenance
 *
 * Idempotent: wipes prior claims for this paper before inserting.
 *
 * Returns a per-claim-type summary.
 */
export async function processClaimsResponses(paperId, responses, opts = {}) {
  await store.init();
  if (!Array.isArray(responses) || responses.length === 0) {
    return { paper_id: paperId, total_accepted: 0, items: [] };
  }
  // Wipe prior claims for this paper (idempotent re-runs).
  store.exec('DELETE FROM claims WHERE paper_id = ?', [paperId]);
  // Strip stale embeddings for this paper from the sidecar (rewritten below).
  await pruneClaimVectors(paperId);

  const items = [];
  let totalAccepted = 0;
  const pendingEmbeddings = [];

  for (const resp of responses) {
    const claimType = resp.claim_type;
    if (!claimType || !(claimType in CLAIM_TYPES)) {
      items.push({ claim_type: claimType, accepted: 0, error: 'unknown_claim_type' });
      continue;
    }
    const cfg = CLAIM_TYPES[claimType];
    const chunkRows = eligibleChunks(paperId, cfg.sections);
    if (chunkRows.length === 0) {
      items.push({ claim_type: claimType, accepted: 0, error: 'no_eligible_chunks' });
      continue;
    }

    // 1. Parse JSON quotes from the LLM response.
    const quotes = parseLLMResponse(resp.llm_text || '');
    const itemReport = { claim_type: claimType, n_returned: quotes.length, n_validated: 0, n_accepted: 0, drops: [] };

    // 2. Substring-validate each quote + stance + embed.
    for (const q of quotes.slice(0, cfg.maxQuotes)) {
      const sourceChunk = findSourceChunk(q.quote, chunkRows);
      if (!sourceChunk) {
        itemReport.drops.push({ reason: 'substring_validation_failed', quote_preview: q.quote.slice(0, 80) });
        continue;
      }
      itemReport.n_validated++;

      // Stance classification via NLI. We classify the quote text against
      // the five stance labels using a generic template; the strongest
      // axis wins. Low-confidence cases default to 'asserts'.
      let stance = 'asserts';
      let stanceConfidence = 0;
      let stanceDistribution = null;
      try {
        const stanceResult = await nli.classify(q.quote, STANCE_LABELS, {
          hypothesisTemplate: STANCE_HYPOTHESIS_TEMPLATE,
        });
        if (stanceResult.score >= STANCE_MIN_CONFIDENCE) {
          stance = stanceResult.label;
          stanceConfidence = stanceResult.score;
        }
        stanceDistribution = stanceResult.scores;
      } catch (e) {
        // Don't fail the whole claim if NLI fails — accept with default stance.
        console.warn(`claims: stance classification failed: ${e?.message || e}`);
      }

      // Topic embedding via bge-small. We don't store it in SQLite (large
      // BLOB column would be awkward); instead we cache it for the M4
      // detectors to re-fetch on demand. For now: skip storage but record
      // that an embedding *would* exist for this claim_id.
      let embedding = null;
      try {
        const r = await embedder.embed([q.quote]);
        embedding = Array.from(r.data);  // arrayify so JSON write works
      } catch (e) {
        console.warn(`claims: embedding failed: ${e?.message || e}`);
      }

      // 3. Write provenance + claims row.
      const provId = store.recordProvenance({
        mechanism: 'llm_finder+substring_validated',
        model: opts.llmModel || 'webllm',
        chunk_id: sourceChunk.chunk_id,
        page: q.page ?? sourceChunk.page_first,
        raw_text: q.quote,
        classifier_scores: stanceDistribution
          ? { stance: stanceDistribution }
          : null,
        confidence: stanceConfidence,
        llm_prompt: null,    // could store the prompt here; trimming for size
        llm_response: q.quote,
      });

      const claimRes = store.exec(
        `INSERT INTO claims
           (paper_id, text, page, stance, claim_type, chunk_id, mechanism, provenance_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [paperId, q.quote, q.page ?? sourceChunk.page_first, stance, claimType,
         sourceChunk.chunk_id, 'llm_finder+substring_validated', provId],
      );
      const claimId = claimRes.lastInsertId;
      itemReport.n_accepted++;
      totalAccepted++;
      // Persist the topic embedding to a JSONL sidecar keyed by claim_id
      // so M4 cluster-based detectors can read it back without re-embedding.
      if (embedding && claimId != null) {
        pendingEmbeddings.push({ claim_id: claimId, paper_id: paperId, claim_type: claimType, embedding });
      }
    }

    items.push(itemReport);
  }

  await store.flush();
  // Append the new claim embeddings to the sidecar file. Append is safe
  // because pruneClaimVectors() removed this paper's prior rows.
  if (pendingEmbeddings.length > 0) {
    await appendClaimVectors(pendingEmbeddings);
  }
  return { paper_id: paperId, total_accepted: totalAccepted, items };
}

// ─────────────────────────────────────────────────────────────────────────
// Claim embedding sidecar  (project/data/_vectors/claims.jsonl)
// ─────────────────────────────────────────────────────────────────────────
//
// One JSON object per line:
//   { claim_id, paper_id, claim_type, embedding: [<float>, ...] }
// Read with `loadClaimVectors()`; used by M4 cluster-based detectors
// (Knowledge / Practical / Empirical / Theoretical gaps).

async function pruneClaimVectors(paperId) {
  try {
    const text = await fs.readFile(CLAIM_VECTORS_PATH, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const kept = [];
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        if (o.paper_id !== paperId) kept.push(line);
      } catch { /* drop malformed lines */ }
    }
    await fs.writeFile(CLAIM_VECTORS_PATH, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // No file yet — nothing to prune.
  }
}

async function appendClaimVectors(records) {
  await ensureDir(path.dirname(CLAIM_VECTORS_PATH));
  const lines = records.map((r) => JSON.stringify(r));
  await fs.appendFile(CLAIM_VECTORS_PATH, lines.join('\n') + '\n', 'utf8');
}

/**
 * Load all persisted claim embeddings as a packed matrix +
 * parallel metadata array. M4 detectors call this once per detection
 * run; the matrix goes into sbert_utils.communityDetection.
 *
 * Returns { matrix: { data: Float32Array, rows, dim }, meta: [{claim_id, paper_id, claim_type}, ...] }
 * or null if the sidecar is empty / missing.
 */
export async function loadClaimVectors() {
  let text;
  try {
    text = await fs.readFile(CLAIM_VECTORS_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  if (records.length === 0) return null;
  const dim = records[0].embedding?.length ?? 0;
  if (dim === 0) return null;
  const data = new Float32Array(records.length * dim);
  const meta = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    data.set(r.embedding, i * dim);
    meta[i] = { claim_id: r.claim_id, paper_id: r.paper_id, claim_type: r.claim_type };
  }
  return { matrix: { data, rows: records.length, dim }, meta };
}

// ─────────────────────────────────────────────────────────────────────────
// Convenience: drive the LLM inline
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run the full claim extraction pipeline for one paper, driving the LLM
 * inline via the supplied `llmFn(prompt) → Promise<string>`. Used by
 * tests with a stub LLM, and by future server-side paths where the LLM
 * runs through a proxy (OpenAI / Anthropic / Ollama).
 *
 * For the browser-driven path the caller invokes prepareClaimsExtraction
 * directly, runs WebLLM in the browser, then posts back to an endpoint
 * that calls processClaimsResponses. This function is the in-process
 * shortcut.
 */
export async function extractClaims(paperId, opts = {}) {
  if (typeof opts.llmFn !== 'function') {
    throw new Error('extractClaims: opts.llmFn(prompt) is required');
  }
  const prep = await prepareClaimsExtraction(paperId, opts);
  const responses = [];
  for (const item of prep.items) {
    let llmText = '';
    try {
      llmText = await opts.llmFn(item.prompt);
    } catch (e) {
      console.warn(`claims: llmFn failed for ${item.claim_type}: ${e?.message || e}`);
    }
    responses.push({ claim_type: item.claim_type, llm_text: llmText });
  }
  return processClaimsResponses(paperId, responses, opts);
}

export const CLAIM_TYPES_LIST = CLAIM_TYPE_KEYS;
export function getClaimTypeConfig(t) { return CLAIM_TYPES[t] || null; }
