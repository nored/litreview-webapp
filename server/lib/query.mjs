// query.mjs
//
// Structured query interface over the SQLite store. Lets a caller
// (or the UI's stage-5 search bar) compose targeted queries like
//
//   dataset:MIMIC-III AND method_family:deep_learning AND results.F1>0.8
//   category:privacy AND tech_stack:bert-base
//   methodology_type:experimental AND year>=2023
//   "graph neural network" AND framework:RAG
//
// without writing raw SQL. The grammar is intentionally small — the
// goal is "expressive enough to compose realistic gap-hypothesis
// verifications", not a general DSL.
//
// Grammar (whitespace-tolerant):
//
//   query        := clause ( (AND|OR) clause )*
//   clause       := field_clause | quoted_text | bare_word
//   field_clause := key (op value | : value)
//   key          := IDENT ( '.' IDENT )?           // e.g. results.f1
//   op           := '>=' | '<=' | '>' | '<' | '=' | ':'
//   value        := quoted_text | bare_token
//
// Boolean precedence: AND > OR (standard). Parentheses not supported in
// v1; complex queries split into multiple calls.
//
// Resolution: each field_clause maps to a SQL fragment + binding. Some
// fields require JOINs (results, name_usage, paper_category). The
// builder accumulates joins; the final WHERE is an AND/OR tree of the
// per-clause fragments.
//
// Free-text clauses ("graph neural network") OR-aggregate via BM25 over
// title + abstract, then intersect with the structured filter. Hybrid
// retrieval surfaces at this layer once we wire it in (M5).

import * as store from './store.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Tokeniser
// ─────────────────────────────────────────────────────────────────────────

