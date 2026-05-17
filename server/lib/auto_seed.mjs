// auto_seed.mjs
//
// When topic.md doesn't yet define `categories` or `method_families`, five
// of seven gap detectors stay empty (they classify against those axes).
// This module derives a sensible first cut from the corpus itself.
//
// Two paths, picked by AI provider availability:
//
//   1. LLM path (Anthropic / OpenAI configured)
//        Sample up to N abstracts, cluster their embeddings with
//        sentence-transformers `communityDetection`, send each cluster's
//        representative titles+abstract snippets to the LLM with a strict
//        "name this cluster in 1-3 words" instruction. Same for method
//        families using a methods-section sample. Result: human-readable
//        category labels grounded in the actual corpus.
//
//   2. Local path (no AI configured)
//        communityDetection still runs to identify the clusters; we then
//        label each by extracting the most distinctive bigrams from the
//        cluster's combined text (relative to corpus-wide bigram
//        frequency). Coarser, but no external calls.
//
// Output is WRITTEN to topic.md. Existing user-set fields (title,
// description, contact_email, year_min/max, target_includes) are
// preserved. Only `categories` and `method_families` are replaced /
// inserted.

import { promises as fs } from 'node:fs';
import * as store from './store.mjs';
import * as embedder from './embedder.mjs';
import { callLlm, pickAvailableProvider as pickLlmProvider } from './llm_proxy.mjs';
import { makeMatrix, normalize, communityDetection, autoTuneCommunityParams } from './sbert_utils.mjs';
import { PROTOCOL_FILES } from '../paths.mjs';
import { parseTopic } from './topic_md.mjs';

const MAX_ABSTRACT_SAMPLE = 400;     // cap clustering input — beyond this the labelling LLM call gets unwieldy
const SAMPLE_TITLES_PER_CLUSTER = 8;
const MAX_CATEGORIES = 8;
const MAX_METHOD_FAMILIES = 6;

// ─────────────────────────────────────────────────────────────────────────
// Corpus sampling
// ─────────────────────────────────────────────────────────────────────────

function sampleAbstracts(limit = MAX_ABSTRACT_SAMPLE) {
  // Prefer include/maybe papers. Skip empty abstracts.
  return store.query(
    `SELECT paper_id, title, abstract, year
       FROM papers
      WHERE triage_label IN ('include', 'maybe')
        AND abstract IS NOT NULL
        AND length(abstract) > 80
      ORDER BY paper_id
      LIMIT ?`,
    [limit],
  );
}

