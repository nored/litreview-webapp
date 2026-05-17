// public/lib/webllm_claims.mjs
//
// Drive the M3 claims-extraction round-trip from the browser:
//
//   server → prepareClaimsExtraction(paperId) → prompts
//   browser → loop over prompts, invoke LLM (WebLLM / OpenAI / Anthropic
//             via the existing llm.mjs `chat()` surface) → responses
//   server → processClaimsResponses(paperId, responses) → write to DB
//
// Server endpoints used:
//   POST /api/v2/papers/:id/claims/prepare   → { paper_id, items: [...] }
//   POST /api/v2/papers/:id/claims/process   → { paper_id, total_accepted, items: [...] }
//
// The LLM call goes through `chat()` in public/lib/llm.mjs, which
// respects the user's per-stage AI provider choice (off / WebLLM /
// OpenAI / Anthropic / share-to-chat). For 'off' the function refuses;
// for 'share-to-chat' we don't have a useful path here (claims need
// programmatic JSON), so the caller should pre-check the provider.

import * as llm from './llm.mjs';

const SYSTEM_PROMPT =
  'You are a strict quote-finder. Output ONLY the requested JSON array, ' +
  'with quotes copied VERBATIM from the chunks provided. No paraphrase, ' +
  'no preamble, no markdown fences.';

/**
 * Run the full claims pipeline for one paper. Returns the server's
 * processing report.
 *
 * opts:
 *   temperature   — passed to the LLM (default 0.0; we want deterministic
 *                   quote selection, not creativity).
 *   onProgress    — (claimType, status, partialText?) callback for UI.
 *   abortSignal   — AbortSignal that cancels pending LLM calls between
 *                   claim types (current call is finished first).
 */
export async function runClaimsExtraction(paperId, opts = {}) {
  const onProgress = opts.onProgress || (() => {});

  // 1. Get the prompts from the server.
  onProgress('_preparing', 'running');
  const prep = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/claims/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).then((r) => r.json());
  if (prep.error) {
    onProgress('_preparing', 'failed', prep.error);
    return { error: prep.error };
  }
  onProgress('_preparing', 'done', `${prep.items.length} prompt(s)`);

  // 2. Run the LLM per prompt.
  const responses = [];
  for (const item of prep.items) {
    if (opts.abortSignal?.aborted) {
      onProgress(item.claim_type, 'aborted');
      continue;
    }
    onProgress(item.claim_type, 'running');
    let text = '';
    try {
      text = await llm.chat({
        system: SYSTEM_PROMPT,
        user: item.prompt,
        temperature: opts.temperature ?? 0.0,
      });
      onProgress(item.claim_type, 'done', text.slice(0, 80));
    } catch (e) {
      onProgress(item.claim_type, 'failed', e?.message || String(e));
      text = '';
    }
    responses.push({ claim_type: item.claim_type, llm_text: text });
  }

  // 3. Post responses back; server validates + persists.
  onProgress('_processing', 'running');
  const result = await fetch(`/api/v2/papers/${encodeURIComponent(paperId)}/claims/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses, llmModel: llm.currentModel?.() || llm.getProvider() }),
  }).then((r) => r.json());
  onProgress('_processing', result.error ? 'failed' : 'done',
    result.error ? result.error : `${result.total_accepted} claim(s) accepted`);
  return result;
}
