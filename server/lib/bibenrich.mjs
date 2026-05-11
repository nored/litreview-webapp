// Bibliographic enrichment via OpenAlex's DOI endpoint.
//
// Used when a candidate row is missing venue/authors/year/arxiv_id but has
// a DOI (or arXiv ID). One HTTP call, no LLM, no auth — just the mailto
// politeness header. Returns null on any failure so callers can fall
// through silently.

const OPENALEX_WORKS = 'https://api.openalex.org/works';
const ENRICH_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('enrich timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function pickVenue(work) {
  return (
    work?.primary_location?.source?.display_name ||
    work?.host_venue?.display_name ||
    work?.locations?.[0]?.source?.display_name ||
    ''
  );
}

function pickArxivId(work) {
  const ids = work?.ids || {};
  // OpenAlex sometimes stores arXiv ID under ids.arxiv_id or as a location.
  if (typeof ids.arxiv_id === 'string' && ids.arxiv_id) return ids.arxiv_id;
  for (const loc of work?.locations || []) {
    const src = loc?.source?.display_name || '';
    if (src && /arxiv/i.test(src)) {
      const url = loc?.landing_page_url || loc?.pdf_url || '';
      const m = url.match(/(\d{4}\.\d{4,5})/);
      if (m) return m[1];
    }
  }
  return '';
}

function authorList(work) {
  return (work?.authorships || [])
    .map((a) => a?.author?.display_name)
    .filter(Boolean);
}

// Look up a paper by DOI. Returns { venue, year, authors, arxiv_id, url,
// pdf_url, abstract } — fields are only present when OpenAlex had them.
// Returns null on network error, 404, or timeout.
export async function enrichByDoi(doi, email) {
  if (!doi) return null;
  const clean = String(doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  if (!clean) return null;
  const url = `${OPENALEX_WORKS}/doi:${encodeURIComponent(clean)}?mailto=${encodeURIComponent(email || 'anonymous@example.com')}`;
  let res;
  try {
    res = await withTimeout(fetch(url), ENRICH_TIMEOUT_MS);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let work;
  try { work = await res.json(); } catch { return null; }
  if (!work || typeof work !== 'object') return null;

  const oa = work.best_oa_location || {};
  return {
    venue: pickVenue(work),
    year: work.publication_year ? String(work.publication_year) : '',
    authors: authorList(work).join(', '),
    arxiv_id: pickArxivId(work),
    url: work.id || '',
    pdf_url: oa.pdf_url || oa.landing_page_url || '',
    title: work.title || '',
  };
}

// Merge enrichment over a row, NEVER overwriting non-empty existing fields.
// Returns { row, changed }.
export function mergeEnrichment(row, enrich) {
  if (!enrich) return { row, changed: false };
  const next = { ...row };
  let changed = false;
  for (const key of ['venue', 'year', 'authors', 'arxiv_id', 'url', 'pdf_url', 'title']) {
    const cur = String(next[key] ?? '').trim();
    const incoming = String(enrich[key] ?? '').trim();
    if (!cur && incoming) {
      next[key] = incoming;
      changed = true;
    }
  }
  return { row: next, changed };
}
