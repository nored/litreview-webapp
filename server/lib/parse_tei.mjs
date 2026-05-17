// parse_tei.mjs
//
// Parse the TEI-XML string grobid-js's `Grobid.processPdf()` returns
// into the structured shape postprocess uses (header / body.sections /
// body.figures / body.tables / references / citation markers nested in
// paragraphs).
//
// Uses fast-xml-parser with `preserveOrder: true` so that mixed-content
// elements (paragraphs containing inline <ref> citations) are kept in
// document order. The previous bucketed parse silently relocated every
// inline citation to the end of the paragraph because text and child
// elements were bucketed separately — that bug is what motivated this
// rewrite.

import { XMLParser } from 'fast-xml-parser';

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // CRITICAL: keep text + element ordering inside mixed-content nodes
  // like <p>...<ref>...</ref>...</p>. Without this, fast-xml-parser
  // bundles all text nodes under '#text' and all <ref> children under
  // 'ref', losing the position of each citation inside the prose.
  preserveOrder: true,
  textNodeName: '#text',
  // Don't trim — we need the spaces that surround inline refs so the
  // reconstructed prose joins cleanly. The final text gets a whitespace
  // collapse pass in `textOf`.
  trimValues: false,
  parseTagValue: false,
  // In preserveOrder mode, fast-xml-parser puts attributes under ':@'
  // by default. Do NOT also set attributesGroupName — it would
  // double-nest the attributes ({ ':@': { ':@': { '@_attr': value } } }).
});

// In preserveOrder mode every element node looks like:
//   { tagName: [...children array...], ':@': { '@_attr': value, ... } }
// where children are themselves the same shape, and text nodes are:
//   { '#text': 'literal text' }
// Root parse output is an array of such nodes.

// ─── Helpers over the ordered shape ───────────────────────────────────────

// Walk a children array, recursively concatenating all text content
// (including any inline <ref> surface text). Used wherever we want the
// human-readable prose of an element, preserving inline citation
// markers like "(Li, 2023)" in their original positions.
function textOf(children) {
  if (children == null) return '';
  if (!Array.isArray(children)) return '';
  let out = '';
  for (const node of children) {
    if (node == null || typeof node !== 'object') continue;
    if (node['#text'] != null) {
      out += String(node['#text']);
      continue;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === ':@') continue;
      out += textOf(v);
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Pick out every direct child of `parentChildren` with tag `tagName`.
function childrenOf(parentChildren, tagName) {
  if (!Array.isArray(parentChildren)) return [];
  const out = [];
  for (const node of parentChildren) {
    if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, tagName)) {
      out.push(node);
    }
  }
  return out;
}

// First child by tag.
function firstChild(parentChildren, tagName) {
  const arr = childrenOf(parentChildren, tagName);
  return arr.length ? arr[0] : null;
}

// Get the children array of an element node (given `{ p: [...] }`).
function bodyOf(node) {
  if (!node || typeof node !== 'object') return [];
  for (const [k, v] of Object.entries(node)) {
    if (k === ':@') continue;
    return Array.isArray(v) ? v : [];
  }
  return [];
}

// Get the attributes of an element node.
function attrsOf(node) {
  return (node && node[':@']) || {};
}

// Get a single attribute by name (without '@_' prefix), returning the
// raw value or null. Looks at the `':@'` map first, falls back to the
// legacy '@_attr' style for robustness.
function attr(node, name) {
  const a = attrsOf(node);
  const v = a[`@_${name}`];
  if (v != null) return String(v);
  if (node && Object.prototype.hasOwnProperty.call(node, `@_${name}`)) return String(node[`@_${name}`]);
  return null;
}

