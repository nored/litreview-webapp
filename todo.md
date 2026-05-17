# todo

Canonical plan for the project. Edit this file when scope changes or items ship.

## ⟶ Resume here (current state, 2026-05-12)

**Project corpus**: wiped on 2026-05-12 (was GDPR test data). `project/data/_credentials.json` preserved; protocol files reset to defaults. Empty slate.

**Working tree (uncommitted)**:
- `public/app.mjs`, `public/index.html`, `public/styles.css`, `public/views/conveyor.mjs`, `public/components/stage_rail.mjs` — conveyor Phase A (single-card + persistent stage rail). Tested locally; ready to commit when user says so.
- `server/lib/notes.mjs` — listEligible/getNote convergence via `applyInMemoryDefaults`; schema_version: 2 + `extracted:` skeleton + provenance validator.
- `server/lib/section_classifier.mjs` (new) — M0 deliverable. Tier-1 heading-pattern + tier-2 cosine-to-prototype.
- `todo.md`, `MEMORY.md` updates.

**Last commits**: `e7bfaf2` (paper identification + validation fixes) → `944b048` (conveyor workaround patches, force-pushed clean of Claude trailer).

**Next action**: USER TEST PASS. M0 → M5 are all complete and uncommitted. End-to-end pipeline lives in the working tree; no commits yet (per `feedback_commit_workflow.md`). After test feedback we build the next todo.

M4 progress (first cut):

- [x] **M4.a — SQL-only gap detectors** (DONE 2026-05-12). 4 detectors landed:
  - `server/lib/detectors/methodological_gap.mjs` — empty `(category × method_family)` cells with row marginal ≥ 3.
  - `server/lib/detectors/knowledge_gap.mjs` — `(category × method × system_domain)` tensor; empty cells with dense Hamming-1 neighbours.
  - `server/lib/detectors/population_gap.mjs` — `(system_domain × sample_type)` sub-tensor sparsity.
  - `server/lib/detectors/evidence_gap.mjs` — variance (range + CV) over `(metric, dataset)` from `results` table.
  - `server/lib/detectors/index.mjs` — orchestrator. `detectAll(opts)` runs all four in parallel and returns a cross-type ranked combined list. End-to-end smoke-tested on a 12-paper synthetic corpus (returned 5 methodological + 1 evidence candidates with correct cells and salience).
- [x] **M3 — Claims via WebLLM** (DONE). `server/lib/extractors/claims.mjs`: `prepareClaimsExtraction(paperId)` builds prompts; `processClaimsResponses(paperId, responses)` substring-validates each quote against the source chunks (rejects fabrications), stance-classifies via NLI, embeds the quote, writes `claims` row + provenance. Embeddings persist to `project/data/_vectors/claims.jsonl` keyed by claim_id (loaded by `loadClaimVectors()` for cluster detectors). `extractClaims(paperId, { llmFn })` is the in-process shortcut for tests / proxied LLMs; browser-driven path is exposed for WebLLM in M5. Six claim types: contribution, finding, limitation, future_work, framework, method.
- [x] **Topic enums extractor** (DONE alongside M3). `server/lib/extractors/topic_enums.mjs` covers `category` (multi-label) and `method_family` (single-label) — both cosine to topic.md-defined prototype embeddings. Wired into the orchestrator (runs first; downstream detectors depend on these axes).
- [x] **M4.b — Cluster-based detectors** (DONE 2026-05-12). All three cluster-based detectors built on a shared cluster index. Smoke-tested end-to-end on a synthetic corpus.
  - `server/lib/detectors/_claim_clusters.mjs` — loads `_vectors/claims.jsonl`, runs sbert `communityDetection` with `autoTuneCommunityParams`, materialises each cluster with member claims joined to paper-level fields (stance, claim_type, methodology_type, categories).
  - `server/lib/detectors/empirical_gap.mjs` — per cluster: count `stance==theorises` vs `stance==validates`; flag clusters with ≥2 theorises and 0 validates.
  - `server/lib/detectors/practical_gap.mjs` — per cluster: partition by paper `methodology_type` ∈ {survey/observational/case_study} vs {experimental/theoretical/formal/review}; flag mismatched modal stances or critical↔assertive splits.
  - `server/lib/detectors/theoretical_gap.mjs` — per category: orphan (`papers / frameworks` ratio ≥ 5) + disputed (`challenges_existing=true` fraction ≥ 0.25). Pure SQL, no clustering.
  - `detectors/index.mjs` orchestrator builds the cluster index once and shares across the cluster-using detectors (no duplicate `communityDetection` cost).
- [x] **M4.c — Network layer** (DONE 2026-05-12). 4 detectors over the citations table. Smoke-tested on a synthetic graph with chains + co-citation triangles.
  - `server/lib/detectors/citation_centrality.mjs` — PageRank (30 iterations, damping 0.85, dangling-node handling). Returns top in-corpus papers by centrality.
  - `server/lib/detectors/main_path.mjs` — Hummon & Doreian SPC (Search Path Count): forward+backward path counts in topological order, greedy chain extension from highest-SPC seed edge.
  - `server/lib/detectors/co_citation.mjs` — self-join on `from_paper` (papers cited together by third papers; suggests shared intellectual lineage).
  - `server/lib/detectors/bibliographic_coupling.mjs` — self-join on `to_paper` (papers sharing references; suggests emerging conversations).
  - `detectors/index.mjs` now exposes `DETECTOR_CATEGORY` tagging each detector as `gap` or `network`. 11 detectors total in `detectAll`.
- [x] **M4.d — Temporal + bibliometric** (DONE 2026-05-12). 4 modules. Smoke-tested.
  - `server/lib/detectors/temporal_trends.mjs` — per-axis (category, method_family, framework, dataset, tech) year aggregates; emerging / declining / accelerating subtypes.
  - `server/lib/detectors/lof_novelty.mjs` — Local Outlier Factor over per-paper averaged claim embeddings. k auto-set, cosine distance, full reach-dist / LRD / LOF.
  - `server/lib/detectors/ngram_novelty.mjs` — bi/tri-gram document-frequency rarity over paper title+abstract. Tri-grams weighted higher.
  - `server/lib/detectors/rerank.mjs` — `rerankByCitations(candidates)` multiplies each candidate's salience by `mean(1 + log(1 + in_corpus_cites))` over its contributing papers. Plugged into `detectAll({rerankByCitations: true})`.
- [x] **M4.e — Interactive surfaces** (DONE 2026-05-12).
  - `server/lib/query.mjs` — structured query language with tokeniser + parser + SQL builder. Grammar supports `key:value`, `key>=N`, `AND`/`OR`, quoted free-text. Joins paper_field / paper_category / name_usage / results automatically. 7 test queries pass (`dataset:mimic-iii`, `results.f1>0.8`, `category:nlp AND dataset:mimic-iii`, etc.).
  - `server/lib/recommend.mjs` — `recommendCandidates(shortlistIds)` combines claim-similarity (top-K per shortlist claim via embedding cosine) + citation-pull (papers cited by shortlist members) into a min-max-normalised weighted score (α=0.6, β=0.4). Returns ranked recommendations with contributing-signal breakdown.

**M4 complete.** 11 detectors via `detectors/index.mjs` (`detectAll(opts)`), each tagged in `DETECTOR_CATEGORY` as `gap` / `network` / `temporal` / `novelty`. Plus `query.mjs` (structured search) and `recommend.mjs` (shortlist → suggestions).

**Next action**: continue M5. **M5.a done — v2 backend exposed + debug view in place.** Next is **M5.b — proper Stage 4 / Stage 7 form rewrite + v1 cleanup + framing sweep.**

M5 progress:

