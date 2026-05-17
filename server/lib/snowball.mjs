// snowball.mjs
//
// Citation snowballing. For each include-labeled paper in the corpus,
// fetches its referenced works (backward citations) via OpenAlex and
// optionally its incoming citations (forward), then dedupes the new
// candidates against the existing triage CSV and writes the survivors
// back as pending rows. The embed daemon picks them up automatically;
// from there the Stage 2 wizard handles them via the same cluster-
// propagation + finish-remaining flow already in place.
//
// Why OpenAlex first:
//   - Free, no API key, full polite-pool access with a mailto.
//   - The `referenced_works` field on a Work is a direct list of
//     OpenAlex Work IDs — no fuzzy parsing of bibliographies.
//   - Forward citations come via the `cited_by_api_url` cursor.
//   - The `Works` lookup API supports batched fetch by OpenAlex ID
//     (50 at a time via `filter=ids.openalex:W123|W456|...`), so
//     resolving 30 references for one paper is one HTTP call.
//
// We deliberately don't add Semantic Scholar fallback yet — OpenAlex
// has the highest coverage for citation data in 2024+. A future patch
// can layer S2 in if students hit gaps.

const OPENALEX_API = 'https://api.openalex.org/works';

// Polite-pool rate limit. OpenAlex allows 10 req/sec with mailto. We sit
// well under so we don't trigger their automated cool-down on bursty use.
const POLITE_DELAY_MS = 150;

// Hard cap on how many references we'll process per source paper. A few
// papers (especially surveys) cite 200+; pulling all of them risks a
// rabbit hole. The cap can be raised at the daemon level if needed.
const MAX_REFS_PER_SOURCE = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// OpenAlex resolution
// ---------------------------------------------------------------------------

// Normalize a DOI string from any of the common shapes — bare DOI,
// https://doi.org/..., http://, with or without trailing slashes.
function normalizeDoi(raw) {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  if (s.startsWith('https://doi.org/')) s = s.slice('https://doi.org/'.length);
  else if (s.startsWith('http://doi.org/')) s = s.slice('http://doi.org/'.length);
  else if (s.startsWith('doi:')) s = s.slice(4);
  return s.replace(/\/+$/, '');
}

// Strip the OpenAlex URL prefix to leave just the W… id.
function shortOpenalexId(url) {
  if (!url) return '';
  const m = String(url).match(/(?:openalex\.org\/|^)(W\d+)/i);
  return m ? m[1] : '';
}

// Find the OpenAlex Work ID for an existing triage row. Strategy:
//   1. If the row's `url` is already an openalex.org link → strip the W id.
//   2. If we have a DOI → /works?filter=doi:...
//   3. If we have an arXiv id → /works?filter=ids.arxiv:...
//   4. Last resort: search by title (rare; identifiers are usually present).
//
// Returns the W id (e.g. "W2741809807") or '' if we couldn't resolve.
export async function resolveToOpenalexId(row, { email, signal } = {}) {
  const fromUrl = shortOpenalexId(row.url || '');
  if (fromUrl) return fromUrl;

  const params = new URLSearchParams();
  if (email) params.set('mailto', email);

  if (row.doi) {
    const doi = normalizeDoi(row.doi);
    params.set('filter', `doi:${doi}`);
    const w = await firstWork(`${OPENALEX_API}?${params}`, signal);
    if (w) return shortOpenalexId(w.id);
  }
  if (row.arxiv_id) {
    const arxivParams = new URLSearchParams();
    if (email) arxivParams.set('mailto', email);
    arxivParams.set('filter', `ids.arxiv:${row.arxiv_id}`);
    const w = await firstWork(`${OPENALEX_API}?${arxivParams}`, signal);
    if (w) return shortOpenalexId(w.id);
  }
  if (row.title) {
    const titleParams = new URLSearchParams();
    if (email) titleParams.set('mailto', email);
    titleParams.set('filter', `title.search:${row.title.slice(0, 200)}`);
    titleParams.set('per_page', '1');
    const w = await firstWork(`${OPENALEX_API}?${titleParams}`, signal);
    if (w) return shortOpenalexId(w.id);
  }
  return '';
}