// Parse a TEI coords attribute (e.g. "1,142.3,318.4,412.0,330.5") into
// a bbox array. Multiple coords sets get concatenated.
function parseCoords(coordsStr) {
  if (!coordsStr) return null;
  const sets = String(coordsStr).split(';');
  const out = [];
  for (const s of sets) {
    const parts = s.split(',').map((x) => parseFloat(x));
    if (parts.length >= 5 && Number.isFinite(parts[0])) {
      out.push({ page: Math.round(parts[0]), x: parts[1], y: parts[2], w: parts[3], h: parts[4] });
    }
  }
  return out.length ? out : null;
}

function firstPage(coords) {
  if (!coords || coords.length === 0) return null;
  return coords[0].page;
}

// ─── Paragraph parsing — the core of the order-preserving fix ─────────────

// Walk a <p> element's children array in document order, building the
// reconstructed prose (with inline citation markers in their real
// positions) and collecting structured citation / figure-marker rows.
function parseParagraphChildren(children, page) {
  let text = '';
  const citations = [];
  const figureMarkers = [];
  for (const node of children) {
    if (node == null || typeof node !== 'object') continue;
    if (node['#text'] != null) {
      text += String(node['#text']);
      continue;
    }
    // Element child. In a <p> we expect <ref> for citations / figure
    // markers, plus possibly <hi> / <s> / <formula>. We extract text
    // from any element and treat <ref> specially.
    if (Object.prototype.hasOwnProperty.call(node, 'ref')) {
      const surface = textOf(node.ref);
      text += surface;
      const refType = attr(node, 'type');
      const refTarget = attr(node, 'target');
      const refCoords = parseCoords(attr(node, 'coords'));
      const entry = {
        text: surface,
        target: refTarget ? String(refTarget).replace(/^#/, '') : undefined,
        page: firstPage(refCoords) ?? page,
        bbox: refCoords,
      };
      if (refType === 'bibr') citations.push(entry);
      else if (refType === 'figure' || refType === 'table') figureMarkers.push(entry);
    } else {
      // Generic element — just absorb its text content.
      for (const [k, v] of Object.entries(node)) {
        if (k === ':@') continue;
        text += textOf(v);
      }
    }
  }
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    citations,
    figureMarkers,
  };
}

// Parse a <p> element node.
function parseParagraph(pNode) {
  const coords = parseCoords(attr(pNode, 'coords'));
  const page = firstPage(coords);
  const children = pNode.p || [];
  const { text, citations, figureMarkers } = parseParagraphChildren(children, page);
  return { text, page, bbox: coords, citations, figureMarkers };
}

// ─── Sections ─────────────────────────────────────────────────────────────

function levelFromHead(headNode) {
  if (!headNode) return 1;
  const n = attr(headNode, 'n');
  if (!n) return 1;
  const parts = String(n).split('.').filter(Boolean);
  return Math.max(1, parts.length);
}

function parseDiv(divNode, sections, paragraphs) {
  const children = divNode.div || [];
  const headNode = firstChild(children, 'head');
  const heading = headNode ? textOf(headNode.head) : '';
  const level = levelFromHead(headNode);
  const sectionIdx = sections.length;
  sections.push({ title: heading, level, paragraphs: [] });
  for (const pn of childrenOf(children, 'p')) {
    const parsed = parseParagraph(pn);
    sections[sectionIdx].paragraphs.push(parsed);
    paragraphs.push({ ...parsed, sectionIdx });
  }
  for (const sub of childrenOf(children, 'div')) {
    parseDiv(sub, sections, paragraphs);
  }
}

// ─── References ───────────────────────────────────────────────────────────

