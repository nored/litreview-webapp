// catalogue_grounded.mjs
//
// Stage 6 catalogue grounding. The original catalogue prompts feed only
// frontmatter (and a JSON dump of all paper metadata) to the LLM. That
// means the model never sees the actual note prose the student wrote —
// "Stated limitations", "Gaps this paper opens", "Method summary" all
// stay invisible. The catalogue chapters end up paraphrasing what's in
// the JSON, not citing what the student concluded.
//
// This module retrieves the relevant note text per chapter sub-section
// via embedding similarity, plus reads the saved note files for any
// papers the LLM is about to cite, and packages that into a structured
// context object the catalogue prompts can embed verbatim. Mirrors what
// note_drafter.mjs does for individual notes, but the retrieval target
// is the `notes` vector store kind (populated by the embed daemon when
// notes are saved).
//
// Three context bundles, one per catalogue chapter type:
//
//   assembleSoaContext()       — state-of-the-art chapter. Retrieves notes
//                                relevant to corpus structure, gap shape,
//                                ground-truth problems, cross-paper themes.
//
//   assembleTopicContext(idx)  — per-candidate chapter. Retrieves notes
//                                relevant to that candidate's statement
//                                and research question, plus the
//                                candidate's own evidence papers.
//
//   assembleSelectionContext() — topic-selection chapter. Comparative
//                                summary built from per-candidate top
//                                notes (so the recommendation is grounded
//                                in the same evidence as the chapters
//                                above).
//
// Coverage check happens client-side after generation (regex over the
// catalogue markdown for [paper_NNN] vs the include set).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NOTES_DIR } from '../paths.mjs';
import { parseNoteMd } from './notes.mjs';
import * as vectors from './vectors.mjs';
import * as embedder from './embedder.mjs';

const NOTES_KIND = 'notes';

// Top-K notes per anchor query. Keep small — the catalogue prompts
// already carry frontmatter for every paper; RAG retrieval just surfaces
// the most relevant *prose* per chapter sub-aspect.
const TOPK = 5;

// Maximum chars of note text we include per retrieved note. The note
// body sections are short by schema (target 600–1200 words total) so a
// hard cap of ~1000 chars keeps a single chapter context under 5K chars.
const NOTE_TEXT_CAP = 1000;

// Anchor queries for the state-of-the-art chapter. Each sub-aspect of
// the SOA chapter retrieves its own slice of notes.
const SOA_ANCHORS = {
  corpus_structure:
    'the structure of the literature on this topic, how research is organised by method and problem',
  empty_gaps:
    'unaddressed combinations of method and problem, regions of the field with little prior work',
  ground_truth_problems:
    'how ground truth is constructed, self-constructed evaluation, circular validation, threats to validity',
  cross_paper_themes:
    'open problems that multiple papers leave unresolved, recurring limitations, themes across the literature',
};

// ---------------------------------------------------------------------------
// Note file readers
// ---------------------------------------------------------------------------

// Read the saved note for a paper_id and return its body text + structured
// frontmatter. Used for the LLM context — gives the chapter prompts access
// to the student's actual written notes, not just frontmatter.
async function readNote(paperId) {
  const file = path.join(NOTES_DIR, `paper_${paperId}.md`);
  try {
    const md = await fs.readFile(file, 'utf8');
    const note = parseNoteMd(md);
    return {
      paper_id: paperId,
      title: note.frontmatter?.title || '',
      authors: Array.isArray(note.frontmatter?.authors)
        ? note.frontmatter.authors.join(', ')
        : (note.frontmatter?.authors || ''),
      year: note.frontmatter?.year || '',
      primary_contribution: note.frontmatter?.claims?.primary_contribution || '',
      novelty_strength: note.frontmatter?.claims?.novelty_strength || '',
      stated_limitations: Array.isArray(note.frontmatter?.limitations_authors_state)
        ? note.frontmatter.limitations_authors_state
        : [],
      quality_flags: note.frontmatter?.quality_flags || {},
      // The six body sections — what the student actually wrote.
      body: {
        problem_statement: (note.body?.problem_statement || '').slice(0, NOTE_TEXT_CAP),
        method_summary: (note.body?.method_summary || '').slice(0, NOTE_TEXT_CAP),
        ground_truth_and_evaluation: (note.body?.ground_truth_and_evaluation || '').slice(0, NOTE_TEXT_CAP),
        stated_limitations: (note.body?.stated_limitations || '').slice(0, NOTE_TEXT_CAP),
        gaps_this_paper_opens: (note.body?.gaps_this_paper_opens || '').slice(0, NOTE_TEXT_CAP),
        relevance_to_the_thesis_topic: (note.body?.relevance_to_the_thesis_topic || '').slice(0, NOTE_TEXT_CAP),
      },
    };
  } catch {
    return null;
  }
}

