// ===================== POSTGRESQL DATABASE LAYER =====================
// This file used to open a local SQLite file with better-sqlite3. It has been converted
// to talk to PostgreSQL instead, but it keeps the SAME call shape the rest of the app
// already uses everywhere: db.prepare(sql).get(...params) / .all(...) / .run(...).
// That is what makes this a small, mechanical migration rather than a rewrite: every
// route file still writes SQLite-flavoured SQL with `?` placeholders; this module
// transparently translates it to PostgreSQL before sending it over the wire.
//
// The one unavoidable difference: better-sqlite3 was synchronous, a real network
// database driver cannot be. So every call site now needs `await` in front of it
// (db.prepare(...).get() -> await db.prepare(...).get()) and its enclosing function
// needs to be `async`. That is the only mechanical change made to route files.
//
// See docs/postgres-migration.md for the full list of what changed and why.
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Accepts either this project's own DB_* variable names OR the standard libpq PG* names
// (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD) - the .env this project ships with uses the
// PG* names. Previously only DB_* was read here, so a .env with just PG* values was silently
// ignored in favor of these hardcoded fallbacks; that happened to still connect correctly
// only because the fallbacks below matched the .env's PG* values by coincidence. DB_* is
// checked first so it still wins if both are ever set.
const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432', 10),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'aiventra',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD, // ALWAYS from env - never hard-coded here
  max: parseInt(process.env.DB_POOL_MAX || '10', 10)
});

pool.on('error', (err) => {
  // A background/idle client error should never crash the whole process.
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

// ---- Transaction context propagation ----
// db.transaction(fn) needs every db.prepare(...).get/all/run() call made *inside* fn to
// run on the SAME client/connection (so BEGIN/COMMIT/ROLLBACK actually wrap them). Since
// queries normally borrow a random connection from the pool, we track "the client for the
// currently-running transaction" using AsyncLocalStorage, which automatically follows
// async/await call chains - no need to thread a `client` parameter through every helper.
const txContext = new AsyncLocalStorage();

// ---- SQLite -> PostgreSQL SQL translation ----
// Kept entirely inside this module so every existing route file's SQL text (written for
// SQLite) keeps working completely unmodified.

// datetime('now'[, modifier]) / date('now'[, 'start of month']) -> Postgres expressions
// that produce the SAME text format SQLite produced ('YYYY-MM-DD HH:MI:SS' / 'YYYY-MM-DD'),
// so every column can stay TEXT and no application-level date parsing needs to change.
function translateDateFunctions(sql) {
  // datetime('now', ?) - modifier supplied as a bind parameter, e.g. '-30 days'
  sql = sql.replace(/datetime\(\s*'now'\s*,\s*\?\s*\)/gi,
    `to_char((now() at time zone 'utc') + (?)::interval, 'YYYY-MM-DD HH24:MI:SS')`);
  // datetime('now','-30 days') - modifier as a literal
  sql = sql.replace(/datetime\(\s*'now'\s*,\s*'([^']*)'\s*\)/gi,
    (m, mod) => `to_char((now() at time zone 'utc') + interval '${mod}', 'YYYY-MM-DD HH24:MI:SS')`);
  // datetime('now')
  sql = sql.replace(/datetime\(\s*'now'\s*\)/gi,
    `to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')`);
  // date('now','start of month')
  sql = sql.replace(/date\(\s*'now'\s*,\s*'start of month'\s*\)/gi,
    `to_char(date_trunc('month', now() at time zone 'utc'), 'YYYY-MM-DD')`);
  // date('now')
  sql = sql.replace(/date\(\s*'now'\s*\)/gi,
    `to_char(now() at time zone 'utc', 'YYYY-MM-DD')`);
  return sql;
}

// `?` positional placeholders -> $1, $2, ... (skipping `?` that appear inside quoted
// string literals, so nothing inside the SQL text itself is mistaken for a parameter).
function toPositionalPlaceholders(sql) {
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (inString && sql[i + 1] === "'") { out += "''"; i++; continue; } // escaped '' inside a string
      inString = !inString;
      out += c;
      continue;
    }
    if (c === '?' && !inString) { n += 1; out += '$' + n; continue; }
    out += c;
  }
  return out;
}

