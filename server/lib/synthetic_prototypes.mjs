// synthetic_prototypes.mjs
//
// Build "synthetic" prototype embeddings from the student's Setup + criteria
// text — *before* (and alongside) anything they've manually labeled. These
// fill three roles:
//
//   1. Cold start. With 0 manual decisions, the pre-filter still has an
//      include side because we embed the topic abstract + inclusion-rule
//      paragraphs and treat them as if they were labeled papers.
//
//   2. Class-imbalance anchor. When manual labels skew heavily one way
//      (e.g. 43 includes vs 733 excludes), synthetic prototypes give the
//      underrepresented side concrete coverage that doesn't get drowned
//      out by sheer count on the other side.
//
//   3. Criteria-as-signal. The student's qualitative inclusion rules are
//      already in inclusion_criteria.md. Embedding them gives the
//      classifier *some* of that signal — not as good as an LLM reading
//      them, but free, fast, and applied to every preview/auto-decide
//      automatically.
//
// What we embed and which side it lands on:
//   - topic.md title + description           → include anchor
//   - each category from topic.md            → include concept anchor
//   - each paragraph under "## Inclusion criteria" → include anchor
//   - each paragraph under "## Exclusion criteria" → exclude anchor
//
// Cached in-process by content hash so we don't re-embed on every preview.
// Cache is invalidated when topic.md or inclusion_criteria.md is saved
// (api.mjs already calls invalidateSyntheticCache on those writes).

import crypto from 'node:crypto';
import { PROTOCOL_FILES } from '../paths.mjs';
import { readText } from '../storage.mjs';
import { parseTopic } from './topic_md.mjs';
import * as embedder from './embedder.mjs';

const MIN_CHARS = 20; // ignore one-word fragments

let _cache = null; // { hash, include: [{vec, source}, …], exclude: [...] }

function hashOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

// Pull paragraphs out of a markdown section, where the section header is
// identified by a `## Heading` line containing the keyword. Returns an
// array of trimmed paragraph strings; bullet markers / numbering stripped.
function paragraphsUnder(md, headingKeyword) {
  if (!md) return [];
  const lines = md.split('\n');
  let inSection = false;
  const collected = [];
  let buf = [];
  const flush = () => {
    const joined = buf.join(' ').trim();
    if (joined.length >= MIN_CHARS) collected.push(joined);
    buf = [];
  };
  const isHeading = (l) => /^#{1,6}\s/.test(l);
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (isHeading(line)) {
      flush();
      inSection = new RegExp(`^#{1,6}\\s+.*${headingKeyword}`, 'i').test(line);
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.replace(/^\s*[-*\d]+\.?\s*/, '').trim();
    if (trimmed === '') {
      flush();
    } else {
      buf.push(trimmed);
    }
  }
  flush();
  return collected;
}

// Collect the text fragments we want to embed, tagged with which side
// they belong on and a human-readable source label for the UI.
async function gatherSourceTexts() {
  const topicMd = await readText(PROTOCOL_FILES.topic, '');
  const criteriaMd = await readText(PROTOCOL_FILES.inclusion_criteria, '');
  const topic = parseTopic(topicMd);

  const includes = [];
  const excludes = [];

  // Topic title + description → primary include anchor.
  const topicText = [topic.title, topic.description].filter(Boolean).join('\n\n').trim();
  if (topicText.length >= MIN_CHARS) {
    includes.push({ text: topicText, source: 'topic abstract' });
  }

  // Each category as its own concept anchor. These are typically 1-3 words,
  // which is below MIN_CHARS — embed only if combined with the topic title
  // to give the embedder enough context.
  for (const cat of topic.categories || []) {
    if (!cat || /^replace_with/i.test(cat)) continue;
    const ctx = `${topic.title ? topic.title + ': ' : ''}category — ${cat}`;
    if (ctx.length >= MIN_CHARS) {
      includes.push({ text: ctx, source: `category: ${cat}` });
    }
  }

  // Inclusion criteria paragraphs.
  for (const p of paragraphsUnder(criteriaMd, 'inclu')) {
    includes.push({ text: p, source: 'inclusion criterion' });
  }
  // Exclusion criteria paragraphs.
  for (const p of paragraphsUnder(criteriaMd, 'exclu')) {
    excludes.push({ text: p, source: 'exclusion criterion' });
  }

  return { includes, excludes };
}

// Build (or return cached) synthetic prototype embeddings. The cache key is
// a hash of all text we'd embed, so any change to topic.md or
// inclusion_criteria.md naturally invalidates without needing the explicit
// invalidateSyntheticCache hook (the hook just short-circuits the read).
export async function loadSyntheticPrototypes() {
  const { includes, excludes } = await gatherSourceTexts();
  const fullText = JSON.stringify({ includes, excludes });
  const h = hashOf(fullText);
  if (_cache?.hash === h) return _cache;

  const all = [...includes.map((it) => ({ ...it, side: 'include' })),
               ...excludes.map((it) => ({ ...it, side: 'exclude' }))];
  if (all.length === 0) {
    _cache = { hash: h, include: [], exclude: [] };
    return _cache;
  }
  const r = await embedder.embed(all.map((it) => it.text));
  const dim = r.dim;
  const out = { hash: h, include: [], exclude: [] };
  for (let i = 0; i < all.length; i++) {
    const vec = new Float32Array(r.data.subarray(i * dim, (i + 1) * dim));
    out[all[i].side].push({
      vec,
      size: 1,
      members: [],
      source: all[i].source,
      synthetic: true,
    });
  }
  _cache = out;
  return out;
}

// Hook called from api.mjs after topic.md / inclusion_criteria.md saves.
// The hash-based cache key would catch this anyway, but explicit
// invalidation avoids the next request paying a redundant hash compute.
export function invalidateSyntheticCache() {
  _cache = null;
}
