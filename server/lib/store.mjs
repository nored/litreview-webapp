// store.mjs
//
// SQLite-backed structured store via `sql.js` (pure-WASM SQLite, no native
// bindings, runs in Node and could be moved to the browser later). The
// schema lives in `server/lib/schema.sql`; see that file for table layout.
//
// Lifecycle:
//
//   const store = await init();
//   const papers = store.query('SELECT * FROM papers WHERE year > ?', [2020]);
//   store.exec('INSERT INTO papers (paper_id, title) VALUES (?, ?)', ['001','Hi']);
//   store.transaction(() => { ... });        // BEGIN .. COMMIT (or ROLLBACK)
//   await store.flush();                      // force persist-to-disk now
//   await store.close();                      // flush + dispose
//
// Persistence model: sql.js holds the whole database in memory. Writes
// don't reach disk by default; we schedule a debounced flush after each
// write so the on-disk image stays warm without IO on every statement.
// `flush()` forces an immediate write and `close()` flushes synchronously
// before disposing. The database file lives at
// `<project>/data/store.sqlite`.
//
// Foreign keys: SQLite requires `PRAGMA foreign_keys = ON` per connection
// to enforce them. We set it on init().
//
// Provenance contract: every populated structured field row in non-meta
// tables should carry a `provenance_id` referencing the provenance table.
// Use `recordProvenance(...)` from this module to obtain a prov_id.

import initSqlJs from 'sql.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../paths.mjs';
import { ensureDir } from '../storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILENAME = 'store.sqlite';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const FLUSH_DEBOUNCE_MS = 500;

let _db = null;
let _dbPath = null;
let _flushTimer = null;
let _flushPromise = null;

// Resolve the sql-wasm.wasm file shipped inside the sql.js package. Lets us
// run without the file being on PATH or in CWD — important for tests and
// for running from a sub-directory. sql.js's package.json doesn't expose
// './package.json' via the exports field, so we resolve via the main entry
// (which IS exported) and take its directory.
function locateWasm(file) {
  const mainUrl = import.meta.resolve('sql.js');           // file://.../dist/sql-wasm.js
  const distDir = path.dirname(fileURLToPath(mainUrl));    // .../dist
  return path.join(distDir, file);
}

/**
 * Initialise the store. Idempotent — calling twice returns the same handle.
 *
 * opts.dbPath  — override the on-disk path (default: project/data/store.sqlite)
 */
export async function init(opts = {}) {
  if (_db) return _api();

  const dbPath = opts.dbPath || path.join(DATA_DIR, DB_FILENAME);
  await ensureDir(path.dirname(dbPath));

  const SQL = await initSqlJs({ locateFile: locateWasm });

  let db;
  try {
    const blob = await fs.readFile(dbPath);
    db = new SQL.Database(new Uint8Array(blob));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    db = new SQL.Database();
  }

  // FK enforcement — must be set after open per SQLite docs.
  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA journal_mode = MEMORY;');  // sql.js has no real journaling
  db.run('PRAGMA synchronous = NORMAL;');

  // Apply schema. All CREATE statements are `IF NOT EXISTS`, so applying
  // on every boot is the migration step.
  const schemaSql = await fs.readFile(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);

  _db = db;
  _dbPath = dbPath;
  runMigrations(db);
  return _api();
}

// Idempotent post-schema migrations. The schema.sql file uses
// `INSERT OR IGNORE` for the version stamp, which means existing
// databases never advance their schema_version even after we ship new
// tables. Migrations explicitly bump the version when their idempotent
// preconditions are met (e.g. "the new table now exists").
function runMigrations(db) {
  function getVersion() {
    try {
      const r = db.exec('SELECT value FROM schema_meta WHERE key = "schema_version"');
      return parseInt(r?.[0]?.values?.[0]?.[0] ?? '1', 10);
    } catch { return 1; }
  }
  function setVersion(v) {
    db.run('UPDATE schema_meta SET value = ? WHERE key = "schema_version"', [String(v)]);
    db.run('INSERT OR IGNORE INTO schema_meta (key, value) VALUES ("schema_version", ?)', [String(v)]);
  }
  function hasTable(name) {
    const r = db.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${name}'`);
    return (r?.[0]?.values?.length || 0) > 0;
  }

  function hasColumn(table, col) {
    try {
      const r = db.exec(`PRAGMA table_info(${table})`);
      const values = r?.[0]?.values || [];
      return values.some((row) => row[1] === col);
    } catch { return false; }
  }

  let current = getVersion();
  // v1 → v2: dismissed_candidates table introduced.
  if (current < 2 && hasTable('dismissed_candidates')) {
    setVersion(2);
    current = 2;
  }
  // v2 → v3: dismissed_candidates.content_json added.
  if (current < 3 && hasTable('dismissed_candidates') && !hasColumn('dismissed_candidates', 'content_json')) {
    db.run('ALTER TABLE dismissed_candidates ADD COLUMN content_json TEXT');
    setVersion(3);
    current = 3;
  } else if (current < 3 && hasTable('dismissed_candidates') && hasColumn('dismissed_candidates', 'content_json')) {
    // Column already exists (fresh schema applied a new DB); just bump.
    setVersion(3);
    current = 3;
  }
  // v3 → v4: grobid-js structured-parse tables. schema.sql's CREATE IF
  // NOT EXISTS handles the actual creation; the bump just acknowledges
  // the tables are present.
  if (current < 4 && hasTable('sections') && hasTable('paragraphs') && hasTable('reference_list')) {
    setVersion(4);
    current = 4;
  }
  // v4 → v5: Phase 2 entity_spans table.
  if (current < 5 && hasTable('entity_spans')) {
    setVersion(5);
    current = 5;
  }
  // v5 → v6: Phase 3 emergent-cluster tables + cluster_id columns on
  // member tables (papers, claims). entity_spans.cluster_id already
  // existed in the v5 schema.
  if (current < 6) {
    if (hasTable('papers') && !hasColumn('papers', 'paper_cluster_id')) {
      db.run('ALTER TABLE papers ADD COLUMN paper_cluster_id INTEGER REFERENCES paper_clusters(cluster_id)');
    }
    if (hasTable('papers') && !hasColumn('papers', 'method_cluster_id')) {
      db.run('ALTER TABLE papers ADD COLUMN method_cluster_id INTEGER REFERENCES method_clusters(cluster_id)');
    }
    if (hasTable('claims') && !hasColumn('claims', 'cluster_id')) {
      db.run('ALTER TABLE claims ADD COLUMN cluster_id INTEGER REFERENCES claim_clusters(cluster_id)');
    }
    if (hasTable('paper_clusters') && hasTable('claim_clusters') &&
        hasTable('method_clusters') && hasTable('entity_clusters')) {
      setVersion(6);
      current = 6;
    }
  }
  // Future migrations chain here. Each is idempotent: precondition + bump.
}

