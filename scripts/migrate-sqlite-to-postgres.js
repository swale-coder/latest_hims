/**
 * migrate-sqlite-to-postgres.js
 * ----------------------------------------------------------------------------
 * One-time data migration: copies every row from the existing SQLite database
 * (data/hospital.db) into PostgreSQL, table by table, preserving primary keys so
 * every foreign key relationship (patients -> admissions -> billing -> ... ) stays
 * intact exactly as it was in SQLite.
 *
 * SAFETY:
 *   - This script only READS from SQLite (opened with { readonly: true }). Your
 *     original data/hospital.db is never modified or deleted - keep it as your
 *     pre-migration backup, exactly as requested.
 *   - Tables are copied in FK-dependency order (parents before children).
 *   - After loading each table's rows (with their original ids), the table's
 *     SERIAL sequence is reset to MAX(id)+1, so new rows created after migration
 *     get fresh, non-colliding ids.
 *   - Safe to re-run: pass --wipe to TRUNCATE every target table first (with
 *     RESTART IDENTITY CASCADE) before reloading, so re-running after fixing a
 *     problem doesn't create duplicate rows.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-postgres.js [path/to/hospital.db] [--wipe]
 *
 *   Defaults to data/hospital.db if no path is given. Requires the PostgreSQL
 *   schema to already exist (server/index.js or `node -e "require('./server/db').init()"`
 *   creates it automatically - this script also calls db.init() itself for safety).
 */
const path = require('path');
const fs = require('fs');
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('better-sqlite3 is not installed. Run: npm install better-sqlite3');
  process.exit(1);
}
const db = require('../server/db');

// Tables in FK-dependency order (parents before children) - matches the order tables
// are created in server/schema.sql / server/schema.postgres.sql.
const TABLES_IN_ORDER = [
  'organizations', 'organization_settings', 'platform_audit_log', 'support_tickets',
  'support_access_requests', 'users', 'floors', 'rooms', 'beds', 'patients',
  'patient_documents', 'departments', 'doctors', 'opd_visits', 'consultations',
  'admissions', 'bed_allocations', 'clinical_notes', 'vitals', 'prescriptions',
  'medication_administration', 'lab_orders', 'surgeries', 'surgical_items',
  'discharge_summaries', 'patient_timeline', 'notifications', 'sms_log', 'audit_log',
  'ai_query_log', 'billing_accounts', 'billing_transactions', 'invoices',
  'billing_rates', 'hospital_settings', 'plans', 'subscriptions',
  'subscription_payments', 'subscription_events', 'marketing_leads',
  'password_reset_tokens', 'invitations', 'email_log'
];

const args = process.argv.slice(2);
const wipe = args.includes('--wipe');
const dbPathArg = args.find(a => !a.startsWith('--'));
const SQLITE_PATH = dbPathArg || path.join(__dirname, '..', 'data', 'hospital.db');

function quoteIdent(name) {
  return `"${name}"`;
}

async function migrateTable(sqlite, table) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (cols.length === 0) {
    console.log(`  ${table}: not found in SQLite database, skipping.`);
    return { table, rows: 0, skipped: true };
  }

  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows.`);
    return { table, rows: 0 };
  }

  if (wipe) {
    await db.pool.query(`TRUNCATE TABLE ${quoteIdent(table)} RESTART IDENTITY CASCADE`);
  }

  const colList = cols.map(quoteIdent).join(', ');
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${placeholders})
    ON CONFLICT (id) DO NOTHING`;

  const client = await db.pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const values = cols.map(c => row[c]);
      const res = await client.query(insertSql, values);
      inserted += res.rowCount;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Failed migrating table "${table}": ${err.message}`);
  } finally {
    client.release();
  }

  // Move the table's id sequence past the highest migrated id so the next INSERT
  // (through the normal app, which never specifies id) doesn't collide.
  if (cols.includes('id')) {
    await db.pool.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1), true)`,
      [table]
    );
  }

  console.log(`  ${table}: ${inserted}/${rows.length} row(s) inserted${inserted !== rows.length ? ' (some skipped - already present)' : ''}.`);
  return { table, rows: rows.length, inserted };
}

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`SQLite database not found at ${SQLITE_PATH}`);
    console.error('Pass the path explicitly: node scripts/migrate-sqlite-to-postgres.js /path/to/hospital.db');
    process.exit(1);
  }

  console.log(`Source (read-only): ${SQLITE_PATH}`);
  console.log(`Target: ${process.env.DB_NAME || 'aiventra'} @ ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
  if (wipe) console.log('--wipe passed: target tables will be TRUNCATEd before loading.\n');

  const sqlite = new Database(SQLITE_PATH, { readonly: true });

  // Ensure the Postgres schema exists before we try to insert into it.
  await db.init();

  console.log('\nMigrating tables (parent -> child order):');
  const results = [];
  for (const table of TABLES_IN_ORDER) {
    results.push(await migrateTable(sqlite, table));
  }

  sqlite.close();

  const totalRows = results.reduce((s, r) => s + (r.rows || 0), 0);
  const totalInserted = results.reduce((s, r) => s + (r.inserted || 0), 0);
  console.log(`\nDone. ${totalInserted}/${totalRows} total row(s) migrated across ${results.filter(r => !r.skipped).length} table(s).`);
  if (totalInserted !== totalRows) {
    console.log('Some rows were skipped because a row with that id already existed in PostgreSQL');
    console.log('(expected on a re-run without --wipe). Re-run with --wipe for a completely clean reload.');
  }

  await db.pool.end();
}

main().catch(e => {
  console.error('\nMigration FAILED:', e.message);
  process.exit(1);
});
