# Public Marketing Website (Phase 4)

## A deliberate URL decision

The hospital app (login, dashboard, everything built in Phases 1–3) keeps living at `/`,
unchanged, because it's already tested end-to-end and moving it would risk breaking working
functionality for no real benefit in a single local dev server. The marketing site lives
under `/marketing/*` instead of taking over `/`.

This mirrors where things are headed anyway: the original brief's deployment plan is
`aiventra.in` (marketing) and `app.aiventra.in` (the hospital app) as separate domains. In
production, `aiventra.in` would reverse-proxy to this app's `/marketing/` path, and
`app.aiventra.in` would proxy to `/`. Locally, open `http://localhost:4000/marketing/index.html`
to see the marketing site, and `http://localhost:4000/` for the hospital app.

## What's real, not mockup

- **Pricing page pulls live data** from `GET /api/subscriptions/plans` (built in Phase 2).
  Change a price in the Admin Control Center's plan editor (Phase 3) and it's correct on
  the public pricing page immediately — nothing here is a hardcoded second copy of the
  numbers.
- **Signup page** posts to the real `POST /api/auth/register-organization` endpoint (Phase
  1) and logs the new owner straight into a genuinely new, isolated hospital organization —
  the same tenant-isolation guarantees apply to a hospital that signs up from the marketing
  site as to the two demo hospitals.
- **Book a Demo and Contact forms** write to a real `marketing_leads` table via
  `POST /api/demo-requests` and `POST /api/contact`, with real validation (not a fake
  "thanks!" that discards the input) and their own rate limit. Aiventra admins can view
  submitted leads at `GET /api/platform/leads`.
- **Design system** follows the brand brief's given palette (off-white/navy/blue/purple)
  and pairs a warm display serif (Fraunces) against a clinical sans body face (Inter) —
  a deliberate choice, not the generic AI-page defaults (no cream-and-terracotta, no
  near-black-and-neon, no identical-shadow SaaS card kit). Animations are scroll-reveal and
  animated counters only, respecting `prefers-reduced-motion` throughout.
- **No invented legal or business details.** Privacy Policy and Terms of Service are
  honest working drafts that explicitly flag what's still pending (GSTIN, registration
  numbers, legal review) rather than inventing placeholder values, per the brief's explicit
  instruction not to invent the GSTIN.
- **No client logos or certifications** are shown anywhere, since none were provided and
  the brief explicitly said not to invent them.

## Pages

`/marketing/index.html`, `features.html`, `solutions.html`, `pricing.html`, `security.html`,
`about.html`, `contact.html`, `book-demo.html`, `faq.html`, `signup.html`,
`privacy-policy.html`, `terms-of-service.html`. `/login` isn't a separate marketing page —
the hospital app's own `/#/login` already handles it, so the marketing site's "Log In" links
straight there instead of duplicating a login form.

## Documented remaining tasks

- **The actual Aiventra logo** was referenced in the brief but never attached to any
  conversation — the header currently uses a simple gradient mark in the brand colors as a
  placeholder. Swap in the real logo file once provided; do not let this get "redesigned or
  distorted" as the brief warned against.
- **No production image assets** (team photos, real hospital screenshots) — the product
  preview on the homepage is a genuine CSS/HTML mockup of the actual OPD queue UI, not a
  stock photo, but higher-fidelity screenshots of the live app would strengthen it further.
- **SEO basics** (sitemap.xml, robots.txt, per-page Open Graph tags) aren't set up yet.
- **Marketing leads have no admin UI yet** — they're stored and queryable
  (`GET /api/platform/leads`) but not yet surfaced as a tab in `/admin.html` the way
  Organizations/Plans/Analytics/Support are.
