# SQLite → PostgreSQL + Multi-Tenancy Migration — Summary

## Starting point

This codebase already had full multi-tenant isolation built in at the SQLite layer
(`organization_id` on every table, JWT-derived `req.orgId` — never trusted from the client,
`requireOrgContext` middleware, scoped file uploads, and an existing tenant-isolation test
suite). That part of the original ask was already done; this pass is the PostgreSQL
conversion, done in a way that preserves it exactly.

## What changed

### 1. `server/db.js` — rewritten on `pg`, same call shape everywhere else
Every route file already called `db.prepare(sql).get(...)/.all(...)/.run(...)`. The new
`db.js` keeps that exact shape (so route files barely changed) but talks to PostgreSQL
underneath, translating:
- `?` positional placeholders → `$1, $2, ...`
- `datetime('now'[, modifier])` / `date('now'[, 'start of month'])` → Postgres expressions
  producing the **same text format**, so date columns stay `TEXT` and no parsing code changed
- bare `INSERT`s get `RETURNING id` auto-appended, so `.run().lastInsertRowid` keeps working
  (the one exception, `hospital_settings`, has a composite primary key and is special-cased)
- `db.transaction(fn)` reimplemented with real `BEGIN`/`COMMIT`/`ROLLBACK` on one connection,
  propagated through nested calls via `AsyncLocalStorage`

### 2. Schema converted, original kept as backup
- `server/schema.sql` → renamed to `server/schema.sqlite.sql`, untouched, for reference
- `server/schema.postgres.sql` — generated from it: `AUTOINCREMENT` → `SERIAL`, inline
  `REFERENCES` pulled out into trailing `ALTER TABLE ... ADD CONSTRAINT` statements (Postgres
  rejects forward references at table-creation time; SQLite doesn't), date defaults
  translated as above. Applied cleanly to a real Postgres 16 instance: 43 tables, all FKs,
  all indexes, all `CHECK`/`UNIQUE` constraints preserved.

### 3. Every route file converted to async/await
`better-sqlite3` was synchronous; `pg` isn't. ~440 call sites across 23 route files plus
`index.js` and the shared helpers got `await` added and their enclosing functions marked
`async` — done with an AST-based codemod for the mechanical part, then hand-reviewed file by
file. A handful of `.forEach()`/`.map()` sites needed manual conversion to `for...of` /
`Promise.all()`, since `forEach` silently doesn't wait for async callbacks (a real bug the
codemod couldn't safely fix on its own — found in `beds.js`, `billing.js`,
`hospitalConfig.js`, and the standalone seed/sweep scripts).

**No business logic, routes, request/response contracts, or frontend code changed.**

### 4. Data migration script
`scripts/migrate-sqlite-to-postgres.js` — copies every row from an existing
`data/hospital.db` into PostgreSQL, table by table in FK-dependency order, preserving
primary keys so every relationship stays intact, then resets each table's `SERIAL` sequence
past the migrated max id. Your original SQLite file is only ever read, never modified —
keep it as your pre-migration backup. Safe to re-run (`ON CONFLICT (id) DO NOTHING`); pass
`--wipe` for a clean reload.

### 5. Backups
`scripts/backup-database.js` rewritten to use `pg_dump` (custom format) instead of
SQLite's file-copy backup API, with the same verify-and-rotate behavior as before.

### 6. Everything else
`scripts/seed-plans.js`, `scripts/create-super-admin.js`,
`scripts/subscription-lifecycle-sweep.js`, `server/seed.js`, `server/seedBilling.js` — all
converted by hand (they had the same `forEach`-with-async-work pattern the codemod couldn't
safely handle). `package.json` updated (`pg` added, `better-sqlite3` moved to
`devDependencies` since it's now only used by the migration script). `.env.example` and
`docs/deployment.md` / `docs/security.md` updated to describe the Postgres setup.

## Verification

Ran a full reset → seed → serve → test cycle against a real local PostgreSQL 16 instance.
**All 6 of the project's existing test suites pass completely — 90/90 checks:**

| Suite | Result |
|---|---|
| `test:tenant-isolation` | 11/11 ✓ |
| `test:subscriptions` | 11/11 ✓ |
| `test:platform-admin` | 14/14 ✓ |
| `test:security` | 10/10 ✓ |
| `test:lifecycle` | 20/20 ✓ |
| `test:accounts` (password reset / invitations) | 24/24 ✓ |

Also verified directly: the schema applies cleanly to a fresh database; `server/seed.js`
and `server/seedBilling.js` run end-to-end and seed two isolated demo hospitals with
realistic data (admissions, surgeries, lab orders, billing, discharges); the data migration
script correctly preserves ids, resets sequences, and is idempotent; the backup script
produces a verified, restorable `pg_dump`.

## How to run it

1. **Install PostgreSQL** (if not already) and create the database:
   ```bash
   createdb aiventra
   # or: psql -U postgres -c "CREATE DATABASE aiventra;"
   ```

2. **Copy `.env.example` to `.env`** and fill in your values:
   ```env
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=aiventra
   DB_USER=postgres
   DB_PASSWORD=sa@123
   JWT_SECRET=<a long random string>
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **If you have an existing `data/hospital.db` with real data**, migrate it:
   ```bash
   node scripts/migrate-sqlite-to-postgres.js data/hospital.db
   ```
   (Your original `hospital.db` is left untouched — keep it as a backup.)
   If you don't have existing data and just want demo data instead, skip this step and use
   step 6.

5. **Start the server** (this also creates the schema automatically if it doesn't exist yet):
   ```bash
   npm start
   ```

6. **(Optional, fresh installs only) Seed demo data:**
   ```bash
   node server/seed.js
   ```

7. **Create a platform super-admin** (if you need one):
   ```bash
   node scripts/create-super-admin.js "Your Name" <username> <password>
   ```

8. **Run the test suites** (server must be running):
   ```bash
   node scripts/test-tenant-isolation.js
   node scripts/test-subscription-flow.js
   node scripts/test-platform-admin.js       # needs a super-admin created above
   node scripts/test-security-hardening.js
   node scripts/test-lifecycle-and-onboarding.js
   node scripts/test-password-reset-and-invitations.js
   ```

9. **Back up the database** any time with:
   ```bash
   node scripts/backup-database.js
   ```

Everything else — the frontend, API routes, request/response shapes, business logic, and
tenant isolation — is unchanged from before this migration.