function parseBiblStruct(bNode) {
  const children = bNode.biblStruct || [];
  const id = attr(bNode, 'xml:id') || attr(bNode, 'id') || '';
  // ref label may live in <note type="raw_reference"> or @n.
  let refLabel = null;
  for (const n of childrenOf(children, 'note')) {
    const t = attr(n, 'type');
    if (t === 'raw_reference' || t === 'label') {
      refLabel = textOf(n.note);
      break;
    }
  }
  const analytic = firstChild(children, 'analytic');
  const monogr = firstChild(children, 'monogr');
  const analyticChildren = analytic ? analytic.analytic : [];
  const monogrChildren = monogr ? monogr.monogr : [];
  // Titles.
  let title = null;
  const analyticTitle = firstChild(analyticChildren, 'title');
  if (analyticTitle) title = textOf(analyticTitle.title);
  if (!title) {
    const monogrTitle = firstChild(monogrChildren, 'title');
    if (monogrTitle) title = textOf(monogrTitle.title);
  }
  let journal = null, booktitle = null;
  for (const t of childrenOf(monogrChildren, 'title')) {
    const level = attr(t, 'level');
    if (level === 'j') journal = textOf(t.title);
    else if (level === 'm' || level === 'a') booktitle = booktitle || textOf(t.title);
  }
  // Date / pages / volume from imprint.
  const imprint = firstChild(monogrChildren, 'imprint');
  const imprintChildren = imprint ? imprint.imprint : [];
  let dateRaw = null;
  const normalizedDate = {};
  for (const d of childrenOf(imprintChildren, 'date')) {
    const when = attr(d, 'when');
    if (when) {
      const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(String(when));
      if (m) {
        normalizedDate.year = m[1];
        if (m[2]) normalizedDate.month = m[2];
        if (m[3]) normalizedDate.day = m[3];
      }
      dateRaw = String(when);
    } else {
      const t = textOf(d.date);
      if (t) dateRaw = t;
    }
  }
  let pages = null, volume = null;
  for (const bs of childrenOf(imprintChildren, 'biblScope')) {
    const unit = attr(bs, 'unit');
    const inner = textOf(bs.biblScope);
    if (unit === 'page') {
      pages = inner || (attr(bs, 'from') && attr(bs, 'to') ? `${attr(bs, 'from')}–${attr(bs, 'to')}` : null);
    } else if (unit === 'volume') {
      volume = inner || null;
    }
  }
  let publisher = null;
  const publisherNode = firstChild(imprintChildren, 'publisher');
  if (publisherNode) publisher = textOf(publisherNode.publisher);
  // DOI / URL via idno.
  const idnoNodes = [...childrenOf(children, 'idno'), ...childrenOf(analyticChildren, 'idno'), ...childrenOf(monogrChildren, 'idno')];
  let doi = null, url = null;
  for (const idnoNode of idnoNodes) {
    const type = String(attr(idnoNode, 'type') || '').toLowerCase();
    const val = textOf(idnoNode.idno);
    if (!val) continue;
    if (type === 'doi') doi = val;
    else if (type === 'url') url = val;
  }
  // Authors.
  const authorNodes = [...childrenOf(analyticChildren, 'author'), ...childrenOf(monogrChildren, 'author')];
  const parsedAuthors = [];
  const authorNames = [];
  for (const aNode of authorNodes) {
    const persNameNode = firstChild(aNode.author, 'persName');
    if (!persNameNode) continue;
    const persChildren = persNameNode.persName;
    const forenames = childrenOf(persChildren, 'forename').map((f) => textOf(f.forename)).filter(Boolean);
    const surnameNode = firstChild(persChildren, 'surname');
    const surname = surnameNode ? textOf(surnameNode.surname) : null;
    if (forenames.length || surname) {
      const e = {};
      if (forenames.length) {
        e.forenames = [forenames[0]];
        if (forenames.length > 1) e.middlenames = forenames.slice(1);
      }
      if (surname) e.surname = surname;
      parsedAuthors.push(e);
      authorNames.push([forenames.join(' '), surname].filter(Boolean).join(' '));
    }
  }
  return {
    id,
    label: refLabel,
    authors: authorNames.length ? authorNames.join('; ') : null,
    parsedAuthors: parsedAuthors.length ? parsedAuthors : null,
    title,
    date: dateRaw,
    normalizedDate: Object.keys(normalizedDate).length ? normalizedDate : null,
    journal,
    booktitle,
    publisher,
    pages,
    volume,
    doi,
    url,
    rawText: textOf(children),
  };
}

