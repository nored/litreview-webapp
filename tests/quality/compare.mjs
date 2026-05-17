#!/usr/bin/env node
// Diff gold notes vs pipeline output. Computes per-phase P/R/F1
// across the gold sample, plus per-paper diff markdown to
// tests/quality/report/.
//
// Phases compared (one section per phase in the report):
//   - sections        (canonical_type per heading)
//   - entities        (span_text + gliner_label)
//   - claims          (quote substring + claim_type + stance)
//   - numerical       (metric + value ±1% + dataset)
//   - citation_stance (ref_key + stance)
//   - miles_gaps      (type + contributing-paper overlap with last Phase 4 run)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import * as store from '../../server/lib/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const GOLD_DIR = path.join(__dirname, 'gold');
const REPORT_DIR = path.join(__dirname, 'report');

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const LIGATURES = { 'ﬀ':'ff','ﬁ':'fi','ﬂ':'fl','ﬃ':'ffi','ﬄ':'ffl','ﬅ':'ft','ﬆ':'st' };
function norm(s) {
  let t = String(s || '').toLowerCase();
  t = t.replace(/­/g, '');
  t = t.replace(/-\s*\n\s*/g, '');
  t = t.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c);
  t = t.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[–—−]/g, '-');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function prf(tp, fp, fn) {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall    = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1        = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

function fmt(n) { return n.toFixed(3); }

// ─────────────────────────────────────────────────────────────────────────
// Parse gold note
// ─────────────────────────────────────────────────────────────────────────

function parseGold(file) {
  const src = fs.readFileSync(path.join(GOLD_DIR, file), 'utf8');
  const end = src.indexOf('\n---', 3);
  const fm = YAML.parse(src.slice(3, end).replace(/^\s*\n/, ''));
  return { paper_id: fm.paper_id, fm };
}

function loadCorpusGaps() {
  const p = path.join(GOLD_DIR, 'corpus_gaps.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────────
// Pipeline readers
// ─────────────────────────────────────────────────────────────────────────

function pipelineSections(paperId) {
  return store.query(
    `SELECT canonical_type, raw_heading FROM sections WHERE paper_id = ? ORDER BY section_idx`,
    [paperId],
  );
}
function pipelineEntities(paperId) {
  return store.query(
    `SELECT span_text, gliner_label FROM entity_spans WHERE paper_id = ?`,
    [paperId],
  );
}
function pipelineClaims(paperId) {
  return store.query(
    `SELECT text, claim_type, stance FROM claims WHERE paper_id = ?`,
    [paperId],
  );
}
function pipelineNumerical(paperId) {
  return store.query(
    `SELECT metric, value, dataset, split, raw_text FROM results WHERE paper_id = ?`,
    [paperId],
  );
}
function pipelineCitationStance(paperId) {
  return store.query(
    `SELECT reference_id, stance, context_text FROM citation_markers WHERE paper_id = ?`,
    [paperId],
  );
}
function pipelinePhase4Last() {
  // Read the cached last-run from disk, if the API saved one.
  const p = path.join(ROOT, 'project', 'data', '_phase4_last.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-phase matchers (each returns {tp, fp, fn, perPaper})
// ─────────────────────────────────────────────────────────────────────────

function matchSections(gold, sys) {
  // Hungarian-style greedy on heading-token overlap, then check
  // canonical_type. Tolerant because heading text varies (numbering,
  // capitalisation).
  const golds = (gold.fm.sections || []).map((s, i) => ({ i, type: s.type, head: norm(s.heading) }));
  const used = new Set();
  let tp = 0, fp = 0;
  for (const s of sys) {
    const sysHead = norm(s.raw_heading || '');
    const sysType = s.canonical_type;
    let best = -1, bestScore = 0;
    for (const g of golds) {
      if (used.has(g.i)) continue;
      const score = tokenOverlap(sysHead, g.head);
      if (score > bestScore) { bestScore = score; best = g.i; }
    }
    if (best >= 0 && bestScore > 0.3) {
      used.add(best);
      const goldType = golds.find((g) => g.i === best).type;
      if (goldType === sysType) tp += 1;
      else fp += 1;
    } else {
      fp += 1;
    }
  }
  const fn = golds.length - used.size;
  return prf(tp, fp, fn);
}
function tokenOverlap(a, b) {
  const ta = new Set(a.split(/\s+/).filter(Boolean));
  const tb = new Set(b.split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.max(ta.size, tb.size);
}

function matchEntities(gold, sys) {
  const goldKeys = new Set((gold.fm.entities || []).map((e) => `${norm(e.text)}|${e.type}`));
  const sysKeys  = new Set(sys.map((e) => `${norm(e.span_text)}|${e.gliner_label}`));
  let tp = 0;
  for (const k of sysKeys) if (goldKeys.has(k)) tp += 1;
  return prf(tp, sysKeys.size - tp, goldKeys.size - tp);
}

function matchClaims(gold, sys) {
  let tp = 0, fp = 0;
  const matchedGold = new Set();
  for (const s of sys) {
    const sysText = norm(s.text);
    let matched = false;
    for (const [i, g] of (gold.fm.claims || []).entries()) {
      if (matchedGold.has(i)) continue;
      const goldQuote = norm(g.quote);
      if (goldQuote.length < 12) continue;
      const overlap =
        sysText.includes(goldQuote) ||
        goldQuote.includes(sysText) ||
        sysText.includes(goldQuote.slice(0, 60)) ||
        goldQuote.includes(sysText.slice(0, 60));
      if (overlap && g.type === s.claim_type && g.stance === s.stance) {
        tp += 1; matchedGold.add(i); matched = true; break;
      }
    }
    if (!matched) fp += 1;
  }
  const fn = (gold.fm.claims || []).length - matchedGold.size;
  return prf(tp, fp, fn);
}

function matchNumerical(gold, sys) {
  let tp = 0, fp = 0;
  const matchedGold = new Set();
  for (const s of sys) {
    let matched = false;
    for (const [i, g] of (gold.fm.numerical || []).entries()) {
      if (matchedGold.has(i)) continue;
      const metricEq = norm(g.metric) === norm(s.metric);
      const dsEq = norm(g.dataset || '') === norm(s.dataset || '');
      const valEq = Math.abs(g.value - s.value) <= Math.max(0.01, Math.abs(g.value) * 0.01);
      if (metricEq && dsEq && valEq) {
        tp += 1; matchedGold.add(i); matched = true; break;
      }
    }
    if (!matched) fp += 1;
  }
  const fn = (gold.fm.numerical || []).length - matchedGold.size;
  return prf(tp, fp, fn);
}

function matchCitationStance(gold, sys) {
  // System stores reference_id like "<paper_id>:ref:<idx>". Gold uses
  // ref_key like "smith2020" or "ref_17". Pipeline does not currently
  // expose the surface ref_key alongside, so we match on stance label
  // population only (per-paper recall on stance distribution). This is
  // a coarser comparison than the other phases; flagged in the report.
  const goldStances = (gold.fm.citation_stance || []).map((c) => c.stance);
  const sysStances = sys.map((c) => c.stance).filter(Boolean);
  const goldHist = histogram(goldStances);
  const sysHist  = histogram(sysStances);
  let tp = 0;
  for (const k of Object.keys(sysHist)) {
    if (goldHist[k]) tp += Math.min(sysHist[k], goldHist[k]);
  }
  const fp = sysStances.length - tp;
  const fn = goldStances.length - tp;
  return prf(tp, fp, fn);
}
function histogram(arr) { const h = {}; for (const v of arr) h[v] = (h[v] || 0) + 1; return h; }

function matchMilesGaps(corpusGold, phase4) {
  // Both sides are corpus-wide candidate lists with the same shape.
  // Match within each Miles type by signature equality first
  // (deterministic detector key), then by contributing_papers
  // Jaccard >= 0.5 as a softer match.
  if (!corpusGold || !phase4 || !phase4.byType) return { skipped: true };
  const out = {};
  for (const type of Object.keys(phase4.byType)) {
    const sysList  = phase4.byType[type].candidates || [];
    const goldList = corpusGold.byType?.[type] || [];
    const goldSigs = new Set(goldList.map((g) => g.signature));
    const goldByPapers = goldList.map((g) => new Set(g.contributing_papers || []));
    let tp = 0;
    const matchedGold = new Set();
    for (const s of sysList) {
      if (goldSigs.has(s.signature)) {
        tp += 1;
        matchedGold.add(s.signature);
        continue;
      }
      // Soft match on contributing-paper Jaccard.
      const sysSet = new Set(s.contributing_papers || []);
      let bestIdx = -1, bestJacc = 0;
      for (let i = 0; i < goldList.length; i += 1) {
        if (matchedGold.has(goldList[i].signature)) continue;
        const j = jaccard(sysSet, goldByPapers[i]);
        if (j > bestJacc) { bestJacc = j; bestIdx = i; }
      }
      if (bestIdx >= 0 && bestJacc >= 0.5) {
        tp += 1;
        matchedGold.add(goldList[bestIdx].signature);
      }
    }
    const fp = sysList.length - tp;
    const fn = goldList.length - matchedGold.size;
    out[type] = prf(tp, fp, fn);
  }
  return out;
}
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  await store.init();
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const files = fs.readdirSync(GOLD_DIR).filter((f) => /^paper_\d+\.md$/.test(f)).sort();
  if (files.length === 0) {
    console.error('no gold notes — run build_gold first');
    process.exit(1);
  }

  const totals = {
    sections: { tp:0, fp:0, fn:0 },
    entities: { tp:0, fp:0, fn:0 },
    claims:   { tp:0, fp:0, fn:0 },
    numerical:{ tp:0, fp:0, fn:0 },
    citation_stance: { tp:0, fp:0, fn:0 },
  };
  for (const file of files) {
    const gold = parseGold(file);
    const pid = gold.paper_id;

    const per = {
      sections:        matchSections(gold, pipelineSections(pid)),
      entities:        matchEntities(gold, pipelineEntities(pid)),
      claims:          matchClaims(gold, pipelineClaims(pid)),
      numerical:       matchNumerical(gold, pipelineNumerical(pid)),
      citation_stance: matchCitationStance(gold, pipelineCitationStance(pid)),
    };
    for (const k of Object.keys(totals)) {
      totals[k].tp += per[k].tp; totals[k].fp += per[k].fp; totals[k].fn += per[k].fn;
    }

    const lines = [];
    lines.push(`# paper_${pid} comparison\n`);
    for (const k of Object.keys(per)) {
      const r = per[k];
      lines.push(`## ${k}\n`);
      lines.push(`TP=${r.tp} FP=${r.fp} FN=${r.fn}  ·  P=${fmt(r.precision)} R=${fmt(r.recall)} F1=${fmt(r.f1)}\n`);
    }
    fs.writeFileSync(path.join(REPORT_DIR, `paper_${pid}.md`), lines.join('\n'));
  }

  const phase4 = pipelinePhase4Last();
  const corpusGold = loadCorpusGaps();
  const milesPerType = matchMilesGaps(corpusGold, phase4);

  // Corpus-wide table.
  const out = [];
  out.push(`# Quality report — ${files.length} papers\n`);
  out.push(`Generated ${new Date().toISOString()}\n`);
  out.push('## Per-phase summary\n');
  out.push('| phase | TP | FP | FN | Precision | Recall | F1 |');
  out.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const k of ['sections', 'entities', 'claims', 'numerical', 'citation_stance']) {
    const r = prf(totals[k].tp, totals[k].fp, totals[k].fn);
    out.push(`| ${k} | ${r.tp} | ${r.fp} | ${r.fn} | ${fmt(r.precision)} | ${fmt(r.recall)} | ${fmt(r.f1)} |`);
  }
  out.push('');
  out.push('## Miles-7 gaps (Phase 4)\n');
  if (milesPerType.skipped) {
    if (!corpusGold) out.push('skipped — no `tests/quality/gold/corpus_gaps.json`. Run `node tests/quality/synthesise_gaps.mjs`.\n');
    else out.push('skipped — no Phase 4 run cached at project/data/_phase4_last.json\n');
  } else {
    out.push('| type | TP | FP | FN | Precision | Recall | F1 |');
    out.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const t of Object.keys(milesPerType)) {
      const r = milesPerType[t];
      out.push(`| ${t} | ${r.tp} | ${r.fp} | ${r.fn} | ${fmt(r.precision)} | ${fmt(r.recall)} | ${fmt(r.f1)} |`);
    }
  }
  out.push('');
  out.push('## Caveats\n');
  out.push('- citation_stance compares stance-label histograms per paper, not per ref_key (pipeline does not expose the surface bib key alongside the marker).');
  out.push('- numerical match tolerates ±1% on value.');
  out.push('- Miles-7 ground truth is produced by a synthesis subagent (`agents/synthesise_gaps.md`) that reads every per-paper gold note. Match = signature equality OR contributing_papers Jaccard >= 0.5.');
  out.push('');

  fs.writeFileSync(path.join(REPORT_DIR, 'summary.md'), out.join('\n'));
  await store.close();

  console.log(out.join('\n'));
  console.log(`\nper-paper diffs in ${path.relative(ROOT, REPORT_DIR)}/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