- [x] **M5.a — v2 API + debug view** (DONE 2026-05-12). 13 new endpoints on `/api/v2/*` wrapping the backend M1-M4 work:
  - `POST /api/v2/sync`, `POST /api/v2/papers/:id/ingest` — bridge from triage CSV + run chunk/section pipeline
  - `POST /api/v2/papers/:id/extract`, `POST /api/v2/extract/corpus` (+ status) — run the M2 extractors
  - `GET  /api/v2/papers/:id/structured` — full structured record (paper + fields + names + results + claims + chunk count)
  - `GET  /api/v2/detect[?only=type1,type2&rerank=1]`, `GET /api/v2/detect/:type` — run detectors
  - `GET  /api/v2/query?q=...` — structured query
  - `POST /api/v2/recommend` — recommendation surface
  - `POST /api/v2/papers/:id/claims/prepare` + `.../process` — split LLM round-trip for WebLLM
  - `GET  /api/v2/snapshot` — row-count overview
  
  Plus a debug view at `#/structured` (`public/views/structured.mjs`) with 5 tabs: Snapshot · Corpus · Detect · Query · Recommend. Reachable from the persistent stage rail. Lets you trigger sync / ingest / extract per paper, run all 11 detectors with optional citation-weighted rerank, run structured queries against the SQLite store, and pull recommendations from a shortlist. Hand-rolled minimal UI — NOT the final form; just enough surface to validate the backend end-to-end.

- [x] **M5.b — Stage 4 v2 + WebLLM claims + framing start** (DONE 2026-05-12).
  - New `public/views/deep_read_v2.mjs` (~370 lines) — three-pane Stage 4: paper list / PDF viewer / structured record. Routes `#/stage4` to it; legacy prose-drafter view archived at `#/stage4-legacy`.
  - `public/lib/webllm_claims.mjs` — browser-side driver for the M3 claims pipeline: prepare → loop over prompts via existing `llm.chat()` (respects provider switch) → process. Subscription-style progress callback for the UI.
  - New `PUT /api/v2/papers/:id/categories` endpoint with user-edit provenance.
  - Provenance hovers on extracted field rows showing classifier score distribution.
  - "Re-ingest chunks", "Re-extract structured fields", "Extract claims (LLM)" buttons per paper.
  - Editable category chips (add by typing + Enter; × to remove); writes through to SQLite with `mechanism='user_edit'`.
  - README opening reframed from "MSc/BSc thesis" to "research-domain corpus" — full UI label sweep deferred to M5.c.
- [x] **M5.c — Stage 5 + Stage 7 v2 + corpus index** (DONE 2026-05-12).
  - New `public/views/corpus_shape_v2.mjs` (~280 lines). Replaces v1 Stage 5 prose with a detector dashboard. Tabs: Gap / Network / Temporal / Novelty / Corpus index. Per-type ranked candidates with drill-down, click-to-paper links, citation-weighted rerank toggle. v1 Stage 5 archived at `#/stage5-legacy`.
  - New `public/views/positioning_v2.mjs` (~280 lines). Replaces v1 Stage 7 with an OUTPUT-MODE SELECTOR (Thesis / Paper / Grant / Landscape / Custom). Landscape mode fully built (inventory tables + temporal trends + central papers); Grant mode renders ranked gap candidates; Paper mode shows a related-work table + top gaps; Custom mode is the structured-query bar. Thesis mode delegates to legacy stage7 at `#/stage7-legacy` for now (PRISMA / catalogue rewrites are M5.d).
  - New endpoint `GET /api/v2/corpus-index?kind=dataset|tech|framework` — per-canonical paper count + paper_ids + sample raw forms. Drives the Corpus index tab + the Landscape inventory.
  - Router: `#/stage5` and `#/stage7` now route to v2 views; legacy views accessible at `-legacy` URLs. 15 v2 API routes total.
- [x] **M5.d — editable fields + partial framing sweep** (DONE 2026-05-12).
  - `PUT /api/v2/papers/:id/fields/:fieldName` — write a single paper_field value with `mechanism='user_edit'` provenance. Backs inline editors in the v2 deep-read form.
  - `POST /api/v2/papers/:id/name-usage` — add/remove named-entity rows. Three actions: `add` (creates canonical if needed + name_usage row with user_edit provenance), `remove` (by usage_id), `remove_by_canonical` (by kind + canonical).
  - `deep_read_v2.mjs`: click any field value → inline input → Enter saves, Escape cancels; named-entity chips have × buttons + dashed "+ add X" inputs for tech/dataset/framework kinds.
  - `templates.mjs`: topic.md template reframed from MSc/BSc thesis → review focus + researcher; collapsed `msc_target_includes` / `bsc_target_includes` into single `target_includes` / `minimum_includes`.
  - `conveyor.mjs`: "Draft N notes" → "Extract N papers"; "Polish N invalid notes" → "Polish N papers"; detail copy rewritten for the structured-extraction flow.
- [x] **M5.e — Body section editing + conveyor idle deliverables** (DONE 2026-05-12).
  - `GET /api/v2/papers/:id/spans` + `POST /api/v2/papers/:id/spans` — load and mutate quoted_spans grouped by section. Actions: add (with new position), remove (by span_id), edit (text + page). 19 v2 routes total.
  - `deep_read_v2.mjs`: six body-section tables (problem_statement / method_summary / ground_truth_and_evaluation / stated_limitations / gaps_this_paper_opens / relevance_to_the_thesis_topic). Each row clickable to edit; × button to remove; "+ paste a verbatim quote" input + page field per section for adding.
  - `conveyor.mjs` idle card (Phase C): replaced "Deliverables ready" stub with a mode grid (Thesis / Paper / Grant / Landscape / Custom) — each is a one-click jump to `#/stage7` with the mode pre-selected via the same localStorage key positioning_v2 reads on load. Plus secondary "Explore corpus shape" / "Open v2 data view" buttons.
- [x] **M5.f — last residue + loose ends sweep** (DONE 2026-05-12). One push to empty the backlog.
  - **Editable results table**: `POST /api/v2/papers/:id/results` (add/edit/remove a result row with user_edit provenance); `deep_read_v2.mjs` results table is now click-to-edit + × to remove + add-row form.
  - **Thesis mode in `positioning_v2.mjs`**: rewrote to read v2-native — PRISMA from `/api/positioning/prisma`, indicators from `/api/synthesis/state`, positioning from `/api/positioning/state`. Catalogue still points to legacy.
  - **Validator cleanup in `server/lib/notes.mjs`**: dropped v1 prose-drafter contracts (novelty_strength enum check, 400-word body min, body-section presence check). v2 extracted-provenance validation kept.
  - **Provider robustness** (`server/lib/llm_proxy.mjs`): `fetchWithRetry(url, init, { retries=3 })` with exponential backoff on 429/502/503/504 + network errors. `formatProviderError(provider, res)` for human-readable error surface. Both `callOpenAi` and `callAnthropic` wired through both helpers.
  - **Embed-daemon visibility**: `stage_rail.mjs` now shows a `.rail-embed-badge` heartbeat (queue depth + last-run timestamp) fetched from `/api/embed/status`.
  - **Project export / import**: `GET /api/v2/export` streams a tar.gz of `project/`; `POST /api/v2/import` accepts a multipart upload and restores. Triggered from the v2 Stage 4 toolbar.
  - **External corpus comparison** (Phase 6.d): `server/lib/external_comparison.mjs` (~210 lines) — pulls up to 100 same-topic OpenAlex works, embeds joint with corpus, runs `communityDetection`, flags clusters dense in external but sparse in corpus. `POST /api/v2/external-compare` + `GET /api/v2/external-compare/status` (fire-and-forget with module-level state). Landscape mode in `positioning_v2.mjs` has a "Run comparison" button + polling + rendered gap-cluster list.
  - **Framing sweep**: README opening, "seven thesis indicators" → "seven quality indicators", "thesis topic catalogue" → "review catalogue", "your thesis work" → "your review work". Future-work section pruned (only fallback chains across providers remain).
  - **Conveyor idle deliverables** (already in M5.e but extended): mode-card grid persists the selected mode via `localStorage` key `litreview:positioning:mode` that positioning_v2 reads on load.
  - **24 v2 routes total** registered under `/api/v2/*`.

