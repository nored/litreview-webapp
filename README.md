# Literature Review Web App

Local-first web app for running an MSc/BSc thesis literature review pipeline. Companion to the [CLI template](https://github.com/nored/thesis-litreview-template); the on-disk artifact format is identical so you can switch between them on the same project.

Pipeline stages: search → triage → download → deep read → synthesis → catalogue (positioning + PRISMA). Every stage has AI assistance (optional, multi-provider).

## What you get

- **Stage 1 — Search**: arXiv + OpenAlex + Semantic Scholar with rate limiting, deduplication, manifest-based interrupted-run resumption.
- **Stage 2 — Triage**: mail-client-style three-pane layout (filter, list, detail). Per-paper `I` / `M` / `E` / `Enter` keyboard shortcuts. AI batch suggestion across the whole pending queue.
- **Stage 3 — Download**: background daemon auto-fetches PDFs as you mark papers `include` / `maybe`. Bookmarklet for one-click capture from publisher pages that reject scripted clients (Akamai, Cloudflare).
- **Stage 4 — Deep read**: native PDF viewer + structured note form mirroring the canonical schema. AI single-call full-note draft (frontmatter + body) per paper, plus across-papers batch.
- **Stage 5 — Synthesis & quality**: deterministic gap matrix from note frontmatter, AI-generated gap candidates, AI-scored against seven thesis quality indicators (PASS/PARTIAL/FAIL with justifications), auto-computed shortlist.
- **Stage 6 — Catalogue**: generates a multi-chapter thesis topic catalogue (state-of-the-art + per-topic chapters with research questions / methodology / risks / reading lists + topic selection + references). Single button. ZIP export to hand off to Claude.ai or ChatGPT if local AI isn't strong enough.

## Multi-provider AI

Configure in the topbar AI pill:

- **Local (WebLLM)** — runs in your browser via WebGPU. Pulls Llama 3.2 3B / Qwen 2.5 3B / Ministral 3B / Gemma 3 1B. No keys, no cost, no data leaves the machine.
- **OpenAI-compatible** — works with OpenAI, Ollama, OpenRouter, Groq, Together, vLLM, LM Studio, llama.cpp server. Configure base URL + API key + model.
- **Anthropic Claude** — direct Claude API. Recommended for the catalogue chapter where reasoning quality matters.

API keys live in `project/data/_credentials.json` (gitignored, file mode 0600). Never sent anywhere except the configured endpoint.

## Install

Requires Node 20 or later.

```bash
git clone https://github.com/nored/litreview-webapp.git
cd litreview-webapp
npm install
npm start
```

Open http://localhost:4173

## Configure

Three deps total: `express`, `fast-xml-parser`, `yaml`. No system binaries, no Chromium download, no native add-ons.

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
│   ├── _jobs/search.json           (interrupt-resume manifest)
│   ├── _jobs/download.json
│   ├── _triage_meta.json           (AI suggestions sidecar)
│   ├── _synthesis.json             (gap candidates, indicator verdicts)
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

Setup view has a "Danger zone" section with a "Reset for new topic" button. Wipes search results, triage, downloaded PDFs, notes, and synthesis output. Resets `topic.md` / `search_queries.md` / `inclusion_criteria.md` to defaults. Preserves your contact email and API keys by default; uncheck the boxes to wipe those too.

## Privacy and data flow

Everything runs on your machine. The browser talks only to:

- **Your local server** (`localhost:4173`) for everything that touches your data
- **Public academic APIs** (arXiv, OpenAlex, Semantic Scholar, Unpaywall) during search and download — these are the same endpoints the CLI tool would hit
- **Your configured AI provider** (only when you click an AI button) — WebLLM stays local, OpenAI/Anthropic/Ollama go through your local server

API keys are stored in `project/data/_credentials.json` with file mode 0600. The `GET /api/credentials` endpoint returns set/unset + a masked preview, never the full key. The browser never sees your API keys.

## License

MIT.
