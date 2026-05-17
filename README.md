# Literature Review Web App

Local-first web app for **structured analysis over a research-domain corpus**. Build a gap report, identify research opportunities, and produce evidence-grounded positioning artefacts — for a thesis literature review, a related-work section, a grant proposal, a review-paper, or any work that needs to position itself against prior literature.

Pipeline stages: search → triage → download → deep read → corpus shape → positioning & catalogue → loop close. Every LLM-touching feature inherits the same five-way provider switch (off / WebLLM / OpenAI-compatible / Anthropic / share-to-chat).

**v2 in progress (2026-05):** the deep-read stage is being migrated to a structured per-paper extraction pipeline (typed fields with full provenance) feeding 11 cross-paper detectors over a SQLite store. The legacy prose-drafter Stage 4 remains available at `#/stage4-legacy`; the new structured form lives at `#/stage4`.

## What you get

- **Stage 1 — Search**: arXiv + OpenAlex + Semantic Scholar with rate limiting, deduplication, manifest-based interrupt-resume.
- **Stage 2 — Triage**: mail-client-style three-pane layout. `I` / `M` / `E` / `Enter` keyboard shortcuts. Multi-prototype embedding classifier with active-learning training wizard — the system asks blind questions, you label, weights re-tune on every decision. Snowball expansion (forward + backward citations via OpenAlex) lands new candidates as pending triage rows.
- **Stage 3 — Download**: background daemon auto-fetches PDFs as you mark papers `include` / `maybe`. Bookmarklet for one-click capture from publisher pages that reject scripted clients.
- **Stage 4 — Deep read (structured extraction)**: three-pane layout (paper list / PDF viewer / structured record). Per-paper pipeline: PDF chunks → section classifier → bool signals (5) + categorical enums (3) + named entities (tech/datasets/frameworks) + numerical (sample size + results) + topic enums (category, method_family). Every field carries provenance (mechanism, source chunk, page, raw quote, classifier scores). Optional **claims extraction (WebLLM)** runs LLM-as-finder bounded to substring-validated quotes, NLI-classified stance per claim. Inline editing on every field; undo on the most recent edit.
- **Stage 5 — Corpus shape (detector dashboards)**: read-only. 11 pure-SQL/JS detectors over the structured store — 7 typed gap detectors (Evidence / Knowledge / Practical / Methodological / Empirical / Theoretical / Population), 4 network analyses (citation centrality / main path / co-citation / bibliographic coupling), plus temporal trends, LOF + n-gram novelty, citation-weighted rerank. Every candidate carries a deterministic signature; user can dismiss a candidate and have the dismissal stick across runs.
- **Stage 6 / 7 — Positioning & catalogue (output modes)**: pick an output mode at the top.
  - **Thesis** — PRISMA flow + top gap candidates from the detectors + positioning statement + v2 catalogue (verbatim quotes grouped by category × body section, every quote has page + paper_id provenance).
  - **Paper** — related-work table + top gaps + suggested positioning paragraph.
  - **Grant** — gap report + bibliometric impact + research-direction suggestions.
  - **Landscape** — corpus inventory + temporal trends + central papers + optional external-corpus comparison (OpenAlex same-topic pull, joint clustering, gap-cluster flagging).
  - **Custom** — structured query bar + recommendation surface over the SQLite store.
- **Stage 8 — Loop close**: closed-loop remediation. Walks the pipeline state and surfaces concrete next actions, each with a severity tier and deep-link to the stage that resolves it.

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

- **Topic title and description** — drives search queries, catalogue prototypes, and extraction prompts.
- **Categories and method families** — used as detector axes (methodological / knowledge / population gap tensors).
- **Target/minimum includes** — the rough corpus size you're aiming for; influences adaptive detector thresholds.
- **Year window** — bounds search results.
- **Contact email** — used in HTTP politeness headers for arXiv / OpenAlex / Semantic Scholar.
- *Optional*: **Semantic Scholar API key** (kills the 429 rate-limit pain).
- *Optional*: **OpenAI / Anthropic credentials** for server-side LLM calls. Set `provider_fallback` to e.g. `"anthropic,openai"` to chain across providers when the primary fails before any tokens stream.

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

`project/` is gitignored. Bring your own `git init project/` if you want version control of your review work separately.

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
- **Fallback chains across providers.** Provider robustness now has retry-with-backoff and human-readable errors; full chained-fallback (auto-fail-over from Claude to OpenAI mid-batch) is still on the list.

## License

MIT.
