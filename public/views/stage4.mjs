// Stage 4: Deep read. Three-pane layout — paper list / PDF viewer /
// structured note form. Per-section ✨ suggest buttons. Saves to
// notes/paper_NNN.md in canonical schema format.

import { h, debounce } from '../lib/dom.mjs';
import * as llm from '../lib/llm.mjs';

const SECTION_LABELS = {
  problem_statement: 'Problem statement',
  method_summary: 'Method summary',
  ground_truth_and_evaluation: 'Ground truth and evaluation',
  stated_limitations: 'Stated limitations',
  gaps_this_paper_opens: 'Gaps this paper opens',
  relevance_to_the_thesis_topic: 'Relevance to the thesis topic',
};

const SECTION_PROMPT_HINTS = {
  problem_statement: 'In 2-3 sentences, what problem does this paper address, in the authors\' own framing?',
  method_summary: 'In 2-4 sentences, how does the paper solve the problem? Cover input, model, output. Do not quote.',
  ground_truth_and_evaluation: 'Describe the data used for evaluation. State whether ground truth is external or self-constructed. Case count and metrics.',
  stated_limitations: 'Summarize the limitations the authors acknowledge. 2-3 sentences.',
  gaps_this_paper_opens: 'Three to six specific gap statements. Each is one sentence. Form: "the paper does not address X" or "the paper restricts itself to Y, leaving Z unexamined". Be specific.',
  relevance_to_the_thesis_topic: 'In 2-3 sentences, how does this paper relate to the thesis topic? State whether the thesis must cite this paper and why.',
};

const SYSTEM_BASE = (topic) => `You are an academic literature-review assistant helping a student write structured notes on research papers. The student's thesis topic is: "${topic}". Be concise, concrete, and faithful to the paper. Write in plain consecutive sentences, no markdown formatting, no bullet lists in the body, no preamble like "this paper" or "in conclusion".`;

// Single-call full-note draft. The model returns:
//   1. A small block of structured key:value lines for required frontmatter
//      fields the validator checks (category, method.family, novelty,
//      primary contribution, relevance).
//   2. The six body sections of the literature-review note.
// We parse both out, route the structured fields to fm.* and the body
// sections to note.body.*. Saves the student from filling the same data
// twice when the abstract already implies it.
const FULL_BODY_SYSTEM = (topic, categories, methodFamilies) => `${SYSTEM_BASE(topic)}

You will be given a paper. Output two parts.

PART 1: Structured key:value lines, exactly these keys, exactly this order, one per line:

CATEGORY: <comma-separated, choose 1-3 from: ${categories.join(', ')}, other>
METHOD_FAMILY: <choose one: ${methodFamilies.join(', ')}, other>
METHOD_SPECIFIC: <short name of the model or technique, e.g. "transformer encoder", "GPT-4 prompt", "static analysis with rule set">
PRIMARY_CONTRIBUTION: <one sentence>
NOVELTY_STRENGTH: <one of: strong, moderate, incremental, unclear>
RELEVANCE_TO_TOPIC: <one of: core, adjacent, peripheral>

PART 2: Six body sections with these exact headings, in order:

## Problem statement
## Method summary
## Ground truth and evaluation
## Stated limitations
## Gaps this paper opens
## Relevance to the thesis topic

After each heading, write 1-4 paragraphs of plain prose. No bullets. No quotes from the paper. No preamble.`;

const SECTION_HEADINGS_FOR_PARSE = [
  ['Problem statement',           'problem_statement'],
  ['Method summary',              'method_summary'],
  ['Ground truth and evaluation', 'ground_truth_and_evaluation'],
  ['Stated limitations',          'stated_limitations'],
  ['Gaps this paper opens',       'gaps_this_paper_opens'],
  ['Relevance to the thesis topic','relevance_to_the_thesis_topic'],
];

// ---------------------------------------------------------------------------
// Sectioned drafter — 7 parallel LLM calls (6 body sections + frontmatter),
// each with the FULL relevant PDF-section text as context. This matches
// the CLI template's "read the full text" expectation while staying
// within the context budget of even short-context local LLMs.
// ---------------------------------------------------------------------------

// Field-level system prompts. Each one is laser-focused on a single
// note section, with the schema's rules for that section baked in. The
// model returns only that section's body text — no headings, no preamble.
const FIELD_RULES = {
  problem_statement: {
    label: 'Problem statement',
    rule:
      'Write 2 to 3 sentences stating the problem this paper addresses in the AUTHORS\' OWN framing. ' +
      'No quotes from the paper. No "this paper" preamble. State the problem itself.',
  },
  method_summary: {
    label: 'Method summary',
    rule:
      'Write 1 to 3 short paragraphs summarising how this paper solves the problem. ' +
      'Cover: (a) the input the method consumes, (b) the technique / model / algorithm, (c) the output. ' +
      'Avoid quoting. Use plain consecutive sentences, no bullet lists.',
  },
  ground_truth_and_evaluation: {
    label: 'Ground truth and evaluation',
    rule:
      'Write 1 to 3 paragraphs describing how the paper is evaluated. ' +
      'Explicitly state: (1) what data is used as ground truth, (2) whether the ground truth is EXTERNAL ' +
      '(independent dataset, benchmark, expert review by someone other than the authors) or SELF-CONSTRUCTED ' +
      '(the authors built their own evaluation data), (3) the number of evaluation instances if reported, ' +
      '(4) the metrics reported. State the actual numbers if the paper gives them.',
  },
  stated_limitations: {
    label: 'Stated limitations',
    rule:
      'Write 1 to 3 short paragraphs summarising ONLY the limitations the authors themselves explicitly state. ' +
      'Do not infer or invent limitations. If the authors admit none, say exactly: "The authors do not explicitly state limitations." ' +
      'Do not paraphrase the abstract. Do not list strengths.',
  },
  gaps_this_paper_opens: {
    label: 'Gaps this paper opens',
    rule:
      'Write 3 to 6 specific gap statements. EACH must be one sentence in the form ' +
      '"the paper does not address X" or "the paper restricts itself to Y, leaving Z unexamined". ' +
      'Never write "more work is needed", "future work could", or any generic placeholder. ' +
      'Each gap must name a concrete unexamined dimension, dataset, regime, or class of problem.',
  },
  relevance_to_the_thesis_topic: {
    label: 'Relevance to the thesis topic',
    rule:
      'Write 2 to 3 sentences. State how this paper relates to the thesis topic. ' +
      'State whether the thesis must cite this paper and why (or why not).',
  },
};

const FRONTMATTER_RULE = (categoriesEnum, methodFamiliesEnum) =>
  `Extract the structured frontmatter values for this paper. Output EXACTLY these keys, exactly one per line, no preamble:\n\n` +
  `CATEGORY: <comma-separated, choose 1-3 from: ${categoriesEnum.join(', ')}, other>\n` +
  `METHOD_FAMILY: <one of: ${methodFamiliesEnum.join(', ')}, other>\n` +
  `METHOD_SPECIFIC: <short name, e.g. "transformer encoder", "static analysis with rule set">\n` +
  `METHOD_INPUTS: <comma-separated list of what the method consumes, e.g. "raw text, tabular data">\n` +
  `GROUND_TRUTH_SOURCE: <short label, e.g. "public_dataset", "manual_annotation", "expert_review", "simulation">\n` +
  `GROUND_TRUTH_EXTERNAL: <true if the GT is independent of the authors, else false>\n` +
  `GROUND_TRUTH_CASE_COUNT: <integer, 0 if not stated>\n` +
  `GROUND_TRUTH_REPRODUCIBLE: <true or false>\n` +
  `EVALUATION_METRICS: <comma-separated, e.g. "precision, recall, f1", or empty>\n` +
  `BASELINE_COMPARED: <true or false>\n` +
  `HAS_UQ: <true if confidence intervals or error bars reported, else false>\n` +
  `PRIMARY_CONTRIBUTION: <one sentence>\n` +
  `NOVELTY_STRENGTH: <one of: strong, moderate, incremental, unclear>\n` +
  `RELEVANCE_TO_TOPIC: <one of: core, adjacent, peripheral>\n` +
  `MUST_CITE: <true or false>\n` +
  `SELF_CONSTRUCTED_GT: <true or false>\n` +
  `COMPARISON_TABLE_ONLY: <true if main contribution is comparing existing methods>\n` +
  `HOBBY_PROJECT_SCALE: <true if reproducible by one person on a laptop in a weekend>\n` +
  `PREDICTABLE_OUTCOME: <true if the result was predictable from prior work>\n` +
  `LIMITATIONS: <semicolon-separated list of limitations the authors themselves state; empty if none>`;

// Compact rendering of the related-papers context block. The drafter
// uses it to make comparative claims like "unlike [paper_5], this work
// also covers X". One block is built per draft and shared across all
// section prompts — each section can reference whichever related papers
// are pertinent.
function renderRelatedNotesBlock(relatedNotes) {
  if (!Array.isArray(relatedNotes) || relatedNotes.length === 0) return '';
  const lines = relatedNotes.map((r) => {
    const head = `[paper_${r.paper_id}] ${r.authors || ''} (${r.year || 'n.d.'}) — "${r.title || ''}"`;
    const sim = typeof r.similarity === 'number' ? ` (sim=${r.similarity.toFixed(2)})` : '';
    const parts = [head + sim];
    if (r.method_family) parts.push(`  method family: ${r.method_family}`);
    if (r.primary_contribution) parts.push(`  contribution: ${oneLineShort(r.primary_contribution, 200)}`);
    if (r.gaps_opened) parts.push(`  gaps opened: ${oneLineShort(r.gaps_opened, 200)}`);
    return parts.join('\n');
  });
  return `\nRelated papers already in this corpus (use these for comparative claims only when relevant; never invent overlap that doesn't exist):\n${lines.join('\n\n')}\n`;
}

