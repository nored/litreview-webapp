-- schema.sql
--
-- SQLite schema for the structured-data store. Tables are versioned via
-- `schema_meta`. All CREATE statements are idempotent so the file can be
-- re-applied on startup as a low-friction migration step.
--
-- Conventions:
--   * Text-based primary keys for natural ids (paper_id, chunk_id, canonical).
--   * INTEGER auto-increment primary keys for synthetic rows (claims,
--     results, citations, provenance, etc.).
--   * Every populated structured field has a provenance row reachable via
--     a provenance_id column; this is the "every datapoint is explainable"
--     contract enforced at the schema level.
--   * Foreign keys are declared but enforcement requires
--     `PRAGMA foreign_keys = ON;` at connection time (store.mjs does this).
--   * Provenance is created first so other tables can reference it.

-- ─────────────────────────────────────────────────────────────────────────
-- Metadata
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────
-- Provenance: keyed by a synthetic id, referenced from every populated
-- structured field via the *_id columns on other tables.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS provenance (
  prov_id                INTEGER PRIMARY KEY AUTOINCREMENT,
  mechanism              TEXT NOT NULL,            -- 'regex' | 'nli_zero_shot' | 'ner_canonical' | 'llm_finder' | 'heading_pattern' | 'cosine_prototype' | ...
  model                  TEXT,                     -- 'Xenova/distilbert-base-uncased-mnli' | 'Xenova/bge-small-en-v1.5' | ...
  pattern                TEXT,                     -- regex source when mechanism='regex'
  chunk_id               TEXT,                     -- source chunk (FK to chunks.chunk_id; not enforced until chunk exists)
  page                   INTEGER,
  raw_text               TEXT,                     -- verbatim span; must be substring of chunk.text for LLM mechanisms
  classifier_scores_json TEXT,                     -- per-label score distribution as JSON
  confidence             REAL,                     -- chosen value's score
  llm_prompt             TEXT,                     -- mechanism='llm_finder'
  llm_response           TEXT,                     -- mechanism='llm_finder'
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────
-- Papers: the canonical record per paper
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS papers (
  paper_id        TEXT PRIMARY KEY,                -- '001', '002', ...
  title           TEXT NOT NULL,
  year            INTEGER,
  venue           TEXT,
  doi             TEXT,
  arxiv_id        TEXT,
  url             TEXT,
  pdf_path        TEXT,
  abstract        TEXT,
  read_date       TEXT,
  triage_label    TEXT,                             -- 'include' | 'exclude' | 'maybe' | 'pending'
  triage_reason   TEXT,
  source_database TEXT,                             -- 'arxiv' | 'openalex' | 'semantic_scholar' | 'arxiv+openalex' | ...
  schema_version  INTEGER NOT NULL DEFAULT 2,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_papers_doi      ON papers(doi)         WHERE doi      IS NOT NULL AND doi      <> '';
CREATE INDEX IF NOT EXISTS idx_papers_arxiv    ON papers(arxiv_id)    WHERE arxiv_id IS NOT NULL AND arxiv_id <> '';
CREATE INDEX IF NOT EXISTS idx_papers_year     ON papers(year);
CREATE INDEX IF NOT EXISTS idx_papers_triage   ON papers(triage_label);

-- Authors (ordered, many-to-many with papers)
CREATE TABLE IF NOT EXISTS paper_authors (
  paper_id    TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  position    INTEGER NOT NULL,                     -- 1 = first author
  PRIMARY KEY (paper_id, position)
);
CREATE INDEX IF NOT EXISTS idx_authors_name ON paper_authors(author_name);

-- Topic-defined categories per paper (many-to-many)
CREATE TABLE IF NOT EXISTS paper_category (
  paper_id TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  PRIMARY KEY (paper_id, category)
);
CREATE INDEX IF NOT EXISTS idx_paper_category ON paper_category(category);

-- Generic key-value table for structured scalar fields with provenance.
-- Used for: methodology_type, system_domain, sample_type, sample_size,
-- claims_first_in_area, challenges_existing, baseline_compared,
-- releases_code, reports_uncertainty, method_family, ...
-- Each row carries its own provenance reference.
CREATE TABLE IF NOT EXISTS paper_field (
  paper_id      TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  field_name    TEXT NOT NULL,                      -- 'methodology_type' | 'method_family' | ...
  field_value   TEXT NOT NULL,                      -- always stored as text; cast on read by type column
  field_type    TEXT NOT NULL,                      -- 'enum' | 'number' | 'bool' | 'string'
  provenance_id INTEGER REFERENCES provenance(prov_id),
  PRIMARY KEY (paper_id, field_name)
);

-- Population dimensions (multi-valued: language, geography)
CREATE TABLE IF NOT EXISTS paper_population (
  paper_id      TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  dimension     TEXT NOT NULL,                      -- 'language' | 'geography' | 'time_period_start' | 'time_period_end'
  value         TEXT NOT NULL,
  provenance_id INTEGER REFERENCES provenance(prov_id),
  PRIMARY KEY (paper_id, dimension, value)
);

-- ─────────────────────────────────────────────────────────────────────────
-- Chunks: PDF chunks as produced by pdf_chunks.mjs
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id    TEXT PRIMARY KEY,                     -- 'paper_id:NNN'
  paper_id    TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  raw_section TEXT,                                  -- slugified verbatim heading from pdf_chunks
  page_first  INTEGER,
  page_last   INTEGER,
  chunk_idx   INTEGER NOT NULL,
  text        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(paper_id);

-- Section classification (one row per chunk, from section_classifier.mjs)
CREATE TABLE IF NOT EXISTS chunk_section (
  chunk_id          TEXT PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  label             TEXT NOT NULL,                   -- canonical section label
  mechanism         TEXT NOT NULL,                   -- 'heading_pattern' | 'cosine_prototype'
  score             REAL NOT NULL,
  distribution_json TEXT                              -- per-label scores when mechanism='cosine_prototype'
);
CREATE INDEX IF NOT EXISTS idx_chunk_section_label ON chunk_section(label);

-- ─────────────────────────────────────────────────────────────────────────
-- Canonical names (datasets / tech / frameworks / metrics) — deduped vocab
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS canonical_names (
  canonical       TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,                     -- 'dataset' | 'tech' | 'framework' | 'metric'
  preferred_label TEXT,                              -- display form (canonical may be a slug; preferred_label is human-friendly)
  aliases_json    TEXT,                              -- JSON array of known variant spellings
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_canon_kind ON canonical_names(kind);

-- Per-paper usage of canonical names
CREATE TABLE IF NOT EXISTS name_usage (
  usage_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id      TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  canonical     TEXT NOT NULL REFERENCES canonical_names(canonical),
  kind          TEXT NOT NULL,                      -- duplicated for index speed
  raw           TEXT,                                -- verbatim form found in the paper
  role          TEXT,                                -- datasets: 'training'|'validation'|'test'|'other'; null for others
  n             INTEGER,                             -- dataset sample size if known
  page          INTEGER,
  mechanism     TEXT,
  score         REAL,
  provenance_id INTEGER REFERENCES provenance(prov_id)
);
CREATE INDEX IF NOT EXISTS idx_name_usage_paper     ON name_usage(paper_id);
CREATE INDEX IF NOT EXISTS idx_name_usage_canonical ON name_usage(canonical);
CREATE INDEX IF NOT EXISTS idx_name_usage_kind      ON name_usage(kind);

-- ─────────────────────────────────────────────────────────────────────────
-- Numerical results
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS results (
  result_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id      TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  metric        TEXT NOT NULL,                       -- 'F1' | 'AUROC' | 'MAE' | ...
  value         REAL NOT NULL,
  dataset       TEXT,                                -- canonical dataset name when known
  split         TEXT,                                -- 'train' | 'val' | 'test'
  page          INTEGER,
  mechanism     TEXT,
  raw_text      TEXT,                                -- e.g. "F1 = 0.84 on MIMIC-III test split"
  provenance_id INTEGER REFERENCES provenance(prov_id)
);
CREATE INDEX IF NOT EXISTS idx_results_paper          ON results(paper_id);
CREATE INDEX IF NOT EXISTS idx_results_metric_dataset ON results(metric, dataset);

-- ─────────────────────────────────────────────────────────────────────────
-- Claims (one row per salient quote-and-stance triple)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS claims (
  claim_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id      TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  page          INTEGER,
  stance        TEXT,                                -- 'asserts' | 'validates' | 'theorises' | 'challenges' | 'extends'
  claim_type    TEXT,                                -- 'finding' | 'method' | 'limitation' | 'future_work' | 'framework' | 'contribution'
  chunk_id      TEXT REFERENCES chunks(chunk_id),
  mechanism     TEXT,
  -- topic_embedding lives in USearch keyed by claim_id; not stored here.
  provenance_id INTEGER REFERENCES provenance(prov_id)
);
CREATE INDEX IF NOT EXISTS idx_claims_paper  ON claims(paper_id);
CREATE INDEX IF NOT EXISTS idx_claims_stance ON claims(stance);

-- ─────────────────────────────────────────────────────────────────────────
-- Quoted spans per body section (mirrored from markdown on save)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quoted_spans (
  span_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id      TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  section       TEXT NOT NULL,                       -- 'problem_statement' | 'method_summary' | ...
  position      INTEGER NOT NULL,                    -- order within the section
  text          TEXT NOT NULL,
  page          INTEGER,
  chunk_id      TEXT REFERENCES chunks(chunk_id),
  mechanism     TEXT,
  provenance_id INTEGER REFERENCES provenance(prov_id)
);
CREATE INDEX IF NOT EXISTS idx_quoted_paper_section ON quoted_spans(paper_id, section);

-- ─────────────────────────────────────────────────────────────────────────
-- Citation graph (from snowball + OpenAlex). from_paper / to_paper may point
-- to papers outside the corpus — we still record them for downstream
-- analysis (centrality, MPA, etc).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS citations (
  citation_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  from_paper    TEXT NOT NULL,                       -- intentionally NOT a FK: may be out-of-corpus
  to_paper      TEXT NOT NULL,                       -- intentionally NOT a FK: may be out-of-corpus
  source        TEXT,                                -- 'snowball' | 'openalex' | 'crossref' | ...
  context_class TEXT,                                -- 'support' | 'contrast' | 'extend' | 'background' (NLI-classified, optional)
  context_page  INTEGER,
  context_quote TEXT,
  provenance_id INTEGER REFERENCES provenance(prov_id)
);
CREATE INDEX IF NOT EXISTS idx_citations_from ON citations(from_paper);
CREATE INDEX IF NOT EXISTS idx_citations_to   ON citations(to_paper);

-- ─────────────────────────────────────────────────────────────────────────
-- Dismissed detector candidates. The user marks a candidate as
-- "considered & rejected" so it stops surfacing on every detect run.
-- Signature is a deterministic, detector-specific hash of the candidate
-- identity (e.g. "category:method" for methodological gaps).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dismissed_candidates (
  detector_type TEXT NOT NULL,
  signature     TEXT NOT NULL,
  dismissed_at  TEXT,
  reason        TEXT,
  content_json  TEXT,                                -- snapshot of the candidate at dismiss time (for restore-and-review)
  PRIMARY KEY (detector_type, signature)
);
CREATE INDEX IF NOT EXISTS idx_dismissed_by_type ON dismissed_candidates(detector_type);

-- ─────────────────────────────────────────────────────────────────────────
-- v4 — grobid-js structured-parse tables. Populated by ingest_grobid.mjs.
-- The old chunks / chunk_section tables stay for backward compat during
-- Phase 1; downstream code progressively migrates to read from these.
--
-- One section row per <div> in grobid's body. One paragraph row per <p>.
-- One reference row per <biblStruct> in the bibliography. Citation
-- markers in body paragraphs are pre-linked to their reference rows.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sections (
  section_id      TEXT PRIMARY KEY,                  -- '<paper_id>:sec:<idx>'
  paper_id        TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  section_idx     INTEGER NOT NULL,                  -- order within paper
  raw_heading     TEXT,                              -- verbatim heading text from grobid <head>
  level           INTEGER,                           -- 1 = top-level <h1>, 2 = <h2>, etc.
  canonical_type  TEXT,                              -- 'introduction' | 'methods' | 'results' | ... | 'other'
  parent_id       TEXT REFERENCES sections(section_id)
);
CREATE INDEX IF NOT EXISTS idx_sections_paper ON sections(paper_id);
CREATE INDEX IF NOT EXISTS idx_sections_type  ON sections(canonical_type);

CREATE TABLE IF NOT EXISTS paragraphs (
  paragraph_id    TEXT PRIMARY KEY,                  -- '<paper_id>:p:<idx>'
  paper_id        TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  section_id      TEXT REFERENCES sections(section_id) ON DELETE CASCADE,
  paragraph_idx   INTEGER NOT NULL,                  -- order within paper
  canonical_type  TEXT,                              -- inherited from parent section
  text            TEXT NOT NULL,
  page_first      INTEGER,
  page_last       INTEGER,
  bbox_json       TEXT                               -- JSON: per-token bbox spans when teiCoordinates pass'em
);
CREATE INDEX IF NOT EXISTS idx_paragraphs_paper        ON paragraphs(paper_id);
CREATE INDEX IF NOT EXISTS idx_paragraphs_section      ON paragraphs(section_id);
CREATE INDEX IF NOT EXISTS idx_paragraphs_canon_type   ON paragraphs(canonical_type);

-- Reference list parsed by grobid (per-paper biblStruct entries).
-- bib_ref_id is grobid's local id like "b14"; we prefix with paper_id
-- to make it globally unique. parsed_authors_json carries the structured
-- name-citation CRF output when available.
CREATE TABLE IF NOT EXISTS reference_list (
  reference_id        TEXT PRIMARY KEY,              -- '<paper_id>:ref:<bib_ref_id>'
  paper_id            TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  bib_ref_id          TEXT NOT NULL,                 -- grobid local id, e.g. "b14"
  ref_label           TEXT,                          -- "[14]", "14.", or empty for author-year
  authors_raw         TEXT,
  parsed_authors_json TEXT,
  title               TEXT,
  date_raw            TEXT,
  date_year           INTEGER,
  date_month          INTEGER,
  date_day            INTEGER,
  journal             TEXT,
  booktitle           TEXT,
  publisher           TEXT,
  pages               TEXT,
  volume              TEXT,
  doi                 TEXT,
  url                 TEXT,
  raw_text            TEXT
);
CREATE INDEX IF NOT EXISTS idx_reflist_paper ON reference_list(paper_id);
CREATE INDEX IF NOT EXISTS idx_reflist_doi   ON reference_list(doi) WHERE doi IS NOT NULL AND doi <> '';

-- Inline citation markers grobid pre-linked to the reference_list. Each
-- row is one occurrence of "[14]" or "(Yarom et al., 2014)" in a
-- paragraph, joined to a reference. context_text is a small window
-- around the marker for stance classification (Phase 2 work).
CREATE TABLE IF NOT EXISTS citation_markers (
  marker_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id        TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  paragraph_id    TEXT NOT NULL REFERENCES paragraphs(paragraph_id) ON DELETE CASCADE,
  reference_id    TEXT REFERENCES reference_list(reference_id),
  surface_text    TEXT NOT NULL,
  marker_idx      INTEGER,                            -- order within paragraph
  page            INTEGER,
  bbox_json       TEXT,
  context_text    TEXT,                               -- ±N chars around marker
  stance          TEXT,                               -- 'support'|'contrast'|'extend'|'background' (Phase 2)
  stance_provenance_id INTEGER REFERENCES provenance(prov_id)
);
CREATE INDEX IF NOT EXISTS idx_cite_marker_paper     ON citation_markers(paper_id);
CREATE INDEX IF NOT EXISTS idx_cite_marker_paragraph ON citation_markers(paragraph_id);
CREATE INDEX IF NOT EXISTS idx_cite_marker_target    ON citation_markers(reference_id);

-- Tables from the body. cells_json is a row-major JSON serialization of
-- the table cells when grobid resolves the structure; if it doesn't,
-- the caption alone is still useful context for numerical-result
-- extraction in Phase 2.
CREATE TABLE IF NOT EXISTS doc_tables (
  doc_table_id    TEXT PRIMARY KEY,                  -- '<paper_id>:tbl:<idx>'
  paper_id        TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  table_idx       INTEGER NOT NULL,
  label           TEXT,                              -- "Table 1"
  caption         TEXT,
  page            INTEGER,
  bbox_json       TEXT,
  cells_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_tables_paper ON doc_tables(paper_id);

CREATE TABLE IF NOT EXISTS doc_figures (
  doc_figure_id   TEXT PRIMARY KEY,                  -- '<paper_id>:fig:<idx>'
  paper_id        TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  figure_idx      INTEGER NOT NULL,
  label           TEXT,                              -- "Figure 3"
  caption         TEXT,
  page            INTEGER,
  bbox_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_figures_paper ON doc_figures(paper_id);

-- ─────────────────────────────────────────────────────────────────────────
-- v5 — Phase 2 extraction outputs. entity_spans replaces the v1 name_usage
-- model for spans grounded in paragraphs. GLiNER's initial label is stored
-- as a HINT only; the authoritative type comes from emergent clustering
-- in Phase 3 (entity_clusters, populated later).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS entity_spans (
  entity_span_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id        TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  paragraph_id    TEXT NOT NULL REFERENCES paragraphs(paragraph_id) ON DELETE CASCADE,
  span_text       TEXT NOT NULL,
  start_offset    INTEGER,
  end_offset      INTEGER,
  gliner_score    REAL,
  gliner_label    TEXT,                              -- initial GLiNER type hint (not authoritative)
  cluster_id      INTEGER,                           -- populated Phase 3 (entity_clusters)
  provenance_id   INTEGER REFERENCES provenance(prov_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_spans_paper     ON entity_spans(paper_id);
CREATE INDEX IF NOT EXISTS idx_entity_spans_paragraph ON entity_spans(paragraph_id);
CREATE INDEX IF NOT EXISTS idx_entity_spans_label     ON entity_spans(gliner_label);

-- ─────────────────────────────────────────────────────────────────────────
-- v6 — emergent cluster tables (Phase 3). One table per cluster KIND so
-- queries stay straightforward. Each cluster carries an auto_label
-- written by per-stage AI (provenance row records mechanism + model +
-- sample texts the AI saw). Member assignment lives on the source row
-- (paper_clusters → papers.paper_cluster_id, claim_clusters →
-- claims.cluster_id, method_clusters → papers.method_cluster_id,
-- entity_clusters → entity_spans.cluster_id already there).
--
-- The 'kind' column on member tables is implicit from which table they
-- live in. NULL cluster_id = outlier (small / singleton community).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS paper_clusters (
  cluster_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  auto_label    TEXT,
  member_count  INTEGER NOT NULL DEFAULT 0,
  centroid_sample_json TEXT,                          -- 3-5 representative title strings the labeller saw
  label_provenance_id INTEGER REFERENCES provenance(prov_id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS claim_clusters (
  cluster_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  auto_label    TEXT,
  member_count  INTEGER NOT NULL DEFAULT 0,
  stance_distribution_json TEXT,                       -- {asserts: 4, validates: 1, theorises: 2, ...}
  claim_type_distribution_json TEXT,                   -- {finding: 3, limitation: 2, ...}
  centroid_sample_json TEXT,
  label_provenance_id INTEGER REFERENCES provenance(prov_id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS method_clusters (
  cluster_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  auto_label    TEXT,
  member_count  INTEGER NOT NULL DEFAULT 0,
  centroid_sample_json TEXT,
  label_provenance_id INTEGER REFERENCES provenance(prov_id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entity_clusters (
  cluster_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  auto_label    TEXT,
  member_count  INTEGER NOT NULL DEFAULT 0,
  gliner_label_distribution_json TEXT,                 -- how the per-cluster hint distribution looked
  centroid_sample_json TEXT,
  label_provenance_id INTEGER REFERENCES provenance(prov_id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────
-- Initial schema version stamp. Migrations on top of this advance the
-- value; store.mjs runs migrations idempotently on startup.
-- ─────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '6');
