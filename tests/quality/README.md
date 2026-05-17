# Quality Harness

Auto-tests the pipeline by comparing its output against gold notes
produced by parallel subagents reading whole PDFs. Mirrors the
litreview-template `04_deepread.md` pattern, adapted for the
litreview-webapp's structured schemas and the seven Miles 2017 gap
types.

## Pipeline phase → harness phase mapping

| Phase  | Pipeline outputs               | Gold artefact                                  | Compared by    |
|--------|--------------------------------|------------------------------------------------|----------------|
| 1      | `sections` table               | per-paper `sections[]`                         | `compare.mjs`  |
| 2a     | `entity_spans`                 | per-paper `entities[]`                         | `compare.mjs`  |
| 2b     | `claims`                       | per-paper `claims[]`                           | `compare.mjs`  |
| 2c     | `results` (numerical)          | per-paper `numerical[]`                        | `compare.mjs`  |
| 2d     | `citation_markers.stance`      | per-paper `citation_stance[]`                  | `compare.mjs`  |
| 4      | `/api/v2/detect-phase4` output | corpus-wide `corpus_gaps.json`                 | `compare.mjs`  |

Phase 3 (clusters) is implicitly evaluated through Phase 4: if the
detector's contributing-paper sets do not overlap the gold synthesis's
contributing-paper sets, the cluster structure is the most likely
culprit.

**Important: Miles-7 gaps are corpus-wide statistics, not per-paper
attributes.** A single paper cannot self-report "this is a knowledge
gap"; it can only record raw observables (topics it covers, methods
it applies, hardware it tests, evaluation rigour). The gold synthesis
script (`synthesise_gaps.mjs`) aggregates those observables and
computes the same seven detector statistics that `detect_phase4.mjs`
runs on the pipeline's own extractions. Phase 4 P/R/F1 measures
whether the pipeline recovers what hand-labelled statistics agree
exists.

## Three modes (inherited from litreview-template AGENTS.md)

**Agentic AI mode.** Orchestrator (you, in a Claude Code session)
dispatches one Task subagent per batch. Each subagent reads at most
fifteen papers and produces one gold note per paper using
`agents/read_paper.md` as its prompt. Batches run in parallel.

**Single-shot LLM mode.** Paste `agents/read_paper.md` plus the PDF
into any chat LLM. Save the response to
`tests/quality/gold/paper_NNN.md`. Validate. Repeat.

**By hand.** Open the PDF. Fill the template in `schema.md`. Save.
Validate.

## Day-to-day workflow

```bash
# Pick the sample (stratified across paper_clusters by default).
npm run quality:pick                 # writes sample.txt
npm run quality:pick -- --all        # gold-label every PDF instead

# Split into parallel-subagent batches (15-per-batch cap enforced).
npm run quality:split                # writes batches/batch_NN.txt
npm run quality:split -- --num-batches=8

# Dispatch subagents (one Task per batch). For each batch_NN.txt:
#   Task({
#     description: "gold-build batch NN",
#     subagent_type: "Explore",   // or general-purpose
#     prompt: <agents/read_paper.md contents>
#            + "\nProcess these paper_ids in order: <batch contents>"
#   })

# Validate every gold note.
npm run quality:validate

# (Re-run a failed paper by dispatching a single-paper subagent with
#  the validator's error appended to the prompt.)

# Synthesise corpus-wide ground truth (the 7 Miles gap candidates,
# computed deterministically over the gold `descriptors` blocks).
npm run quality:synthesise

# Score the pipeline.
npm run quality:compare              # writes report/summary.md + per-paper
```

For phases 1–3, run the pipeline against the same papers first
(grobid-ingest, extract-phase2, embed-phase3 + cluster-phase3) so the
SQLite store is populated. For Phase 4, call `/api/v2/detect-phase4`
once; the response is cached to `project/data/_phase4_last.json`
which the comparator reads.

## What gets reported

`tests/quality/report/summary.md`:

- Corpus-wide per-phase Precision / Recall / F1 table.
- Per-Miles-type Precision / Recall / F1.
- Caveats (citation_stance compared by histogram, numerical ±1%).

`tests/quality/report/paper_NNN.md`: per-paper TP/FP/FN for spot-check.

## Anti-context-fatigue rules

Inherited from the litreview-template. Each subagent: at most 15
papers per dispatch. Reset framing between papers. Orchestrator
never opens a PDF. Orchestrator reads only `build_log.jsonl` and
validator output.

## Re-running

Gold notes are idempotent — re-dispatching a subagent on the same
paper overwrites the existing file. The validator and comparator are
both pure functions of `gold/*.md` plus the SQLite store, so they are
safe to re-run cheaply.

## Files

```
schema.md                  contract: gold-note schema + comparator rules
agents/read_paper.md       per-paper subagent prompt
pick_sample.mjs            sample picker (default: stratified)
split_batches.mjs          batch splitter (15-per-subagent cap)
validate_notes.mjs         schema + quote-substring validator
synthesise_gaps.mjs        deterministic Miles-7 statistics over gold descriptors
compare.mjs                per-phase P/R/F1 + Miles-7 + report writer
sample.txt                 (generated) one paper_id per line
batches/batch_NN.txt       (generated) one batch per parallel subagent
gold/paper_NNN.md          gold note per paper
gold/corpus_gaps.json      (generated) corpus-wide Miles-7 ground truth
report/summary.md          (generated) corpus-wide P/R/F1 table
report/paper_NNN.md        (generated) per-paper diffs
build_log.jsonl            (optional) subagent run log
```