function oneLineShort(s, max = 200) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Per-section user prompt. Includes the paper meta + the bundle text +
// the field's rule. Section text is what makes this work — the LLM sees
// the actual paper content for the section it's writing.
function buildSectionedDraftPrompt(field, bundle, paper, topic, relatedNotes) {
  const r = FIELD_RULES[field];
  const relatedBlock = renderRelatedNotesBlock(relatedNotes);
  // Comparative claims are valuable for most sections but distracting
  // for limitations (which must be the authors' own words, not inferred
  // from neighbors). Skip the block there to avoid contamination.
  const includeRelated = field !== 'stated_limitations' && relatedBlock;
  return `Paper:
Title: ${paper.title}
Authors: ${paper.authors}
Year: ${paper.year}
Venue: ${paper.venue}

${topic.title ? `Thesis topic: ${topic.title}\n${topic.description ? 'Thesis description: ' + topic.description + '\n' : ''}` : ''}
${field === 'relevance_to_the_thesis_topic'
    ? 'You are writing the "Relevance to the thesis topic" section.\n'
    : `You are writing the "${r.label}" section of a structured literature-review note.\n`}
${r.rule}

PDF excerpts (drawn from sections: ${bundle.source_sections.join(', ') || 'none — fallback to abstract only'}):
${bundle.text || '(no PDF excerpts available — work from title and abstract only, and mark your output more tentative if needed.)'}
${includeRelated ? relatedBlock : ''}
Write the section now. Plain prose, no headings, no quotes, no preamble.${includeRelated ? ' You may cite a related paper as [paper_NNN] when making a substantive comparative point that the PDF excerpts above genuinely support — never invent overlap.' : ''}`;
}

function buildFrontmatterPrompt(bundle, paper, categoriesEnum, methodFamiliesEnum) {
  return `${FRONTMATTER_RULE(categoriesEnum, methodFamiliesEnum)}

Paper:
Title: ${paper.title}
Authors: ${paper.authors}
Year: ${paper.year}
Venue: ${paper.venue}

PDF excerpts (drawn from sections: ${bundle.source_sections.join(', ') || 'abstract'}):
${bundle.text || paper.abstract || '(none — work from title only)'}`;
}

// ---------------------------------------------------------------------------
// Critic + reviser
// ---------------------------------------------------------------------------
// Optional post-drafting pass. The drafter is one-shot RAG over retrieved
// PDF chunks; it can leave drafts that paraphrase the abstract instead of
// the chunks, miss specific method/metric names that ARE present in the
// chunks, lapse into AI voice ("this paper", "in conclusion"), or skip
// schema requirements (e.g. "3 to 6 specific gap statements"). A single
// critic call audits all 5 drafted sections in one pass; only the ones
// it marks "revise" trigger a follow-up reviser call. Costs 1 extra LLM
// call when everything's clean, up to 6 in the worst case.

// Chars of chunk text the critic sees per section. Drafters get ~3000;
// 900 is enough excerpt for the critic to verify grounding without
// re-loading the entire bundle.
const CRITIC_CHUNK_CAP = 900;

const CRITIC_SYSTEM_PROMPT =
  'You audit drafted sections of a structured literature-review note. ' +
  'Be terse, concrete, and faithful to the supplied chunks. ' +
  'You do not rewrite — you only judge each section and explain what to fix.';

function buildCriticPrompt(sections, bundles, paperCtx) {
  const blocks = [];
  for (const [field, info] of Object.entries(sections)) {
    const rule = FIELD_RULES[field];
    if (!rule) continue;
    const draft = info?.draft || '';
    const bundle = bundles?.[field] || { text: '', source_sections: [] };
    const excerpt = (bundle.text || '').slice(0, CRITIC_CHUNK_CAP);
    blocks.push(
      `[${field}]\n` +
      `rule: ${rule.rule}\n` +
      `chunks (excerpt, from sections ${bundle.source_sections?.join(', ') || 'n/a'}):\n` +
      `${excerpt || '(no chunks)'}\n` +
      `draft:\n${draft || '(empty)'}\n`,
    );
  }
  return `Paper: ${paperCtx.title}; ${paperCtx.authors}; ${paperCtx.year}; ${paperCtx.venue}

For each section below, judge against four criteria:
1. Grounding — does the draft only state things present in the chunks? Flag claims with no support.
2. Specificity — are method names, dataset names, metric values, baselines, case counts CONCRETE? "deep learning" or "various datasets" is vague.
3. Voice — flag AI-isms: "this paper", "in conclusion", "it is worth noting", "future work could", "researchers have shown".
4. Schema compliance — does it match the rule (length, format, what to include)?

Output exactly one block per section, in this format and nothing else:

[<section_key>]
verdict: ok
reason: <one short sentence>

OR

[<section_key>]
verdict: revise
reason: <one or two sentences naming SPECIFICALLY what is wrong and what concrete fact from the chunks should be in the rewrite>

Sections to audit:

${blocks.join('\n')}`;
}

// Parse the critic's output into { field: { verdict, reason } }. Tolerant —
// if a block can't be parsed or its verdict isn't one of ok|revise, it
// defaults to ok (we won't pretend a section needs revising just because
// the model produced messy output).
function parseCritique(text, fields) {
  const out = {};
  for (const f of fields) {
    const re = new RegExp(
      `\\[${f.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\]\\s*\\n` +
      `\\s*verdict\\s*:\\s*(ok|revise)\\b[^\\n]*\\n` +
      `\\s*reason\\s*:\\s*([^\\n]+(?:\\n(?!\\[)[^\\n]+)*)`,
      'i',
    );
    const m = text.match(re);
    if (m) {
      out[f] = { verdict: m[1].toLowerCase(), reason: m[2].trim() };
    } else {
      out[f] = { verdict: 'ok', reason: 'critic output unparseable for this section; left as-is' };
    }
  }
  return out;
}

function buildReviserPrompt(field, bundle, paperCtx, originalDraft, reason, topic) {
  const r = FIELD_RULES[field];
  return `Paper:
Title: ${paperCtx.title}
Authors: ${paperCtx.authors}
Year: ${paperCtx.year}
Venue: ${paperCtx.venue}

${topic?.title ? `Thesis topic: ${topic.title}\n${topic.description ? 'Thesis description: ' + topic.description + '\n' : ''}` : ''}
You are revising the "${r.label}" section of a structured literature-review note. The previous draft was audited and needs revision.

Section rule:
${r.rule}

PDF excerpts (drawn from sections: ${bundle.source_sections?.join(', ') || 'none'}):
${bundle.text || '(no PDF excerpts available)'}

Previous draft (the one being revised):
${originalDraft || '(empty)'}

Auditor's reason for revision (address each point):
${reason}

Rewrite the section, addressing the auditor's concerns while keeping any parts of the previous draft that were correct. Plain prose, no headings, no quotes, no preamble. Output the rewritten section only.`;
}

// Parse a frontmatter response into structured fields. Mirrors the
// existing parseFrontmatterPart shape so applyFrontmatterDraft can
// consume it unchanged.
function parseFrontmatterResponse(text, categoriesEnum, methodFamiliesEnum) {
  const ALLOWED_NOVELTY = new Set(['strong', 'moderate', 'incremental', 'unclear']);
  const ALLOWED_RELEVANCE = new Set(['core', 'adjacent', 'peripheral']);
  const out = {};
  const get = (k) => (text.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, 'im')) || [])[1]?.trim();
  const truthy = (v) => /^(true|yes)$/i.test((v || '').trim());

  const cats = get('CATEGORY');
  if (cats) {
    const allowed = new Set([...categoriesEnum, 'other']);
    out.category = cats.split(/[,;]\s*/)
      .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''))
      .filter((s) => s && allowed.has(s));
  }
  const mf = get('METHOD_FAMILY');
  if (mf) {
    const v = mf.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (new Set([...methodFamiliesEnum, 'other']).has(v)) out.methodFamily = v;
  }
  const ms = get('METHOD_SPECIFIC'); if (ms) out.methodSpecific = ms;
  const mi = get('METHOD_INPUTS');
  if (mi) out.methodInputs = mi.split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean);
  const gts = get('GROUND_TRUTH_SOURCE'); if (gts) out.groundTruthSource = gts;
  const gte = get('GROUND_TRUTH_EXTERNAL'); if (gte != null) out.groundTruthExternal = truthy(gte);
  const gtcc = get('GROUND_TRUTH_CASE_COUNT');
  if (gtcc) { const n = parseInt(gtcc, 10); if (!Number.isNaN(n)) out.groundTruthCaseCount = n; }
  const gtr = get('GROUND_TRUTH_REPRODUCIBLE'); if (gtr != null) out.groundTruthReproducible = truthy(gtr);
  const em = get('EVALUATION_METRICS');
  if (em) out.evaluationMetrics = em.split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean);
  const bc = get('BASELINE_COMPARED'); if (bc != null) out.baselineCompared = truthy(bc);
  const uq = get('HAS_UQ'); if (uq != null) out.hasUq = truthy(uq);
  const pc = get('PRIMARY_CONTRIBUTION'); if (pc) out.primaryContribution = pc;
  const nv = get('NOVELTY_STRENGTH');
  if (nv) { const v = nv.toLowerCase().trim(); if (ALLOWED_NOVELTY.has(v)) out.novelty = v; }
  const rl = get('RELEVANCE_TO_TOPIC');
  if (rl) { const v = rl.toLowerCase().trim(); if (ALLOWED_RELEVANCE.has(v)) out.relevance = v; }
  const mc = get('MUST_CITE'); if (mc != null) out.mustCite = truthy(mc);
  const scgt = get('SELF_CONSTRUCTED_GT'); if (scgt != null) out.selfConstructedGt = truthy(scgt);
  const cto = get('COMPARISON_TABLE_ONLY'); if (cto != null) out.comparisonTableOnly = truthy(cto);
  const hps = get('HOBBY_PROJECT_SCALE'); if (hps != null) out.hobbyProjectScale = truthy(hps);
  const po = get('PREDICTABLE_OUTCOME'); if (po != null) out.predictableOutcome = truthy(po);
  const lim = get('LIMITATIONS');
  if (lim) out.limitations = lim.split(/;\s*/).map((s) => s.trim()).filter((s) => s && s.length > 3);
  return out;
}

