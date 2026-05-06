// API clients for arXiv, OpenAlex, Semantic Scholar. Plus dedup.
// Mirrors scripts/run_search.py from the CLI repo.

import { XMLParser } from 'fast-xml-parser';

const ARXIV_API = 'http://export.arxiv.org/api/query';
const OPENALEX_API = 'https://api.openalex.org/works';
const SEMANTIC_SCHOLAR_API = 'https://api.semanticscholar.org/graph/v1/paper/search';

const ua = (email) => `LitReview/1.0 (mailto:${email})`;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

export async function searchArxiv(query, email, opts = {}) {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(opts.maxResults ?? 50),
    sortBy: 'relevance',
    sortOrder: 'descending',
  });
  const url = `${ARXIV_API}?${params}`;
  const headers = { 'User-Agent': ua(email) };
  let res = await fetch(url, { headers, signal: opts.signal });
  // arXiv 429s aggressively when many sequential requests look botty.
  // One backoff retry usually clears it.
  if (res.status === 429 || res.status === 503) {
    await sleep(15000);
    res = await fetch(url, { headers, signal: opts.signal });
  }
  if (!res.ok) throw new Error(`arxiv HTTP ${res.status}`);
  const xml = await res.text();
  const parsed = xmlParser.parse(xml);
  const entries = parsed?.feed?.entry ?? [];
  const list = Array.isArray(entries) ? entries : [entries];
  return list.filter(Boolean).map((e) => {
    const id = String(e.id || '');
    const arxivId = (id.split('/').pop() || '').split('v')[0];
    const authorList = e.author
      ? (Array.isArray(e.author) ? e.author : [e.author]).map((a) => a.name)
      : [];
    return {
      title: String(e.title || '').replace(/\s+/g, ' ').trim(),
      authors: authorList.join(', '),
      year: String(e.published || '').slice(0, 4),
      venue: 'arXiv',
      abstract: String(e.summary || '').replace(/\s+/g, ' ').trim(),
      doi: '',
      arxiv_id: arxivId,
      url: id,
      pdf_url: arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : '',
      source_database: 'arxiv',
      source_query: query,
    };
  });
}

export async function searchOpenalex(query, email, opts = {}) {
  const max = opts.maxResults ?? 100;
  // `search=` (the loose param) matches across title, abstract, and full
  // text — a query like "gdpr ai compliance" then returns every paper
  // mentioning any of those words anywhere, which is the noise the user
  // actually saw. `filter=title_and_abstract.search:` restricts matching
  // to title and abstract, ranked by relevance, which is what we want for
  // a literature review search.
  const params = new URLSearchParams({
    filter: `title_and_abstract.search:${query}`,
    per_page: String(Math.min(max, 200)),
    sort: 'relevance_score:desc',
    mailto: email,
  });
  const res = await fetch(`${OPENALEX_API}?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`openalex HTTP ${res.status}`);
  const data = await res.json();
  return (data.results ?? []).slice(0, max).map((work) => {
    const authors = (work.authorships ?? [])
      .map((a) => a?.author?.display_name)
      .filter(Boolean);
    let doi = work.doi ?? '';
    if (typeof doi === 'string' && doi.startsWith('https://doi.org/')) {
      doi = doi.slice('https://doi.org/'.length);
    }
    const oa = work.best_oa_location ?? {};
    // OpenAlex deprecated `host_venue` in favor of `primary_location.source`.
    // Try the new shape first, then the legacy one, then any location.
    const venue =
      work.primary_location?.source?.display_name ||
      work.host_venue?.display_name ||
      work.locations?.[0]?.source?.display_name ||
      '';
    return {
      title: work.title ?? '',
      authors: authors.join(', '),
      year: String(work.publication_year ?? ''),
      venue,
      abstract: reconstructInverted(work.abstract_inverted_index),
      doi: doi || '',
      arxiv_id: '',
      url: work.id ?? '',
      pdf_url: oa.pdf_url || oa.landing_page_url || '',
      source_database: 'openalex',
      source_query: query,
    };
  });
}

function reconstructInverted(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const positions = [];
  for (const [word, idxs] of Object.entries(inv)) {
    for (const i of idxs) positions.push([i, word]);
  }
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map((p) => p[1]).join(' ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function searchSemanticScholar(query, email, opts = {}) {
  const max = opts.maxResults ?? 100;
  const params = new URLSearchParams({
    query,
    limit: String(Math.min(max, 100)),
    fields: 'title,authors,year,venue,abstract,externalIds,openAccessPdf,url',
  });
  const headers = { 'User-Agent': ua(email) };
  // Caller-provided key takes precedence over the env var.
  const apiKey = opts.apiKey || process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  const url = `${SEMANTIC_SCHOLAR_API}?${params}`;
  let res = await fetch(url, { headers, signal: opts.signal });
  if (res.status === 429) {
    await sleep(30000);
    res = await fetch(url, { headers, signal: opts.signal });
  }
  if (!res.ok) throw new Error(`semantic_scholar HTTP ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((it) => {
    const ext = it.externalIds ?? {};
    return {
      title: it.title ?? '',
      authors: (it.authors ?? []).map((a) => a?.name).filter(Boolean).join(', '),
      year: String(it.year ?? ''),
      venue: it.venue ?? '',
      abstract: it.abstract ?? '',
      doi: ext.DOI ?? '',
      arxiv_id: ext.ArXiv ?? '',
      url: it.url ?? '',
      pdf_url: it.openAccessPdf?.url ?? '',
      source_database: 'semantic_scholar',
      source_query: query,
    };
  });
}

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccard(a, b) {
  const sa = new Set(a.split(' '));
  const sb = new Set(b.split(' '));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function dedupe(rows, threshold = 0.85) {
  const byDoi = new Map();
  const noDoi = [];
  for (const r of rows) {
    const doi = (r.doi || '').toLowerCase().trim();
    if (doi) {
      if (!byDoi.has(doi)) byDoi.set(doi, r);
    } else {
      noDoi.push(r);
    }
  }
  const out = [...byDoi.values()];
  const seenTitles = out.map((r) => normalizeTitle(r.title));
  for (const r of noDoi) {
    const nt = normalizeTitle(r.title);
    if (!nt) continue;
    let dup = false;
    for (const st of seenTitles) {
      if (jaccard(nt, st) >= threshold) { dup = true; break; }
    }
    if (!dup) {
      out.push(r);
      seenTitles.push(nt);
    }
  }
  return out;
}