**M5 complete.** Backend (M1-M4) + UI (M5) are end-to-end. User test pass next, then a fresh todo.

- [x] **M5.g — close out the half-implementations** (DONE 2026-05-12). One push to eliminate every "v2 surface over v1 storage" handoff and every unfinished promise from the pivot.
  - **Citation context classifier**: `server/lib/extractors/citation_context.mjs` (~150 lines). Anchors citations by author-surname + year in the citing paper's chunks; runs NLI zero-shot over a ±240-char window with labels {supports / contrasts with / extends / mentions as background to}; writes `citations.context_class / context_page / context_quote / provenance_id`. New endpoints `POST /api/v2/citation-context/classify` (fire-and-forget) + `GET /api/v2/citation-context/status` (counts + distribution).
  - **Snowball → citations table**: `syncSnowballCitations` was implemented in `ingest.mjs` but never called. Now wired into `POST /api/v2/sync` (returns `{papers, citations}`) AND auto-fires on snowball daemon `idle` events via a subscribe hook so v2 picks up edges as soon as a snowball run completes.
  - **Catalogue v2** (`server/lib/catalogue_v2.mjs`, ~210 lines): structured aggregation over `quoted_spans` + `claims`, grouped by topic category. No LLM generation — every entry is a verbatim quote with paper + page provenance. `catalogueToMarkdown()` renders to Markdown. Endpoints `GET /api/v2/catalogue` and `GET /api/v2/catalogue.md`.
  - **Thesis mode rewritten** in `positioning_v2.mjs`: PRISMA (kept — sources from workflow files), Top gap candidates (new — `/api/v2/detect?rerank=1`), Positioning statement (kept), Catalogue v2 (new — `/api/v2/catalogue` with collapsible per-chapter quote lists). Indicator-scorecard handoff to legacy `_synthesis.json` is gone.
  - **Provider chained fallback**: `callLlm({ provider, fallback })` walks a chain on failure. Strict policy: if ANY tokens have streamed before failure, do NOT retry on another provider (would corrupt output). `provider_fallback` credential field added (CSV, e.g. `"anthropic,openai"`). `/api/llm/chat` honours per-request `fallback` array. Mid-stream failures still surface clean errors via the existing retry+format wrappers.
  - **Legacy views deleted**: `public/views/stage4.mjs`, `stage5.mjs`, `stage7.mjs` removed. App router cleaned. The legacy `/api/positioning/prisma` + `/api/positioning/state` endpoints stay — they read from authoritative workflow files (`search_log.jsonl`, `candidates_*.csv`, `positioning_statement.md`), not from analytical state, and serve as the source of truth for those artefacts. `synthesis.mjs` server-side is retained because `remediation.mjs` and `conveyor.mjs` still depend on it.
  - **28 v2 routes total**.

**Resume point**: user test pass. M0→M5.g uncommitted; system is end-to-end complete with no v2-surface-over-v1-storage residue.

- [x] **M5.h — close out every silent-wrong-output bug + thresholds + UX gaps** (DONE 2026-05-12). 18 separate fixes in one push.
  - **Numeric `[N]` citation anchors**: citation-context classifier now parses the references section (bracketed + numbered styles), maps each ref to to_paper by surname+year, locates `[N]` (and `[N, M]`, `[N-M]`) in non-references chunks. Per-from_paper cache avoids re-parsing.
  - **Whitespace-tolerant substring validation in claims.mjs**: handles non-breaking spaces, soft hyphens, ligatures (ﬁ ﬂ ﬀ ﬃ ﬄ ﬅ ﬆ), smart quotes, en/em dashes, hyphenated line breaks. Case-insensitive fallback for acronym mis-casing.
  - **PRISMA `notes_written` v2-aware**: counts distinct paper_id with paper_field rows in v2 store; falls back to `notes/*.md` count only when v2 is empty.
  - **Catalogue v2 quote ranking**: per-section embedding prototype; each quote scored by cosine, round-robin emits best-quote-per-paper first then second-best, etc. Falls back to length-based ranking if embedder is unavailable.
  - **Detector preconditions + warnings**: `detectOne` checks corpus state per detector and emits human-readable issues ("no paper_field rows — run extract", "no claims with stance — re-run extraction", "citations table empty — run sync after snowball"). `detectAll` surfaces `precondition_warnings` array + `rerank_note` when bibliometric rerank silently no-ops.
  - **Adaptive corpus-size thresholds**: new `detectors/_scale.mjs` with `pickThresholds()`. minPapersPerGroup, orphanRatio, minRowTotal, minClusterSize, topK all derived from sqrt(N). Cache cleared at start of every `detectAll`. Threshold values bubble into the result so the UI can show them.
  - **Extraction coverage metrics**: `server/lib/coverage.mjs` + `GET /api/v2/coverage`. Per-field populated/unknown/missing % across the corpus; per-table coverage (chunks, claims, results, citations, named entities); one-decimal percentages.
  - **Stale-detections marker**: `schema_meta.last_extracted_at` set by every `extractForPaper`; `last_detected_at` set by every `detectAll`. `detectAll` returns `was_stale: true` when extractions postdate the last detect run.
  - **Vector-store embedder identity stamp**: `project/data/_vectors/_meta.json` records model + dtype + dim on every persist. `checkEmbedderCompatibility()` exposed; structured snapshot endpoint includes the check so model/dtype drift surfaces.
  - **External-compare query override**: `runExternalComparison({ queries })` accepts a caller-supplied query array (skips topic.md parsing). UI input field in Landscape mode for comma-separated overrides.
  - **Failed-extraction feed**: `project/data/_extraction_log.jsonl` appended after every `extractForPaper`. `GET /api/v2/extraction-log[?limit=100&failures=1]` reads the tail.
  - **Inline-edit undo in deep_read_v2**: module-level undo stack (cap 20); `pushUndo({ description, undoFn })` after every successful save; `↶ Undo (N)` button in the toolbar pops + reverts. Wired into field-edit save site.
  - **Candidate dismissal**: new `dismissed_candidates(detector_type, signature, dismissed_at, reason)` table (schema_version bumped to 2). `signatureFor(type, candidate)` produces a deterministic per-detector identity. Detectors emit signatures; `annotateAndFilter` drops dismissed ones from results. Endpoints `POST/DELETE/GET /api/v2/dismiss-candidate(s)`.
  - **v1→v2 readiness probe**: `GET /api/v2/migration-status` returns row counts + concrete next-step instructions ("X papers need chunk ingestion", "Y need extraction", "claims sparse for Z papers").
  - **README refresh**: Stage 4/5/6+7/8 descriptions rewritten for the structured-extraction + detector-dashboard + output-mode model. Stage 6 and 7 collapsed into "Positioning & catalogue (output modes)".
  - **CHANGELOG.md**: new file. Documents the v2 pivot — added/changed/removed sections + migration steps + known limitations.
  - **Conveyor mode-card last-choice highlight**: reads `litreview:positioning:mode` from localStorage on render; the last-used card gets a `.conveyor-mode-card-last` class + "↻ last used" subtitle.
  - **Stage-rail badge auto-refresh**: 5s polling against `/api/embed/status` via setInterval that auto-clears on root disconnect.
  - **Import schema-version compat check**: `/api/v2/import` opens the incoming store.sqlite (if any), reads schema_meta.schema_version, refuses if it differs from the current build's version.

