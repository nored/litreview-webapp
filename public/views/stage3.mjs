// Stage 3: Download. Background daemon-driven. Auto-fetches PDFs as soon
// as papers are labelled include/maybe in stage 2. This view shows the
// daemon's current state, lets the student pause/resume/discard, and
// displays the manual retrieval list for failures.

import { h } from '../lib/dom.mjs';
import { formatRelative } from '../lib/draft.mjs';

export async function renderStage3(root) {
  root.innerHTML = '';
  root.appendChild(h('h1', {}, ['3. Download']));
  root.appendChild(h('p', { class: 'lead' }, [
    'PDFs auto-download in the background as you triage. The daemon resolves each paper through ',
    h('code', {}, ['pdf_url']), ' → arXiv direct → Unpaywall. ',
    'Papers that none of those resolve to land on the manual retrieval list.',
  ]));

  const summaryEl = h('div', { class: 'panel' });
  const logEl = h('div', { class: 'progress-log download-log' });
  const failuresEl = h('div', { class: 'panel' });

  root.appendChild(summaryEl);
  root.appendChild(h('section', { class: 'panel' }, [
    h('h2', {}, ['Live log']),
    logEl,
  ]));
  root.appendChild(failuresEl);

  let lastStatus = null;
  let reader = null;

  function renderSummary() {
    const s = lastStatus;
    summaryEl.innerHTML = '';
    summaryEl.appendChild(h('h2', {}, ['Status']));
    if (!s) {
      summaryEl.appendChild(h('p', { class: 'muted' }, ['Loading…']));
      return;
    }
    const job = s.job;
    const succ = job?.success_count ?? 0;
    const fail = job?.failed_count ?? 0;
    const queued = s.queue_size;

    let stateText = 'Idle (no work)';
    let stateClass = 'idle';
    if (s.paused) { stateText = 'Paused'; stateClass = 'paused'; }
    else if (s.running) { stateText = `Running — ${queued} pending`; stateClass = 'running'; }
    else if (queued > 0) { stateText = `${queued} pending`; stateClass = 'pending'; }

    summaryEl.appendChild(h('div', { class: 'download-stats' }, [
      stat('State', stateText, stateClass),
      stat('Success', succ, succ > 0 ? 'good' : ''),
      stat('Failed', fail, fail > 0 ? 'warn' : ''),
      stat('Queued', queued, queued > 0 ? 'pending' : ''),
    ]));

    if (s.inflight) {
      summaryEl.appendChild(h('p', { class: 'muted small' }, [
        `Currently downloading paper_${s.inflight}…`,
      ]));
    }

    // Action buttons
    const actions = h('div', { class: 'panel-actions' });
    if (s.running || queued > 0) {
      if (s.paused) {
        const resumeBtn = h('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            await fetch('/api/download/resume', { method: 'POST' });
            await refresh();
          },
        }, ['Resume']);
        actions.appendChild(resumeBtn);
      } else {
        const pauseBtn = h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            await fetch('/api/download/pause', { method: 'POST' });
            await refresh();
          },
        }, ['Pause']);
        actions.appendChild(pauseBtn);
      }
    } else {
      // No work pending. Offer a "Sync from triage" button in case the
      // student labelled things while we weren't running.
      const syncBtn = h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          await fetch('/api/download/start', { method: 'POST' });
          await refresh();
        },
      }, ['Check for new pending']);
      actions.appendChild(syncBtn);
    }

    if (job && (job.completed_count + job.failed_count > 0 || queued > 0)) {
      const discardBtn = h('button', {
        class: 'btn btn-ghost', type: 'button',
        onclick: async () => {
          if (!confirm('Discard the download log and manual retrieval list? Already-downloaded PDFs in data/pdfs/ are kept.')) return;
          await fetch('/api/download/job', { method: 'DELETE' });
          logEl.innerHTML = '';
          await refresh();
        },
      }, ['Discard log']);
      actions.appendChild(discardBtn);
    }
    summaryEl.appendChild(actions);

    if (job?.finished_at && job.status === 'completed' && fail === 0 && queued === 0) {
      summaryEl.appendChild(h('div', { class: 'banner banner-success' }, [
        h('strong', {}, ['All targeted papers downloaded.']),
        ' Proceed to ', h('a', { href: '#/stage4' }, ['stage 4 deep read']), '.',
      ]));
    } else if (fail > 0 && queued === 0 && !s.running) {
      summaryEl.appendChild(h('p', { class: 'small muted' }, [
        `${fail} paper${fail > 1 ? 's' : ''} could not be auto-fetched. See the manual retrieval list below.`,
      ]));
    }
  }

  function stat(label, value, kind) {
    return h('div', { class: 'stat ' + (kind || '') }, [
      h('div', { class: 'stat-value' }, [String(value)]),
      h('div', { class: 'stat-label muted small' }, [label]),
    ]);
  }

  async function refresh() {
    const s = await fetch('/api/download/status').then((r) => r.json());
    lastStatus = s;
    renderSummary();
  }

  async function loadFailures() {
    const data = await fetch('/api/download/failures').then((r) => r.json());
    failuresEl.innerHTML = '';
    const failures = data.failures || [];
    if (failures.length === 0) return;

    failuresEl.appendChild(h('h2', {}, [`Manual retrieval (${failures.length})`]));
    failuresEl.appendChild(renderBookmarkletPanel());
    failuresEl.appendChild(h('p', { class: 'small muted' }, [
      'For each paper: click ', h('strong', {}, ['Open publisher']),
      ', then either click the bookmarklet on the publisher page (one-click capture) ',
      'or save the PDF and drag it onto the drop zone.',
    ]));

    const list = h('div', { class: 'failure-list' });
    for (const f of failures) {
      list.appendChild(renderFailureCard(f));
    }
    failuresEl.appendChild(list);
  }

  function renderBookmarkletPanel() {
    // The bookmarklet runs ON the publisher's page. It reads paper_id from
    // window.name (set by our "Open publisher" button), finds the PDF on
    // the page, fetches it (which uses the user's real-browser TLS
    // fingerprint and any auth cookies), then POSTs it to our localhost.
    const code = bookmarkletCode();
    const href = 'javascript:' + encodeURIComponent(code);
    return h('div', { class: 'bookmarklet-panel' }, [
      h('div', {}, [
        h('strong', {}, ['📌 One-click capture: ']),
        h('a', {
          href,
          class: 'bookmarklet-link',
          draggable: 'true',
          onclick: (e) => e.preventDefault(),
        }, ['📚 Capture PDF → LitReview']),
      ]),
      h('p', { class: 'small muted' }, [
        'Drag the link above to your browser bookmarks bar (one-time install). ',
        'Then on any publisher page opened via "Open publisher", click the bookmarklet to fetch and upload the PDF in one click. ',
        'Your browser does the fetch, so it works on Akamai/Cloudflare-protected sites.',
      ]),
    ]);
  }

  function bookmarkletCode() {
    const origin = location.origin;
    // Self-contained, minified-ish. No deps. Reads paper_id from window.name
    // set by the "Open publisher" button.
    return `(function(){var n=(window.name||"").match(/^lr-paper-(\\d+)$/);if(!n){alert("Open this page via the LitReview Stage 3 'Open publisher' button first.");return;}var pid=n[1];function findPdf(){if(/\\.pdf(\\?|#|$)/i.test(location.href))return location.href;var meta=document.querySelector('meta[name="citation_pdf_url"]');if(meta&&meta.content)return meta.content;var link=document.querySelector('link[type="application/pdf"]');if(link&&link.href)return link.href;var a=document.querySelector('a[href$=".pdf"],a[href*=".pdf?"],a[href*="/pdf/"]');return a?a.href:null;}var url=findPdf();if(!url){alert("No PDF link found on this page.");return;}fetch(url,{credentials:"include"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.blob();}).then(function(b){return fetch("${origin}/api/download/upload/"+pid,{method:"POST",headers:{"Content-Type":"application/pdf"},body:b}).then(function(r){return r.json();});}).then(function(d){if(d.ok){alert("✓ paper_"+pid+" saved ("+Math.round(d.size/1024)+" KB)");window.close();}else{alert("Upload failed: "+(d.error||"unknown"));}}).catch(function(e){alert("Failed: "+e.message);});})();`;
  }

  function renderFailureCard(f) {
    const links = [];
    // The "Open publisher" button uses window.open with name=lr-paper-NNN
    // so the capture bookmarklet (running on the publisher's page) can
    // find the paper_id later.
    if (f.doi) {
      links.push(openInTabButton(`https://doi.org/${f.doi}`, 'Open publisher', f.paper_id));
    }
    if (f.url && f.url !== `https://doi.org/${f.doi}`) {
      links.push(openInTabButton(f.url, 'Source page', f.paper_id));
    }
    const searchUrl = 'https://scholar.google.com/scholar?q=' + encodeURIComponent(f.title || '');
    links.push(openInTabButton(searchUrl, 'Google Scholar', f.paper_id));

    const fileInput = h('input', {
      type: 'file', accept: 'application/pdf,.pdf',
      style: { display: 'none' },
    });
    const uploadBtn = h('button', { class: 'btn', type: 'button' }, ['Upload PDF']);
    const dropZone = h('div', { class: 'drop-zone' }, ['Drop PDF here']);
    const status = h('span', { class: 'small' }, []);

    async function uploadFile(file) {
      if (!file) return;
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        status.textContent = 'not a PDF';
        status.className = 'small error-text';
        return;
      }
      status.textContent = 'uploading…';
      status.className = 'small muted';
      uploadBtn.disabled = true;
      try {
        const res = await fetch(`/api/download/upload/${f.paper_id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf' },
          body: file,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const kb = Math.round((data.size || 0) / 1024);
        status.textContent = `saved (${kb} KB)`;
        status.className = 'small hint-good';
      } catch (err) {
        status.textContent = 'error: ' + err.message;
        status.className = 'small error-text';
      } finally {
        uploadBtn.disabled = false;
      }
    }

    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => uploadFile(e.target.files[0]));

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drop-zone-hover');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drop-zone-hover');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drop-zone-hover');
      const file = e.dataTransfer.files?.[0];
      uploadFile(file);
    });

    return h('div', { class: 'failure-card' }, [
      h('div', { class: 'failure-meta' }, [
        h('div', { class: 'failure-title' }, [
          h('span', { class: 'paper-id-pill' }, [`paper_${f.paper_id}`]),
          ' ',
          f.title || '(untitled)',
        ]),
        h('div', { class: 'failure-byline muted small' }, [
          f.authors || '(unknown authors)',
          ' · ', f.year || 'n.d.',
          f.venue ? ' · ' : '',
          f.venue || '',
        ]),
        f.attempts && f.attempts.length
          ? h('details', { class: 'failure-details' }, [
              h('summary', { class: 'small muted' }, [
                `Why it failed (${f.attempts.length} URL${f.attempts.length > 1 ? 's' : ''} tried)`,
              ]),
              h('ul', { class: 'small attempts-list' },
                f.attempts.map((a) => h('li', {}, [
                  h('code', {}, [a.source]),
                  ' ',
                  h('span', { class: 'muted' }, [`${a.url.slice(0, 70)}${a.url.length > 70 ? '…' : ''}`]),
                  ' → ',
                  h('span', { class: 'error-text' }, [a.error]),
                ]))
              ),
            ])
          : null,
      ]),
      h('div', { class: 'failure-actions' }, [
        h('div', { class: 'link-row' }, links),
        dropZone,
        h('div', { class: 'upload-row' }, [uploadBtn, status, fileInput]),
      ]),
    ]);
  }

  function linkButton(url, label) {
    return h('a', {
      href: url, target: '_blank', rel: 'noopener',
      class: 'btn btn-link',
    }, [label]);
  }

  // Opens a URL in a new tab whose window.name encodes the paper_id, so the
  // capture bookmarklet running on that page knows which paper to upload as.
  // We can't use rel="noopener" because that would null the window.name.
  function openInTabButton(url, label, paperId) {
    const a = h('a', {
      href: url,
      class: 'btn btn-link',
    }, [label]);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(url, `lr-paper-${paperId}`);
    });
    return a;
  }

  function appendLogLine(text, kind = '') {
    const line = h('div', { class: 'log-line ' + kind }, [text]);
    logEl.appendChild(line);
    // Cap log size in the DOM
    while (logEl.childElementCount > 200) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'status':
        // Initial replay; ignore
        break;
      case 'enqueued':
        appendLogLine(`+ paper_${event.paper_id} queued (${event.queue_size} pending)`, 'muted small');
        refresh();
        break;
      case 'paper_start':
        appendLogLine(`→ paper_${event.paper_id}: ${(event.title || '').slice(0, 70)}`, '');
        break;
      case 'paper_done':
        if (event.status === 'success') {
          const kb = Math.round((event.size || 0) / 1024);
          appendLogLine(`  ✓ paper_${event.paper_id} downloaded (${kb} KB)`, 'muted small');
        } else if (event.status === 'already_present') {
          appendLogLine(`  ✓ paper_${event.paper_id} already on disk`, 'muted small');
        } else {
          appendLogLine(`  ✗ paper_${event.paper_id} ${event.error || 'failed'}`, 'error-text small');
        }
        refresh();
        loadFailures();
        break;
      case 'paper_error':
        appendLogLine(`  ✗ paper_${event.paper_id}: ${event.error}`, 'error-text small');
        refresh();
        loadFailures();
        break;
      case 'paused':
      case 'paused_idle':
        appendLogLine('-- paused --', 'muted small');
        refresh();
        break;
      case 'resumed':
      case 'started':
        appendLogLine('-- running --', 'muted small');
        refresh();
        break;
      case 'idle':
        appendLogLine('-- idle (queue drained) --', 'muted small');
        refresh();
        loadFailures();
        break;
      case 'paper_uploaded':
        appendLogLine(`  ↑ paper_${event.paper_id} uploaded manually (${Math.round((event.size || 0) / 1024)} KB)`, 'muted small');
        refresh();
        loadFailures();
        break;
      case 'discarded':
        logEl.innerHTML = '';
        refresh();
        loadFailures();
        break;
      case 'queue_sync':
        if (event.added > 0) appendLogLine(`+ ${event.added} new pending from triage`, 'muted small');
        refresh();
        break;
      case 'error':
        appendLogLine(`error: ${event.error}`, 'error-text');
        refresh();
        break;
    }
  }

  async function attachStream() {
    try {
      const res = await fetch('/api/download/stream');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let event;
          try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
          handleEvent(event);
        }
      }
    } catch (e) {
      console.warn('download stream closed:', e?.message);
    }
  }

  await refresh();
  await loadFailures();
  attachStream();

  return () => {
    if (reader) {
      try { reader.cancel(); } catch {}
    }
  };
}
