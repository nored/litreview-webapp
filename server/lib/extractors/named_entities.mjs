// extractors/named_entities.mjs
//
// Type-prompted zero-shot named-entity extraction via GLiNER. The user's
// topic.md declares which entity types matter (e.g. `attack_technique`,
// `dataset`, `treaty`, `company` — anything). For each paper:
//
//   1. Pull eligible-section chunks via _section_routing (whole-paper
//      fallback when section classification missed). References excluded.
//   2. For each chunk: ONE GLiNER inference returns labelled spans across
//      the entity_types in topic.md. No regex proposer, no NLI typing,
//      no static dictionary.
//   3. Entity-resolution canonicalises each accepted span across the
//      corpus (variant spellings → one canonical_name).
//   4. Write canonical_names + name_usage with provenance: GLiNER
//      score, span start/end, section tier, chunk + page.
//
// GLiNER returns spans like:
//   { text: "Prime+Probe", label: "attack_technique", start: 41, end: 52, score: 0.92 }
//
// Score range typically 0.4-0.99; we keep the threshold low here and
// surface the score in provenance so the deep-read UI can show it.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as store from '../store.mjs';
import * as gliner from '../gliner.mjs';
import { EntityResolver } from '../entity_resolution.mjs';
import { readText } from '../../storage.mjs';
import { PROTOCOL_FILES } from '../../paths.mjs';
import { parseTopic } from '../topic_md.mjs';
import { eligibleChunksWithFallback, annotateMechanism } from './_section_routing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOCAB_DIR = path.join(__dirname, '..', '..', '..', 'data', '_vocab');

const ENTITY_SECTIONS = [
  'abstract', 'introduction', 'background', 'related_work',
  'methods', 'experimental_setup', 'results', 'discussion',
  'limitations', 'conclusion', 'future_work', 'appendix',
];

// GLiNER inference parameters. threshold lower-bounds the per-span score;
// chunks pass through whole — GLiNER's positional embeddings handle
// internal context. maxSpansPerText caps runaway extraction on long
// passages (one chunk should produce at most ~50 entities).
const GLINER_THRESHOLD = 0.40;
const GLINER_MAX_SPANS_PER_CHUNK = 60;
// GLiNER's max input length. We trim per-chunk to be safe.
const CHUNK_CHAR_BUDGET = 1800;

// ─────────────────────────────────────────────────────────────────────────
// Entity-resolver cache — one per kind, populated lazily from canonical_names
// + optional sidecar JSON vocab files.
// ─────────────────────────────────────────────────────────────────────────

const _resolverCache = new Map();
const _resolverDirty = new Set();

function vocabFileFor(kind) {
  return path.join(VOCAB_DIR, `${kind}.json`);
}

async function getResolver(kind) {
  if (_resolverCache.has(kind)) return _resolverCache.get(kind);
  const resolver = new EntityResolver({ kind });
  try {
    const blob = JSON.parse(await fs.readFile(vocabFileFor(kind), 'utf8'));
    resolver.loadFromObject(blob);
  } catch { /* no sidecar */ }
  try {
    const rows = store.query(
      'SELECT canonical, preferred_label, aliases_json FROM canonical_names WHERE kind = ?',
      [kind],
    );
    for (const r of rows) {
      let aliases = [];
      try { aliases = JSON.parse(r.aliases_json || '[]'); } catch { /* skip */ }
      resolver.add(r.canonical, { label: r.preferred_label || r.canonical, aliases });
    }
  } catch { /* fresh DB */ }
  _resolverCache.set(kind, resolver);
  return resolver;
}

export async function saveDirtyVocabs() {
  const saved = [];
  for (const kind of _resolverDirty) {
    const resolver = _resolverCache.get(kind);
    if (!resolver) continue;
    try {
      await fs.mkdir(VOCAB_DIR, { recursive: true });
      const blob = resolver.toObject();
      await fs.writeFile(vocabFileFor(kind), JSON.stringify(blob, null, 2) + '\n', 'utf8');
      saved.push(kind);
    } catch (e) {
      console.warn(`named_entities: vocab persist failed for ${kind}: ${e.message}`);
    }
  }
  _resolverDirty.clear();
  return saved;
}

