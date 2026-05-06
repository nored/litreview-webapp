// PDF download helpers. Mirrors scripts/download_pdfs.py from the CLI repo.
// Resolution chain: pdf_url → arxiv direct → Unpaywall.

const PDF_MAGIC = '%PDF-';
const MIN_PDF_SIZE = 100 * 1024;
const MAX_PDF_SIZE = 50 * 1024 * 1024;

// Use a browser-like User-Agent. Many publishers reject simple bot UAs even
// for open-access PDFs; a Chrome string opens those doors. Note: this won't
// defeat Akamai/Cloudflare TLS fingerprinting — those papers still need
// manual retrieval and the upload-from-browser flow.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ua = (email) => `${BROWSER_UA} LitReview/1.0 (+mailto:${email})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isValidPdf(buffer) {
  if (buffer.length < MIN_PDF_SIZE) {
    return { ok: false, reason: `too small (${buffer.length} bytes)` };
  }
  if (buffer.length > MAX_PDF_SIZE) {
    return { ok: false, reason: `too large (${buffer.length} bytes)` };
  }
  const magic = buffer.slice(0, 5).toString('utf8');
  if (magic !== PDF_MAGIC) {
    return { ok: false, reason: 'not a PDF (wrong magic bytes)' };
  }
  return { ok: true };
}

export async function tryDownload(url, email, opts = {}) {
  if (!url) return { error: 'no url' };
  const headers = {
    'User-Agent': ua(email),
    'Accept': 'application/pdf,application/x-pdf,application/octet-stream,*/*',
    'Accept-Language': 'en-US,en;q=0.7',
  };
  try {
    let res = await fetch(url, {
      headers, signal: opts.signal, redirect: 'follow',
    });
    if (res.status === 429 || res.status === 503) {
      await sleep(30000);
      res = await fetch(url, { headers, signal: opts.signal, redirect: 'follow' });
    }
    if (res.status !== 200) {
      return { error: `http ${res.status}`, status: res.status };
    }
    const ab = await res.arrayBuffer();
    return { buffer: Buffer.from(ab), contentType: res.headers.get('content-type') || '' };
  } catch (err) {
    return { error: `request error: ${err.message}` };
  }
}

export async function queryUnpaywall(doi, email, opts = {}) {
  if (!doi) return '';
  try {
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
    const res = await fetch(url, { signal: opts.signal });
    if (res.status !== 200) return '';
    const data = await res.json();
    return data?.best_oa_location?.url_for_pdf || '';
  } catch {
    return '';
  }
}

export async function resolveCandidates(row, email, opts = {}) {
  const cands = [];
  if (row.pdf_url) cands.push({ url: row.pdf_url, source: 'primary pdf_url' });
  if (row.arxiv_id) {
    const id = String(row.arxiv_id).trim();
    cands.push({ url: `https://arxiv.org/pdf/${id}.pdf`, source: 'arxiv direct' });
  }
  if (row.doi) {
    const oaUrl = await queryUnpaywall(row.doi, email, opts);
    if (oaUrl) cands.push({ url: oaUrl, source: 'unpaywall' });
  }
  return cands;
}