function sampleMethodsText(limit = MAX_ABSTRACT_SAMPLE) {
  // Pull methods-section chunks (one per paper, longest available).
  // Falls back to all chunks if section classification is missing.
  return store.query(
    `WITH ranked AS (
       SELECT c.paper_id, c.text, length(c.text) AS len,
              ROW_NUMBER() OVER (PARTITION BY c.paper_id ORDER BY length(c.text) DESC) AS rn
         FROM chunks c
         LEFT JOIN chunk_section cs ON cs.chunk_id = c.chunk_id
        WHERE cs.label IN ('methods', 'experimental_setup', 'abstract')
           OR cs.label IS NULL
     )
     SELECT paper_id, text FROM ranked WHERE rn = 1 LIMIT ?`,
    [limit],
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Clustering helpers
// ─────────────────────────────────────────────────────────────────────────

async function embedTexts(texts) {
  if (!texts.length) return null;
  const r = await embedder.embed(texts);
  const mat = makeMatrix(texts.length, r.dim, new Float32Array(r.data));
  normalize(mat);
  return mat;
}

function clusterMatrix(mat) {
  if (!mat || mat.rows < 4) {
    // Not enough data to cluster meaningfully; treat every doc as its own
    // tiny cluster up to MAX_CATEGORIES.
    return Array.from({ length: Math.min(mat?.rows || 0, MAX_CATEGORIES) }, (_, i) => [i]);
  }
  const tuned = autoTuneCommunityParams(mat, {});
  const clusters = communityDetection(mat, {
    threshold: tuned.threshold ?? 0.55,
    minCommunitySize: tuned.minCommunitySize ?? 2,
  });
  // communityDetection returns arrays of indices; outliers come back as
  // singletons or are dropped. Sort by size, keep largest N.
  const sorted = (clusters || []).filter((c) => c.length > 0).sort((a, b) => b.length - a.length);
  return sorted;
}

// ─────────────────────────────────────────────────────────────────────────
// Local labelling (no AI): bigram TF-IDF-ish over a cluster vs corpus.
// We use distinctive bigrams, not LDA / k-means, so this stays within the
// project's "no legacy stats" constraint — it's a name-the-cluster
// heuristic, not a clustering algorithm.
// ─────────────────────────────────────────────────────────────────────────

function tokenise(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

const STOP = new Set([
  'the','and','for','with','from','that','this','these','those','they','their','have','has','had','was','were','been','being','are','our','use','using','used','one','two','three','also','more','most','some','such','very','can','may','will','would','could','should','its','it\'s','any','all','non','than','then','only','into','out','about','over','between','among','within','toward','towards','here','there','where','which','who','what','how','why','when','etc','via','per','among','same','show','shows','found','find','study','studies','paper','work','approach','approaches','method','methods','results','using','based','set','data','model','models','task','tasks','propose','proposed','novel','new','first','large','small','high','low','better','well','also','many','few','different','given','known','important','specific','general',
]);

function bigrams(words) {
  const out = [];
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (a.length < 3 || b.length < 3) continue;
    out.push(`${a} ${b}`);
  }
  return out;
}

function labelClustersLocal(clusters, docs) {
  // Build corpus-wide bigram DF for distinctiveness.
  const corpusBigrams = new Map();
  const docBigrams = new Array(docs.length);
  for (let i = 0; i < docs.length; i++) {
    const words = tokenise(docs[i]);
    const grams = new Set(bigrams(words));
    docBigrams[i] = grams;
    for (const g of grams) corpusBigrams.set(g, (corpusBigrams.get(g) || 0) + 1);
  }
  return clusters.map((cluster) => {
    const local = new Map();
    for (const idx of cluster) {
      for (const g of docBigrams[idx]) local.set(g, (local.get(g) || 0) + 1);
    }
    const scored = [];
    for (const [g, c] of local) {
      const df = corpusBigrams.get(g) || 1;
      // Distinctiveness: cluster_count / sqrt(corpus_df). Avoids one-doc bigrams.
      if (c < 2 && cluster.length > 2) continue;
      const score = c / Math.sqrt(df);
      scored.push({ g, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      indices: cluster,
      label: scored[0]?.g || 'cluster',
      candidates: scored.slice(0, 5).map((s) => s.g),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// LLM labelling — one call labels every cluster at once. The LLM gets a
// compact preview per cluster and returns short labels.
// ─────────────────────────────────────────────────────────────────────────

async function labelClustersWithLLM(clusters, docs, kind, topicHint) {
  const provider = await pickLlmProvider({});
  if (!provider) return null;
  // Build compact preview per cluster.
  const previews = clusters.map((cluster, ci) => {
    const lines = [`Cluster ${ci + 1} (${cluster.length} papers):`];
    const sample = cluster.slice(0, SAMPLE_TITLES_PER_CLUSTER);
    for (const idx of sample) {
      const d = docs[idx];
      if (!d) continue;
      lines.push(`- ${String(d).slice(0, 240).replace(/\s+/g, ' ').trim()}`);
    }
    return lines.join('\n');
  }).join('\n\n');

  const purpose = kind === 'categories'
    ? `Each cluster represents a research category — a topical grouping the papers fit under (e.g. "clinical NLP", "graph neural networks", "differential privacy"). Use the topic context to pick labels at the right scope.`
    : `Each cluster represents a methodological family — the technical approach the papers share (e.g. "deep_learning", "regression", "ethnography", "formal_verification"). Use snake_case, lower kebab is fine.`;

  const sys = `You are labelling clusters of research papers found in a literature-review corpus. ${purpose}

Topic the review is positioned within: ${topicHint || '(no topic title set yet)'}

Read the clusters below and return a JSON array. Each element: {"index": <1-based cluster number>, "label": <1-3 word label>, "rationale": <one short sentence quoting key vocabulary you used>}. No prose, no fences, no extra fields. Skip a cluster only if it looks like noise.`;

  const usr = previews;
  const raw = await callLlm({
    provider,
    system: sys,
    user: usr,
    temperature: 0.1,
  });
  // Parse first JSON array.
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const open = s.indexOf('[');
  if (open < 0) return null;
  s = s.slice(open);
  // Balanced-bracket scan.
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
  if (end < 0) return null;
  let parsed;
  try { parsed = JSON.parse(s.slice(0, end)); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const labels = new Map();
  for (const obj of parsed) {
    if (!obj || typeof obj.index !== 'number' || typeof obj.label !== 'string') continue;
    labels.set(obj.index - 1, obj.label.trim());
  }
  return clusters.map((cluster, ci) => ({
    indices: cluster,
    label: labels.get(ci) || `cluster_${ci + 1}`,
    n: cluster.length,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Topic.md rewriting (preserves untouched fields)
// ─────────────────────────────────────────────────────────────────────────

function renderTopicMd(existing, categories, methodFamilies) {
  // Existing topic.md may use YAML-front-matter style; we re-render a
  // minimal canonical form. Preserve known fields if set.
  const lines = [];
  lines.push(`title: ${existing.title || 'Untitled review'}`);
  if (existing.description) {
    lines.push(`description: |`);
    for (const l of existing.description.split('\n')) lines.push(`  ${l}`);
  } else {
    lines.push(`description: |`);
    lines.push(`  A research-domain analysis. Auto-seeded categories and method families below from the imported corpus; review and refine.`);
  }
  if (existing.contact_email) lines.push(`contact_email: ${existing.contact_email}`);
  if (existing.year_min) lines.push(`year_min: ${existing.year_min}`);
  if (existing.year_max) lines.push(`year_max: ${existing.year_max}`);
  if (existing.target_includes) lines.push(`target_includes: ${existing.target_includes}`);
  if (existing.minimum_includes) lines.push(`minimum_includes: ${existing.minimum_includes}`);
  lines.push(`categories:`);
  for (const c of categories) lines.push(`  - ${c}`);
  lines.push(`method_families:`);
  for (const m of methodFamilies) lines.push(`  - ${m}`);
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Probe whether topic.md needs seeding. Returns
 *   { needs_seed: boolean, reason: string, corpus_size: number, has_llm: boolean }
 */
export async function status() {
  await store.init();
  let topic = {};
  try {
    const md = await fs.readFile(PROTOCOL_FILES.topic, 'utf8');
    topic = parseTopic(md) || {};
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const corpusSize = store.query(
    `SELECT COUNT(*) AS n FROM papers WHERE triage_label IN ('include', 'maybe') AND abstract IS NOT NULL AND length(abstract) > 80`,
  )[0]?.n || 0;
  const provider = await pickLlmProvider({});
  const empty = !topic.categories?.length && !topic.method_families?.length;
  return {
    needs_seed: empty,
    reason: empty ? 'topic.md has no categories or method_families set' : 'topic.md already has axes',
    corpus_size: corpusSize,
    has_llm: !!provider,
    llm_provider: provider,
    current_categories: topic.categories || [],
    current_method_families: topic.method_families || [],
  };
}

/**
 * Build categories + method_families from the current corpus and write
 * them into topic.md.
 *
 * opts:
 *   force          — overwrite even if topic.md already has axes
 *   maxCategories  — cap on categories produced
 *   maxMethods     — cap on method families produced
 */
export async function runAutoSeed(opts = {}) {
  await store.init();
  const report = { started_at: new Date().toISOString(), stages: {} };

  const md = await fs.readFile(PROTOCOL_FILES.topic, 'utf8').catch(() => '');
  const existing = parseTopic(md) || {};
  if (!opts.force && (existing.categories?.length || existing.method_families?.length)) {
    return { skipped: 'topic_already_set', existing };
  }

  // ─── Categories from abstracts.
  const abstracts = sampleAbstracts();
  report.stages.abstracts = { count: abstracts.length };
  if (abstracts.length < 4) {
    return { error: 'corpus too small to seed (need ≥ 4 papers with abstracts; have ' + abstracts.length + ')' };
  }
  const docTexts = abstracts.map((r) => `${r.title || ''}. ${String(r.abstract || '').slice(0, 700)}`);
  const mat = await embedTexts(docTexts);
  const clusters = clusterMatrix(mat).slice(0, opts.maxCategories ?? MAX_CATEGORIES);
  report.stages.cluster_categories = { n: clusters.length, sizes: clusters.map((c) => c.length) };

  // Cluster labelling is a generative task — picking a 1-3 word name
  // for a group of papers. AI is the right tool when the user has a
  // provider configured. Fall back to a deterministic distinctive-
  // bigram heuristic when AI is off or fails. Caller can force one
  // path with opts.useLlm = true / false.
  const allowLlm = opts.useLlm !== false;
  let labelledCategories = null;
  if (allowLlm) {
    try {
      labelledCategories = await labelClustersWithLLM(clusters, docTexts, 'categories', existing.title);
      if (labelledCategories) report.stages.label_categories = { mechanism: 'llm', n: labelledCategories.length };
    } catch (e) {
      report.stages.label_categories = { mechanism: 'llm_failed', error: e.message };
    }
  }
  if (!labelledCategories) {
    labelledCategories = labelClustersLocal(clusters, docTexts);
    report.stages.label_categories = { mechanism: 'local_bigram', n: labelledCategories.length };
  }
  const categories = labelledCategories
    .map((c) => c.label)
    .filter(Boolean)
    .map((s) => s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '').slice(0, 40))
    .filter(Boolean);

  // ─── Method families from methods-section chunks.
  const methodsRows = sampleMethodsText();
  report.stages.methods_text = { count: methodsRows.length };
  let methodFamilies = [];
  if (methodsRows.length >= 4) {
    const methodTexts = methodsRows.map((r) => String(r.text || '').slice(0, 900));
    const mat2 = await embedTexts(methodTexts);
    const clusters2 = clusterMatrix(mat2).slice(0, opts.maxMethods ?? MAX_METHOD_FAMILIES);
    report.stages.cluster_methods = { n: clusters2.length, sizes: clusters2.map((c) => c.length) };
    let labelledMethods = null;
    if (allowLlm) {
      try {
        labelledMethods = await labelClustersWithLLM(clusters2, methodTexts, 'method_families', existing.title);
      } catch (e) {
        report.stages.label_methods = { mechanism: 'llm_failed', error: e.message };
      }
    }
    if (!labelledMethods) {
      labelledMethods = labelClustersLocal(clusters2, methodTexts);
      report.stages.label_methods = { mechanism: 'local_bigram', n: labelledMethods.length };
    } else {
      report.stages.label_methods = { mechanism: 'llm', n: labelledMethods.length };
    }
    methodFamilies = labelledMethods
      .map((c) => c.label)
      .filter(Boolean)
      .map((s) => s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '').slice(0, 40))
      .filter(Boolean);
  } else {
    // Reasonable defaults for very tiny corpora; the user will edit.
    methodFamilies = ['deep_learning', 'classical_machine_learning', 'qualitative', 'theoretical', 'other'];
  }

  // ─── Persist to topic.md.
  const next = renderTopicMd(existing, categories, methodFamilies);
  await fs.writeFile(PROTOCOL_FILES.topic, next, 'utf8');

  report.categories = categories;
  report.method_families = methodFamilies;
  report.finished_at = new Date().toISOString();
  return report;
}