async function firstWork(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.[0] || null;
}

// ---------------------------------------------------------------------------
// Reference and citation fetching
// ---------------------------------------------------------------------------

// Given a source OpenAlex Work ID, fetch the Work record (which contains
// `referenced_works`) and then batch-resolve those referenced IDs to full
// Work records. Returns an array of Work objects (raw OpenAlex shape).
export async function fetchBackwardCitations(sourceId, { email, signal, maxRefs = MAX_REFS_PER_SOURCE } = {}) {
  if (!sourceId) return [];
  const params = new URLSearchParams();
  if (email) params.set('mailto', email);
  const res = await fetch(`${OPENALEX_API}/${sourceId}?${params}`, { signal });
  if (!res.ok) return [];
  const work = await res.json();
  const refIds = (work.referenced_works || [])
    .map((u) => shortOpenalexId(u))
    .filter(Boolean)
    .slice(0, maxRefs);
  if (refIds.length === 0) return [];
  return await fetchWorksBatched(refIds, { email, signal });
}

// Forward citations — papers citing this one. OpenAlex exposes these via
// `cited_by_api_url` which is already a paginated /works endpoint with the
// right filter applied. We fetch the first page only by default; the
// daemon can ask for more if needed.
export async function fetchForwardCitations(sourceId, { email, signal, maxCiting = MAX_REFS_PER_SOURCE } = {}) {
  if (!sourceId) return [];
  const params = new URLSearchParams();
  if (email) params.set('mailto', email);
  params.set('filter', `cites:${sourceId}`);
  params.set('per_page', String(Math.min(maxCiting, 200)));
  const res = await fetch(`${OPENALEX_API}?${params}`, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).slice(0, maxCiting);
}

