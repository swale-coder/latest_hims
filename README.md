# Aiventra Hospital Management System SaaS — Phases 1–7

This is the original City Care Hospital HMS (Node.js/Express + SQLite, vanilla JS frontend),
converted into a multi-tenant SaaS product in stages:

1. **Multi-tenant core** — hard data isolation between hospitals, new SaaS roles.
2. **Subscriptions & Razorpay billing** — real order creation and signature verification.
3. **Aiventra Admin Control Center** — a separate platform-staff dashboard at `/admin.html`.
4. **Public marketing website** — at `/marketing/index.html`.
5. **Subscription lifecycle automation & onboarding wizard** — real status aging and a real
   setup checklist.
6. **Security hardening** — dependency vulnerabilities fixed, brute-force login protection,
   a real Content-Security-Policy, restrictable CORS, tested backups, and an honest account
   of what still needs a human (penetration testing, legal review) rather than more code.
7. **Password reset & staff invitations** — real token-based flows for both, closing the
   two account-management gaps flagged earlier.

Each phase's own doc (`docs/tenant-isolation.md`, `docs/subscriptions.md`,
`docs/admin-control-center.md`, `docs/marketing-site.md`, `docs/deployment.md`,
`docs/security.md`) has the full design write-up and an honest list of what's still left.

Every button is still wired to a real database. Nothing here is a mockup — admitting a
patient really occupies a bed, finalizing a bill really generates a PDF, and now, every
single one of those operations is scoped to exactly one hospital.

---

## 1. Requirements

- Node.js 18+ (tested on Node 22)
- npm

## 2. Setup (first time)

```bash
cd HMS_Aiventra-main
npm install
npm run seed                     # creates two demo hospitals for isolation testing
npm start
```

The app runs at **http://localhost:4000**.

## 3. Demo login credentials

Two independent, fully isolated demo hospitals are seeded so you can see (and test) that
data never crosses between them.

**Hospital A — City Care Hospital** (`citycare`)

| Role | Username | Password |
|---|---|---|
| Organization Owner | `owner.hospitala` | `admin123` |
| Hospital Admin / Manager | `manager.hospitala` | `manager123` |
| Receptionist | `reception.hospitala` | `reception123` |
| Doctor (General Medicine) | `dr.sharma.hospitala` | `doctor123` |
| Nurse | `nurse.anita.hospitala` | `nurse123` |
| Lab Staff | `lab.deepa.hospitala` | `lab123` |
| Pharmacy Staff | `pharmacy.manoj.hospitala` | `pharmacy123` |

**Hospital B — Sunrise Multispecialty Hospital** (`sunrise`)

Same usernames with `.hospitalb` instead of `.hospitala` (e.g. `owner.hospitalb`), same
passwords.

Log in as Hospital A and Hospital B in two different browser sessions and confirm neither
can see the other's patients, admissions, beds, or bills.

## 4. Proving tenant isolation

```bash
npm run test:tenant-isolation
```

Runs 11 live checks against the running server: cross-tenant reads, writes, file downloads,
and a natural-language AI assistant query are all confirmed blocked, while each hospital can
still access its own data. See [`docs/tenant-isolation.md`](docs/tenant-isolation.md) for
what each check does.

## 5. Upgrading an existing single-tenant database

If you already have a copy of the original (pre-SaaS) database with real data in it, **do
not delete it.** Run:

```bash
npm run migrate:tenancy
```

This backs up the original file, builds a new multi-tenant database, copies every row
across, remaps old role names to the new ones, and only swaps it into place after verifying
row counts match. The original file is kept on disk. Full details in
[`docs/tenant-isolation.md`](docs/tenant-isolation.md).

## 6. Public QR self-registration

Each hospital's OPD self-registration QR code (generated from **Administration → QR Code**
while logged in) now encodes that hospital's own identifier
(`/opd-register.html?org=<slug>`), so a patient scanning Hospital A's poster always
registers into Hospital A's queue, never Hospital B's.

## 7. New SaaS-ready roles

`organization_owner`, `hospital_admin`, `doctor`, `receptionist`, `accountant`,
`pharmacy_staff`, `lab_staff`, `nurse`, `report_viewer` — plus `aiventra_super_admin`
reserved for Aiventra's own platform staff (not used by any hospital account).

## 8. Subscriptions & Razorpay billing (Phase 2)

The platform's own SaaS billing — Aiventra charging each hospital a subscription — is now
built with real Razorpay order creation and real HMAC signature verification (never a faked
"payment successful"). See [`docs/subscriptions.md`](docs/subscriptions.md) for exactly what
was tested, what requires your own Razorpay keys to try live, and what's honestly still left
for a later phase (proration, automatic period-end enforcement, the Aiventra Admin plan
editor).

```bash
npm run seed:plans            # seeds the 4 standard plans (also runs automatically on first start)
npm run test:subscriptions    # 11 checks: plan listing, org scoping, signature verification
```