// Apply the new (richer) frontmatter draft shape — extends the original
// applyFrontmatterDraft from earlier in the file.
function applyRichFrontmatterDraft(fm, d) {
  if (d.category && d.category.length > 0) fm.category = d.category;
  if (d.methodFamily) fm.method.family = d.methodFamily;
  if (d.methodSpecific && !fm.method.specific) fm.method.specific = d.methodSpecific;
  if (d.methodInputs && d.methodInputs.length > 0) fm.method.inputs = d.methodInputs;
  if (d.groundTruthSource && !fm.ground_truth.source) fm.ground_truth.source = d.groundTruthSource;
  if (d.groundTruthExternal != null) fm.ground_truth.external = d.groundTruthExternal;
  if (d.groundTruthCaseCount != null && d.groundTruthCaseCount > 0) fm.ground_truth.case_count = d.groundTruthCaseCount;
  if (d.groundTruthReproducible != null) fm.ground_truth.reproducible = d.groundTruthReproducible;
  if (d.evaluationMetrics && d.evaluationMetrics.length > 0) fm.evaluation.metrics = d.evaluationMetrics;
  if (d.baselineCompared != null) fm.evaluation.baseline_compared = d.baselineCompared;
  if (d.hasUq != null) fm.evaluation.has_uncertainty_quantification = d.hasUq;
  if (d.primaryContribution && !fm.claims.primary_contribution) fm.claims.primary_contribution = d.primaryContribution;
  if (d.novelty) fm.claims.novelty_strength = d.novelty;
  if (d.relevance) fm.relevance.relevance_to_topic = d.relevance;
  if (d.mustCite != null) fm.relevance.must_cite = d.mustCite;
  if (d.selfConstructedGt != null) fm.quality_flags.self_constructed_ground_truth = d.selfConstructedGt;
  if (d.comparisonTableOnly != null) fm.quality_flags.comparison_table_only = d.comparisonTableOnly;
  if (d.hobbyProjectScale != null) fm.quality_flags.hobby_project_scale = d.hobbyProjectScale;
  if (d.predictableOutcome != null) fm.quality_flags.predictable_outcome = d.predictableOutcome;
  if (d.limitations && d.limitations.length > 0) fm.limitations_authors_state = d.limitations;
}

// Orchestrator. Fires fetch + 7 parallel LLM calls. Each call streams
// into its respective form field. Total time = slowest single call (for
// parallel providers) or sum-of-calls (for sequential providers like
// WebLLM, which is single-threaded per browser tab). Either way the
// student gets a per-section progress indicator.
// Core RAG drafting flow shared by both the single-paper button and the
// batch "draft all" loop. Takes a paper + its loaded note + frontmatter
// and runs the 7-parallel-call sectioned draft. Status callbacks let the
// caller route progress to whichever UI surface is active (form pills,
// batch bar, both). Returns { ok, sectionsDone, sectionsFailed }.
async function draftPaperSectioned({
  paper, fm, note,
  topicTitle, topicDescription, categoriesEnum, methodFamiliesEnum,
  useCritic = false,  // when true, run critic + reviser pass after drafting
  onStatus,         // (taskKey, state, detail) — called per task transition
  onSectionStream,  // (taskKey, full)            — called when streaming tokens arrive
}) {
  const sectionKeys = Object.keys(FIELD_RULES);
  const allTasks = sectionKeys.concat(['frontmatter']);
  if (useCritic) allTasks.push('critic');

  const status = (k, s, d) => { try { onStatus?.(k, s, d); } catch { /* ignore */ } };
  for (const k of allTasks) status(k, 'queued');

  let bundles = null;
  try {
    bundles = await fetch(`/api/notes/${encodeURIComponent(paper.paper_id)}/section-bundles`).then((r) => r.json());
  } catch (err) {
    for (const k of allTasks) status(k, 'failed', 'bundle fetch error');
    return { ok: false, error: 'bundle fetch failed: ' + err.message, sectionsDone: 0, sectionsFailed: allTasks.length };
  }
  if (bundles.error) {
    for (const k of allTasks) status(k, 'failed', bundles.error);
    return { ok: false, error: bundles.error, sectionsDone: 0, sectionsFailed: allTasks.length };
  }
  const topic = { title: topicTitle, description: topicDescription };
  const paperCtx = {
    title: paper.title || '',
    authors: paper.authors || '',
    year: paper.year || '',
    venue: paper.venue || '',
    abstract: paper.abstract || '',
  };

  let sectionsDone = 0;
  let sectionsFailed = 0;

  // Apply embedding-based extractions FIRST — these are free (no LLM call
  // needed) and the server already computed them in the bundle response.
  // They populate the frontmatter and the relevance-to-thesis body
  // section, leaving only 5 body sections that genuinely need an LLM.
  applyExtractedFrontmatter(fm, bundles.extracted_frontmatter || {});
  if (bundles.templated_relevance_body && !note.body.relevance_to_the_thesis_topic?.trim()) {
    note.body.relevance_to_the_thesis_topic = bundles.templated_relevance_body;
    onSectionStream?.('relevance_to_the_thesis_topic', bundles.templated_relevance_body);
  }
  status('relevance_to_the_thesis_topic', 'done', 'extracted (cosine)');
  sectionsDone++;
  status('frontmatter', 'done', 'extracted (embedding + regex)');
  sectionsDone++;

  // Remaining body sections still need LLM synthesis — these write prose.
  const sectionKeysToLLM = sectionKeys.filter((k) => k !== 'relevance_to_the_thesis_topic');

  const sys = 'You are an academic literature-review assistant writing structured notes on research papers. Be concise, concrete, and faithful to the provided excerpts. Output only the requested section body — plain prose, no headings, no markdown formatting, no bullet lists, no preamble.';

  const relatedNotes = Array.isArray(bundles.related_notes) ? bundles.related_notes : [];
  const calls = sectionKeysToLLM.map(async (field) => {
    const bundle = bundles.bundles?.[field] || { text: '', source_sections: [], provenance: [] };
    status(field, 'running');
    try {
      const usr = buildSectionedDraftPrompt(field, bundle, paperCtx, topic, relatedNotes);
      const text = await llm.chat({
        system: sys,
        user: usr,
        temperature: 0.3,
        onToken: (_d, full) => onSectionStream?.(field, full),
      });
      // Quote-grounding pass — annotate each paragraph with the page
      // numbers of the chunk it best matches. Non-blocking: on failure
      // we keep the raw drafted text without page refs.
      let finalText = text;
      try {
        const gr = await fetch(
          `/api/notes/${encodeURIComponent(paper.paper_id)}/ground-section`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ field, text }),
          },
        ).then((r) => r.json());
        if (gr?.annotated_text && typeof gr.annotated_text === 'string') {
          finalText = gr.annotated_text;
          onSectionStream?.(field, finalText);
        }
      } catch { /* keep raw text */ }
      note.body[field] = finalText;
      const pages = Array.from(new Set((bundle.provenance || []).map((p) => p.page).filter(Boolean))).slice(0, 4);
      status(field, 'done', pages.length ? `pages ${pages.join(', ')}` : '');
      sectionsDone++;
    } catch (err) {
      console.warn(`section ${field} failed for ${paper.paper_id}:`, err.message);
      status(field, 'failed', err.message.slice(0, 80));
      sectionsFailed++;
    }
  });

  // Frontmatter and relevance-to-thesis already done by the deterministic
  // extractor — no LLM call needed for either. Wait only for the 5
  // remaining body section calls.
  await Promise.all(calls);

  // Optional post-drafting audit. Skip entirely if not requested, or if
  // every section failed (nothing to audit).
  let revisions = 0;
  if (useCritic && sectionsDone > 0) {
    try {
      status('critic', 'running');

      // Build the input to the critic from whatever the drafter wrote.
      // Skip empty drafts — the critic has nothing useful to say about
      // sections that never produced text.
      const sectionsForCritic = {};
      for (const f of sectionKeysToLLM) {
        const draft = note.body[f];
        if (draft && draft.trim()) sectionsForCritic[f] = { draft };
      }
      const fieldsForCritic = Object.keys(sectionsForCritic);

      if (fieldsForCritic.length === 0) {
        status('critic', 'skipped', 'no drafts to audit');
      } else {
        const critPrompt = buildCriticPrompt(sectionsForCritic, bundles.bundles || {}, paperCtx);
        const critRaw = await llm.chat({
          system: CRITIC_SYSTEM_PROMPT,
          user: critPrompt,
          temperature: 0.2,
        });
        const critique = parseCritique(critRaw, fieldsForCritic);
        const toRevise = fieldsForCritic.filter((f) => critique[f]?.verdict === 'revise');
        status('critic', 'done', toRevise.length === 0
          ? 'all clean'
          : `${toRevise.length} section${toRevise.length === 1 ? '' : 's'} flagged`);

        // Run reviser calls in parallel — one per flagged section.
        const reviseCalls = toRevise.map(async (field) => {
          const bundle = bundles.bundles?.[field] || { text: '', source_sections: [], provenance: [] };
          const originalDraft = note.body[field] || '';
          const reason = critique[field]?.reason || '';
          status(field, 'revising', truncate(reason, 60));
          try {
            const usr = buildReviserPrompt(field, bundle, paperCtx, originalDraft, reason, topic);
            const text = await llm.chat({
              system: sys,
              user: usr,
              temperature: 0.3,
              onToken: (_d, full) => onSectionStream?.(field, full),
            });
            // Re-run grounding on the revised text so page refs reflect
            // the rewrite, not the discarded original.
            let finalText = text;
            try {
              const gr = await fetch(
                `/api/notes/${encodeURIComponent(paper.paper_id)}/ground-section`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ field, text }),
                },
              ).then((r) => r.json());
              if (gr?.annotated_text && typeof gr.annotated_text === 'string') {
                finalText = gr.annotated_text;
                onSectionStream?.(field, finalText);
              }
            } catch { /* keep raw text */ }
            note.body[field] = finalText;
            revisions++;
            status(field, 'done', 'revised');
          } catch (err) {
            console.warn(`reviser ${field} failed for ${paper.paper_id}:`, err.message);
            // Keep the original draft. Mark done — the section still has
            // a usable draft, just not the revised version.
            status(field, 'done', 'revise failed; original kept');
          }
        });
        await Promise.all(reviseCalls);
      }
    } catch (err) {
      console.warn(`critic failed for ${paper.paper_id}:`, err.message);
      status('critic', 'failed', err.message.slice(0, 80));
    }
  }

  return {
    ok: sectionsDone > 0,
    sectionsDone,
    sectionsFailed,
    revisions,
    chunks_available: bundles.chunks_available,
  };
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Apply the server-extracted frontmatter into the note's frontmatter
// object. Mirrors applyRichFrontmatterDraft's shape, but reads from the
// embedding+regex extractor's payload (different field names).
function applyExtractedFrontmatter(fm, ex) {
  if (!ex || !ex.extracted) return;
  if (ex.categories && ex.categories.length > 0) fm.category = ex.categories;
  if (ex.method_family) fm.method.family = ex.method_family;
  if (ex.metrics && ex.metrics.length > 0) fm.evaluation.metrics = ex.metrics;
  if (ex.baseline_compared != null) fm.evaluation.baseline_compared = ex.baseline_compared;
  if (ex.has_uncertainty_quantification != null) fm.evaluation.has_uncertainty_quantification = ex.has_uncertainty_quantification;
  if (ex.case_count != null && ex.case_count > 0) fm.ground_truth.case_count = ex.case_count;
  if (ex.external_ground_truth != null) fm.ground_truth.external = ex.external_ground_truth;
  if (ex.reproducible != null) fm.ground_truth.reproducible = ex.reproducible;
  if (ex.relevance_to_topic) fm.relevance.relevance_to_topic = ex.relevance_to_topic;
  if (ex.must_cite != null) fm.relevance.must_cite = ex.must_cite;
  if (ex.self_constructed_ground_truth != null) fm.quality_flags.self_constructed_ground_truth = ex.self_constructed_ground_truth;
  if (ex.hobby_project_scale != null) fm.quality_flags.hobby_project_scale = ex.hobby_project_scale;
  if (ex.limitations && ex.limitations.length > 0) fm.limitations_authors_state = ex.limitations;
  // Deterministic novelty heuristic — server-derived. The LLM frontmatter
  // call can still override it, but if AI is off this keeps the field from
  // tripping validation on every note.
  if (ex.novelty_strength && !fm.claims.novelty_strength) {
    fm.claims.novelty_strength = ex.novelty_strength;
  }
}

