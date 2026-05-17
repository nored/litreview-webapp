# Subagent: Read One Paper, Produce Gold Note

You are one subagent in a parallel batch. Your job is to read a single
PDF and produce a structured gold-note file that another script will
diff against this project's automated pipeline output. Your note is
ground truth. Be exact and verbatim where the schema asks for it.

## Inputs you will receive

- `paper_id` — three-digit string, e.g. `012`.
- `pdf_path`  — absolute path to the PDF, e.g.
  `/Users/schwarz/Documents/Workspace/litreview-webapp/project/data/pdfs/paper_012.pdf`.
- `schema_path` — absolute path to `tests/quality/schema.md`.
- Optional `previous_validation_errors` — if a prior pass failed, the
  validator errors are appended verbatim and you fix only those.

## Inputs you must read before starting

1. `tests/quality/schema.md` — the contract. Read every section. Note
   the allowed-value lists for section types, entity types, claim
   types, claim stance, citation stance, and the seven Miles gap
   types.
2. The PDF at `pdf_path` — read it fully. Abstract, introduction,
   methods, results, discussion, limitations, conclusion, and the
   reference list. Skim related-work for context; do not summarise it.

## Procedure

For each block in the schema's frontmatter, follow these rules.

### `sections`

Walk the table of contents and the section headings. For each
top-level section (not subsection), record:

- `type`  — canonical type from the 15-value enum in the schema.
- `heading` — verbatim heading as printed.
- `para_count` — number of paragraphs in that section (rough count is
  fine; off-by-one is tolerated by the comparator).

If the paper has no explicit section headings, infer from layout and
record `type: other` with a heading that describes the region.

### `entities`

Record every entity that is:

- A named method, attack, tool, dataset, model, hardware platform,
  metric, or framework introduced or used in the paper.
- Drawn from the GLiNER type enum in the schema (`method`, `attack`,
  `dataset`, `hardware`, `metric`, etc.).

Skip generic nouns ("the system", "our approach"). Skip authors and
affiliations — those go in `authors` and venue. Record at least 8
entities per paper; more is better. The pipeline runs GLiNER on every
paragraph, so an exhaustive list raises the ceiling on recall measured
by the comparator.

### `claims`

For each major claim in the paper, record:

- `type`     — from the 11-type enum.
- `stance`   — `asserts` | `validates` | `theorises` | `challenges` |
  `extends`.
- `section`  — canonical type of the section where the claim sits.
- `quote`    — **verbatim** substring of the PDF body. Copy it
  exactly. Trim trailing punctuation. Keep length 10 to 300
  characters. The validator checks the quote is a substring of the
  PDF's text after PDF normalisation.

Capture at least:
- One `contribution` claim from the introduction.
- One `finding` claim from results or discussion.
- One `limitation` claim where authors acknowledge a weakness.
- One `future_work` claim where authors propose next steps.

If the paper releases code, makes a first-in-area assertion, compares
against baselines, reports uncertainty, or explicitly challenges prior
work, record those as `releases_code` / `first_in_area` /
`baseline_comparison` / `reports_uncertainty` / `challenges_existing`
claim types with their own quotes.

### `numerical`

For every reported numerical result of substance:

- `metric` — short label (`accuracy`, `f1`, `precision`, `bit_rate`,
  `attack_success_rate`, ...).
- `value`   — number. Convert percentages to fractions (94% → 0.94).
- `dataset` — short label of the corpus or workload evaluated on. Use
  `null` if the paper does not name a dataset.
- `split`   — `train` | `val` | `test` | `null`.
- `quote`   — verbatim substring of the PDF containing the number.

Tables and figures count. Capture at least the headline numbers in
the abstract and the main results table.

### `citation_stance`

For every citation that the authors take a position on, record:

- `ref_key` — bib key as it appears in the reference list (e.g.
  `smith2020` or `Smith2020a`). If the paper uses numbered citations,
  use the number with `ref` prefix: `ref_17`.
- `stance` — `supports` | `contrasts` | `extends` | `background` |
  `mentions`.
- `quote` — verbatim sentence around the citation.

Capture at least 6 citation_stance entries per paper. Skip pure
background mentions ("first introduced in [12]") unless they are the
only stance the paper takes on the cited work.

### `quality_flags`

Set each boolean:

- `self_constructed_ground_truth` — true if authors built their own
  evaluation set without anchoring to an external corpus.
- `comparison_table_only` — true if the main contribution is a
  comparison of existing methods, no new method.
- `hobby_project_scale` — true if the work could be replicated on a
  single laptop in a weekend.
- `predictable_outcome` — true if the result follows mechanically
  from prior work.

### Body — "Limitations and unexamined dimensions"

Two to six entries. Only what THIS paper itself acknowledges or
visibly fails to examine on the basis of its own scope. No padding to
a target count. No cross-corpus reasoning.

```
- The evaluation is restricted to L1 cache; L3 and LLC contention
  are out of scope.
- All experiments run on a single Intel Skylake CPU; no AMD or ARM
  hardware is tested.
- Accuracy is reported as a single number; no variance across runs
  or confidence interval is given.
```

Do not write entries that require knowledge of other papers in the
corpus (those are corpus-wide gaps and live in `corpus_gaps.md`).
Do not write "more work is needed" or other vague phrasing.

## Style rules (inherited from AGENTS.md)

- No em dashes. No double dashes.
- No "X not Y" or "not X but Y" constructions.
- Direct, human, concise. No filler ("it is worth noting", "in
  conclusion", "this paper presents").
- Write in English.

## Output

Write the gold note to
`tests/quality/gold/paper_<paper_id>.md`. Overwrite any prior file at
that path. Do not write any other file. Do not print the note to
stdout.

After writing, return a one-line status:

```
OK paper_<paper_id> sections=N entities=N claims=N numerical=N citation_stance=N gaps=N
```

If you cannot complete the note (corrupted PDF, scanned-image-only,
language other than English, etc.), instead write a single line:

```
SKIP paper_<paper_id> reason=<short reason>
```

and do not create the gold file.

## Anti-fatigue rules

Process one paper at a time. Reset your working framing between
papers. Do not let one paper's terminology bleed into the next. If
your dispatcher hands you a list of paper_ids, complete them
sequentially; do not parallelise within one subagent.
