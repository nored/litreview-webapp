// conveyor.mjs
//
// "The conveyor" is the new opinionated default UI: instead of a sidebar
// with seven stages the user navigates between, the system decides what
// needs the user's attention right now and shows that one thing. This
// module is the decision function — it walks the pipeline state on disk
// and returns a structured thread of events the client renders top-to-
// bottom, with exactly one event marked `current`.
//
// Three event flavours matter:
//
//   - **milestone**  — past steps that completed; render as a compact
//                      "✓ done" line.
//   - **action**     — the step the user should take next. Renders with a
//                      big primary button. There is exactly one of these
//                      (or zero, when nothing is pending).
//   - **gate**       — a hard refusal. The conveyor won't let the user
//                      cross this gate until the precondition is met.
//                      e.g. "you have 12 notes but synthesis needs ≥30 —
//                      keep reading papers." Below the gate, every later
//                      step renders as locked.
//   - **soft**       — non-blocking warning (missing PDFs, invalid notes).
//                      Surfaces the count, suggests a remedy, doesn't
//                      stop the user from progressing.
//   - **idle**       — appended at the very end when nothing is pending;
//                      the client uses this to flip to "deliverables"
//                      view mode.
//
// The legacy multi-stage UI is still accessible via the old hash routes
// and a topbar "Advanced view" toggle. The gates here are advisory —
// they make the conveyor refuse but the underlying APIs don't reject.
// That's deliberate: an advanced user who really wants to bypass can
// (and gets whatever quality their corpus warrants).

import path from 'node:path';
import { fileExists } from '../storage.mjs';
import { PROTOCOL_FILES, DATA_FILES, SYNTHESIS_DIR, NOTES_DIR } from '../paths.mjs';
import { promises as fs } from 'node:fs';
import * as triage from './triage.mjs';
import * as notes from './notes.mjs';
import * as synthesis from './synthesis.mjs';
import * as aggregator from './notes_aggregator.mjs';
import * as catalogueGrounded from './catalogue_grounded.mjs';

const CATALOGUE_PATH = path.join(SYNTHESIS_DIR, 'catalogue.md');