function canonicaliseSlug(raw) {
  return String(raw).toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._+-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─────────────────────────────────────────────────────────────────────────
// Per-paper extraction
// ─────────────────────────────────────────────────────────────────────────

async function loadEntityTypes() {
  const md = await readText(PROTOCOL_FILES.topic, '');
  const t = parseTopic(md) || {};
  if (Array.isArray(t.entity_types) && t.entity_types.length) {
    return t.entity_types;
  }
  // Universal fallback when topic.md has nothing set — works for any
  // field but is less specific than user-tuned types. The Setup banner
  // prompts the user to auto-seed entity_types.
  return ['person', 'organisation', 'place', 'time_period', 'document', 'concept'];
}

export async function extractNamedEntities(paperId, opts = {}) {
  await store.init();

  const { rows: chunks, tier } = eligibleChunksWithFallback(paperId, ENTITY_SECTIONS);
  if (chunks.length === 0) {
    return { paper_id: paperId, n_spans: 0, n_kept: 0, by_kind: {}, tier, reason: 'no_chunks' };
  }

  // Wipe prior name_usage so this paper's results reflect the current
  // entity_types catalogue.
  store.exec('DELETE FROM name_usage WHERE paper_id = ?', [paperId]);

  const entityTypes = await loadEntityTypes();
  if (entityTypes.length === 0) {
    return { paper_id: paperId, n_spans: 0, n_kept: 0, by_kind: {}, tier, reason: 'no_entity_types' };
  }

  // GLiNER per chunk. The model handles full-passage context so we don't
  // batch across chunks — one call per chunk keeps inputs under the
  // 384-token max length.
  const allSpans = [];
  let glinerDegraded = false;
  for (const c of chunks) {
    const text = String(c.text || '').slice(0, CHUNK_CHAR_BUDGET);
    if (!text.trim()) continue;
    try {
      const spans = await gliner.extract(text, entityTypes, {
        threshold: opts.threshold ?? GLINER_THRESHOLD,
        maxSpansPerText: GLINER_MAX_SPANS_PER_CHUNK,
      });
      for (const s of spans) {
        allSpans.push({
          text: s.text,
          label: s.label,
          score: s.score,
          start: s.start,
          end: s.end,
          chunk_id: c.chunk_id,
          page: c.page_first ?? null,
        });
      }
    } catch (e) {
      glinerDegraded = true;
      console.warn(`named_entities: gliner failed on chunk ${c.chunk_id}: ${e?.message || e}`);
      // continue — one bad chunk shouldn't kill the paper.
    }
  }

  if (allSpans.length === 0) {
    return {
      paper_id: paperId, n_spans: 0, n_kept: 0, by_kind: {}, tier,
      reason: glinerDegraded ? 'gliner_degraded' : 'no_entities_found',
    };
  }

  // Resolve, canonicalise, write. Dedup per (kind, canonical) within
  // this paper — multiple mentions collapse to one row but the
  // highest-confidence mention keeps its provenance.
  allSpans.sort((a, b) => b.score - a.score);   // best-confidence wins on dedup

  const seen = new Set();    // "kind|canonical" already written for this paper
  const byKind = {};
  let novel = 0;

  for (const s of allSpans) {
    const kind = s.label;
    const resolver = await getResolver(kind);
    const resolved = await resolver.canonicalise(s.text);
    let canonical, resolverMechanism;
    if (resolved.status === 'exact' || resolved.status === 'edit') {
      canonical = resolved.canonical;
      resolverMechanism = resolved.mechanism;
    } else if (resolved.status === 'embedding' && resolved.score >= 0.85) {
      canonical = resolved.canonical;
      resolverMechanism = 'embedding';
    } else {
      // Novel entity — slugify and register.
      canonical = canonicaliseSlug(s.text);
      if (!canonical) continue;
      resolver.add(canonical, { label: s.text, aliases: [s.text] });
      _resolverDirty.add(kind);
      resolverMechanism = 'novel';
      novel++;
    }
    const dedupKey = `${kind}|${canonical}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // canonical_names upsert.
    const existing = store.query(
      'SELECT canonical, aliases_json FROM canonical_names WHERE canonical = ?',
      [canonical],
    );
    if (existing.length === 0) {
      store.exec(
        `INSERT INTO canonical_names (canonical, kind, preferred_label, aliases_json)
         VALUES (?, ?, ?, ?)`,
        [canonical, kind, s.text, JSON.stringify([s.text])],
      );
    } else {
      let aliases = [];
      try { aliases = JSON.parse(existing[0].aliases_json || '[]'); } catch { /* skip */ }
      if (!aliases.includes(s.text)) {
        aliases.push(s.text);
        store.exec('UPDATE canonical_names SET aliases_json = ? WHERE canonical = ?',
          [JSON.stringify(aliases), canonical]);
      }
    }

    // Provenance + name_usage.
    const provId = store.recordProvenance({
      mechanism: annotateMechanism(`gliner+${resolverMechanism}`, tier),
      model: gliner.MODEL,
      chunk_id: s.chunk_id,
      page: s.page,
      raw_text: s.text,
      classifier_scores: {
        gliner_score: s.score,
        span_start: s.start,
        span_end: s.end,
        resolver_mechanism: resolverMechanism,
      },
      confidence: s.score,
    });
    store.exec(
      `INSERT INTO name_usage (paper_id, canonical, kind, raw, page, mechanism, score, provenance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [paperId, canonical, kind, s.text, s.page,
       annotateMechanism('gliner', tier), s.score, provId],
    );
    byKind[kind] = (byKind[kind] || 0) + 1;
  }

  await store.flush();
  return {
    paper_id: paperId,
    n_spans: allSpans.length,
    n_kept: Object.values(byKind).reduce((a, b) => a + b, 0),
    n_novel: novel,
    by_kind: byKind,
    tier,
    model: gliner.MODEL,
  };
}

export const NAMED_ENTITY_FIELDS = ['entities'];
