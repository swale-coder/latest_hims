# Tenant Isolation — Design & Verification

This is Phase 1 of the Aiventra SaaS conversion: turning the existing single-tenant HMS into
a securely multi-tenant one. Later phases (subscriptions/Razorpay, Aiventra Admin Control
Center, public marketing site) build on top of this foundation.

## How isolation works

1. **Every hospital-owned table has an `organization_id` column** (see `server/schema.sql`).
   28 tables in total — patients, OPD, admissions, beds, billing, lab, discharge, audit logs,
   the AI query log, everything.

2. **The organization is derived exclusively from the authenticated session.**
   `server/middleware/auth.js` verifies the JWT and `requireOrgContext` copies
   `organization_id` from the verified token onto `req.orgId`. Route handlers use
   `req.orgId` — never a value from `req.body`, `req.params`, or `req.query`.

3. **Every query is filtered by `organization_id`,** including:
   - Reads (`SELECT ... WHERE ... AND organization_id = ?`)
   - Writes (`INSERT` always includes `organization_id`)
   - Updates/deletes (`WHERE id = ? AND organization_id = ?` — a cross-tenant `id` guess
     returns 404, not someone else's row)
   - Joins (every `JOIN` clause also pins `organization_id` on both sides)
   - File uploads/downloads (`uploads/organization-<id>/...` + an authenticated guard in
     `server/index.js` that checks the requester's own `organization_id` before serving
     any file)
   - The natural-language "Ask AI" assistant (a real, tested leak: without this, a typed
     Patient ID from another hospital would have returned that hospital's data)

## Deliberate simplifications (documented, not oversights)

- **Business identifiers stay globally unique** (`PAT-000001`, `OPD-...`, `ADM-...`,
  `INV-...`) rather than unique-per-organization. This is *safer*, not weaker — no two
  hospitals can ever collide on an ID. The only trade-off is cosmetic (Hospital B's first
  patient won't necessarily be `PAT-000001`). Listed as a remaining task if per-org
  numbering becomes a hard requirement.
- **`users.username` is globally unique**, and each user belongs to exactly one
  organization. This keeps login simple (username + password only) rather than requiring a
  subdomain/org picker step. Aiventra platform staff will use `organization_id = NULL`
  (role `aiventra_super_admin`) in a later phase.
- **Bed numbers** are globally unique too, for the same reason; the seed data therefore
  prefixes them per hospital (e.g. `HOSPITALA-101`, `HOSPITALB-101`).

## What is NOT yet built (later phases)

- The Aiventra Admin Control Center is now built — see [`docs/admin-control-center.md`](admin-control-center.md).
- Subscriptions / Razorpay billing is now built — see [`docs/subscriptions.md`](subscriptions.md).
- The full onboarding wizard — `POST /api/auth/register-organization` creates a working,
  isolated organization + owner account today, but doesn't yet walk through bed count,
  department setup, staff invites, or plan selection.
- Aiventra staff support access — the file-download guard already refuses platform-admin
  requests with a clear message, pending the approval-based support session flow.

## Verifying it yourself

```
npm install
npm run seed                     # creates two demo hospitals: citycare and sunrise
npm start                        # starts the server
npm run test:tenant-isolation    # runs 11 live HTTP checks against a running server
```

The test logs in as both hospitals' owners and, using Hospital B's token, attempts to read
Hospital A's patient record, admission, billing account, and receipt file, attempts to
modify Hospital A's OPD visit, and asks the AI assistant a question containing Hospital A's
Patient ID. All are confirmed blocked (404/403), while Hospital A can still read its own
data normally.

## Migrating an existing (pre-tenant) database

If you have real data in the *original* single-tenant schema, do **not** delete it — run:

```
npm run migrate:tenancy
```

This makes a timestamped backup (`data/hospital.pre-tenant-backup-<timestamp>.db`, kept
forever), builds a new database on the multi-tenant schema, copies every row across with an
injected `organization_id`, remaps old role names to the new ones, verifies row counts, and
only then swaps the new file into place. This was tested against a full copy of the original
project's demo database (12 users, 13 patients, 8 admissions, 30 billing transactions) with
100% of rows migrated and verified.