// Minimum note count before we let the student build candidates +
// catalogue. The hard floor (20) catches the "I read 7 papers, let's
// synthesise" case. The relative threshold (50% of include set) catches
// the "I have 80 includes, I've read 12, that's enough right?" case —
// no, it's not.
const TOO_FEW_NOTES_ABS_MIN = 20;
const TOO_FEW_NOTES_FRACTION = 0.5;

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export async function pickNext() {
  const events = [];

  // 1. Setup ------------------------------------------------------------
  const [topicSet, queriesSet, criteriaSet] = await Promise.all([
    fileExists(PROTOCOL_FILES.topic),
    fileExists(PROTOCOL_FILES.search_queries),
    fileExists(PROTOCOL_FILES.inclusion_criteria),
  ]);
  const setupDone = topicSet && queriesSet && criteriaSet;
  events.push({
    id: 'setup',
    status: setupDone ? 'done' : 'open',
    kind: setupDone ? 'milestone' : 'action',
    title: 'Setup',
    summary: setupDone ? 'Topic, queries, and inclusion criteria configured.' : null,
    detail: setupDone
      ? null
      : 'Tell the system what your thesis is about. Topic, search queries, and inclusion criteria are required before anything else can run.',
    // Every event gets a stage URL it can be opened at — done events
    // still navigate the user there for review/edit.
    href: '#/setup',
    action: setupDone ? null : { label: 'Configure setup', href: '#/setup' },
  });

  // 2. Search -----------------------------------------------------------
  const searchDone = await fileExists(DATA_FILES.candidates_raw);
  let recordsIdentified = 0;
  if (searchDone) {
    try {
      const rows = await triage.getAll();
      recordsIdentified = rows.length;
    } catch { /* fall through */ }
  }
  events.push({
    id: 'search',
    status: !setupDone ? 'locked' : (searchDone ? 'done' : 'open'),
    kind: searchDone ? 'milestone' : 'action',
    title: 'Search',
    summary: searchDone ? `${recordsIdentified.toLocaleString()} records identified` : null,
    detail: searchDone
      ? null
      : 'Run your saved search queries across arXiv, OpenAlex, and Semantic Scholar. Deduplication and rate limiting happen automatically.',
    href: '#/stage1',
    action: (setupDone && !searchDone) ? { label: 'Run search', href: '#/stage1' } : null,
  });

  // 3. Triage -----------------------------------------------------------
  let triageSum = null;
  if (searchDone) {
    try { triageSum = await triage.summary(); } catch { triageSum = null; }
  }
  const pending = triageSum?.pending || 0;
  const included = triageSum?.include || 0;
  const excluded = triageSum?.exclude || 0;
  const maybeCount = triageSum?.maybe || 0;
  const triageDone = searchDone && triageSum && pending === 0 && (included + excluded + maybeCount) > 0;
  events.push({
    id: 'triage',
    status: !searchDone ? 'locked' : (triageDone ? 'done' : 'open'),
    kind: triageDone ? 'milestone' : 'action',
    title: 'Triage',
    summary: triageDone
      ? `${included} included · ${excluded} excluded${maybeCount ? ` · ${maybeCount} maybe` : ''}`
      : null,
    detail: triageDone
      ? null
      : (pending > 0
          ? `${pending.toLocaleString()} records still need an include/exclude/maybe label. Auto-triage uses the trained embedding classifier to clear them.`
          : 'Mark each search hit as include, maybe, or exclude. The embedding classifier learns from your decisions and proposes the rest.'),
    href: '#/stage2',
    action: (searchDone && !triageDone) ? { label: pending > 0 ? `Open triage (${pending} pending)` : 'Open triage', href: '#/stage2' } : null,
    metrics: triageSum,
  });

  // 4. PDFs (soft gate) -------------------------------------------------
  // PDFs failing to download is a fact of life — some are paywalled,
  // some are behind anti-bot walls. We surface the count but don't
  // block. The student can use the manual retrieval list to fill gaps.
  let eligibleAll = [];
  if (triageDone) {
    try { eligibleAll = await notes.listEligible(); } catch { eligibleAll = []; }
  }
  let labeledWithoutPdf = 0;
  if (triageDone) {
    try {
      const rows = await triage.getAll();
      const labeled = rows.filter((r) => r.triage_label === 'include' || r.triage_label === 'maybe');
      const eligibleIds = new Set(eligibleAll.map((p) => p.paper_id));
      labeledWithoutPdf = labeled.filter((r) => r.paper_id && !eligibleIds.has(r.paper_id)).length;
    } catch { /* ignore */ }
  }
  if (triageDone && labeledWithoutPdf > 0) {
    events.push({
      id: 'pdfs-soft',
      status: 'soft',
      kind: 'soft',
      title: 'Some PDFs missing',
      summary: `${labeledWithoutPdf} include/maybe papers have no PDF — non-blocking.`,
      detail: `Some PDFs couldn\'t be downloaded automatically (paywalls, anti-bot walls). They\'re skipped for deep-read. Use the manual retrieval list if you want them included.`,
      href: '#/stage3',
      action: { label: 'Manual retrieval list', href: '#/stage3' },
    });
  }

  // 5. Deep read (notes) ------------------------------------------------
  const eligibleCount = eligibleAll.length;
  const eligibleNoNote = eligibleAll.filter((p) => p.note_status === 'none').length;
  const eligibleDraft = eligibleAll.filter((p) => p.note_status === 'draft').length;
  const notesValid = eligibleAll.filter((p) => p.note_status === 'valid').length;
  const deepReadActive = triageDone;
  // "Done" only if every eligible paper has a *valid* note. Drafts that
  // fail validation count as work in progress, not completion.
  const deepReadDone = deepReadActive && eligibleCount > 0 && eligibleNoNote === 0 && eligibleDraft === 0;

  // Compose the action label/detail from whichever sub-state is biggest:
  // missing > draft > "review existing".
  let drLabel, drDetail;
  if (eligibleNoNote > 0) {
    drLabel = `Draft ${eligibleNoNote} missing notes`;
    drDetail = `${eligibleNoNote.toLocaleString()} eligible paper${eligibleNoNote === 1 ? '' : 's'} ${eligibleNoNote === 1 ? 'has' : 'have'} no note yet. The AI drafts every section in parallel using RAG over the PDF chunks. Toggle "Audit & revise" for the critic pass.`;
  } else if (eligibleDraft > 0) {
    drLabel = `Polish ${eligibleDraft} invalid notes`;
    drDetail = `${eligibleDraft.toLocaleString()} note${eligibleDraft === 1 ? '' : 's'} ${eligibleDraft === 1 ? 'has' : 'have'} validation issues (missing required fields, schema mismatches). Polish them before synthesis.`;
  } else {
    drLabel = 'Open deep read';
    drDetail = 'Each paper gets a structured note. The AI drafts; you polish.';
  }

  events.push({
    id: 'deepread',
    status: !triageDone ? 'locked' : (deepReadDone ? 'done' : 'open'),
    kind: deepReadDone ? 'milestone' : 'action',
    title: 'Deep read',
    summary: deepReadDone
      ? `${notesValid} valid notes`
      : (eligibleCount > 0 ? `${notesValid}/${eligibleCount} valid · ${eligibleDraft} draft · ${eligibleNoNote} missing` : null),
    detail: deepReadDone ? null : drDetail,
    href: '#/stage4',
    action: (triageDone && !deepReadDone) ? { label: drLabel, href: '#/stage4' } : null,
    metrics: { eligible: eligibleCount, missing: eligibleNoNote, draft: eligibleDraft, valid: notesValid },
  });

  // Quality gate: not enough notes for downstream synthesis.
  // Hard refusal — the conveyor stops here even if everything else is
  // ready. We don't pretend a 7-paper "corpus" produces a defensible
  // gap analysis.
  const minNotesRequired = Math.max(
    TOO_FEW_NOTES_ABS_MIN,
    Math.floor(TOO_FEW_NOTES_FRACTION * (included + maybeCount)),
  );
  const tooFewNotes = deepReadActive && notesValid < minNotesRequired;

  if (tooFewNotes && deepReadDone) {
    // Edge case: all eligible papers have notes, but the include set
    // itself is small. The gate still refuses; the user needs to
    // include more papers (back to triage) or accept that synthesis
    // won't be defensible.
    events.push({
      id: 'gate-too-few-notes',
      status: 'gate',
      kind: 'gate',
      title: 'Too few notes for synthesis',
      summary: `${notesValid} valid notes — need at least ${minNotesRequired} for defensible analysis.`,
      detail: `A gap matrix and indicator assessment over fewer than ${minNotesRequired} notes don\'t hold up. Either include more papers (revisit triage) or accept that the synthesis won\'t be defensible.`,
      href: '#/stage2',
      action: { label: 'Revisit triage', href: '#/stage2' },
    });
  } else if (tooFewNotes) {
    // Notes are missing AND the count is below the threshold — the
    // deepread action is still the right next step; gate fires only
    // when deepread is "done" but counts are still too low.
  }

  // 6. Corpus shape (informational — accessible once we have any notes)
  // No action, no gate. Just a "you can review the matrix" pointer.
  // Skipped from event stream unless we're past the gate.

  // 7. Candidates -------------------------------------------------------
  // Gate: refuses if fewer than minimum notes.
  let synthState;
  try { synthState = await synthesis.readState(); } catch { synthState = { candidates: [] }; }
  const cands = synthState.candidates || [];
  const candUnscored = cands.filter((c) => !c.overall).length;
  const accepted = cands.filter((c) => c.overall === 'accept').length;
  const refinable = cands.filter((c) => c.overall === 'refine').length;
  const shortlistReady = (accepted + refinable) > 0;

  if (!tooFewNotes && deepReadDone) {
    if (cands.length === 0) {
      events.push({
        id: 'candidates-build',
        status: 'open',
        kind: 'action',
        title: 'Build candidates and shortlist',
        summary: null,
        detail: 'Generate gap candidates from your notes, score each against the seven thesis quality indicators, produce the accept/refine/reject shortlist.',
        href: '#/stage7',
        action: { label: 'Open positioning', href: '#/stage7' },
      });
    } else if (candUnscored > 0) {
      events.push({
        id: 'candidates-score',
        status: 'open',
        kind: 'action',
        title: 'Score unscored candidates',
        summary: `${cands.length} candidates · ${candUnscored} unscored`,
        detail: 'Candidates exist but lack verdicts. Run the indicator assessment to populate the shortlist.',
        href: '#/stage7',
        action: { label: 'Open positioning', href: '#/stage7' },
      });
    } else {
      events.push({
        id: 'candidates-done',
        status: 'done',
        kind: 'milestone',
        title: 'Candidates & shortlist',
        summary: `${accepted} accepted · ${refinable} refinable · ${cands.length - accepted - refinable} rejected`,
        detail: null,
        href: '#/stage7',
        action: null,
      });
    }
  } else if (deepReadActive) {
    events.push({
      id: 'candidates-locked',
      status: 'locked',
      kind: 'milestone',
      title: 'Candidates & shortlist',
      summary: tooFewNotes ? 'Locked — gate above must clear first.' : 'Locked.',
      detail: null,
      action: null,
    });
  }

  // 8. Catalogue --------------------------------------------------------
  const catalogueExists = await fileExists(CATALOGUE_PATH);
  if (shortlistReady && !tooFewNotes) {
    if (!catalogueExists) {
      events.push({
        id: 'catalogue-build',
        status: 'open',
        kind: 'action',
        title: 'Generate the catalogue',
        summary: null,
        detail: `${accepted + refinable} viable topic${(accepted + refinable) === 1 ? '' : 's'} ready. The catalogue drafts a state-of-the-art chapter plus one chapter per candidate, all grounded in your notes via RAG. Output lives in synthesis/catalogue.md.`,
        href: '#/stage7',
        action: { label: 'Open positioning', href: '#/stage7' },
      });
    } else {
      // Catalogue exists. Run coverage and surface any must-cite misses.
      let coverage = null;
      try {
        const md = await fs.readFile(CATALOGUE_PATH, 'utf8');
        const agg = await aggregator.aggregate();
        const papers = Object.values(agg.by_paper).map((p) => ({
          id: p.paper_id, title: p.title,
          novelty: p.novelty_strength, must_cite: p.must_cite,
        }));
        coverage = await catalogueGrounded.coverageCheck(md, papers);
      } catch { /* silent */ }
      if (coverage?.stats?.must_cite_missing > 0) {
        events.push({
          id: 'catalogue-coverage-gap',
          status: 'open',
          kind: 'soft',
          title: 'Catalogue missing must-cite papers',
          summary: `${coverage.stats.must_cite_missing} must-cite paper${coverage.stats.must_cite_missing === 1 ? '' : 's'} not cited in the generated catalogue.`,
          detail: 'Re-generate the catalogue or edit it to include the missing papers. The coverage report shows which ones.',
          href: '#/stage7',
          action: { label: 'Open positioning', href: '#/stage7' },
        });
      } else {
        events.push({
          id: 'catalogue-done',
          status: 'done',
          kind: 'milestone',
          title: 'Catalogue',
          summary: coverage
            ? `${coverage.stats.cited_count}/${coverage.stats.total_includes} include papers cited.`
            : 'Generated and saved.',
          detail: null,
          href: '#/stage7',
          action: null,
        });
      }
    }
  } else if (deepReadActive) {
    events.push({
      id: 'catalogue-locked',
      status: 'locked',
      kind: 'milestone',
      title: 'Catalogue',
      summary: 'Locked — shortlist required.',
      detail: null,
      action: null,
    });
  }

  // 9. Idle ------------------------------------------------------------
  // If everything is done, append an idle marker so the client can flip
  // to the "deliverables ready" view.
  const everythingDone =
    setupDone && searchDone && triageDone && deepReadDone &&
    !tooFewNotes && shortlistReady && catalogueExists;
  if (everythingDone) {
    events.push({
      id: 'idle',
      status: 'idle',
      kind: 'idle',
      title: 'Deliverables ready',
      summary: 'Positioning statement, catalogue, PRISMA, scorecard all available below.',
      detail: null,
      action: { label: 'View deliverables', href: '#/stage7' },
    });
  }

  // Decide currentIdx: the FIRST event whose status is 'open' or 'gate'.
  // Soft events don't claim currency; they sit alongside the open one.
  let currentIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].status === 'open' || events[i].status === 'gate') {
      currentIdx = i;
      break;
    }
  }
  return {
    events,
    current_idx: currentIdx,
    summary: {
      records_identified: recordsIdentified,
      included,
      excluded,
      pending_triage: pending,
      eligible: eligibleCount,
      notes_valid: notesValid,
      candidates: cands.length,
      accepted,
      refinable,
      catalogue_exists: catalogueExists,
      min_notes_required: minNotesRequired,
    },
  };
}