// ─── Figures + tables ─────────────────────────────────────────────────────

function parseFigureNode(fNode) {
  const children = fNode.figure || [];
  const id = attr(fNode, 'xml:id') || attr(fNode, 'id') || '';
  const isTable = attr(fNode, 'type') === 'table';
  const headNode = firstChild(children, 'head');
  const figDescNode = firstChild(children, 'figDesc');
  const label = headNode ? textOf(headNode.head) : null;
  const caption = figDescNode ? textOf(figDescNode.figDesc) : (headNode ? textOf(headNode.head) : null);
  const coords = parseCoords(attr(fNode, 'coords'));
  return {
    id,
    label,
    caption,
    page: firstPage(coords),
    bbox: coords,
    isTable,
  };
}

// ─── Header ───────────────────────────────────────────────────────────────

function parseAffiliation(afNode) {
  const children = afNode.affiliation || [];
  const orgNodes = childrenOf(children, 'orgName');
  const institutions = orgNodes.filter((o) => attr(o, 'type') === 'institution').map((o) => textOf(o.orgName)).filter(Boolean);
  const departments  = orgNodes.filter((o) => attr(o, 'type') === 'department').map((o) => textOf(o.orgName)).filter(Boolean);
  const laboratories = orgNodes.filter((o) => attr(o, 'type') === 'laboratory').map((o) => textOf(o.orgName)).filter(Boolean);
  const addressNode = firstChild(children, 'address');
  const addrChildren = addressNode ? addressNode.address : [];
  const get = (tag) => {
    const c = firstChild(addrChildren, tag);
    return c ? textOf(c[tag]) : undefined;
  };
  return {
    institutions,
    departments,
    laboratories,
    settlement: get('settlement'),
    region: get('region'),
    postCode: get('postCode'),
    country: get('country'),
    addrLine: get('addrLine'),
    rawText: attr(afNode, 'n') || textOf(children),
  };
}

function parseAuthor(aNode) {
  const children = aNode.author || [];
  const persNode = firstChild(children, 'persName');
  if (!persNode) return null;
  const persChildren = persNode.persName;
  const forenames = childrenOf(persChildren, 'forename').map((f) => textOf(f.forename)).filter(Boolean);
  const surnameNode = firstChild(persChildren, 'surname');
  const surname = surnameNode ? textOf(surnameNode.surname) : null;
  const name = [forenames.join(' '), surname].filter(Boolean).join(' ').trim();
  if (!name) return null;
  const emailNode = firstChild(children, 'email');
  const email = emailNode ? textOf(emailNode.email) : undefined;
  const affiliations = childrenOf(children, 'affiliation').map(parseAffiliation);
  return { name, email, affiliations };
}

// ─── Top-level ─────────────────────────────────────────────────────────────

/**
 * Parse a TEI-XML string (as returned by grobid-js's `processPdf`) into
 * a ParsedDocument-shape object that grobid_postprocess.mjs can consume.
 */
