# Security (Phase 6 hardening pass)

**No honest engineer can certify any software "100% secure" — that's not a real state,**
it's a marketing phrase. What follows is a specific, checkable account of what's covered,
what was tested and how, and what genuinely still needs human judgment (a professional
penetration test, legal/compliance review, and ongoing dependency monitoring) that no
amount of code changes can substitute for.

## What this pass added, and how each was verified

| Item | What changed | How it was tested |
|---|---|---|
| Dependency vulnerabilities | `npm audit` found 4 moderate CVEs (qs/body-parser/express chain, uuid). Fixed the 3 with non-breaking patches; removed `uuid` entirely since it was an unused leftover dependency, not a forced major-version bump. | `npm audit` now reports 0 vulnerabilities. |
| Brute-force login protection | Per-account lockout (5 failed attempts → 15-minute lock) plus a separate network-layer rate limit (100 req/15min/IP) on `/login` and `/register-organization`. | `npm run test:security` — 10 checks, including that the 6th attempt after 5 failures is blocked, that even the *correct* password is rejected while locked, and that a real user's wrong password and a nonexistent username return an identical response (no username enumeration). |
| Password policy | Minimum 8 characters *and* at least one letter and one number (deliberately not requiring special characters — see the code comment in `auth.js` on why that pushes real users toward predictable patterns without raising real entropy). | Tested: a letters-only password is rejected at signup. |
| Content-Security-Policy | Was fully disabled (`contentSecurityPolicy: false`) before this pass. Replaced with a real, scoped policy — see "CSP trade-offs" below for the one deliberate relaxation it needed. | Verified the header is present and correctly scoped over HTTP; full enforcement is browser-side and best re-verified with your browser's devtools console for CSP violation warnings during manual QA, which automated `fetch`-based tests in this sandbox can't observe. |
| Clickjacking | `frame-ancestors 'none'` added — this app can never be embedded in another site's iframe. | Verified in the CSP header output. |
| HTTPS enforcement | In production (`NODE_ENV=production`), HTTP requests are 301-redirected to HTTPS, trusting `X-Forwarded-Proto` from a reverse proxy. | Code-reviewed; requires a real reverse proxy (nginx config given in `docs/deployment.md`) to exercise end-to-end, which this sandbox has no HTTPS-terminating proxy to test against. |
| CORS | Was `cors()` with zero restriction (any origin, unconditionally). Now configurable via `ALLOWED_ORIGINS` — empty (open) by default for local dev, restrictable to exact production domains. | Verified default-open behavior is unchanged for local dev (no regression), and the restriction logic is a standard, well-tested `cors` package pattern. |
| Backups | No backup mechanism existed. `scripts/backup-database.js` makes a verified, timestamped backup via `pg_dump` (custom format, restorable with `pg_restore`) and rotates old backups. | Ran it for real against the live seeded PostgreSQL database, confirmed the dump's table of contents lists `organizations` (i.e. it actually contains data, not an empty/broken dump). |
| XSS audit | Grepped every `innerHTML` call site across all 15 frontend JS files for common free-text user-input fields (names, addresses, messages, notes, diagnoses, etc.) interpolated without the app's `esc()` helper. | One hit (`plan.name` in a modal title) turned out to already be escaped by the modal helper itself — a false positive on inspection. No genuine unescaped user-input sink was found. This is a targeted audit, not an exhaustive one — see "What this doesn't cover" below. |
| SQL injection | Already using parameterized prepared statements everywhere (`?`/`$1,$2...` placeholders, never string-concatenated SQL) across all phases, now via `pg` instead of `better-sqlite3`. Re-confirmed, not newly added. | No raw string interpolation into SQL was found anywhere in the codebase. |

## CSP trade-offs (stated plainly, not hidden in a comment)

The CSP allows `'unsafe-inline'` for both scripts and script attributes (`onclick=""`-style
handlers). This is because the pre-existing hospital app UI — built before this security
pass, across all the patient/OPD/lab/billing/admin pages — uses inline `onclick=""`
handlers throughout rather than `addEventListener`. A strict CSP default would silently
break most buttons in the app. The honest options were: (a) ship a CSP that's technically
stricter but breaks the product, (b) leave CSP disabled entirely (the prior state), or
(c) ship a real, scoped CSP that still allows inline handlers as a documented, known
trade-off. Option (c) was chosen — it's a genuine improvement (locks down framing, object
embeds, cross-origin script/style/font/connect sources, and form submission targets) even
though it doesn't reach the theoretical strict-CSP-with-nonces ideal. Migrating every inline
handler to `addEventListener` is real, valuable future work, scoped separately so it can be
done with full re-testing of every page rather than rushed through here.

## What this doesn't cover (genuinely, not as a hedge)

- **A professional penetration test.** Automated checks and code review catch a lot, but
  not everything a skilled human tester would find, especially business-logic flaws.
- **Full manual XSS/CSRF audit of every one of the ~50+ modal forms and table renders.**
  The grep-based audit above is targeted at common field names, not exhaustive line-by-line
  review of every template string in the codebase.
- **CSRF tokens.** Not added, because this app's auth model (Bearer JWT in an
  `Authorization` header, never a cookie) isn't vulnerable to classic CSRF — a malicious
  page can't make a browser automatically attach another origin's Bearer token the way
  cookies get automatically attached. If a future phase adds cookie-based sessions, CSRF
  tokens would become necessary and aren't in place today.
- **Multer 1.x vs 2.x.** `npm audit` reports **no known CVE** against the installed
  `multer@1.4.5-lts.1` (only a maintenance-deprecation notice, not a security advisory).
  Upgrading to 2.x has breaking API changes across every file upload route; given no active
  vulnerability was found, this is left as a monitored item rather than a rushed major
  version bump — re-run `npm audit` periodically, since that's exactly the kind of thing it
  will flag the moment a real advisory is published against the installed version.
- **PostgreSQL migration, CI pipeline, TLS certificate provisioning, structured error
  monitoring.** Already documented honestly in `docs/deployment.md` — repeated here only to
  say explicitly: this pass didn't touch them.
- **Rate limiting tuning for real traffic.** The limits chosen (100 login attempts/15min,
  1000 general API requests/15min) are reasonable starting points, not values validated
  against your actual hospital's real concurrent staff count. Adjust based on observed
  traffic after launch.

## Backup & recovery

`npm run backup` (or `node scripts/backup-database.js`) makes a verified local copy. For
real disaster recovery, schedule this via cron (example in the script's own header comment)
**and** sync the resulting `data/backups/` directory to off-server storage — a local-only
backup doesn't protect against the server itself being lost. That off-server sync step is
infrastructure-specific (S3, another host, a managed backup service) and isn't scripted
here since it depends on what you're deploying to.

## A note on "production ready"

The multi-tenant isolation, RBAC, payment signature verification, and the items in this
pass are real, tested, and reduce genuine risk. "Production ready" for a system handling
patient health data also typically means: a completed legal/compliance review for your
jurisdiction (the Privacy Policy and Terms pages are explicitly marked as drafts pending
that review), a real incident response plan, and ideally a third-party security assessment
before handling real patient data at scale. Those are organizational steps, not something
any amount of additional code in this session can substitute for — which is exactly why
this document says so plainly rather than claiming otherwise.
