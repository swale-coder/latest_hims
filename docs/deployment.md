# Deployment & PostgreSQL Migration (Phase 5)

## What's built and tested in this phase

- **Subscription lifecycle automation** (`scripts/subscription-lifecycle-sweep.js`) — ages
  subscriptions `active → payment_due → grace_period → suspended` and expires trial
  organizations that never subscribe, all as real dates pass. Scheduled automatically every
  hour in `server/index.js` for local/single-instance use. Tested with 20 checks
  (`npm run test:lifecycle`), including that it's idempotent (safe to run repeatedly) and
  that it can't fabricate a duplicate transition.
- **Onboarding wizard** (`/#/onboarding` in the hospital app, `server/routes/onboarding.js`)
  — a real checklist (hospital profile, plan selection, structure setup, staff invites) with
  live status tracked in the database, not a static "3 of 4 steps" mockup. Tested end-to-end
  in the same suite.

## Production process management

For a real deployment, replace the in-process `setInterval` lifecycle sweep with an actual
cron entry, since an in-process timer only runs once per server instance — with more than
one instance behind a load balancer, you'd get duplicate sweeps (harmless here since the
sweep is idempotent, but wasteful and a bad pattern to rely on):

```cron
# Run hourly on exactly one designated instance/worker, not on every app server
0 * * * * cd /path/to/app && node scripts/subscription-lifecycle-sweep.js >> /var/log/aiventra-sweep.log 2>&1
```

Run the app itself under a process manager (pm2 shown; systemd works equally well):

```bash
npm install -g pm2
pm2 start server/index.js --name aiventra-hms -i 1   # -i 1: see "Why not cluster mode" below
pm2 save
pm2 startup
```

**Why not cluster mode (`-i max`) without extra care:** this codebase's in-process
lifecycle scheduler assumes a single instance (see the updated note under "PostgreSQL
migration" below) — run `scripts/subscription-lifecycle-sweep.js` as an external cron job
instead before running multiple instances.

## Domain / reverse proxy layout

Matching the brief's intended structure — one Node process, reverse-proxied to different
paths per subdomain:

```
aiventra.in         -> this app's  /marketing/  path
app.aiventra.in      -> this app's  /            path (the hospital SPA)
admin.aiventra.in    -> this app's  /admin.html  path
api.aiventra.in      -> this app's  /api/        path (same origin as app./admin., listed
                        separately only if you want a dedicated API subdomain later)
```

Example nginx server block for `aiventra.in` (repeat similarly for the other subdomains,
adjusting the `proxy_pass` path prefix):

```nginx
server {
    listen 443 ssl;
    server_name aiventra.in;
    # ssl_certificate / ssl_certificate_key via certbot or your provider

    location / {
        proxy_pass http://127.0.0.1:4000/marketing/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Environment variables for production

See `.env.example` for the full list. At minimum for production: `JWT_SECRET` (long random
value — the server refuses to start without one when `NODE_ENV=production`), `NODE_ENV=production`,
and the three `RAZORPAY_*` values with live (not test) keys once you're ready to accept real
payments.

## PostgreSQL migration

**Done.** The app now runs on PostgreSQL instead of SQLite/better-sqlite3, with full
multi-tenant isolation preserved and re-verified against all six existing test suites
(90/90 checks passing: `test:tenant-isolation`, `test:subscriptions`, `test:platform-admin`,
`test:security`, `test:lifecycle`, `test:accounts`).

What changed, concretely:

1. **`server/db.js`** was rewritten around `pg` instead of `better-sqlite3`, but keeps the
   exact same `db.prepare(sql).get(...)/.all(...)/.run(...)` call shape every route file
   already used. It transparently translates `?` placeholders to `$1,$2,...`,
   `datetime('now', ...)`/`date('now', ...)` to equivalent Postgres expressions (producing
   the identical text format, so no column types or app-level parsing changed), and
   auto-appends `RETURNING id` to bare INSERTs so `.run().lastInsertRowid` keeps working.
   `db.transaction(fn)` is reimplemented with real `BEGIN`/`COMMIT`/`ROLLBACK` on a single
   connection, propagated via `AsyncLocalStorage`.
2. Every route file (~440 call sites across 23 files) had `await` added in front of each
   `db.prepare(...).get/all/run()` call and its enclosing function marked `async` — a
   mechanical change with no logic rewrites, done via an AST codemod and then hand-checked
   file by file (a handful of `.forEach`/`.map()` sites needed converting to `for...of` /
   `Promise.all()` by hand, since `forEach` silently doesn't await async callbacks).
3. **`server/schema.postgres.sql`** was generated from the original `server/schema.sql`
   (kept, untouched, as `server/schema.sqlite.sql`): `AUTOINCREMENT` → `SERIAL`, inline
   `REFERENCES` pulled out into trailing `ALTER TABLE ... ADD CONSTRAINT` statements (Postgres
   rejects forward references at table-creation time; SQLite doesn't), and date-function
   defaults translated as above. Applied cleanly to a real local Postgres 16 instance: all
   43 tables, all foreign keys, all indexes.
4. **`scripts/migrate-sqlite-to-postgres.js`** is the real data migration script: copies every
   row across all 43 tables from an existing `data/hospital.db` into Postgres in FK-dependency
   order, preserving primary keys (so all relationships stay intact), then resets each table's
   sequence past the migrated max id. Tested end-to-end with a seeded SQLite fixture: ids
   preserved exactly, sequences correctly continue post-migration, re-running without
   `--wipe` is a safe no-op (`ON CONFLICT (id) DO NOTHING`), `--wipe` gives a clean reload.
5. The original SQLite database file is never touched by any of this — keep it as your
   pre-migration backup, exactly as before.

**Why not cluster mode (`-i max`) yet**, updated: the single-file constraint from
better-sqlite3 is gone now that Postgres is a real network database, but the in-process
lifecycle scheduler (`setInterval` in `server/index.js`) still assumes one instance. Run
`scripts/subscription-lifecycle-sweep.js` as an external cron job (see above) before scaling
to multiple app instances, same as before.

## Remaining items after this phase

- A CI pipeline (GitHub Actions or similar) running `npm run test:tenant-isolation`,
  `test:subscriptions`, `test:platform-admin`, and `test:lifecycle` automatically on every
  push, rather than run manually as done throughout this build.
- HTTPS/TLS termination configuration (covered at the nginx level above, but certificate
  provisioning/renewal, e.g. via certbot, isn't scripted here).
- Structured error monitoring (e.g. Sentry) — errors are currently caught and logged to
  stdout/stderr only.