Open **Subscription** in the app sidebar (as an Organization Owner or Hospital Admin) to see
the plan picker and checkout flow.

## 9. Aiventra Admin Control Center (Phase 3)

A separate platform-staff-only dashboard at `/admin.html` for managing every hospital on the
platform: organization list/detail/suspend, a live-editable plan/pricing editor, platform
analytics (MRR, signups, OPD volume, storage), and an approval-gated support-access flow
(Aiventra can *request* access to a hospital's data; only that hospital's own admin can
grant it, and every grant expires automatically). See
[`docs/admin-control-center.md`](docs/admin-control-center.md) for the full write-up.

```bash
node scripts/create-super-admin.js "Your Name" <username> <password>
npm start
# open /admin.html and sign in
npm run test:platform-admin   # 14 checks against a running server
```

## 10. Public marketing website (Phase 4)

A full public site — homepage, features, solutions, pricing, security, about, contact, book
a demo, FAQ, signup, privacy policy, terms — at `/marketing/index.html` (kept separate from
the hospital app at `/`; see [`docs/marketing-site.md`](docs/marketing-site.md) for why).
Pricing pulls live data from the real plans API, the signup form creates a genuinely new
isolated hospital tenant, and the demo/contact forms write real leads to the database.

```bash
npm start
# open http://localhost:4000/marketing/index.html
```

## 11. Subscription lifecycle automation & onboarding wizard (Phase 5)

Subscriptions now really age through `active → payment_due → grace_period → suspended` as
dates pass, run automatically every hour (`scripts/subscription-lifecycle-sweep.js`), and
trial organizations that never subscribe expire automatically too. A real onboarding
checklist lives at `/#/onboarding` in the hospital app, tracking hospital profile
completion, plan selection, structure setup and staff invitations against the database —
not a static progress bar.

```bash
npm run test:lifecycle          # 20 checks: onboarding + lifecycle sweep, including idempotency
npm run sweep:subscriptions     # run the sweep manually / from an external cron job
```

PostgreSQL migration and full production deployment configuration (reverse proxy, process
management, CI) are documented honestly in
[`docs/deployment.md`](docs/deployment.md) — including why a full Postgres port wasn't
attempted in this phase rather than doing it shallowly.

## 12. Security hardening pass (Phase 6)

A real hardening pass, not a marketing claim of "100% secure" (no honest engineer can
certify that). Fixed all known dependency vulnerabilities (`npm audit`: 0 now), added
brute-force login protection (per-account lockout + rate limiting), a real scoped
Content-Security-Policy (was previously disabled entirely), restrictable CORS, a tested
database backup script, and a targeted XSS audit. Every item is verified, not just
asserted — see [`docs/security.md`](docs/security.md) for exactly what was done, how it was
tested, and — just as importantly — what genuinely still needs a human (a professional
penetration test, legal/compliance review) rather than more code.

```bash
npm run test:security    # 10 checks: lockout, rate limiting, password policy, headers
npm run backup           # verified database backup
npm audit                # 0 vulnerabilities
```

## 13. Password reset & staff invitations (Phase 7)

Two real account-management flows that were previously missing entirely:

- **Password reset** — `/marketing/forgot-password.html` → `/marketing/reset-password.html`,
  backed by single-use, hashed, 1-hour-expiring tokens (never the raw token stored, same
  pattern as password hashing itself). Resetting clears any active brute-force lockout too.
- **Staff invitations** — Administration → Users → "Invite Staff" sends a 7-day invitation
  link (`/accept-invite.html`) instead of requiring an admin to set a temporary password on
  someone else's behalf. Pending invitations are listed and revocable.

No real email provider is configured out of the box — this follows the same honest pattern
already used for SMS in this app (`server/utils/helpers.js:sendSMS`): every email's full
content, including the actual reset/invite link, is generated for real and logged to a new
`email_log` table (and printed to the console in dev), rather than silently discarded or
faked as "sent". See `server/utils/email.js` — it's the single function to replace with a
real provider (SendGrid/SES/etc) when you're ready; nothing else needs to change.

```bash
npm run test:accounts   # 24 checks: reset token lifecycle, invitation lifecycle,
                         # cross-tenant isolation of both, and a quick full-suite regression
```

## 14. What's next

See [`docs/tenant-isolation.md`](docs/tenant-isolation.md),
[`docs/subscriptions.md`](docs/subscriptions.md),
[`docs/admin-control-center.md`](docs/admin-control-center.md),
[`docs/marketing-site.md`](docs/marketing-site.md),
[`docs/deployment.md`](docs/deployment.md), and
[`docs/security.md`](docs/security.md) for what's left: PostgreSQL migration, a CI
pipeline, TLS/certificate provisioning, structured error monitoring, a professional
penetration test, and legal/compliance review of the Privacy Policy and Terms drafts.