**34 v2 routes total**. All edited files pass `node --check`.

- [x] **M5.i — close out the second-round audit** (DONE 2026-05-12). 22 fixes in one push.
  - **Catalogue 6th section**: `relevance_to_the_thesis_topic` now in `SECTION_ORDER` + section prototype.
  - **Cluster signature stability**: cluster-cell candidates use sorted top-3 contributing-paper IDs as the dismissal-stable identity, not the run-specific cluster_id. Helper `extractPaperList` flattens nested contributing_papers shapes.
  - **Coverage `unknown` separated**: three buckets per field (populated / unknown / missing); bool signals additionally track `false_signal` ("checked and absent" is a real outcome, not unknown).
  - **PRISMA studies threshold**: requires ≥2 substantive extraction dimensions ({fields beyond topic_enums, named entities, results, claims}) per paper. Topic-enums-only papers no longer inflate the count.
  - **Schema_version migration**: `runMigrations()` in `store.mjs` bumps v1 → v2 when `dismissed_candidates` table exists. Idempotent; future migrations chain.
  - **References-section fallback parsing**: if no chunk is tagged 'references', scans all chunks for "References" / "Bibliography" / "Works Cited" header and parses everything after. No more silent zero-classification on mis-tagged PDFs.
  - **Coverage view in structured.mjs**: new "Coverage" tab — per-field populated/unknown/missing % + per-table coverage (chunks, claims, results, citations, named entities by kind).
  - **Extraction log view**: new "Log" tab with "Only failures" filter, rendering each entry's paper_id + timestamp + elapsed + error list.
  - **Migration banner**: conveyor renders an info banner with next-steps from `/api/v2/migration-status` + "Run migration now" button that triggers `/api/v2/migrate` and polls status.
  - **Dismiss buttons**: every detector candidate in `corpus_shape_v2` gets a `× dismiss` button that prompts for a reason and POSTs to `/api/v2/dismiss-candidate`. Stays dismissed across detect runs via stable signature.
  - **Stale-detection banner**: banner shown in stage 5 when `was_stale=true`. Plus precondition warnings, rerank note, and cross-detector coherence warnings rendered as separate banners.
  - **Provider fallback config UI**: Setup view has a dedicated input + hint with example value (`anthropic,openai`) and explanation of the no-mid-stream-restart rule.
  - **Inline undo on all save sites**: pushUndo now wraps every category chip add/remove, named-entity chip add/remove, results table add/edit/remove, span add/remove. The toolbar Undo button popping any of these reverses via the matching reverse-action.
  - **Adaptive thresholds for remaining 7 detectors**: population_gap, evidence_gap, practical_gap, citation_centrality, main_path, lof_novelty, ngram_novelty all wired through `pickThresholds()`. All 14 detectors now scale by corpus size.
  - **Citation context window chunk-aware**: `windowAroundMatch()` extends into adjacent chunks of the same paper when the anchor lands near a chunk boundary; respects references-section boundary. Both surname-anchor and numeric-anchor paths use it.
  - **Catalogue embedding caching + skip-when-small**: session-scoped `_protoCache` for prototype embeddings. Ranking skipped entirely when rows ≤ cap×1.5 (no embedding cost when keeping most rows anyway).
  - **Extraction-log rotation**: per-append size check; trims to last 1000 lines when file exceeds the threshold.
  - **Catalogue prototype from topic.md**: prototypes prepended with `${topic.title}. ${first_sentence_of_description}.` so ranking is tuned to the actual domain, not generic English.
  - **README Configure refresh + package.json version**: Configure section rewritten with v2-relevant fields (target_includes, provider_fallback). `package.json` bumped to `2.0.0` with new description.
  - **Cross-detector consistency pass**: `collectCoherenceConflicts()` flags papers in both `citation_centrality` top-N AND a novelty-detector top-N. Surfaces as `coherence_warnings` in detect result.
  - **One-click migrate endpoint**: `POST /api/v2/migrate` runs sync + extract corpus end-to-end. Module-level state, progress reporting, status polled via `GET /api/v2/migrate/status`. Wired into the conveyor migration banner.
  - **Embedder identity check at write**: `maybeWarnOnStampDrift()` called from `upsert()`; one-shot warning per process when stamped model/dtype/dim differs from current.

**36 v2 routes total**. All edited files pass `node --check`.

