# Gold-Note Schema

Every paper in the quality sample produces one gold-note file at
`tests/quality/gold/paper_NNN.md`. The format mirrors the
litreview-template `protocol/note_schema.md` pattern, extended so that
each frontmatter block maps 1:1 onto a pipeline table the comparator
can diff mechanically.

## File structure

YAML frontmatter, then a markdown body. Frontmatter holds structured
fields. The body holds the Miles-7-typed gap statements.

## Frontmatter

```yaml
---
paper_id: "012"
title: ""
authors: []
year: 0
venue: ""
pdf_path: "project/data/pdfs/paper_012.pdf"
read_date: "YYYY-MM-DD"

# Phase 1: section structure (compared against pipeline `sections` table).
# `type` is one of the 15 canonical types from grobid_postprocess.mjs.
sections:
  - type: "introduction"        # abstract|introduction|background|related_work|methods|
                                # experimental_setup|results|discussion|limitations|
                                # conclusion|future_work|references|appendix|
                                # acknowledgments|other
    heading: "1. Introduction"
    para_count: 6

# Phase 2a: typed entities (compared against `entity_spans`).
# `type` should be drawn from the GLiNER seed labels in extract_entities_v2.mjs,
# plus `other` if nothing fits.
entities:
  - text: "Flush+Reload"
    type: "attack"              # method|technique|algorithm|dataset|corpus|benchmark|
                                # tool|library|software|model|system|platform|hardware|
                                # metric|measure|concept|theory|framework|person|
                                # organisation|place|attack|vulnerability|defense|
                                # protocol|standard|other
    section: "background"

# Phase 2b: claims (compared against `claims`).
# Every claim carries the verbatim quote so the comparator can do substring
# match the same way the pipeline does. `stance` is one of the labels used
# in extract_claims_v2.mjs.
claims:
  - type: "contribution"        # contribution|finding|limitation|future_work|framework|
                                # method|first_in_area|releases_code|baseline_comparison|
                                # reports_uncertainty|challenges_existing
    stance: "asserts"           # asserts|validates|theorises|challenges|extends
    section: "introduction"
    quote: "We present the first end-to-end side-channel..."

# Phase 2c: numerical results (compared against numerical_results).
numerical:
  - metric: "accuracy"
    value: 0.94
    dataset: "CIFAR-10"
    split: "test"
    quote: "Our attack achieves 94% accuracy on the test split..."

# Phase 2d: citation stance (compared against citation_markers.stance).
# `ref_key` is the bib key as it appears in the paper's reference list.
citation_stance:
  - ref_key: "smith2020"
    stance: "contrasts"         # supports|contrasts|extends|background|mentions
    quote: "Unlike Smith et al. (2020), we do not rely on..."

# Quality flags inherited from the litreview-template. Used by the
# comparator to spot-check whether the pipeline picked them up via
# Phase 2 claim types (reports_uncertainty, baseline_comparison, etc).
quality_flags:
  self_constructed_ground_truth: false
  comparison_table_only: false
  hobby_project_scale: false
  predictable_outcome: false
---
```

## Body

The body has one free-form section: limitations and unexamined
dimensions of THIS paper. No Miles-2017 typing here. The Miles types
are corpus-wide properties (e.g. "this method has not been studied
in cluster X", "results disagree across papers Y and Z"), so they
cannot be assessed from a single paper. They live in a separate
artefact, `corpus_gaps.md`, produced by a synthesis subagent that
reads ALL per-paper gold notes (see `agents/synthesise_gaps.md`).

```markdown
## Limitations and unexamined dimensions

Two to six entries, only what this paper itself acknowledges or
visibly fails to examine. Each one sentence. No padding to a target
count. No cross-corpus reasoning.

- The evaluation is restricted to L1 cache; L3 and LLC contention
  are out of scope.
- All experiments run on a single Intel Skylake CPU; no AMD or ARM
  hardware is tested.
- Accuracy is reported as a single number; no variance across runs
  or confidence interval is given.
- The threat model assumes a single victim VM; multi-tenant
  collision is mentioned but not measured.
```

### What goes here vs not

Belongs in this section:
- Authors' own acknowledged limitations.
- Scope restrictions the paper makes explicit ("we focus on...").
- Methodological choices that visibly leave a dimension unexamined
  on the basis of the paper alone (single hardware platform, no
  variance, no baseline, etc.).

Does NOT belong:
- Statements that require knowing what other papers in the corpus
  did or did not do. Those are corpus-wide gaps and live in
  `corpus_gaps.md`.
- Generic "more work is needed".
- Speculation about future directions; those are claim entries with
  type `future_work` in the frontmatter, not body items.

## Validation

`tests/quality/validate_notes.mjs` checks each gold note for:

1. Required frontmatter keys present and non-empty.
2. Enumerated fields use values from the allowed sets above.
3. Every `claims[*].quote` and `numerical[*].quote` is a substring of
   the PDF's full text after PDF normalisation (ligatures, soft
   hyphens, hyphenated line breaks) identical to
   `extract_claims_v2.mjs`.
4. Body section "Limitations and unexamined dimensions" present and
   contains at least two non-empty bullet entries.
5. `paper_id` matches the filename.

Notes that fail validation are returned to the dispatcher for redo
with the validation error appended to the per-paper subagent prompt.

## Anti-context-fatigue rules

Inherited from the litreview-template. Each subagent reads at most
fifteen papers per dispatch. Working context resets between papers.
The orchestrator never opens a PDF. The orchestrator only reads
`tests/quality/build_log.jsonl` and validator output.

## Comparator contract

`tests/quality/compare.mjs` reads every gold note plus the
corresponding pipeline outputs from `project/data/store.sqlite` and
produces per-phase Precision / Recall / F1:

| Phase                      | Match rule                                                       |
|----------------------------|------------------------------------------------------------------|
| Sections                   | `type` match per heading (Hungarian-aligned on `heading` token-overlap). |
| Entities                   | `text` (case-folded) + `type` exact.                             |
| Claims                     | Quote substring overlap + `type` + `stance`.                     |
| Numerical                  | `metric` + `value` (±1%) + `dataset`.                            |
| Citation stance            | `ref_key` + `stance` (histogram match per paper).                |
| Miles-7 gaps (Phase 4)     | Detector output diffed against `corpus_gaps.md`, NOT per-paper bodies. Match = same Miles type AND `contributing_papers` set overlaps. |

The corpus-wide table and per-paper diffs land in
`tests/quality/report/`.