async function runSectionedDraft({
  paper, fm, note, formPaneEl, renderForm,
  setDirty, saveDebounced,
  topicTitle, topicDescription, categoriesEnum, methodFamiliesEnum,
  button,
  useCritic = false,
}) {
  const totalCalls = Object.keys(FIELD_RULES).length + 1 + (useCritic ? 1 : 0);
  let done = 0;
  const original = button.innerHTML;
  button.disabled = true;

  // Build the dedicated progress panel at the top of the form. Each task
  // gets its own pill, all 7 visible at once.
  const TASK_LABELS = {
    problem_statement: 'Problem statement',
    method_summary: 'Method summary',
    ground_truth_and_evaluation: 'Evaluation',
    stated_limitations: 'Limitations',
    gaps_this_paper_opens: 'Gaps',
    relevance_to_the_thesis_topic: 'Relevance',
    frontmatter: 'Frontmatter (structured fields)',
  };
  if (useCritic) TASK_LABELS.critic = 'Audit & revise';
  const panelEl = formPaneEl.querySelector('#draft-progress-panel');
  panelEl.style.display = '';
  panelEl.innerHTML = '';
  const headerEl = h('div', { class: 'draft-progress-header' }, [
    h('strong', {}, ['Drafting note']),
    h('span', { class: 'muted small' }, [' · 5 parallel LLM calls + 2 zero-shot extractions (cosine + regex) instead of 7 LLM calls']),
  ]);
  const pillsEl = h('div', { class: 'draft-progress-pills' });
  panelEl.appendChild(headerEl);
  panelEl.appendChild(pillsEl);
  const allTasks = Object.keys(TASK_LABELS);
  const pillByTask = {};
  for (const t of allTasks) {
    const pill = h('div', { class: 'draft-pill status-queued', dataset: { task: t } }, [
      h('span', { class: 'draft-pill-label' }, [TASK_LABELS[t]]),
      h('span', { class: 'draft-pill-state' }, ['queued']),
    ]);
    pillByTask[t] = pill;
    pillsEl.appendChild(pill);
  }

  // Update both: the top progress panel AND the per-section badge next
  // to each heading (the badges stay valuable for direct visual mapping
  // between a section and its status).
  function setStatus(taskKey, state, detail) {
    // Top progress pill
    const pill = pillByTask[taskKey];
    if (pill) {
      pill.className = 'draft-pill status-' + state;
      const stateEl = pill.querySelector('.draft-pill-state');
      if (stateEl) {
        if (state === 'running') {
          stateEl.innerHTML = taskKey === 'critic'
            ? '<span class="spinner-inline"></span> auditing…'
            : '<span class="spinner-inline"></span> drafting…';
        }
        else if (state === 'revising') stateEl.innerHTML = '<span class="spinner-inline"></span> revising…' + (detail ? ` · ${detail}` : '');
        else if (state === 'done') stateEl.innerHTML = '✓ done' + (detail ? ` · ${detail}` : '');
        else if (state === 'failed') stateEl.innerHTML = '✗ ' + (detail || 'failed');
        else if (state === 'queued') stateEl.textContent = 'queued';
        else if (state === 'skipped') stateEl.textContent = 'skipped' + (detail ? ` · ${detail}` : '');
      }
    }
    // Per-section badge next to the heading (kept for direct visual proof
    // each section actually got its own call)
    const el = formPaneEl.querySelector(`[data-section-status="${taskKey}"]`);
    if (el) {
      el.className = 'section-status status-' + state;
      if (state === 'running') el.innerHTML = '<span class="spinner-inline"></span> drafting…';
      else if (state === 'revising') el.innerHTML = '<span class="spinner-inline"></span> revising…' + (detail ? ` <span class="muted small">${detail}</span>` : '');
      else if (state === 'done') el.innerHTML = '✓ done' + (detail ? ` <span class="muted small">${detail}</span>` : '');
      else if (state === 'failed') el.innerHTML = '✗ failed' + (detail ? ` <span class="muted small">${detail}</span>` : '');
      else if (state === 'queued') el.innerHTML = '<span class="muted small">queued</span>';
      else if (state === 'skipped') el.innerHTML = '<span class="muted small">skipped</span>';
      else el.innerHTML = '';
    }
  }
  function setButtonProgress(label) {
    button.innerHTML = `<span class="spinner"></span> ${label} · ${done}/${totalCalls} done`;
  }
  function clearProgressPanel() {
    panelEl.style.display = 'none';
    panelEl.innerHTML = '';
  }

  setButtonProgress('fetching PDF sections');

  // Sections flagged for revision transition done → revising → done. The
  // first `done` increments the counter; the second must not. Track
  // terminated tasks so we count each at most once.
  const counted = new Set();
  const result = await draftPaperSectioned({
    paper, fm, note,
    topicTitle, topicDescription, categoriesEnum, methodFamiliesEnum,
    useCritic,
    onStatus: (taskKey, state, detail) => {
      // On revise re-entry, drop the pill back to in-flight visually
      // but don't touch the counter.
      if (state === 'revising') counted.delete(taskKey);
      setStatus(taskKey, state, detail);
      if ((state === 'done' || state === 'failed') && !counted.has(taskKey)) {
        counted.add(taskKey);
        done++;
        setButtonProgress(useCritic ? 'drafting + auditing' : 'drafting');
      }
    },
    onSectionStream: (taskKey, full) => {
      const ta = formPaneEl.querySelector(`textarea[data-section="${taskKey}"]`);
      if (ta) ta.value = full;
    },
  });

  setDirty(); saveDebounced();
  button.innerHTML = original;
  button.disabled = false;
  // Leave the progress panel visible for 4 seconds after completion so
  // the student can see which sections actually finished vs failed.
  setTimeout(() => {
    clearProgressPanel();
    renderForm();
  }, 4000);
  return result;
}

