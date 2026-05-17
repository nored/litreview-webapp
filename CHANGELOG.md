# Changelog

## v2 (2026-05-12) — structured-data pivot

Replaces the v1 prose-drafter with a typed-extraction + cross-paper-detection pipeline. **Breaking:** the on-disk note schema, the synthesis JSON shape, and the Stage 4/5/7 view modules are all replaced. Existing v1 projects need to re-run extraction (no in-place state migration); the PDFs and triage CSV survive untouched.

### Added

- **SQLite structured store** (`project/data/store.sqlite`) via sql.js (WASM). 16 tables: papers, paper_authors, paper_category, paper_field, paper_population, chunks, chunk_section, canonical_names, name_usage, results, claims, quoted_spans, citations, provenance, schema_meta, dismissed_candidates. FK-enforced; every populated structured field carries a provenance row referencing the mechanism + model + source chunk + page + classifier scores.
- **Stage 1 per-paper extraction pipeline** (`server/lib/extract_orchestrator.mjs` + `server/lib/extractors/*`). Deterministic + classifier + bounded-LLM. Mechanisms in preference order: regex → NER (Xenova/bert-base-NER) → zero-shot NLI (Xenova/distilbart-mnli-12-3) → cosine to label prototypes (bge-small) → LLM-as-finder (WebLLM, substring-validated). All field values either substring-validated against source chunks or bounded to enums.
- **Stage 2 detection pipeline** (`server/lib/detectors/*`). 11 detectors over the structured store, pure SQL/JS, no inference. Includes preconditions check + adaptive thresholds by corpus size + stale-vs-fresh detection marker + per-candidate dismissal.
- **Hybrid retrieval** (`server/lib/hybrid_retrieval.mjs`): BM25 (pure JS) + dense (bge-small) + RRF fusion + cross-encoder reranker (Xenova/ms-marco-MiniLM-L-6-v2).
- **Entity resolution** (`server/lib/entity_resolution.mjs`): 4-pass canonicalisation — normalize → alias → Damerau-Levenshtein → embedding cosine.
- **MinHash + Jaccard near-duplicate detection** (`server/lib/dedup_minhash.mjs`).
- **Citation context classifier** (`server/lib/extractors/citation_context.mjs`): NLI per citation edge into support / contrast / extend / background. Surname+year and numeric-style `[N]` reference parsing.
- **Catalogue v2** (`server/lib/catalogue_v2.mjs`): structured aggregation over quoted_spans + claims, embedding-similarity quote ranking per body section, no LLM generation.
- **Provider chained fallback** (`server/lib/llm_proxy.mjs`): `callLlm({ fallback })` walks a chain on pre-stream failure. Mid-stream failures never retry on a different provider (would corrupt output).
- **External corpus comparison** (`server/lib/external_comparison.mjs`): same-topic OpenAlex pull, joint clustering, gap-cluster flagging.
- **Project export / import** (`/api/v2/export` + `/api/v2/import`).
- **Extraction coverage metrics** (`/api/v2/coverage`).
- **Extraction failure log** (`/api/v2/extraction-log`).
- **v1 → v2 readiness probe** (`/api/v2/migration-status`).
- **Embedder identity stamp** at `project/data/_vectors/_meta.json` so cross-model / cross-dtype vector pollution surfaces in the snapshot.

### Changed

- **Output-mode workflow at Stage 6/7**: Thesis / Paper / Grant / Landscape / Custom — the same Stage 1 + Stage 2 backend, different rendering.
- **PRISMA `notes_written`**: now counts papers with structured extraction populated, falling back to legacy markdown notes only when v2 is empty.
- **Conveyor's "Draft N notes" action**: relabelled "Extract N papers"; drives into the v2 deep-read form.
- **README + topic.md template**: reframed from "thesis literature review" to "structured analysis over a research-domain corpus" — thesis is one output mode among several.

### Removed

- **Stage 4/5/7 v1 views** (`public/views/stage4.mjs`, `stage5.mjs`, `stage7.mjs`). The legacy `/api/synthesis/*` and `/api/positioning/*` endpoints stay because they read authoritative workflow files (search log, CSVs, hand-written markdown) — those are the source of truth for the PRISMA / positioning artefacts and the conveyor + remediation server-side code still depend on them.
- **v1 prose-drafter contracts in `server/lib/notes.mjs` validator**: dropped novelty_strength enum check, 400-word body min, body-section presence check. v2 extracted-provenance validation kept.
- **`-legacy` URLs**: `#/stage4-legacy`, `#/stage5-legacy`, `#/stage7-legacy` are gone.

### Migration

For a v1 project: keep `project/data/_credentials.json`, `candidates_*.csv`, and `pdfs/` as-is. The first run on v2 code:

1. `POST /api/v2/sync` mirrors triage CSV into the v2 papers table.
2. `POST /api/v2/extract/corpus` runs chunk ingestion + structured extraction for every include/maybe paper.
3. Per-paper: open Stage 4 → "Extract claims (LLM)" to populate claims with WebLLM (optional but unlocks the empirical-gap and theoretical-gap detectors).
4. `POST /api/v2/citation-context/classify` populates `citations.context_class` if you've run snowball.

`GET /api/v2/migration-status` returns concrete next-steps based on current state.

### Known limitations

- WebLLM claims extraction never validated against a real browser-side run in this push (smoke tests use a stub LLM).
- Cross-encoder reranker downloads ~80MB on first call with no progress UI.
- Tar export shells out — Windows old builds without `tar.exe` won't work.
- Citation-context classifier can only classify edges whose `from_paper` is in corpus (we need its chunks); outbound snowball edges from external seeds are unclassifiable by design.
- No corpus-wide cross-detector consistency pass — a paper can be "core" by centrality and "novelty outlier" by LOF simultaneously; UI shows both without reconciling.