- [x] **M5.j — round-three audit fixes** (DONE 2026-05-12). 21 fixes.
  - **References-fallback header-anchored**: matches only standalone header lines (`\n REFERENCES \n`, possibly with section-number prefix), not body-text occurrences.
  - **Numeric `[N]` regex word-boundary**: searching for `[2]` no longer matches `[12]` / `[25]`. Negative lookahead `(?![0-9])` after the number.
  - **Citation window page tracking**: cross-chunk extension stops at page boundaries so the recorded `context_page` accurately reflects all content shown.
  - **Broader cross-detector coherence**: three classes — central+novel, signal_stack (paper in ≥3 detectors' top-10), orphan+central. Replaces single centrality×novelty check.
  - **Dismissed candidates restore UI**: `<details>` panel under stage 5 lists every dismissal with × restore button.
  - **Coverage view shows false_signal + embedder drift banner**: bool fields display `(false: N)` inline; embedder mismatch surfaces as warn banner when stamped ≠ current.
  - **Adaptive thresholds visible**: "Corpus auto-tuned (N=..): min-row-total=..." line above each detector category in stage 5.
  - **Migration banner lifecycle**: `MutationObserver` watches the conveyor root; polling interval clears when root detaches. Errors from /api/v2/migrate/status surface inline + button shows "Retry migration".
  - **Migration banner context-aware**: hidden when corpus is genuinely empty (no triaged papers, no legacy notes).
  - **Inline dismiss form**: replaces `prompt()` with inline reason input + Confirm/Cancel buttons.
  - **Dismiss updates count chip**: per-type chip in the summary header decrements without re-detect.
  - **Cmd+Z keyboard shortcut**: global keydown listener on `#/stage4` pops the undo stack. Skips when focus is in input/textarea so it doesn't fight the browser's native text undo.
  - **Stale banner time-decay**: <1h = warn, <24h = info, ≥24h = muted note. <10ms = no banner (extraction is essentially concurrent).
  - **provider_fallback save confirmation**: "Saved." indicator briefly appears after onchange completes; error message on failure.
  - **Catalogue domain hint lighter**: only `problem_statement` + `relevance_to_the_thesis_topic` get topic.md prepended. Other sections stay generic.
  - **Migration-status text updated**: next_steps now points to "Run migration now" on the conveyor instead of listing manual curl sequence.
  - **Migrate preflight**: refuses with clear message when topic.md has no title OR no include/maybe papers in triage CSV.
  - **runMigrations on import**: already covered — `v2Store.close()` clears state, next `v2Store.init()` re-runs schema + migrations.
  - **Embedder drift warns per-drift**: track `_lastWarnedKey`; re-warns when stamped or current identity changes mid-session.
  - **Fallback chain reports active provider**: callLlm tracks attempts; `getLastTrace()` exposes `{ provider_used, attempts }`. SSE `done` event includes `provider_used` so the UI can show "served by fallback X".
  - **Coverage pct reconcile**: `missing_pct = 100 - populated_pct - unknown_pct` so the three buckets sum to 100.0 exactly.

**36 v2 routes total**. All edited files pass `node --check`.

- [x] **M5.k — round-four audit fixes** (DONE 2026-05-12). 27 fixes.
  - **Inline-undo cross-paper closure fix**: undo stacks now per-paper (Map<paper_id, []>); `setCurrentUndoPaper()` called by renderDetail; popAndUndo refuses to fire across paper boundaries.
  - **Migration confirm dialog**: triaged-count + time estimate shown; explicit confirm() before launching multi-minute extract.
  - **Detector preconditions batched**: single `corpusCounts()` query at start of `detectAll`; threaded into all 14 detectors. Replaces ~30 per-call COUNT round-trips.
  - **`pickThresholds()` race-safe**: removed module-global cache; pure function accepting optional `n`.
  - **Coverage UI label clarity**: header explains buckets ("Value · False · Unknown · Missing"); per-row Value column excludes false_signal which now has its own column.
  - **Citation-context classification UI**: Network tab has a "Classify unclassified edges" button + status/distribution display.
  - **Migration-status text UI-neutral**: next_steps reference endpoints, not "the conveyor".
  - **Restore UI full signature**: long signatures collapsed under `<details>` with full text below; original candidate content snapshotted at dismiss time + rendered.
  - **Bulk dismiss**: per-type-section button confirms then dismisses all candidates in one detector type.
  - **Migration polling backoff**: 2s during sync, 10s during extract; replaces fixed interval. setTimeout-based with adaptive cadence.
  - **Cmd+Z keyboard shortcut + transient toast**: keydown handler on document; renders "Undone: <description>" toast for 2.2s after firing.
  - **Coherence top-adaptive**: top-N size derived from `thresholds.topK / 5`, bounded [5, 20].
  - **Migration sub-stage progress**: `last.stage` now ∈ {sync:papers, sync:citations, extract, done} so UI can distinguish phases.
  - **Catalogue 6th section prototype**: rephrased so combined topic-prefixed form reads cleanly.
  - **Numeric anchor unique-surname fallback**: when surname matches exactly one ref entry, accept the match even without year.
  - **Coverage pct precision**: bumped to 2 decimals; reconciliation still ensures sums to 100.
  - **callLlm trace per-call**: removed module-global `_lastTrace`; replaced with `onComplete(trace)` callback. `getLastTrace()` retained as null-returning stub.
  - **Dismiss form network timeout**: AbortController + 10s; aborted requests surface clear error + re-enable Confirm.
  - **provider_fallback hint explains why**: hint text now spells out "browser has already received partial output" reasoning.
  - **Extraction-log client-side filter**: "Only failures" toggles filter in-memory instead of re-fetching.
  - **References-fallback regex more permissive**: accepts case variations, bullet/symbol prefix, section-number prefix, trailing period/colon, "Literature Cited" / "Works Cited" / "Bibliography". Keeps header-anchoring.
  - **Coherence warning drill-down**: paper_id rendered as link to `#/stage4` with localStorage hint.
  - **relevance_to_topic in v2** (`server/lib/extractors/topic_relevance.mjs`): cosine of paper (title+abstract) to topic.md (title+description). Thresholds: ≥0.55 core, ≥0.40 important, else peripheral. User edits skip the extractor on re-run.
  - **Expected-vs-actual surface**: `GET /api/v2/target-progress` returns included / target / minimum. Conveyor renders "N included · target T · X short" widget colored by progress.
  - **Topic.md category validation**: `GET /api/v2/category-validation` flags categories in DB but not in topic.md (typos) + categories declared but unused.
  - **Dismissed content preservation**: dismissed_candidates table gained `content_json` column (schema v2 → v3 with idempotent migration). Dismiss endpoint accepts a `content` snapshot. Restore UI shows the original under a details panel.
  - **Catalogue chapter reordering**: `/api/v2/catalogue?order=by_count|alpha|topic_order` — topic_order matches the order in topic.md categories.

**38 v2 routes total**. Schema bumped to v3 with idempotent migration. All edited files pass `node --check`.

M2 deliverables:

- [x] **M2.1 — NLI + NER wrappers**. `server/lib/nli.mjs` (Xenova/distilbart-mnli-12-3, classify + verifyEntailment). `server/lib/ner.mjs` (Xenova/bert-base-NER, extractNamedThings). Lazy-loaded; models cache to ~/.cache/huggingface/ on first use (~140MB + ~110MB).
- [x] **M2.2 — Seed vocabularies**. `data/_vocab/{tech_stack,datasets,frameworks,metrics}.json` (95 / 75 / 53 / 55 entries). Entity-resolution version-suffix regex tightened to preserve digit-distinguished names (MIMIC-III vs IV, F1 vs F2, CIFAR-10 vs 100, Llama-2 vs 3, GPT-3 vs 4).
- [x] **M2.3 — Boolean signals** (`server/lib/extractors/bool_signals.mjs`). All five flags: regex candidates → NLI entailment verify → write `paper_field` row (true or false with provenance). Near-miss tracking so the student sees the reason for false (not just "absent").
- [x] **M2.4 — Categorical enums** (`extractors/categorical.mjs`). methodology_type / system_domain / sample_type via zero-shot NLI classify. Records full label distribution + margin check; low-confidence cases get `value: 'unknown'` rather than guessing.
- [x] **M2.5 — Named entities** (`extractors/named_entities.mjs`). tech_stack / datasets_used / frameworks_cited via NER + entity-resolution canonicalisation. Novel entities get NLI-verified before being added to vocab. Dirty vocabs persisted back to JSON via `saveDirtyVocabs()`.
- [x] **M2.6 — Numerical** (`extractors/numerical.mjs`). sample_size (largest plausible number that NLI confirms as "the paper's own study N"). results (multi-row: metric × value × dataset × split, NLI verifies "own result" vs cited prior work; dataset attached from same-sentence dataset names already in `name_usage`).
- [x] **M2.7 — Orchestrator** (`server/lib/extract_orchestrator.mjs`). `extractForPaper(paperId)` runs steps in dependency order (ingest → bool → categorical → named → numerical), flushes DB. `extractCorpus()` iterates over all include/maybe papers and persists vocab additions between papers. Re-runs idempotent.

After M3 ships, Stage 1 is complete and we move to M4 (Stage 2 detectors as pure SQL/JS over the populated tables).

M1 deliverables (for context):

M1 deliverables (for context):

1. [x] **M1.1 — SQLite store**. `sql.js@^1.14.1` dep. `server/lib/schema.sql` (15 tables, 19 indexes, FK constraints, provenance referenced from every populated field). `server/lib/store.mjs` (`init / query / exec / run / transaction / recordProvenance / flush / close`). Debounced flush-to-disk (500ms). FK enforcement on. Smoke-tested.
2. [x] **M1.2 — Vector index DROPPED**. USearch's npm package uses native N-API bindings; conflicts with the install promise. At thesis-to-landscape scale (≤100k chunks), the existing `sbert_utils.semanticSearch` brute-force linear scan is fast enough. Existing `_vectors/*.jsonl` format stays. Revisit at ~500k vectors.
3. [x] **M1.3 — Pure-JS BM25 index** (`server/lib/bm25.mjs`). Tokenizer + `BM25Index` class with add/remove/clear/search/toJSON/fromJSON. Smoke-tested: exact technical-term ranking (MIMIC-III, BERT), JSON round-trip, 5000-doc search in 3ms.
4. [x] **M1.4 — Hybrid retrieval + RRF + cross-encoder reranker** (`server/lib/hybrid_retrieval.mjs` + `server/lib/reranker.mjs`). RRF combines BM25 and dense rankings without score normalisation; reranker lazily loads `Xenova/ms-marco-MiniLM-L-6-v2` (~80MB) for final precision pass. Smoke-tested without loading the reranker model (it downloads on first call).
5. [x] **M1.5 — Entity resolution** (`server/lib/entity_resolution.mjs`). Four-pass `canonicalise()`: normalize → alias → edit-distance (Damerau-Levenshtein) → optional embedding cosine. Smoke-tested: exact / alias / fuzzy / version-stripped all resolve correctly; unknown returns `low_confidence`; `canonicaliseOrAdd` adds new entries; round-trip via toObject/loadFromObject.
6. [x] **M1.6 — MinHash + Jaccard near-duplicate dedup** (`server/lib/dedup_minhash.mjs`). 3-word shingles, 128 hash functions, seeded for reproducibility. `NearDuplicateDetector` with `add / remove / findDuplicates / pairs`. Threshold guide documented (≥0.7 obvious dup, 0.4-0.7 preprint↔journal versions, <0.2 independent). Smoke-tested.
7. [x] **M1.7 — Ingestion bridge** (`server/lib/ingest.mjs`). `syncPapersFromCsv` upserts `candidates_triaged.csv` → `papers` + `paper_authors`. `ingestChunksForPaper(id)` runs `pdf_chunks` → `chunks` table + `section_classifier` → `chunk_section`. `syncSnowballCitations` mirrors snowball edges → `citations`. All idempotent, all transactional. Empty-project smoke-tested.

Foundation layer is complete. M1 created `server/lib/{schema.sql, store.mjs, bm25.mjs, hybrid_retrieval.mjs, reranker.mjs, entity_resolution.mjs, dedup_minhash.mjs, ingest.mjs}` and added `sql.js` to package.json. Live SQLite file at `project/data/store.sqlite` with the full empty schema.

User decided (2026-05-12): do all of M1 in order — no splitting into M1a/M1b. Rigor and engineering cleanliness justify the foundational work even at thesis scale, and the broader research-domain repositioning makes scale-readiness worth having from day one.

**Test discipline**: each M1 sub-step ends in a syntax check + a smoke test. Don't commit until the user confirms it works in the browser.

---

## What this tool actually is (repositioning, 2026-05-12)

A **structured gap-report-over-a-research-domain analysis tool**, not just a thesis aid. The technical core (per-paper structured extraction → typed gap detection over a corpus tensor → citation network + KG → grounded output) serves anyone positioning new work against prior literature:

- **Thesis student** — literature-review chapter, positioning statement, PRISMA flow, indicator scorecard.
- **Paper author** — related-work section, "what's been done / what's missing", positioning paragraph.
- **Postdoc / PI** — grant-proposal gap argument, research-direction recommendation.
- **Review-paper author** — comprehensive landscape + synthesised gap report.
- **R&D lead** — tech-stack / dataset / method inventory + academic-vs-industry mismatch + emerging trends.
- **Funding analyst, science journalist, etc.** — research-domain state-of-the-art.

The same Stage 1 + Stage 2 pipeline produces the artefacts for each user; they pick an **output mode** at Stage 7 that determines which deliverables get rendered.

## Architecture (final)

```
┌─────────────────────────────────────────────────────────────────────┐
│  FOUNDATION LAYER                                                   │
│  ───────────────                                                     │
│  • SQLite (sql.js, WASM)  — relational + graph (recursive CTEs)    │
│  • USearch (WASM)         — indexed dense nearest-neighbour         │
│  • BM25 (pure JS)         — sparse retrieval, paired with USearch  │
│  • RRF combiner           — fuses sparse + dense rankings           │
│  • Cross-encoder rerank   — Xenova/ms-marco-MiniLM (precision pass) │
│  • Entity resolution      — canonicalise names across the corpus    │
│  • MinHash + LSH dedup    — catches near-duplicate papers           │
│  • Section classifier     — tier-1 heading + tier-2 cosine (DONE)   │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│  STAGE 1 — per-paper structured extraction                          │
│  ────────────────────────────────────────                            │
│  Inputs:  PDF chunks (existing) + topic.md + section_index          │
│  Mechanisms (allowed, in preference order):                          │
│    1. Regex (deterministic)                                          │
│    2. NER (Xenova/bert-base-NER)                                     │
│    3. Zero-shot NLI (Xenova/distilbart-mnli-12-3)                    │
│    4. Cosine to label prototypes (Xenova/bge-small-en-v1.5)         │
│    5. LLM-as-finder (WebLLM, claims only, substring-validated)       │
│  Output: structured record per paper with full provenance per field │
│          → written into SQLite tables                                │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│  STAGE 2 — gap detection + cross-paper analysis (PURE SQL/JS)      │
│  ────────────────────────────────────────                            │
│  No LLM, no model inference. Deterministic tensor algebra +         │
│  SQL queries over the per-paper records.                             │
│                                                                      │
│  7 typed gap detectors:                                              │
│    1. Evidence       — variance on (metric, dataset); stance pairs  │
│    2. Knowledge      — coverage-tensor sparsity + topic-cluster     │
│    3. Practical      — methodology_type cross-tab + claim mismatch  │
│    4. Methodological — (category × method) cell counts              │
│    5. Empirical      — stance ratio per topic cluster               │
│    6. Theoretical    — orphan / disputed framework clusters         │
│    7. Population     — population sub-tensor sparsity                │
│                                                                      │
│  Cross-paper network layer:                                          │
│    • Citation centrality (PageRank, recursive CTE)                   │
│    • Main Path Analysis (most-traversed citation chain)              │
│    • Co-citation + bibliographic coupling                            │
│    • Citation context classification (support / contrast / extend)   │
│    • Co-author / institution network                                 │
│                                                                      │
│  Bibliometric + temporal layer:                                      │
│    • Year-by-year trend analysis (topic × time)                      │
│    • LOF novelty outliers                                            │
│    • N-gram novelty signals                                          │
│    • Citation-weighted gap salience                                  │
│                                                                      │
│  Interactive query layer:                                            │
│    • Structured query interface (SQL over the records)               │
│    • Hypothesis-verification surface                                 │
│    • Recommendation surface (shortlist → suggested additions)        │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│  STAGE 7 — output modes (rendered from the same Stage 2 records)    │
│  ──────────────────────────                                          │
│  • Thesis mode   — PRISMA + positioning + catalogue + scorecard      │
│  • Paper mode    — related-work table + gap candidates + paragraph   │
│  • Grant mode    — gap report + bibliometric impact + directions     │
│  • Landscape mode — inventory + trends + comparisons                 │
│  • Custom        — query + drill-down only                           │
└─────────────────────────────────────────────────────────────────────┘
```

## Principles (load-bearing)

1. **Grounded in truth.** Every populated field carries provenance (mechanism, source chunk, page, raw quote, classifier score). FK-enforced in SQLite. A field with no provenance is invalid.
2. **No LLM in detection.** Stage 2 is pure SQL/JS. Same records → same matrix. Always. No hallucination compounding.
3. **No fabrication possible by construction.** LLM-as-finder outputs are validated as substrings of source chunks; classifier outputs are bounded to enums or substrings.
4. **No regex-only acceptance.** Every regex candidate is verified by NLI before becoming a field value.
5. **Per-field section routing.** Each field declares eligible PDF sections; the extractor only sees those chunks.
6. **Smart-first.** Anchor queries + negative anchors + cross-field consistency filter candidates before any mechanism runs.
7. **Hybrid retrieval default.** BM25 + dense + RRF for any "find relevant content" operation. Cross-encoder rerank when precision matters.
8. **Local-only, no commercial API.** All models via `@huggingface/transformers` (Node) or WebLLM (browser). Provider switch sacred for any optional LLM use.
9. **Drill-down end-to-end.** Every Stage 2 candidate → contributing papers → per-paper record → provenance → verbatim source. No black-box at any layer.

## Technology stack (final picks)

| Layer | Pick | Why |
|---|---|---|
| Relational + graph DB | `sql.js` (SQLite WASM) | 1MB WASM, mature, recursive CTEs handle every graph query we need |
| Vector DB | `usearch` (WASM) | 500KB WASM, indexed HNSW, sub-ms queries at 100k+ vectors |
| Sparse retrieval | Pure JS BM25 (~100 lines) | Defacto SOTA for keyword precision; complements dense retrieval |
| Embedder | `Xenova/bge-small-en-v1.5` (already used) | 130MB, fast, L2-normalised, proven for the project |
| Cross-encoder reranker | `Xenova/ms-marco-MiniLM-L-6-v2` | ~80MB, dramatic precision win (MRR +40% in benchmarks) |
| NER | `Xenova/bert-base-NER` or scibert variant | Token classification for ORG/MISC entity spans |
| NLI / zero-shot classifier | `Xenova/distilbart-mnli-12-3` | 140MB, multi-label classification for booleans + enums |
| LLM-as-finder | WebLLM (browser-side, 3B local) | Constrained to find-and-quote; substring-validated output |
| Score fusion | RRF (parameter-free) | Combines sparse + dense rankings without score normalisation |
| Entity resolution | Pure JS (normalise + cosine + edit distance) | Three-dim model: record linkage, disambiguation, canonicalisation |
| Near-duplicate detection | MinHash + LSH (pure JS) | Catches preprint↔journal duplicates the DOI dedup misses |
| sbert utilities | Existing `server/lib/sbert_utils.mjs` | Already has semanticSearch, communityDetection, paraphraseMining, etc. |

**Banned:** TF-IDF, LDA, LSA, HDBSCAN, k-means (per `feedback_no_legacy_stats.md`). Embedding-native equivalents always win.

## Working targets (milestones)

Each milestone is a discrete, testable chunk that ends in a commit. You test between each.

### M0 — Section classifier + provenance schema (DONE, uncommitted)

Shipped 2026-05-12. `server/lib/section_classifier.mjs` with tier-1 heading-pattern + tier-2 cosine-to-prototype. `notes.mjs` extended with `schema_version: 2` + `emptyExtracted()` skeleton + `normalizeExtracted` for v1→v2 read + provenance validator. v1 notes still pass through unchanged.

**Done when:** (already done; awaiting your test before commit)

### M1 — Foundation layer (storage + retrieval + entity resolution + dedup)

The biggest piece. Lays the rails for everything else.

**Files to add:**
- `server/lib/store.mjs` — SQLite schema, migrations, query helpers
- `server/lib/sbert_utils.mjs` — extend with proper `semanticSearchUSearch` (USearch wrapper)
- `server/lib/bm25.mjs` — pure-JS BM25 index
- `server/lib/hybrid_retrieval.mjs` — BM25 + dense + RRF combiner
- `server/lib/reranker.mjs` — cross-encoder wrapper
- `server/lib/entity_resolution.mjs` — canonical name normalisation
- `server/lib/dedup_minhash.mjs` — MinHash + LSH near-duplicate detector

**Files to migrate:**
- `server/lib/vectors.mjs` — switch from JSONL/Float32Array to USearch indices
- `server/lib/triage.mjs` — read/write through SQLite instead of CSV (CSV stays as the export format)
- `server/lib/notes.mjs` — `extracted.*` writes go to SQLite tables, body markdown remains source of truth for quoted spans

**SQLite schema (concrete):**
```sql
papers(paper_id PK, title, year, venue, doi, arxiv_id, url, pdf_path, schema_version, ...)
paper_authors(paper_id, author_name, position)
paper_category(paper_id, category)
paper_field(paper_id, field_name, field_value)  -- generic for methodology_type etc.
chunks(chunk_id PK, paper_id, section, page_first, page_last, text)
chunk_section(chunk_id PK, label, mechanism, score)
canonical_names(canonical PK, kind)              -- kind: dataset | tech | framework | metric
name_usage(paper_id, canonical, raw, role, page, mechanism, score)
results(result_id PK, paper_id, metric, value, dataset, split, mechanism, page)
claims(claim_id PK, paper_id, text, page, stance, claim_type, chunk_id, mechanism)
quoted_spans(span_id PK, paper_id, section, text, page, chunk_id, mechanism)
citations(from_paper, to_paper, source, context_class)  -- support|contrast|extend|background
provenance(prov_id PK, ref_kind, ref_id, mechanism, model, raw_text, page,
           classifier_scores_json, confidence)
```

**Done when:**
- A fresh project initialises an empty SQLite DB at `project/data/store.sqlite` and USearch indices at `project/data/_vectors/*.usearch`.
- All existing read/write paths go through `store.mjs`; CSV is export-only.
- BM25 + USearch + cross-encoder + RRF combine into one `hybridSearch(query, opts)` function with rerank toggle.
- Entity resolver canonicalises a sample of inputs correctly (test cases for dataset / tech / framework variants).
- MinHash dedup catches a synthetic near-duplicate pair in a test case.

**Scale:** ~1000-1500 lines across 7 files. Multiple sessions.

### M2 — Per-field extractors (Stage 1, deterministic and classifier paths)

Builds on M1's foundation. Every field gets a candidate generator + NLI verifier. No LLM yet (claims wait for M3).

**Files to add:**
- `server/lib/ner.mjs` — NER pipeline wrapper
- `server/lib/nli.mjs` — zero-shot NLI pipeline wrapper
- `server/lib/extractors/<field>.mjs` — one per field, sharing the candidate→verify shape:
  - `methodology_type.mjs`, `population.mjs`, `tech_stack.mjs`, `datasets_used.mjs`, `frameworks_cited.mjs`, `sample_size.mjs`, `results.mjs`, `bool_signals.mjs` (claims_first_in_area / challenges_existing / baseline_compared / releases_code / reports_uncertainty)
- `server/lib/extract_orchestrator.mjs` — runs all field extractors for a paper, writes to SQLite
- `data/_vocab/datasets.json`, `data/_vocab/tech_stack.json`, `data/_vocab/frameworks.json`, `data/_vocab/metrics.json` — seed canonical vocabularies

**Done when:**
- Running `extractForPaper(paper_id)` populates all M2 fields with full provenance, written to SQLite.
- A test paper produces sane values for ≥80% of the eligible fields.
- Provenance subtree carries: mechanism, source chunk_id, page, raw text, classifier score distribution.
- Wrong-section extraction is empirically demonstrated to be rare (section routing works).

**Scale:** ~2000 lines across ~15 files. Multiple sessions. Should be the biggest milestone.

### M3 — Claims extractor (LLM-as-finder via WebLLM)

The only LLM-using step. Bounded to find-and-quote on the eligible-sections-for-the-claim-type. Substring validator rejects fabricated quotes.

**Files to add:**
- `server/lib/extractors/claims.mjs` — invokes WebLLM (browser side) with 3-5 targeted questions per paper
- `public/lib/llm_finder.mjs` — browser-side WebLLM wrapper for the claims pipeline
- New endpoint `POST /api/notes/:id/extract-claims` that hand-offs to the browser-side LLM

**Done when:**
- For each paper, 3-10 claim quotes extracted, each validated as substring of a source chunk.
- Each claim has stance (NLI-classified) + claim_type + page + chunk_id + topic_embedding.
- All claims persist to SQLite `claims` table with provenance.

**Scale:** ~500 lines. One session.

### M4 — Stage 2 gap detectors + cross-paper analysis (pure SQL/JS)

The novel contribution. Every detector is a pure function over the SQLite records.

**Files to add:**
- `server/lib/detectors/<type>.mjs` — one per gap type (evidence, knowledge, practical, methodological, empirical, theoretical, population)
- `server/lib/detectors/citation_centrality.mjs` — PageRank-style via recursive CTE
- `server/lib/detectors/main_path.mjs` — Main Path Analysis (most-traversed citation chain)
- `server/lib/detectors/co_citation.mjs` + `bibliographic_coupling.mjs`
- `server/lib/detectors/citation_context.mjs` — classifies each citation edge as support/contrast/extend/background (one NLI call per citation, server-side)
- `server/lib/detectors/temporal_trends.mjs` — year-by-year topic × method aggregates
- `server/lib/detectors/lof_novelty.mjs` — Local Outlier Factor over claim embeddings
- `server/lib/detectors/ngram_novelty.mjs` — n-gram rarity signal
- `server/lib/detectors/bibliometric_weight.mjs` — citation-count-weighted gap salience
- `server/lib/query.mjs` — structured query interface (parses a typed query, runs SQL + hybrid search)
- `server/lib/recommend.mjs` — recommendation surface (shortlist → suggested additions)

**Done when:**
- Each detector returns a ranked candidate list with: statistic, contributing_paper_ids, drill-down references.
- A debug page shows all detectors' outputs for a given corpus.
- Citation centrality + MPA produce sensible rankings on a test corpus.
- Structured query interface accepts e.g. `dataset:"MIMIC-III" AND method_family:"deep_learning" AND results.F1 > 0.8` and returns matching papers.
- Recommendation surface returns 3-5 not-yet-included papers similar to a shortlist.

**Scale:** ~2500 lines across ~12 files. Multiple sessions.

### M5 — Form rewrite + output modes (Stage 4 + Stage 7)

The UI catches up to the new data model. Drop v1 cruft; build the new form; introduce output modes.

**Files to rewrite:**
- `public/views/stage4.mjs` — drop prose body editors; add structured-field editor with provenance hovers; per-field "re-extract" buttons; table-aware textareas for body sections (markdown is source of truth)
- `public/views/stage5.mjs` — replace with gap detector dashboards + corpus index (tabular browser over canonical_names + papers)
- `public/views/stage7.mjs` — output mode selector at top; per-mode rendering of artefacts:
  - Thesis mode (current): PRISMA + positioning + catalogue + scorecard
  - Paper mode: related-work table + gap candidates + positioning paragraph
  - Grant mode: gap report + bibliometric impact + funding directions
  - Landscape mode: inventory + trends + comparisons
  - Custom: just the query interface + gap drill-down

**Files to clean up:**
- `server/lib/notes.mjs` — drop v1 legacy fields (`ground_truth.*`, `evaluation.*`, `claims.primary_contribution`, `claims.novelty_strength`, `limitations_authors_state`, `quality_flags.*`, `method.specific`, `method.inputs`); drop hand-rolled YAML serialiser; drop 400-word body validator
- `server/lib/note_drafter.mjs` — delete (replaced by extractors); preserve only the parts the other code still imports
- `public/views/stage4.mjs` — drop all references to dropped v1 fields

**README + framing sweep:**
- Drop "thesis" / "MSc" / "BSc" / "student" wording; use "researcher" / "review focus" / "research scope"
- Update `server/templates.mjs` topic.md template to be use-case neutral
- README "What you get" section reframed around output modes

**Done when:**
- Old prose drafter is gone; form is structured-data-only.
- An existing paper's note opens, shows tables of quoted spans + structured fields + provenance, edits cleanly.
- Stage 7 output mode picker switches deliverables.
- README reads like a research-domain tool, not a thesis aid.

**Scale:** ~1500-2000 lines of UI + ~500 lines of cleanup. Multiple sessions.

### M6 — Polish + naming sweep + optional visualisations

Once the system works end-to-end:

- Force-directed knowledge graph view (Phase 3+ in old plan) — if and only if the tabular browser proves limiting.
- Project rename (if the user wants — `corpuscope` / `gapatlas` / `domainscope` / `recall`).
- Test corpus walkthrough documented.
- Performance tuning (M2's per-paper extraction is the big cost; profile and parallelise).

**Done when:** the app does what this document claims, end-to-end, on a real corpus.

## Conveyor rebuild (PAUSED at Phase A)

The conveyor work shipped Phase A (uncommitted) and was about to do Phases B/C. Paused because the structured-data pivot replaces the drafter the conveyor invokes. After M5 (form rewrite), the conveyor's "Draft N notes" action becomes "Extract N papers" — same shape, different work — and Phases B/C can resume cleanly.

Memory: `project_conveyor_rebuild.md` for the design context; resume after M5.

## External corpus comparison (Phase 6.d, in scope as Landscape-mode feature)

Pull a same-topic OpenAlex sample, embed centroids, compare against the student's corpus. **Now folds into M5 Landscape mode as one of its outputs.** No separate phase needed.

## Project export / import

ZIP the whole `project/` directory for archiving or handoff to a collaborator. Counterpart: import a ZIP into a fresh install. Lower priority; ship after M6.

## Cross-cutting loose ends (orthogonal to the pivot)

- [x] **Provider robustness** — retry + human-readable errors landed in M5.f. Full fallback-chain across providers (auto-fail-over mid-batch) remains for M6.
- [x] **Embed daemon visibility** — rail-embed-badge landed in M5.f.
- [x] **External corpus comparison** — landed in M5.f as Landscape-mode feature.
- [x] **Project export / import** — landed in M5.f.
- [~] **Stage 7 "Step 1 done" banner** — moot for v2 Stage 7 (output-mode selector replaces the section-by-section flow). Leave for legacy view only.
- [x] **Drafter critic ↔ cross-paper comparison** — moot now; drafter is gone in v2. Dropped.

## Dropped

- **Phase 9 — Conversational layer** (dropped 2026-05-11): chat-over-corpus and supervisor-sim. Can be re-added later if static deliverables prove insufficient.
- **VOSviewer-style force-directed visualisation as a primary feature.** Demoted to optional M6 add-on. The 7 typed detectors + tabular corpus index serve the actual user need better.
- **BERTopic / HDBSCAN topic modelling.** Banned by feedback rule; we use `community_detection` instead.
- **LDA / LSA / TF-IDF.** Pre-embedding-era; embeddings replace cleanly.
- **CLI template compatibility.** User accepts breaking the shared schema with `thesis-litreview-template` for this pivot; CLI can adopt the new schema later if at all.

## Recently shipped (for context)

- 2026-05-12 — **Section classifier + provenance schema** (uncommitted). `server/lib/section_classifier.mjs` + `notes.mjs` schema extensions. M0 complete.
- 2026-05-12 — **Conveyor rail + side fix for listEligible/getNote divergence** (uncommitted). New `components/stage_rail.mjs` + `getNote`/`listEligible` share `applyInMemoryDefaults` helper.
- 2026-05-12 — **Paper identification + validation fixes** (commit `e7bfaf2`): dedup field-merge, OpenAlex DOI enrichment, arXiv venue default, relaxed venue validation + DOI/arxiv_id/url requirement, deterministic novelty_strength heuristic, fixed split-brain `relevance_to_the_thesis_topic` key so the auto-template body actually persists, `getNote` + `listEligible` apply same in-memory backfill.
- 2026-05-11 — Catalogue grounding, drafter→critic→reviser, closed-loop remediation + signal expansions, audit-toggle UX consolidation, cross-paper context, Stage 5/7 restructure, quote grounding, method × novelty lattice, PRISMA flow standalone, indicator-assessment scorecard, positioning-statement artifact UI.
- Earlier — Snowballing, gap detection v1, sectioned RAG drafter, embedding/regex frontmatter extraction.