export function parseTeiToParsedDocument(teiXml) {
  if (!teiXml || typeof teiXml !== 'string') {
    throw new Error('parseTeiToParsedDocument: empty or non-string input');
  }
  const root = PARSER.parse(teiXml);
  // root is an array; find the TEI element (skip XML declaration).
  const teiNode = firstChild(root, 'TEI') || firstChild(root, 'teiCorpus');
  const teiChildren = teiNode ? bodyOf(teiNode) : [];
  // ─── Header ─────────────────────────────────────────────────────────
  const teiHeader = firstChild(teiChildren, 'teiHeader');
  const teiHeaderChildren = teiHeader ? teiHeader.teiHeader : [];
  const fileDesc = firstChild(teiHeaderChildren, 'fileDesc');
  const fileDescChildren = fileDesc ? fileDesc.fileDesc : [];
  const profileDesc = firstChild(teiHeaderChildren, 'profileDesc');
  const profileDescChildren = profileDesc ? profileDesc.profileDesc : [];
  const sourceDesc = firstChild(fileDescChildren, 'sourceDesc');
  const sourceDescChildren = sourceDesc ? sourceDesc.sourceDesc : [];
  const headerBibl = firstChild(sourceDescChildren, 'biblStruct');
  const headerBiblChildren = headerBibl ? headerBibl.biblStruct : [];
  const headerAnalytic = firstChild(headerBiblChildren, 'analytic');
  const headerAnalyticChildren = headerAnalytic ? headerAnalytic.analytic : [];
  // Title.
  let title = null;
  const headerAnalyticTitle = firstChild(headerAnalyticChildren, 'title');
  if (headerAnalyticTitle) title = textOf(headerAnalyticTitle.title);
  if (!title) {
    const titleStmt = firstChild(fileDescChildren, 'titleStmt');
    if (titleStmt) {
      const t = firstChild(titleStmt.titleStmt, 'title');
      if (t) title = textOf(t.title);
    }
  }
  // Authors.
  const authors = childrenOf(headerAnalyticChildren, 'author').map(parseAuthor).filter(Boolean);
  // Abstract.
  const abstractNode = firstChild(profileDescChildren, 'abstract');
  let abstractText = null;
  if (abstractNode) {
    const aps = childrenOf(abstractNode.abstract, 'p');
    if (aps.length) abstractText = aps.map((pn) => textOf(pn.p)).join('\n\n');
    else abstractText = textOf(abstractNode.abstract);
  }
  // Keywords.
  const textClassNode = firstChild(profileDescChildren, 'textClass');
  const keywordsNode = textClassNode ? firstChild(textClassNode.textClass, 'keywords') : null;
  let keywords = [];
  if (keywordsNode) {
    const kterms = childrenOf(keywordsNode.keywords, 'term');
    if (kterms.length) keywords = kterms.map((t) => textOf(t.term)).filter(Boolean);
    else {
      const ktext = textOf(keywordsNode.keywords);
      if (ktext) keywords = ktext.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    }
  }
  // ─── Body ───────────────────────────────────────────────────────────
  const textNode = firstChild(teiChildren, 'text');
  const textChildren = textNode ? textNode.text : [];
  const bodyNode = firstChild(textChildren, 'body');
  const bodyChildren = bodyNode ? bodyNode.body : [];
  const sections = [];
  const flatParagraphs = [];
  for (const d of childrenOf(bodyChildren, 'div')) {
    parseDiv(d, sections, flatParagraphs);
  }
  // Figures + tables: direct children of body…
  const allFigures = [];
  const allTables = [];
  for (const f of childrenOf(bodyChildren, 'figure')) {
    const parsed = parseFigureNode(f);
    if (parsed.isTable) allTables.push(parsed);
    else allFigures.push(parsed);
  }
  // …and nested inside divs.
  for (const d of childrenOf(bodyChildren, 'div')) {
    for (const f of childrenOf(d.div, 'figure')) {
      const parsed = parseFigureNode(f);
      if (parsed.isTable) allTables.push(parsed);
      else allFigures.push(parsed);
    }
  }
  // ─── References ─────────────────────────────────────────────────────
  const backNode = firstChild(textChildren, 'back');
  const backChildren = backNode ? backNode.back : [];
  const references = [];
  for (const d of childrenOf(backChildren, 'div')) {
    if (attr(d, 'type') !== 'references') continue;
    for (const lb of childrenOf(d.div, 'listBibl')) {
      for (const b of childrenOf(lb.listBibl, 'biblStruct')) {
        references.push(parseBiblStruct(b));
      }
    }
  }
  for (const lb of childrenOf(backChildren, 'listBibl')) {
    for (const b of childrenOf(lb.listBibl, 'biblStruct')) {
      references.push(parseBiblStruct(b));
    }
  }
  return {
    header: { title, authors, abstract: abstractText, keywords },
    body: { sections, figures: allFigures, tables: allTables },
    references,
  };
}