// Resolve a list of OpenAlex IDs to full Work records, batched (OpenAlex
// supports |-joined ids in a single filter). Politely-rate-limited.
async function fetchWorksBatched(ids, { email, signal, batchSize = 50 } = {}) {
  const out = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const slice = ids.slice(i, i + batchSize);
    const params = new URLSearchParams();
    if (email) params.set('mailto', email);
    params.set('filter', `ids.openalex:${slice.join('|')}`);
    params.set('per_page', String(slice.length));
    const res = await fetch(`${OPENALEX_API}?${params}`, { signal });
    if (res.ok) {
      const data = await res.json();
      out.push(...(data.results || []));
    }
    if (i + batchSize < ids.length) await sleep(POLITE_DELAY_MS);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidate mapping (Work → CSV row shape)
// ---------------------------------------------------------------------------

// Map an OpenAlex Work record to the same shape we use for triage rows.
// This is intentionally compatible with the rest of the existing search
// pipeline so the embed daemon and triage UI treat snowballed rows like
// any other candidate.
export function workToCandidate(work, sourceQuery = 'snowball') {
  if (!work) return null;
  const authors = (work.authorships || [])
    .map((a) => a?.author?.display_name)
    .filter(Boolean);
  let doi = work.doi || '';
  if (typeof doi === 'string' && doi.startsWith('https://doi.org/')) {
    doi = doi.slice('https://doi.org/'.length);
  }
  const venue =
    work.primary_location?.source?.display_name ||
    work.host_venue?.display_name ||
    work.locations?.[0]?.source?.display_name ||
    '';
  const arxivId = extractArxivId(work);
  return {
    title: work.title || '',
    authors: authors.join(', '),
    year: String(work.publication_year || ''),
    venue,
    abstract: reconstructInverted(work.abstract_inverted_index),
    doi: doi || '',
    arxiv_id: arxivId,
    url: work.id || '',
    pdf_url: bestPdfUrl(work, arxivId, doi),
    source_database: 'openalex',
    source_query: sourceQuery,
  };
}

// Pick the best downloadable URL for a snowballed work. OpenAlex has
// best_oa_location (one preferred OA copy), primary_location (publisher
// or repo), and a wider locations[] array. Best_oa_location alone often
// comes back null even when arXiv has a PDF, so we walk through every
// candidate in priority order. Final fallbacks: arXiv abstract URL,
// then a DOI-resolved URL so the downloader has at least something to
// try.
function bestPdfUrl(work, arxivId, doi) {
  const oaBest = work.best_oa_location || {};
  if (oaBest.pdf_url) return oaBest.pdf_url;
  const prim = work.primary_location || {};
  if (prim.pdf_url) return prim.pdf_url;
  for (const loc of work.locations || []) {
    if (loc?.pdf_url) return loc.pdf_url;
  }
  // No direct PDF URL. Try landing pages in the same order.
  if (oaBest.landing_page_url) return oaBest.landing_page_url;
  if (prim.landing_page_url) return prim.landing_page_url;
  for (const loc of work.locations || []) {
    if (loc?.landing_page_url) return loc.landing_page_url;
  }
  // Last-resort constructed URLs. Prefer arXiv since the downloader
  // handles its PDFs directly; doi.org is a redirect-only fallback.
  if (arxivId) return `https://arxiv.org/abs/${arxivId}`;
  if (doi) return `https://doi.org/${doi}`;
  return '';
}

function extractArxivId(work) {
  // OpenAlex stores arXiv IDs under `ids.arxiv` (or sometimes
  // `external_ids.arxiv`). Different shapes across versions; check both.
  const a = work.ids?.arxiv || work.external_ids?.arxiv || '';
  if (!a) return '';
  // Some return full URLs like "https://arxiv.org/abs/2305.12345" — strip.
  return String(a).replace(/^https?:\/\/arxiv\.org\/abs\//, '');
}

// Mirror of OpenAlex's inverted-index reconstruction used in search.mjs.
function reconstructInverted(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const positions = [];
  for (const [word, idxs] of Object.entries(inv)) {
    for (const i of idxs) positions.push([i, word]);
  }
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map((p) => p[1]).join(' ');
}

// ---------------------------------------------------------------------------
// Dedup against existing triage corpus
// ---------------------------------------------------------------------------

// Build a quick-lookup index of identifiers already in the corpus so we
// don't re-add papers the student already has (whether they're labeled or
// pending). Returns Sets of normalized DOIs, arXiv IDs, OpenAlex IDs,
// and a list of normalized titles for jaccard fallback.
export function buildExistingIndex(existingRows) {
  const dois = new Set();
  const arxivs = new Set();
  const oaIds = new Set();
  const titles = [];
  for (const r of existingRows) {
    if (r.doi) dois.add(normalizeDoi(r.doi));
    if (r.arxiv_id) arxivs.add(String(r.arxiv_id).trim());
    const oa = shortOpenalexId(r.url);
    if (oa) oaIds.add(oa);
    if (r.title) titles.push(normalizeTitle(r.title));
  }
  return { dois, arxivs, oaIds, titles };
}

export function isDuplicate(candidate, index, { titleThreshold = 0.85 } = {}) {
  const doi = normalizeDoi(candidate.doi);
  if (doi && index.dois.has(doi)) return true;
  if (candidate.arxiv_id && index.arxivs.has(candidate.arxiv_id)) return true;
  const oa = shortOpenalexId(candidate.url);
  if (oa && index.oaIds.has(oa)) return true;
  const nt = normalizeTitle(candidate.title);
  if (!nt) return false;
  for (const t of index.titles) {
    if (jaccard(nt, t) >= titleThreshold) return true;
  }
  return false;
}

function normalizeTitle(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function jaccard(a, b) {
  if (!a || !b) return 0;
  const sa = new Set(a.split(' '));
  const sb = new Set(b.split(' '));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export { POLITE_DELAY_MS, MAX_REFS_PER_SOURCE };