function buildFullBodyPrompt(paper, fm, draftingContext = null) {
  // Build a per-section "RETRIEVED CONTEXT" block when chunks are
  // available — feeds the LLM the actual paper text for each section it
  // is being asked to write, instead of only the abstract. Falls back
  // silently when no chunks are indexed for this paper.
  let ragBlock = '';
  if (draftingContext?.chunks_available) {
    const fmtSection = (key, label) => {
      const hits = draftingContext.sections?.[key] || [];
      if (!hits.length) return '';
      const body = hits
        .filter((h) => (h.text || '').trim().length > 0)
        .map((h, i) => {
          const where = [
            h.section ? `section "${h.section}"` : '',
            h.page ? `page ${h.page}${h.page_last && h.page_last !== h.page ? '-' + h.page_last : ''}` : '',
          ].filter(Boolean).join(', ');
          return `  [${i + 1}] ${where ? '(' + where + ')' : ''}\n  "${(h.text || '').slice(0, 1200)}"`;
        })
        .join('\n\n');
      return body ? `\n--- Retrieved for "${label}":\n${body}\n` : '';
    };
    const sections = [
      ['problem_statement', 'Problem statement'],
      ['method_summary', 'Method summary'],
      ['ground_truth_and_evaluation', 'Ground truth and evaluation'],
      ['stated_limitations', 'Stated limitations'],
      ['gaps_this_paper_opens', 'Gaps this paper opens'],
    ];
    const blocks = sections.map(([k, l]) => fmtSection(k, l)).filter(Boolean);
    if (blocks.length > 0) {
      ragBlock = '\nRETRIEVED CHUNKS FROM THE PDF (use these directly; do not paraphrase the abstract when the chunks say otherwise):\n' +
        blocks.join('') + '\n';
    }
  }

  return `Paper:
Title: ${paper.title}
Authors: ${paper.authors}
Year: ${paper.year}
Venue: ${paper.venue}
Abstract: ${(paper.abstract || '').slice(0, 1800)}
${ragBlock}
Notes-in-progress (use as context, do not contradict):
- Primary contribution: ${fm?.claims?.primary_contribution || '(not stated)'}
- Method family: ${fm?.method?.family || '(not stated)'}
- Ground truth source: ${fm?.ground_truth?.source || '(not stated)'}

Output all six sections now, with the headings exactly as specified. ${
  draftingContext?.chunks_available
    ? 'Ground each section in the retrieved chunks above. If the chunks contradict the abstract, prefer the chunks.'
    : 'Work from the abstract only (no PDF chunks were indexed for this paper).'
}`;
}

function parseFullBody(text) {
  const out = {};
  for (let i = 0; i < SECTION_HEADINGS_FOR_PARSE.length; i++) {
    const [heading, key] = SECTION_HEADINGS_FOR_PARSE[i];
    const nextHeadings = SECTION_HEADINGS_FOR_PARSE
      .slice(i + 1)
      .map(([h]) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const stop = nextHeadings ? `(?=##\\s*(?:${nextHeadings}))` : '$';
    const re = new RegExp(`##\\s*${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\n([\\s\\S]*?)${stop}`, 'i');
    const m = text.match(re);
    if (m) out[key] = m[1].trim();
  }
  return out;
}

// Extract the structured key:value lines (PART 1) the model emits before
// the markdown headings. Tolerant: skips lines we don't recognize.
function parseFrontmatterPart(text, categoriesEnum, methodFamiliesEnum) {
  const ALLOWED_NOVELTY = new Set(['strong', 'moderate', 'incremental', 'unclear']);
  const ALLOWED_RELEVANCE = new Set(['core', 'adjacent', 'peripheral']);
  const out = {};

  function getLine(key) {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  }

  const cats = getLine('CATEGORY');
  if (cats) {
    const allowed = new Set([...categoriesEnum, 'other']);
    out.category = cats.split(/[,;]\s*/)
      .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''))
      .filter((s) => s && allowed.has(s));
    if (out.category.length === 0 && cats.toLowerCase().includes('other')) out.category = ['other'];
  }

  const mf = getLine('METHOD_FAMILY');
  if (mf) {
    const v = mf.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    const allowed = new Set([...methodFamiliesEnum, 'other']);
    if (allowed.has(v)) out.methodFamily = v;
  }

  const ms = getLine('METHOD_SPECIFIC');
  if (ms) out.methodSpecific = ms;

  const pc = getLine('PRIMARY_CONTRIBUTION');
  if (pc) out.primaryContribution = pc;

  const nv = getLine('NOVELTY_STRENGTH');
  if (nv) {
    const v = nv.toLowerCase().trim();
    if (ALLOWED_NOVELTY.has(v)) out.novelty = v;
  }

  const rl = getLine('RELEVANCE_TO_TOPIC') || getLine('RELEVANCE');
  if (rl) {
    const v = rl.toLowerCase().trim();
    if (ALLOWED_RELEVANCE.has(v)) out.relevance = v;
  }

  return out;
}

function applyFrontmatterDraft(fm, draft) {
  if (draft.category && draft.category.length > 0) fm.category = draft.category;
  if (draft.methodFamily) fm.method.family = draft.methodFamily;
  if (draft.methodSpecific && !fm.method.specific) fm.method.specific = draft.methodSpecific;
  if (draft.primaryContribution && !fm.claims.primary_contribution) fm.claims.primary_contribution = draft.primaryContribution;
  if (draft.novelty) fm.claims.novelty_strength = draft.novelty;
  if (draft.relevance) fm.relevance.relevance_to_topic = draft.relevance;
}

const NOVELTY_OPTIONS = ['', 'strong', 'moderate', 'incremental', 'unclear'];
const RELEVANCE_OPTIONS = ['', 'core', 'adjacent', 'peripheral'];