function _api() {
  return { db: () => _db, query, exec, run, transaction, recordProvenance, flush, close, dbPath: () => _dbPath };
}

/**
 * SELECT. Returns an array of plain-object rows. Bind parameters via the
 * second argument: positional `?` placeholders or named `:name` keys.
 */
export function query(sql, params = []) {
  _assert();
  const stmt = _db.prepare(sql);
  try {
    if (params && (Array.isArray(params) ? params.length : Object.keys(params).length)) {
      stmt.bind(params);
    }
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

/**
 * INSERT / UPDATE / DELETE. Returns { changes, lastInsertId }.
 * Schedules a debounced flush to disk after the statement.
 */
export function exec(sql, params = []) {
  _assert();
  const stmt = _db.prepare(sql);
  try {
    if (params && (Array.isArray(params) ? params.length : Object.keys(params).length)) {
      stmt.bind(params);
    }
    stmt.step();
    const changes = _db.getRowsModified();
    // last_insert_rowid is connection-global; safe because we're single-
    // threaded.
    const idRow = _db.exec('SELECT last_insert_rowid() AS id');
    const lastInsertId = idRow?.[0]?.values?.[0]?.[0] ?? null;
    _scheduleFlush();
    return { changes, lastInsertId };
  } finally {
    stmt.free();
  }
}

/**
 * Run a statement (or multiple semicolon-separated statements) without
 * returning rows. Use for DDL or bulk fire-and-forget writes.
 */
export function run(sql) {
  _assert();
  _db.exec(sql);
  _scheduleFlush();
}

/**
 * Wrap `fn` in BEGIN/COMMIT. Rolls back on throw. Returns whatever fn returned.
 * Nested transactions are NOT supported (sql.js doesn't expose savepoints
 * here); callers should avoid nesting.
 */
export function transaction(fn) {
  _assert();
  _db.run('BEGIN');
  try {
    const result = fn();
    _db.run('COMMIT');
    _scheduleFlush();
    return result;
  } catch (e) {
    try { _db.run('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

/**
 * Insert a provenance row and return its prov_id for use as a foreign key
 * in the field/row that's recording it. Keeps callers from re-typing the
 * insert statement repeatedly.
 *
 * record fields:
 *   mechanism (required)            — 'regex' | 'nli_zero_shot' | ...
 *   model, pattern, chunk_id, page, raw_text, confidence
 *   classifier_scores               — object; serialised to JSON
 *   llm_prompt, llm_response
 */
export function recordProvenance(record) {
  if (!record || typeof record !== 'object' || !record.mechanism) {
    throw new Error('recordProvenance: { mechanism } is required');
  }
  const { changes: _c, lastInsertId } = exec(
    `INSERT INTO provenance
       (mechanism, model, pattern, chunk_id, page, raw_text,
        classifier_scores_json, confidence, llm_prompt, llm_response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.mechanism,
      record.model ?? null,
      record.pattern ?? null,
      record.chunk_id ?? null,
      record.page ?? null,
      record.raw_text ?? null,
      record.classifier_scores ? JSON.stringify(record.classifier_scores) : null,
      record.confidence ?? null,
      record.llm_prompt ?? null,
      record.llm_response ?? null,
    ],
  );
  return lastInsertId;
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flush().catch((e) => console.warn('store.mjs: flush failed:', e?.message || e));
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * Force-write the in-memory DB to disk. Safe to call any time; if a flush
 * is already in flight, returns the same promise so callers don't double-
 * write.
 */
export async function flush() {
  if (!_db || !_dbPath) return;
  if (_flushPromise) return _flushPromise;
  _flushPromise = (async () => {
    const blob = _db.export();
    await fs.writeFile(_dbPath, Buffer.from(blob));
  })().finally(() => { _flushPromise = null; });
  return _flushPromise;
}

/**
 * Flush + dispose. After close(), init() must be called again before use.
 */
export async function close() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  await flush();
  if (_db) { _db.close(); _db = null; _dbPath = null; }
}

/**
 * Drop the in-memory database WITHOUT flushing to disk. Used by reset:
 * close() would write the stale data back over the file we just
 * unlinked, defeating the wipe. discard() throws everything away.
 */
export function discard() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_db) { _db.close(); _db = null; _dbPath = null; }
}

function _assert() {
  if (!_db) throw new Error('store.mjs: init() must be called first');
}