function tokenise(input) {
  const out = [];
  let i = 0;
  const s = String(input || '').trim();
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    // Quoted string.
    if (ch === '"' || ch === "'") {
      const quote = ch; i++;
      let buf = '';
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; }
        else buf += s[i++];
      }
      i++;   // closing quote
      out.push({ kind: 'str', value: buf });
      continue;
    }
    // Operator.
    const op2 = s.slice(i, i + 2);
    if (op2 === '>=' || op2 === '<=' || op2 === '!=') {
      out.push({ kind: 'op', value: op2 }); i += 2; continue;
    }
    if (ch === '>' || ch === '<' || ch === '=' || ch === ':') {
      out.push({ kind: 'op', value: ch }); i++; continue;
    }
    // Bare token.
    let buf = '';
    while (i < s.length && !/[\s:=<>"']/.test(s[i])) buf += s[i++];
    if (!buf) { i++; continue; }
    // Keywords AND / OR detected later.
    out.push({ kind: 'word', value: buf });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Parser — produces a tree of { type: 'AND'|'OR'|'clause', ... }
// ─────────────────────────────────────────────────────────────────────────

function parse(tokens) {
  // Split by OR first (lowest precedence), then by AND, then each leaf
  // is one clause.
  function splitBy(toks, keyword) {
    const groups = [[]];
    for (const t of toks) {
      if (t.kind === 'word' && t.value.toUpperCase() === keyword) groups.push([]);
      else groups[groups.length - 1].push(t);
    }
    return groups.filter((g) => g.length > 0);
  }

  function parseLeaf(toks) {
    // Field clause: word op value | word ':' value
    if (toks.length >= 3 && toks[0].kind === 'word' && toks[1].kind === 'op') {
      const key = toks[0].value;
      const op = toks[1].value === ':' ? '=' : toks[1].value;
      const v = toks[2];
      const value = v.kind === 'str' ? v.value : v.value;
      return { type: 'clause', key, op, value };
    }
    // Quoted free text.
    if (toks.length === 1 && toks[0].kind === 'str') {
      return { type: 'text', value: toks[0].value };
    }
    // Bare words concatenated as free text.
    const words = toks.filter((t) => t.kind === 'word').map((t) => t.value);
    if (words.length > 0) return { type: 'text', value: words.join(' ') };
    return null;
  }

  const orGroups = splitBy(tokens, 'OR');
  const orParts = [];
  for (const g of orGroups) {
    const andGroups = splitBy(g, 'AND');
    const andParts = andGroups.map(parseLeaf).filter(Boolean);
    if (andParts.length === 0) continue;
    orParts.push(andParts.length === 1 ? andParts[0] : { type: 'AND', children: andParts });
  }
  if (orParts.length === 0) return null;
  if (orParts.length === 1) return orParts[0];
  return { type: 'OR', children: orParts };
}

// ─────────────────────────────────────────────────────────────────────────
// SQL builder — converts the parsed tree into a SELECT query
// ─────────────────────────────────────────────────────────────────────────

const ALLOWED_OPS = new Set(['=', '>', '<', '>=', '<=', '!=']);

// Map field key → { sql_expression, joins } where joins is an array of
// JOIN fragments. Each call to fieldExpr may add joins to the builder.
function fieldExpr(builder, rawKey) {
  const key = rawKey.toLowerCase();
  // Direct paper columns.
  const directs = new Set(['paper_id', 'title', 'year', 'venue', 'doi', 'arxiv_id', 'triage_label', 'source_database']);
  if (directs.has(key)) return `papers.${key}`;
  // Author lookup.
  if (key === 'author') {
    builder.joins.add('LEFT JOIN paper_authors a ON a.paper_id = papers.paper_id');
    return 'a.author_name';
  }
  // Category lookup.
  if (key === 'category') {
    builder.joins.add('LEFT JOIN paper_category pc ON pc.paper_id = papers.paper_id');
    return 'pc.category';
  }
  // Name usage: tech_stack / datasets_used / frameworks_cited; plus
  // shorthand "dataset", "tech", "framework".
  const nameKinds = {
    tech_stack: 'tech', datasets_used: 'dataset', frameworks_cited: 'framework',
    tech: 'tech', dataset: 'dataset', framework: 'framework',
  };
  if (key in nameKinds) {
    const kind = nameKinds[key];
    const alias = 'nu_' + kind;
    builder.joins.add(`LEFT JOIN name_usage ${alias} ON ${alias}.paper_id = papers.paper_id AND ${alias}.kind = '${kind}'`);
    return `${alias}.canonical`;
  }
  // results.<metric>  →  results.metric='F1' AND results.value
  if (key.startsWith('results.')) {
    const sub = key.slice('results.'.length);
    builder.joins.add('LEFT JOIN results ON results.paper_id = papers.paper_id');
    if (sub === 'metric') return 'results.metric';
    if (sub === 'dataset') return 'results.dataset';
    if (sub === 'split') return 'results.split';
    if (sub === 'value' || sub === '') return 'results.value';
    // Treat as a metric-specific value: e.g. results.f1 → "results.metric='f1' AND results.value <op> ?"
    builder.fixedClauses.add(`results.metric = '${sub.toLowerCase()}'`);
    return 'results.value';
  }
  // paper_field generic key: methodology_type, system_domain, sample_type,
  // method_family, sample_size, and all the bool signals.
  // We alias so multiple fields can be filtered without colliding.
  const alias = 'pf_' + key.replace(/[^a-z0-9]/g, '_');
  builder.joins.add(`LEFT JOIN paper_field ${alias} ON ${alias}.paper_id = papers.paper_id AND ${alias}.field_name = '${key}'`);
  return `${alias}.field_value`;
}

// Convert a value to its bound form. For string fields lowercase the
// comparison; for numeric fields cast. We let SQLite handle the
// dynamic typing for numeric LIKE.
function clauseSql(builder, node) {
  if (!ALLOWED_OPS.has(node.op)) throw new Error('unsupported operator: ' + node.op);
  const expr = fieldExpr(builder, node.key);
  // Numeric comparisons go via direct CAST.
  if (['>', '<', '>=', '<='].includes(node.op)) {
    const v = Number(node.value);
    if (!Number.isFinite(v)) throw new Error('numeric comparison needs a number: ' + node.value);
    builder.binds.push(v);
    return `CAST(${expr} AS REAL) ${node.op} ?`;
  }
  // Equality / inequality: case-insensitive on text.
  builder.binds.push(node.value);
  return `LOWER(${expr}) ${node.op === '!=' ? '!=' : '='} LOWER(?)`;
}

function textSql(builder, node) {
  // Free text → LIKE against title + abstract (fast and predictable;
  // M5 will swap in hybrid retrieval at this layer).
  const v = `%${node.value.toLowerCase()}%`;
  builder.binds.push(v, v);
  return `(LOWER(papers.title) LIKE ? OR LOWER(papers.abstract) LIKE ?)`;
}

function buildWhere(builder, node) {
  if (!node) return '1=1';
  if (node.type === 'clause') return clauseSql(builder, node);
  if (node.type === 'text')   return textSql(builder, node);
  if (node.type === 'AND' || node.type === 'OR') {
    const parts = node.children.map((c) => buildWhere(builder, c));
    return '(' + parts.join(` ${node.type} `) + ')';
  }
  throw new Error('unknown node type: ' + node.type);
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run a structured query. Returns
 *   { papers: [{paper_id, title, year, venue, ...}], sql, binds, query }
 * where `sql` is the compiled SQL (handy for debugging) and `query` is
 * the parsed tree.
 *
 * opts:
 *   limit  — max papers to return (default 100)
 *   orderBy — 'year_desc' (default) | 'year_asc' | 'title'
 */
export async function runQuery(input, opts = {}) {
  await store.init();
  const limit = Math.min(opts.limit ?? 100, 1000);
  const orderBy = opts.orderBy || 'year_desc';
  const tokens = tokenise(input);
  const tree = parse(tokens);

  const builder = {
    joins: new Set(),
    binds: [],
    fixedClauses: new Set(),
  };
  const where = tree ? buildWhere(builder, tree) : '1=1';
  const fixedWhere = [...builder.fixedClauses].join(' AND ');
  const orderSql = orderBy === 'year_asc'  ? 'papers.year ASC NULLS LAST'
                : orderBy === 'title'     ? 'papers.title ASC'
                : orderBy === 'paper_id'  ? 'papers.paper_id ASC'
                :                           'papers.year DESC NULLS LAST';
  const sql = `
    SELECT DISTINCT papers.paper_id, papers.title, papers.year, papers.venue,
           papers.doi, papers.arxiv_id, papers.pdf_path,
           (SELECT COUNT(*) FROM chunks WHERE paper_id = papers.paper_id) AS chunk_count,
           (SELECT COUNT(*) FROM paper_field WHERE paper_id = papers.paper_id) AS field_count
      FROM papers
      ${[...builder.joins].join(' ')}
     WHERE ${where}
       ${fixedWhere ? ' AND ' + fixedWhere : ''}
     ORDER BY ${orderSql}
     LIMIT ${limit}
  `;
  let rows;
  try {
    rows = store.query(sql, builder.binds);
  } catch (e) {
    return { papers: [], error: e.message, sql, binds: builder.binds, query: tree };
  }
  return { papers: rows, sql, binds: builder.binds, query: tree };
}

// Surface the parser separately for tests / UI auto-complete.
export { tokenise, parse };
