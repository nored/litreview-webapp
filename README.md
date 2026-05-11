# Literature Review Web App

Local-first web app for running an MSc/BSc thesis literature review pipeline. Companion to the [CLI template](https://github.com/nored/thesis-litreview-template); the on-disk artifact format is identical so you can switch between the two on the same project.

Pipeline stages: search → triage → download → deep read → corpus shape → positioning & catalogue → loop close. Every LLM-touching feature inherits the same five-way provider switch (off / WebLLM / OpenAI-compatible / Anthropic / share-to-chat).

## What you get

- **Stage 1 — Search**: arXiv + OpenAlex + Semantic Scholar with rate limiting, deduplication, manifest-based interrupt-resume.
- **Stage 2 — Triage**: mail-client-style three-pane layout. `I` / `M` / `E` / `Enter` keyboard shortcuts. Multi-prototype embedding classifier with active-learning training wizard — the system asks blind questions, you label, weights re-tune on every decision. Snowball expansion (forward + backward citations via OpenAlex) lands new candidates as pending triage rows.
- **Stage 3 — Download**: background daemon auto-fetches PDFs as you mark papers `include` / `maybe`. Bookmarklet for one-click capture from publisher pages that reject scripted clients.
- **Stage 4 — Deep read**: native PDF viewer + structured note form mirroring the canonical schema. Section-aware RAG drafter — 5 parallel LLM calls over PDF-section-retrieved chunks per paper, plus 2 zero-shot extractions (cosine for categories/method-family/relevance, regex for metrics/case-count/booleans). Optional **audit & revise** pass: a critic LLM rereads each section against the retrieved chunks and rewrites the ones it flags. Optional **cross-paper context**: top-3 related notes from the corpus injected so the drafter can make comparative claims. **Quote grounding**: every paragraph gets a `(pp. X)` page reference matched against the chunks it was drafted from. Across-papers batch with 3-way concurrency.
- **Stage 5 — Corpus shape**: read-only overview before you commit to a topic. Gap matrix (category × method), method × novelty lattice (perpendicular view: which methods produce strong-novelty work vs incremental work, which lean on self-constructed ground truth), outliers (papers far from the corpus centroid), contradiction audit (paraphrase-mined pairs, per-pair LLM judge), recurring-limitations clusters.
- **Stage 6 — Positioning & catalogue**: five-section workflow that produces every artefact a supervisor expects.
  1. **Candidates & shortlist** — generate gap candidates from the corpus, score each against seven thesis indicators, auto-compute the accept/refine/reject shortlist. Flat indicator scorecard table for the whole shortlist.
  2. **PRISMA flow** — CSS block diagram (Identification → Deduplication → Screening + excluded → Eligibility + unavailable → Included). Ready-to-paste methodology paragraph.
  3. **Positioning statement** — pick a candidate, auto-fill a structured 1-pager (topic / field state / closest prior work / gap / RQ / external validation / methodology / why-not-hobby / indicator summary), edit, save.
  4. **Catalogue** — multi-chapter thesis topic catalogue (state-of-the-art + per-topic chapters + topic selection). Per-section RAG over the notes vector store so chapters are grounded in actual note prose, not just frontmatter. Post-generation citation-coverage check flags must-cite papers the LLM silently dropped.
  5. **External AI handoff** — ZIP export + master prompt clipboard. For when local AI output is weak and you want to paste into Claude.ai or ChatGPT.
- **Stage 7 — Loop close**: closed-loop remediation. Walks the pipeline state and surfaces concrete next actions: "Triage 12 pending hits", "Draft 8 missing notes", "Audit 5 contradiction candidate pairs", "Address 3 must-cite papers missing from the catalogue", "N empty matrix cells in explored regions". Each card has a severity (red blocking / yellow quality / green opportunity) and a deep-link to the stage that resolves it.

## Multi-provider AI

Configure in the topbar AI pill:

- **Local (WebLLM)** — runs in your browser via WebGPU. Pulls Llama 3.2 3B / Qwen 2.5 3B / Ministral 3B / Gemma 3 1B. No keys, no cost, no data leaves the machine.
- **OpenAI-compatible** — works with OpenAI, Ollama, OpenRouter, Groq, Together, vLLM, LM Studio, llama.cpp server. Configure base URL + API key + model.
- **Anthropic Claude** — direct Claude API. Recommended for catalogue chapter generation and the audit critic where reasoning quality matters.

API keys live in `project/data/_credentials.json` (gitignored, file mode 0600). The browser never sees them — the server proxies all provider calls.

## Embeddings (encoder/decoder split)

Embeddings run server-side via `@huggingface/transformers` with bge-small-en-v1.5 (384-dim, L2-normalized). First call lazy-loads the model into `~/.cache/huggingface/` (~130 MB); subsequent calls reuse the in-process pipeline.

Dtype is auto-picked per platform: **fp16 on Apple Silicon** (M-series, via ONNX Runtime — MLX itself is Python/Swift only and can't be called from a Node toolchain), **fp32 elsewhere**. Override with `LITREVIEW_EMBED_DTYPE=fp32|fp16|q8|q4` if you want to swap (q8 / q4 are quantized — smaller and faster, slight accuracy hit). The embedder falls back to fp32 silently if the requested variant isn't published for this model.

The embed daemon scans `candidates_triaged.csv` and `notes/` for anything new or changed and feeds the encoder. The vector store lives at `project/data/_vectors/` as jsonl-per-kind (papers / chunks / notes).

The drafter, critic, classifier, gap detection, catalogue grounding, quote grounding, and snowballing all consume those vectors. No TF-IDF, no k-means, no HDBSCAN — only sentence-transformers utilities ported to JS (`cosSim`, `paraphraseMining`, `communityDetection`, `semanticSearch`).

## Install

Requires Node 20 or later. First run will also download ~130 MB of model weights for the embedder.

```bash
git clone https://github.com/nored/litreview-webapp.git
cd litreview-webapp
npm install
npm start
```

Open http://localhost:4173

Five runtime deps: `express`, `fast-xml-parser`, `yaml`, `pdfjs-dist` (pure-JS PDF text extraction, no Chromium), `@huggingface/transformers` (the embedder).

## Configure

On first run, fill the **Setup** view:

- Topic title and description
- Categories and method families (used as gap-matrix axes)
- Year window
- Contact email (used in HTTP politeness headers)
- *Optional*: paste your Semantic Scholar API key (kills the 429 rate-limit pain)

## Project layout

The app stores everything under `project/`:

```
project/
├── protocol/
│   ├── topic.md
│   ├── search_queries.md
│   └── inclusion_criteria.md
├── data/
│   ├── _credentials.json           (gitignored, mode 0600)
│   ├── _jobs/{search,download,embed,snowball}.json   (interrupt-resume manifests)
│   ├── _triage_meta.json           (AI suggestions sidecar)
│   ├── _synthesis.json             (gap candidates, indicator verdicts)
│   ├── _vectors/{papers,chunks,notes}.jsonl   (embedding store)
│   ├── candidates_raw.csv
│   ├── candidates_triaged.csv
│   ├── search_log.jsonl
│   ├── download_log.csv
│   └── pdfs/paper_NNN.pdf
├── notes/paper_NNN.md              (canonical note schema, CLI-compatible)
└── synthesis/
    ├── gap_matrix.md
    ├── gap_candidates.md
    ├── indicator_assessment.md
    ├── shortlist.md
    ├── prisma_flow.md
    ├── positioning_statement.md
    └── catalogue.md
```

`project/` is gitignored. Bring your own `git init project/` if you want version control of your thesis work separately.

## Switch between web app and CLI

The CLI template at https://github.com/nored/thesis-litreview-template uses the same on-disk format. You can:

- Run search and download via the web app, do triage in the CLI by editing the CSV in a spreadsheet
- Have the AI draft a note in the web app, then run `python scripts/validate_notes.py` from the CLI repo
- Use either tool to produce the catalogue

Point both tools at the same `project/` directory.

## Reset for a new topic

Setup view has a "Danger zone" section with a "Reset for new topic" button. Wipes search results, triage, downloaded PDFs, notes, synthesis output, and the vector store. Resets `topic.md` / `search_queries.md` / `inclusion_criteria.md` to defaults. Preserves your contact email and API keys by default; uncheck the boxes to wipe those too.

## Privacy and data flow

Everything runs on your machine. The browser talks only to:

- **Your local server** (`localhost:4173`) for everything that touches your data
- **Public academic APIs** (arXiv, OpenAlex, Semantic Scholar, Unpaywall) during search, download, and snowballing
- **Your configured AI provider** (only when you click an AI button). WebLLM stays in the browser; OpenAI / Anthropic / Ollama / others go through your local server, never directly from the browser

API keys are stored in `project/data/_credentials.json` with file mode 0600. The `GET /api/credentials` endpoint returns set/unset + a masked preview, never the full key.

## Future work

Things on the roadmap but not yet built:

- **UX audit across stages 1/2/3.** Stages 4/5/6/7 have been audited and consolidated against the "stupid user gets a good result" principle. The earlier stages haven't yet — the triage training wizard in particular has the kind of complexity stage 5 used to have. Mandatory before a 1.0.
- **External corpus comparison.** Pull a same-topic OpenAlex sample, embed centroids, surface "areas the field has explored that your corpus missed". Considered and deferred — significant overlap with snowballing + triangulation already in place, OpenAlex bulk-pull complexity (rate limits, caching, refresh UI) is high, and the actionable signal is narrow (papers the field publishes but your include set doesn't cite). May come back as a smaller variant ("re-run-search sanity check" or "topical recall check per matrix cell") if recall-anxiety surfaces in practice.
- **Provider robustness.** Clearer error messages, retry-on-rate-limit, fallback chains across providers when the primary fails mid-batch.
- **Embed-daemon visibility.** The daemon currently runs silent — surface a heartbeat / queue depth somewhere so the student knows when their notes are about to be retrievable.
- **Project export / import.** ZIP the whole project for archiving or handoff to a collaborator. The catalogue's external-AI-handoff ZIP is a precedent.

## License

MIT.