export async function renderStage4(root) {
  root.innerHTML = '<h1>4. Deep read</h1><div class="placeholder">loading…</div>';

  let papersRes;
  try {
    papersRes = await fetch('/api/notes').then((r) => r.json());
    if (papersRes.error) throw new Error(papersRes.error);
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['4. Deep read']));
    root.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('strong', {}, ['Cannot start deep read. ']),
      err.message,
    ]));
    return;
  }

  const papers = papersRes.papers || [];
  if (papers.length === 0) {
    root.innerHTML = '';
    root.appendChild(h('h1', {}, ['4. Deep read']));
    root.appendChild(h('p', { class: 'lead' }, [
      'No eligible papers yet. Mark papers ',
      h('strong', {}, ['include']), ' or ', h('strong', {}, ['maybe']),
      ' in ', h('a', { href: '#/stage2' }, ['stage 2 triage']), ', wait for them to download in stage 3, then come back here.',
    ]));
    return;
  }

  // Load topic + categories + method families for the form's enum options
  const topicRes = await fetch('/api/protocol/topic').then((r) => r.json());
  const topicMd = topicRes.content || '';
  const topicTitle = (topicMd.match(/title:\s*(.+)/) || [])[1]?.trim() || '';
  // Pull the multi-line description block so the section-specific drafter
  // can include it as the relevance anchor.
  const topicDescription = ((topicMd.match(/description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/) || [])[1] || '')
    .split('\n').map((l) => l.replace(/^[ \t]{2}/, '')).join('\n').trim();
  const categoriesEnum = parseList(topicMd, 'categories');
  const methodFamiliesEnum = parseList(topicMd, 'method_families');

  // State
  let selectedRow = papers[0]?.paper_id || null;
  let activePaper = null;     // { paper_id, title, ..., abstract }
  let note = null;            // { frontmatter, body }
  let issues = [];
  let dirty = false;
  let saving = false;
  // Optional post-drafting audit: the critic LLM rereads each section
  // against the retrieved chunks and revises the ones it flags. Off by
  // default because it adds 1 LLM call (always) plus up to 5 more
  // (revisions), so it roughly doubles per-paper drafting time when
  // anything gets flagged.
  let auditMode = false;

  // Layout shell
  root.innerHTML = '';
  root.classList.add('view-deepread');
  const headerEl = h('div', { class: 'deepread-header' }, [
    h('h1', {}, ['4. Deep read']),
    h('p', { class: 'lead' }, [
      `${papers.length} eligible paper${papers.length > 1 ? 's' : ''}. Select one, read the PDF on the left, and use the form on the right. Each section has a ✨ Suggest button.`,
    ]),
  ]);
  const batchBar = h('div', { class: 'dr-batch-bar' });
  const layout = h('div', { class: 'deepread-layout' });
  const listEl = h('div', { class: 'deepread-list' });
  const pdfPaneEl = h('div', { class: 'deepread-pdf' });
  const formPaneEl = h('div', { class: 'deepread-form' });
  layout.appendChild(listEl);
  layout.appendChild(pdfPaneEl);
  layout.appendChild(formPaneEl);
  root.appendChild(headerEl);
  root.appendChild(batchBar);
  root.appendChild(layout);

  // Across-papers batch state. Drafts every eligible paper that doesn't
  // already have a valid note. Saves as it goes; cancellable.
  // Across-papers concurrency. WebLLM is single-threaded per browser tab
  // so concurrent calls will serialize there anyway; cloud providers
  // (Anthropic, OpenAI, Groq, Together) gain a 3-5x throughput win. We
  // default to 3 — enough to amortise per-paper overhead without breaching
  // typical per-key rate limits on cheap tiers.
  const CONCURRENT_PAPERS = 3;
  const drBatch = {
    running: false,
    cancelled: false,
    total: 0,
    done: 0,
    errors: 0,
    errorLog: [],
    started: 0,
    // Active worker slots — each is a paper currently being drafted by
    // one of the CONCURRENT_PAPERS workers. The batch bar renders one
    // section-pill row per slot, so the student sees all in-flight
    // papers at a glance.
    activeSlots: [],   // [{ paper_id, title, sectionStatus: {} }]
  };

  function papersNeedingDraft() {
    return papers.filter((p) => p.note_status !== 'valid');
  }

  function renderBatchBar() {
    batchBar.innerHTML = '';
    const candidates = papersNeedingDraft();
    if (drBatch.running) {
      const pct = drBatch.total > 0 ? Math.round((drBatch.done / drBatch.total) * 100) : 0;
      const elapsed = (Date.now() - drBatch.started) / 1000;
      const rate = drBatch.done > 0 ? elapsed / drBatch.done : 0;
      const remaining = rate * (drBatch.total - drBatch.done);
      const eta = remaining > 60 ? `${Math.round(remaining / 60)} min` : `${Math.round(remaining)} s`;

      const TASK_ORDER = [
        ['problem_statement', 'Problem'],
        ['method_summary', 'Method'],
        ['ground_truth_and_evaluation', 'Eval'],
        ['stated_limitations', 'Limit.'],
        ['gaps_this_paper_opens', 'Gaps'],
        ['relevance_to_the_thesis_topic', 'Relev.'],
        ['frontmatter', 'Frontmatter'],
      ];
      if (auditMode) TASK_ORDER.push(['critic', 'Audit']);

      batchBar.appendChild(h('div', { class: 'batch-strip' }, [
        h('div', { class: 'batch-info' }, [
          h('strong', {}, [`${drBatch.done} / ${drBatch.total}`]),
          ' · ',
          h('span', { class: 'muted small' }, [
            `eta ~${eta} · ${drBatch.activeSlots.length} paper${drBatch.activeSlots.length === 1 ? '' : 's'} in flight`,
            drBatch.errors > 0 ? ` · ${drBatch.errors} error${drBatch.errors > 1 ? 's' : ''}` : '',
          ]),
          auditMode
            ? h('span', { class: 'dr-audit-running', title: 'Critic + reviser pass runs after each draft' }, ['audit & revise: on'])
            : null,
        ]),
        h('div', { class: 'batch-progress' }, [
          h('div', { class: 'batch-progress-bar', style: { width: `${pct}%` } }),
        ]),
        h('button', { class: 'btn btn-ghost', type: 'button',
          onclick: () => { drBatch.cancelled = true; },
        }, ['Cancel']),
      ]));

      // One section-pill row per active slot — the student sees each
      // paper that's currently being processed and where each is in its
      // own 7-call sequence.
      for (const slot of drBatch.activeSlots) {
        const sectionPills = TASK_ORDER.map(([key, label]) => {
          const state = slot.sectionStatus?.[key] || 'queued';
          const icon =
            state === 'running'  ? h('span', { class: 'spinner-inline' }, []) :
            state === 'revising' ? h('span', { class: 'spinner-inline' }, []) :
            state === 'done'     ? '✓ ' :
            state === 'failed'   ? '✗ ' :
            '';
          return h('span', {
            class: 'batch-section-pill status-' + state,
            title: key + ': ' + state,
          }, [icon, (state === 'running' || state === 'revising') ? ' ' : '', label]);
        });
        batchBar.appendChild(h('div', { class: 'batch-section-pills' }, [
          h('span', { class: 'muted small slot-title' }, [`${(slot.title || '').slice(0, 50)}: `]),
          ...sectionPills,
        ]));
      }
      if (drBatch.errorLog.length > 0) batchBar.appendChild(renderBatchErrors());
      return;
    }
    // Idle. If we have errors from a prior run, keep them visible so the
    // student can see what failed before deciding to retry.
    if (drBatch.errorLog.length > 0) batchBar.appendChild(renderBatchErrors());

    if (candidates.length === 0) return; // hidden when nothing to draft
    const llmReady = llm.isLoaded();
    const btn = h('button', {
      class: 'btn btn-ai', type: 'button',
      disabled: !llmReady,
      title: llmReady ? '' : 'Configure an AI provider first (topbar AI pill)',
      onclick: runBatchDraft,
    }, [`✨ Draft notes for all ${candidates.length} pending`]);
    const auditCheckbox = h('input', {
      type: 'checkbox',
      id: 'dr-audit-toggle',
      checked: auditMode,
    });
    auditCheckbox.addEventListener('change', (e) => {
      auditMode = !!e.target.checked;
      renderBatchBar();
    });
    batchBar.appendChild(h('div', { class: 'batch-strip-idle' }, [
      btn,
      h('label', {
        class: 'dr-audit-label' + (auditMode ? ' dr-audit-on' : ''),
        for: 'dr-audit-toggle',
        title: 'After each paper drafts, the critic LLM rereads each section against retrieved chunks and rewrites the ones it flags. Adds 1–6 LLM calls per paper.',
      }, [
        auditCheckbox,
        h('span', {}, [' Audit & revise']),
        h('span', { class: 'muted small' }, [' (slower; quality pass)']),
      ]),
      h('span', { class: 'muted small' }, [
        ` Up to ${CONCURRENT_PAPERS} papers in flight at once. Each fires 5 parallel LLM calls (PDF-section RAG) + 2 zero-shot extractions. Saves automatically. Safe to leave running.`,
      ]),
    ]));
  }

  function renderBatchErrors() {
    const summary = drBatch.errors === 1
      ? '1 paper failed in this batch'
      : `${drBatch.errors} papers failed in this batch`;
    const items = drBatch.errorLog.map((e) =>
      h('li', {}, [
        h('span', { class: 'mono small' }, [`paper_${e.paper_id}`]),
        ' · ',
        h('span', { class: 'small' }, [(e.title || '').slice(0, 80)]),
        h('div', { class: 'error-text small' }, [`  ${e.message}`]),
      ])
    );
    return h('details', { class: 'batch-errors', open: drBatch.errors <= 3 }, [
      h('summary', { class: 'small' }, [
        h('span', { class: 'error-text' }, [summary]),
        ' — click to see why',
      ]),
      h('ul', { class: 'batch-errors-list' }, items),
      h('div', { class: 'small muted' }, [
        h('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: () => { drBatch.errorLog = []; drBatch.errors = 0; renderBatchBar(); },
        }, ['Clear error log']),
      ]),
    ]);
  }

  async function runBatchDraft() {
    if (drBatch.running) return;
    const queue = papersNeedingDraft();
    if (queue.length === 0) return;
    drBatch.running = true;
    drBatch.cancelled = false;
    drBatch.total = queue.length;
    drBatch.done = 0;
    drBatch.errors = 0;
    drBatch.activeSlots = [];
    drBatch.started = Date.now();
    renderBatchBar();

    let nextIdx = 0;

    // One worker pulls papers off the shared queue, processes them one at
    // a time, and updates its slot's status independently. CONCURRENT_PAPERS
    // workers run in parallel, so up to that many papers are in flight
    // simultaneously. Each worker keeps its slot in drBatch.activeSlots
    // while it's working; renderBatchBar renders one section-pill row per
    // active slot.
    async function worker() {
      while (!drBatch.cancelled) {
        const idx = nextIdx++;
        if (idx >= queue.length) return;
        const p = queue[idx];
        const slot = {
          paper_id: p.paper_id,
          title: p.title || '(untitled)',
          sectionStatus: {},
        };
        drBatch.activeSlots.push(slot);
        renderBatchBar();
        try {
          const res = await fetch(`/api/notes/${p.paper_id}`).then((r) => r.json());
          const targetNote = res.note;
          const targetPaper = res.paper;

          const result = await draftPaperSectioned({
            paper: targetPaper,
            fm: targetNote.frontmatter,
            note: targetNote,
            topicTitle, topicDescription, categoriesEnum, methodFamiliesEnum,
            useCritic: auditMode,
            onStatus: (taskKey, state) => {
              slot.sectionStatus[taskKey] = state;
              renderBatchBar();
            },
          });

          if (!result.ok || result.sectionsFailed === 7) {
            throw new Error(`all sections failed${result.error ? ': ' + result.error : ''}`);
          }
          if (result.sectionsDone < 3) {
            throw new Error(`only ${result.sectionsDone} of 7 sections succeeded — likely context-limit or provider error`);
          }
          const save = await fetch(`/api/notes/${p.paper_id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: targetNote }),
          }).then((r) => r.json());
          p.note_status = (save.issues?.length ?? 0) === 0 ? 'valid' : 'draft';

          if (selectedRow === p.paper_id) {
            note = targetNote;
            issues = save.issues || [];
            renderForm();
          }
        } catch (err) {
          console.error('batch draft failed for', p.paper_id, err);
          drBatch.errors++;
          drBatch.errorLog.push({
            paper_id: p.paper_id,
            title: p.title || '(untitled)',
            message: err.message || String(err),
          });
          if (drBatch.errorLog.length > 30) drBatch.errorLog.shift();
        } finally {
          // Drop this slot from the active list, advance the global
          // counter, and re-render so the freed lane shows the next paper
          // the loop picks up.
          const slotIdx = drBatch.activeSlots.indexOf(slot);
          if (slotIdx >= 0) drBatch.activeSlots.splice(slotIdx, 1);
          drBatch.done++;
          renderList();
          renderBatchBar();
        }
      }
    }

    const workerCount = Math.min(CONCURRENT_PAPERS, queue.length);
    const workers = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);

    drBatch.running = false;
    drBatch.activeSlots = [];
    renderBatchBar();
  }

  function renderList() {
    listEl.innerHTML = '';
    papers.forEach((p) => {
      const isSelected = selectedRow === p.paper_id;
      const row = h('div', {
        class: 'dr-row dr-status-' + p.note_status + (isSelected ? ' selected' : ''),
        onclick: async () => {
          if (dirty && !confirm('Unsaved changes will be lost. Continue?')) return;
          selectedRow = p.paper_id;
          await loadSelected();
        },
      }, [
        h('span', { class: 'dr-row-status' }, [
          p.note_status === 'valid' ? '✓' :
          p.note_status === 'draft' ? '✎' : '○',
        ]),
        h('div', { class: 'dr-row-body' }, [
          h('div', { class: 'dr-row-id' }, [`paper_${p.paper_id}`]),
          h('div', { class: 'dr-row-title' }, [p.title || '(untitled)']),
          h('div', { class: 'dr-row-meta muted small' }, [
            shortAuthors(p.authors), p.year ? ` · ${p.year}` : '',
          ]),
        ]),
      ]);
      listEl.appendChild(row);
    });
  }

  function renderPdfPane() {
    pdfPaneEl.innerHTML = '';
    if (!selectedRow) {
      pdfPaneEl.appendChild(h('div', { class: 'placeholder' }, ['Select a paper.']));
      return;
    }
    pdfPaneEl.appendChild(h('embed', {
      src: `/api/pdfs/${selectedRow}#view=FitH`,
      type: 'application/pdf',
      class: 'pdf-embed',
    }));
  }

  function setDirty() {
    if (!dirty) {
      dirty = true;
      updateSaveStatus();
    }
  }

  const saveDebounced = debounce(autoSave, 1500);

  async function autoSave() {
    if (!note || !selectedRow) return;
    if (saving) return;
    if (!dirty) return;
    saving = true;
    updateSaveStatus();
    try {
      const res = await fetch(`/api/notes/${selectedRow}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      issues = data.issues || [];
      dirty = false;
      // Update note_status in the paper list
      const p = papers.find((x) => x.paper_id === selectedRow);
      if (p) {
        p.note_status = issues.length === 0 ? 'valid' : 'draft';
        renderList();
      }
    } catch (err) {
      console.error('save failed:', err);
    } finally {
      saving = false;
      updateSaveStatus();
    }
  }

  let saveStatusEl;
  function updateSaveStatus() {
    if (!saveStatusEl) return;
    if (saving) {
      saveStatusEl.className = 'status-pill saved';
      saveStatusEl.textContent = 'saving…';
    } else if (dirty) {
      saveStatusEl.className = 'status-pill dirty';
      saveStatusEl.textContent = 'unsaved';
    } else {
      saveStatusEl.className = 'status-pill ' + (issues.length ? 'dirty' : 'saved');
      saveStatusEl.textContent = issues.length
        ? `draft (${issues.length} ${issues.length === 1 ? 'issue' : 'issues'})`
        : 'valid';
    }
  }

  async function loadSelected() {
    if (!selectedRow) return;
    formPaneEl.innerHTML = '';
    formPaneEl.appendChild(h('div', { class: 'placeholder' }, ['loading…']));
    const res = await fetch(`/api/notes/${selectedRow}`).then((r) => r.json());
    activePaper = res.paper;
    note = res.note;
    issues = res.issues || [];
    dirty = false;
    renderForm();
    renderPdfPane();
    renderList();
  }

  function renderForm() {
    formPaneEl.innerHTML = '';
    if (!note) {
      formPaneEl.appendChild(h('div', { class: 'placeholder' }, ['Select a paper.']));
      return;
    }

    saveStatusEl = h('span', { class: 'status-pill saved' });
    const saveBtn = h('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: () => { dirty = true; autoSave(); },
    }, ['Save now']);

    let fullDraftInflight = false;
    const draftBodyBtn = h('button', {
      class: 'btn btn-ai', type: 'button',
      title: 'Draft every section in parallel using full PDF-section context per call. Falls back to abstract-only when no PDF chunks are indexed.',
    }, ['✨ Draft note']);
    draftBodyBtn.addEventListener('click', () => {
      if (fullDraftInflight) return;
      if (!llm.isLoaded()) {
        alert('Configure an AI provider first (topbar AI pill).');
        return;
      }
      fullDraftInflight = true;
      runSectionedDraft({
        paper: activePaper,
        fm,
        note,
        formPaneEl,
        renderForm,
        setDirty, saveDebounced,
        topicTitle, topicDescription, categoriesEnum, methodFamiliesEnum,
        button: draftBodyBtn,
        useCritic: auditMode,
      }).finally(() => { fullDraftInflight = false; });
    });

    const issuesPanel = h('details', { class: 'issues-panel', open: issues.length > 0 && issues.length <= 3 }, [
      h('summary', { class: 'small' }, [
        `Validation: ${issues.length === 0 ? 'all good' : `${issues.length} issue${issues.length > 1 ? 's' : ''}`}`,
      ]),
      h('ul', { class: 'small' }, issues.map((i) => h('li', {}, [i]))),
    ]);

    const fm = note.frontmatter;

    // ===== Frontmatter form =====
    const titleInput = makeText(fm, 'title', setDirty, saveDebounced);
    const venueInput = makeText(fm, 'venue', setDirty, saveDebounced);
    const yearInput = makeNumber(fm, 'year', setDirty, saveDebounced);
    const doiInput = makeText(fm, 'doi', setDirty, saveDebounced);
    const arxivInput = makeText(fm, 'arxiv_id', setDirty, saveDebounced);
    const urlInput = makeText(fm, 'url', setDirty, saveDebounced);
    const readDateInput = makeText(fm, 'read_date', setDirty, saveDebounced);

    // Authors as comma-separated chip-ish input
    const authorsInput = h('input', {
      type: 'text',
      value: (fm.authors || []).join(', '),
      placeholder: 'Comma-separated',
    });
    authorsInput.addEventListener('input', () => {
      fm.authors = authorsInput.value.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
      setDirty(); saveDebounced();
    });

    // Category chips, options pulled from topic.md
    const categoryEditor = makeChipPicker(
      fm.category, [...categoriesEnum, 'other'],
      'Pick a category from your topic',
      (v) => { fm.category = v; setDirty(); saveDebounced(); },
    );

    // Method
    const methodFamilySelect = makeSelect(fm.method, 'family',
      [['', '— pick —'], ...[...methodFamiliesEnum, 'other'].map((v) => [v, v])],
      setDirty, saveDebounced);
    const methodSpecificInput = makeText(fm.method, 'specific', setDirty, saveDebounced);
    const methodInputsEditor = makeChipFreeform(fm.method.inputs, 'add input modality',
      (v) => { fm.method.inputs = v; setDirty(); saveDebounced(); });

    // Ground truth
    const gtSourceInput = makeText(fm.ground_truth, 'source', setDirty, saveDebounced);
    const gtExternalInput = makeBoolean(fm.ground_truth, 'external', setDirty, saveDebounced);
    const gtCaseCountInput = makeNumber(fm.ground_truth, 'case_count', setDirty, saveDebounced);
    const gtReproducibleInput = makeBoolean(fm.ground_truth, 'reproducible', setDirty, saveDebounced);

    // Evaluation
    const evalMetricsEditor = makeChipFreeform(fm.evaluation.metrics, 'add metric',
      (v) => { fm.evaluation.metrics = v; setDirty(); saveDebounced(); });
    const evalBaselineInput = makeBoolean(fm.evaluation, 'baseline_compared', setDirty, saveDebounced);
    const evalUncertaintyInput = makeBoolean(fm.evaluation, 'has_uncertainty_quantification', setDirty, saveDebounced);

    // Claims
    const claimsContribInput = makeText(fm.claims, 'primary_contribution', setDirty, saveDebounced);
    const claimsNoveltySelect = makeSelect(fm.claims, 'novelty_strength',
      NOVELTY_OPTIONS.map((v) => [v, v || '— pick —']),
      setDirty, saveDebounced);

    // Limitations the authors state
    const limitationsEditor = makeChipFreeform(fm.limitations_authors_state, 'add a limitation the authors stated',
      (v) => { fm.limitations_authors_state = v; setDirty(); saveDebounced(); });

    // Quality flags
    const qfBlock = h('div', { class: 'quality-flags' },
      ['self_constructed_ground_truth', 'comparison_table_only', 'hobby_project_scale', 'predictable_outcome'].map((k) =>
        h('label', { class: 'qf-row' }, [
          h('input', {
            type: 'checkbox',
            checked: !!fm.quality_flags[k],
            onchange: (e) => { fm.quality_flags[k] = e.target.checked; setDirty(); saveDebounced(); },
          }),
          ' ', k.replace(/_/g, ' '),
        ])
      )
    );

    // Relevance
    const relTopicSelect = makeSelect(fm.relevance, 'relevance_to_topic',
      RELEVANCE_OPTIONS.map((v) => [v, v || '— pick —']),
      setDirty, saveDebounced);
    const relMustCiteInput = makeBoolean(fm.relevance, 'must_cite', setDirty, saveDebounced);

    // ===== Body sections (textarea + ✨ suggest each) =====
    const bodyBlocks = [];
    for (const key of Object.keys(SECTION_LABELS)) {
      const ta = h('textarea', { rows: 5, value: note.body[key] || '', dataset: { section: key } });
      ta.value = note.body[key] || '';
      ta.addEventListener('input', () => { note.body[key] = ta.value; setDirty(); saveDebounced(); });
      const suggestBtn = h('button', {
        class: 'btn btn-ai', type: 'button',
        title: 'Generate this section using the active AI provider',
      }, ['✨ Suggest']);
      let inflight = false;
      suggestBtn.addEventListener('click', async () => {
        if (inflight) return;
        if (!llm.isLoaded()) {
          alert('Configure an AI provider first (topbar AI pill).');
          return;
        }
        inflight = true;
        const original = suggestBtn.innerHTML;
        suggestBtn.innerHTML = '<span class="spinner"></span> drafting…';
        suggestBtn.disabled = true;
        ta.disabled = true;
        const start = ta.value;
        try {
          const prompt = buildSectionPrompt(key, activePaper, fm);
          const text = await llm.chat({
            system: SYSTEM_BASE(topicTitle),
            user: prompt,
            temperature: 0.5,
            onToken: (_d, full) => { ta.value = full; },
          });
          note.body[key] = (text || ta.value).trim();
          ta.value = note.body[key];
          setDirty(); saveDebounced();
        } catch (err) {
          ta.value = start;
          alert('AI failed: ' + err.message);
        } finally {
          suggestBtn.innerHTML = original;
          suggestBtn.disabled = false;
          ta.disabled = false;
          inflight = false;
        }
      });
      bodyBlocks.push(h('div', { class: 'note-section' }, [
        h('div', { class: 'note-section-header' }, [
          h('h3', {}, [SECTION_LABELS[key]]),
          h('span', { class: 'section-status', dataset: { sectionStatus: key } }, []),
          suggestBtn,
        ]),
        h('p', { class: 'small muted' }, [SECTION_PROMPT_HINTS[key]]),
        ta,
      ]));
    }

    // ===== Final layout =====
    const toolbar = h('div', { class: 'note-toolbar' }, [
      h('div', { class: 'note-toolbar-left' }, [
        h('span', { class: 'paper-id-pill' }, [`paper_${activePaper.paper_id}`]),
        h('span', { class: 'muted small' }, [`${activePaper.triage_label} · ${shortAuthors(activePaper.authors)} · ${activePaper.year || ''}`]),
      ]),
      h('div', { class: 'note-toolbar-right' }, [saveStatusEl, draftBodyBtn, saveBtn]),
    ]);

    // Drafting progress panel — dynamically populated by runSectionedDraft.
    // Hidden by default; shows a row of 7 pills (one per LLM call) while
    // a draft is in flight so the student sees exactly which of the
    // parallel tasks is queued / running / done / failed.
    const draftProgressPanel = h('div', { class: 'draft-progress-panel', id: 'draft-progress-panel', style: { display: 'none' } });

    formPaneEl.appendChild(toolbar);
    formPaneEl.appendChild(draftProgressPanel);
    formPaneEl.appendChild(issuesPanel);

    formPaneEl.appendChild(section('Identification', [
      twoCol([labeled('Title', titleInput), labeled('Venue', venueInput)]),
      twoCol([labeled('Year', yearInput), labeled('DOI', doiInput)]),
      twoCol([labeled('arXiv ID', arxivInput), labeled('URL', urlInput)]),
      labeled('Authors', authorsInput),
      labeled('Read date', readDateInput),
    ]));

    formPaneEl.appendChild(section('Category & method', [
      labeled('Category', categoryEditor),
      twoCol([labeled('Method family', methodFamilySelect), labeled('Specific (model / tool)', methodSpecificInput)]),
      labeled('Method inputs', methodInputsEditor),
    ]));

    formPaneEl.appendChild(section('Ground truth', [
      twoCol([labeled('Source', gtSourceInput), labeled('Case count', gtCaseCountInput)]),
      twoCol([labeled('External', gtExternalInput), labeled('Reproducible', gtReproducibleInput)]),
    ]));

    formPaneEl.appendChild(section('Evaluation', [
      labeled('Metrics', evalMetricsEditor),
      twoCol([labeled('Baseline compared', evalBaselineInput), labeled('Uncertainty quantification', evalUncertaintyInput)]),
    ]));

    formPaneEl.appendChild(section('Claims', [
      labeled('Primary contribution', claimsContribInput),
      labeled('Novelty strength', claimsNoveltySelect),
    ]));

    formPaneEl.appendChild(section('Stated limitations', [
      labeled('List of limitations', limitationsEditor),
    ]));

    formPaneEl.appendChild(section('Quality flags', [qfBlock]));

    formPaneEl.appendChild(section('Relevance', [
      twoCol([labeled('Relevance to topic', relTopicSelect), labeled('Must cite', relMustCiteInput)]),
    ]));

    // Frontmatter status badge — when "Draft note" is running, the 7th
    // parallel call drafts the structured frontmatter. Surface its
    // status next to the Body divider so the student sees that call's
    // progress alongside the six body section calls.
    const fmStatus = h('span', { class: 'section-status', dataset: { sectionStatus: 'frontmatter' } }, []);
    formPaneEl.appendChild(h('h2', { class: 'body-divider' }, [
      'Body',
      h('span', { class: 'muted small body-divider-fm' }, [' · frontmatter ', fmStatus]),
    ]));
    bodyBlocks.forEach((b) => formPaneEl.appendChild(b));

    updateSaveStatus();
  }

  // Initial load
  await loadSelected();
  renderBatchBar();

  // Re-render the AI buttons when provider state changes
  const unsubLlm = llm.subscribe(() => {
    if (note) renderForm();
    renderBatchBar();
  });

  return () => {
    unsubLlm();
    drBatch.cancelled = true;
    drBatch.running = false;
    root.classList.remove('view-deepread');
  };
}

// ---- Helpers ----

function buildSectionPrompt(sectionKey, paper, fm) {
  const hint = SECTION_PROMPT_HINTS[sectionKey];
  return `Paper:
Title: ${paper.title}
Authors: ${paper.authors}
Year: ${paper.year}
Venue: ${paper.venue}
Abstract: ${(paper.abstract || '').slice(0, 2400)}

Existing notes for context:
- Primary contribution: ${fm?.claims?.primary_contribution || '(not yet stated)'}
- Method family: ${fm?.method?.family || '(not yet stated)'}
- Ground truth source: ${fm?.ground_truth?.source || '(not yet stated)'}

Section to write: ${SECTION_LABELS[sectionKey]}
Instruction: ${hint}

Write only that section. Plain prose, no headings, no bullets, no preamble. Two to four short paragraphs maximum.`;
}

function shortAuthors(s) {
  if (!s) return '';
  const parts = String(s).split(/,\s*/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} & ${parts[1]}`;
  return `${parts[0]} et al.`;
}

function parseList(md, key) {
  const re = new RegExp(`${key}:\\s*\\n((?:[ \\t]*-[ \\t]*\\S.*\\n?)+)`);
  const m = md.match(re);
  if (!m) return [];
  return (m[1].match(/-\s*([^\n]+)/g) || [])
    .map((s) => s.replace(/^-\s*/, '').trim())
    .filter((s) => s && !/^replace_with/.test(s));
}

function makeText(obj, key, onChange, onChangeLater) {
  const input = h('input', { type: 'text', value: obj[key] ?? '' });
  input.addEventListener('input', () => { obj[key] = input.value; onChange(); onChangeLater?.(); });
  return input;
}
function makeNumber(obj, key, onChange, onChangeLater) {
  const input = h('input', { type: 'number', value: String(obj[key] ?? '') });
  input.addEventListener('input', () => {
    obj[key] = parseInt(input.value, 10) || 0;
    onChange(); onChangeLater?.();
  });
  return input;
}
function makeBoolean(obj, key, onChange, onChangeLater) {
  const input = h('input', { type: 'checkbox', checked: !!obj[key] });
  input.addEventListener('change', () => { obj[key] = input.checked; onChange(); onChangeLater?.(); });
  return h('label', { class: 'inline-bool' }, [input, ' ', obj[key] ? 'true' : 'false']);
}
function makeSelect(obj, key, options, onChange, onChangeLater) {
  const select = h('select', {});
  for (const [val, label] of options) {
    const opt = h('option', { value: val }, [label]);
    if (obj[key] === val) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => { obj[key] = select.value; onChange(); onChangeLater?.(); });
  return select;
}

function makeChipPicker(values, options, placeholder, onChange) {
  let items = [...(values || [])];
  const wrap = h('div', { class: 'chip-input' });
  const list = h('div', { class: 'chips' });
  const select = h('select', { class: 'chip-add' });
  select.appendChild(h('option', { value: '' }, [placeholder]));
  for (const o of options) select.appendChild(h('option', { value: o }, [o]));
  function render() {
    list.innerHTML = '';
    items.forEach((v, i) => {
      list.appendChild(h('span', { class: 'chip' }, [
        v,
        h('button', { class: 'chip-remove', type: 'button',
          onclick: () => { items.splice(i, 1); render(); onChange([...items]); },
        }, ['×']),
      ]));
    });
    select.value = '';
  }
  select.addEventListener('change', () => {
    const v = select.value;
    if (!v || items.includes(v)) return;
    items.push(v);
    render();
    onChange([...items]);
  });
  wrap.appendChild(list);
  wrap.appendChild(select);
  render();
  return wrap;
}

function makeChipFreeform(values, placeholder, onChange) {
  let items = [...(values || [])];
  const wrap = h('div', { class: 'chip-input' });
  const list = h('div', { class: 'chips' });
  const input = h('input', { type: 'text', class: 'chip-add', placeholder });
  function render() {
    list.innerHTML = '';
    items.forEach((v, i) => {
      list.appendChild(h('span', { class: 'chip' }, [
        v,
        h('button', { class: 'chip-remove', type: 'button',
          onclick: () => { items.splice(i, 1); render(); onChange([...items]); },
        }, ['×']),
      ]));
    });
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = input.value.trim();
      if (!v || items.includes(v)) { input.value = ''; return; }
      items.push(v);
      input.value = '';
      render();
      onChange([...items]);
    }
  });
  wrap.appendChild(list);
  wrap.appendChild(input);
  render();
  return wrap;
}

function section(title, children) {
  return h('section', { class: 'note-fieldset' }, [
    h('h3', {}, [title]),
    ...children,
  ]);
}
function labeled(label, control) {
  return h('label', { class: 'note-field' }, [
    h('span', { class: 'note-field-label' }, [label]),
    control,
  ]);
}
function twoCol(children) {
  return h('div', { class: 'note-row-2' }, children);
}