// Resolve a list of vectors.search hits to their full note objects.
// Hit ids are paper_ids (the embed daemon stores notes keyed by paper_id).
async function hydrateHits(hits) {
  const out = [];
  for (const h of hits) {
    const pid = h.meta?.paper_id || h.id;
    const note = await readNote(pid);
    if (note) out.push({ ...note, similarity: h.score });
  }
  return out;
}

// Retrieve top-K include notes by anchor query.
async function topNotesForQuery(anchor) {
  const r = await embedder.embed([anchor]);
  const q = new Float32Array(r.data);
  const hits = await vectors.search(NOTES_KIND, q, { topK: TOPK });
  return hydrateHits(hits);
}

// ---------------------------------------------------------------------------
// State-of-the-art context
// ---------------------------------------------------------------------------

export async function assembleSoaContext() {
  const sections = {};
  for (const [key, anchor] of Object.entries(SOA_ANCHORS)) {
    sections[key] = await topNotesForQuery(anchor);
  }
  return { kind: 'state_of_the_art', sections };
}

// ---------------------------------------------------------------------------
// Per-topic chapter context
// ---------------------------------------------------------------------------

// For a candidate, retrieve notes relevant to its statement + research
// question, plus the notes for the explicit evidence papers the student
// already listed in synthesis. Returns the candidate's tailored evidence
// bank for the chapter prompt.
export async function assembleTopicContext(candidate) {
  const queries = [candidate.statement, candidate.research_question].filter(Boolean);
  const fallback = [candidate.title, candidate.statement].filter(Boolean).join(' — ');
  const queryText = queries.length > 0 ? queries.join(' ') : fallback;
  const retrieved = await topNotesForQuery(queryText);

  // Always include the candidate's own listed evidence (student already
  // told the system these papers matter for this topic). De-dupe against
  // the retrieved set.
  const evidencePaperIds = (candidate.evidence || [])
    .map((e) => e.paper_id || e)
    .filter(Boolean);
  const seen = new Set(retrieved.map((r) => r.paper_id));
  const evidenceNotes = [];
  for (const pid of evidencePaperIds) {
    if (seen.has(pid)) continue;
    const note = await readNote(pid);
    if (note) {
      evidenceNotes.push({ ...note, similarity: null, from_evidence: true });
      seen.add(pid);
    }
  }

  return {
    kind: 'topic_chapter',
    candidate_title: candidate.title,
    candidate_statement: candidate.statement,
    candidate_research_question: candidate.research_question,
    retrieved_notes: retrieved,
    evidence_notes: evidenceNotes,
  };
}

// ---------------------------------------------------------------------------
// Topic-selection context
// ---------------------------------------------------------------------------

// For each candidate, retrieve its single strongest note (top-1 by
// similarity to its statement). Used to ground the comparative chapter
// in actual evidence rather than indicator scores alone.
export async function assembleSelectionContext(candidates) {
  const perCandidate = [];
  for (const c of candidates || []) {
    const text = [c.statement, c.research_question].filter(Boolean).join(' ');
    if (!text) {
      perCandidate.push({ title: c.title, top_note: null });
      continue;
    }
    const r = await embedder.embed([text]);
    const q = new Float32Array(r.data);
    const hits = await vectors.search(NOTES_KIND, q, { topK: 1 });
    const hydrated = await hydrateHits(hits);
    perCandidate.push({
      title: c.title,
      overall: c.overall,
      indicators: c.indicators,
      top_note: hydrated[0] || null,
    });
  }
  return { kind: 'topic_selection', per_candidate: perCandidate };
}

// ---------------------------------------------------------------------------
// Coverage check (post-generation)
// ---------------------------------------------------------------------------

// Inspect a generated catalogue markdown to determine which include
// papers got cited and which were silently dropped. The student then
// decides whether the gaps are real or whether they should ask the LLM
// to integrate the missing ones.
//
// Returns:
//   {
//     cited:   [{paper_id, title, citation_count}],
//     missing: [{paper_id, title, novelty, must_cite}],
//     stats:   { total_includes, cited_count, missing_count, must_cite_missing }
//   }
export async function coverageCheck(catalogueMd, allPapers) {
  const md = String(catalogueMd || '');
  const cited = [];
  const missing = [];
  let mustCiteMissing = 0;
  for (const p of allPapers) {
    if (!p.id) continue;
    const re = new RegExp(`\\[paper_${p.id}\\b`, 'g');
    const matches = md.match(re) || [];
    if (matches.length > 0) {
      cited.push({ paper_id: p.id, title: p.title, citation_count: matches.length });
    } else {
      missing.push({
        paper_id: p.id,
        title: p.title,
        novelty: p.novelty,
        must_cite: !!p.must_cite,
      });
      if (p.must_cite) mustCiteMissing++;
    }
  }
  return {
    cited,
    missing,
    stats: {
      total_includes: allPapers.length,
      cited_count: cited.length,
      missing_count: missing.length,
      must_cite_missing: mustCiteMissing,
    },
  };
}