// better-sqlite3's info.lastInsertRowid (used ~70 times across the app after INSERTs) has
// no PostgreSQL equivalent, so RETURNING id is appended automatically to any bare INSERT
// that doesn't already have one. Every table in this schema uses `id` as its primary key,
// so this is safe without inspecting each statement individually.
// Tables whose primary key is NOT a plain `id` column (checked against schema.sql - this
// is the one exception: hospital_settings uses a composite PRIMARY KEY (organization_id, key)).
// Bare INSERTs into these tables must NOT get `RETURNING id` appended, since the column
// doesn't exist - .run().lastInsertRowid is simply undefined for these, matching what
// better-sqlite3 also returned for tables without a rowid alias.
const TABLES_WITHOUT_ID = new Set(['hospital_settings']);

function ensureReturningId(sql) {
  const trimmed = sql.trim();
  const m = trimmed.match(/^insert\s+into\s+(\w+)/i);
  if (!m) return sql;
  if (TABLES_WITHOUT_ID.has(m[1].toLowerCase())) return sql;
  if (/\breturning\b/i.test(trimmed)) return sql;
  return sql.replace(/;\s*$/, '') + ' RETURNING id';
}

function translate(sql, { forRun } = {}) {
  let out = translateDateFunctions(sql);
  if (forRun) out = ensureReturningId(out);
  out = toPositionalPlaceholders(out);
  return out;
}

function flattenArgs(args) {
  // Every call site in this codebase uses spread args: .get(a, b, c). Also tolerate a
  // single array argument (.get([a, b, c])) as a safety net.
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

async function runQuery(sql, params) {
  const client = txContext.getStore();
  if (client) return client.query(sql, params);
  return pool.query(sql, params);
}

class Statement {
  constructor(sql) {
    this.sql = sql;
  }
  async get(...args) {
    const params = flattenArgs(args);
    const res = await runQuery(translate(this.sql, { forRun: false }), params);
    return res.rows[0];
  }
  async all(...args) {
    const params = flattenArgs(args);
    const res = await runQuery(translate(this.sql, { forRun: false }), params);
    return res.rows;
  }
  async run(...args) {
    const params = flattenArgs(args);
    const res = await runQuery(translate(this.sql, { forRun: true }), params);
    const row = res.rows && res.rows[0];
    return {
      changes: res.rowCount || 0,
      lastInsertRowid: row && Object.prototype.hasOwnProperty.call(row, 'id') ? row.id : undefined
    };
  }
}

const db = {
  prepare(sql) {
    return new Statement(sql);
  },

  // Raw multi-statement execution (schema loading, ad-hoc DDL/scripts).
  async exec(sql) {
    const client = txContext.getStore();
    if (client) return client.query(sql);
    return pool.query(sql);
  },

  // Drop-in replacement for better-sqlite3's db.transaction(fn): returns a function that,
  // when called, runs `fn` inside BEGIN/COMMIT (ROLLBACK on error) on a single dedicated
  // connection. Unlike the old synchronous version, both the returned function AND `fn`
  // itself must now be async, and callers must `await` the returned function.
  transaction(fn) {
    return async (...args) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await txContext.run(client, () => fn(...args));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
        throw err;
      } finally {
        client.release();
      }
    };
  },

  // Exposed for scripts that need a raw client (migrations, backups).
  pool,

  // ---- Startup: create schema + apply small additive migrations ----
  // Called once from server/index.js (and from seed/utility scripts) before anything else
  // touches the database. Mirrors what the old db.js did synchronously at require-time,
  // just as an explicit async step since a real DB connection can't be awaited at
  // require-time in CommonJS.
  async init() {
    const schemaPath = path.join(__dirname, 'schema.postgres.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schema);

    // ---- Additive column migrations for existing databases ----
    // Small, purely-additive schema changes (new nullable columns) are applied here
    // automatically, same intent as the old SQLite version's ensureColumn helper.
    async function ensureColumn(table, column, ddl) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ddl}`);
    }
    await ensureColumn('organizations', 'trial_ends_at', 'trial_ends_at TEXT');
    await ensureColumn('users', 'failed_login_attempts', 'failed_login_attempts INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('users', 'locked_until', 'locked_until TEXT');
  }
};

module.exports = db;
