# Aiventra Admin Control Center (Phase 3)

A separate, platform-staff-only surface for Aiventra to manage every hospital on the
platform — deliberately a different frontend (`/admin.html`) from the hospital app
(`/index.html`), matching the eventual `admin.aiventra.in` vs `app.aiventra.in` domain split
described in the original brief.

## Getting in

```bash
node scripts/create-super-admin.js "Your Name" <username> <password>
npm start
```

Then open `/admin.html` and sign in. This login is rejected for any non-`aiventra_super_admin`
account, and every `/api/platform/*` route independently re-checks the role server-side
(`requirePlatformAdmin` in `server/middleware/auth.js`) — the frontend check is not the real
security boundary, the backend is.

## What's in it

- **Organizations** — search/filter, view full detail (stats, staff, subscription, payment
  history, support tickets, storage used), activate/suspend/cancel, and internal notes that
  are never exposed to the hospital itself.
- **Plans** — the pricing editor Phase 2 documented as a gap is now real: edit any plan's
  price, limits, or trial length in the browser, and it's live on the public pricing
  endpoint immediately. No more re-running a seed script to change a price.
- **Analytics** — total/trial organizations, active subscriptions, MRR (monthly-equivalent,
  GST-exclusive), new signups, active users, OPD volume, failed payments, pending
  onboarding, open support tickets, total storage used across the platform.
- **Support Access** — Aiventra staff can *request* access to a hospital's data with a
  reason, but cannot grant it to themselves. The hospital's own admin approves (or denies)
  from their own Administration → Support tab, and every approval is time-boxed (1–24
  hours, default 4). The file-download guard added in Phase 1
  (`server/index.js`) now checks for exactly this: an approved, unexpired
  `support_access_requests` row for that admin and that organization — tested with a real
  before/after file-download check in `scripts/test-platform-admin.js`.

## Verifying it

```bash
npm run test:tenant-isolation   # 11 checks (unchanged, still passing)
npm run test:subscriptions      # 11 checks (unchanged, still passing)
npm run test:platform-admin     # 14 checks: auth boundary, org management, live plan
                                 #  edits, and the full support-access approval + file-gate flow
```

`test:platform-admin` needs `SUPERADMIN_USER` / `SUPERADMIN_PASS` env vars matching an
account created with `create-super-admin.js` (defaults to `superadmin` /
`AiventraAdmin2026` if you used the same values shown in the Quick Start).

## Documented remaining tasks

- **Subscription status automation.** Suspending an organization here is manual; there's
  still no scheduler flipping `payment_due → grace_period → suspended` automatically as
  dates pass (same gap noted in `docs/subscriptions.md`).
- **Support ticket assignment/routing.** Tickets can be raised and viewed on both sides, but
  there's no assignment, SLA tracking, or in-thread replies yet.
- **Audit trail for the Admin Control Center itself** is captured (`platform_audit_log`) but
  not yet surfaced in the admin UI — it's queryable via `GET /api/platform/audit-log` today.
- **Bulk actions / CSV export** on the organizations list.
