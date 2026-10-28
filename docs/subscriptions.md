# Subscriptions & Razorpay Billing (Phase 2)

This is the platform's own billing — Aiventra charging a hospital for its subscription —
kept entirely separate from that hospital's own patient billing (`billing_accounts` etc,
built in Phase 1). A hospital's subscription status has nothing to do with what it charges
its patients.

## What's real here

- **Real Razorpay order creation** via the official `razorpay` npm SDK
  (`server/utils/razorpay.js`) — not a mock.
- **Real signature verification**, matching Razorpay's documented HMAC-SHA256 scheme exactly:
  - Checkout callback: `HMAC-SHA256(order_id + "|" + payment_id, key_secret)`
  - Webhook: `HMAC-SHA256(raw_request_body, webhook_secret)`
  A subscription is **never** marked `active` from anything the browser says on its own —
  only after this server-side signature check passes, or after the webhook (Razorpay's own
  server calling ours) confirms it independently. Both paths write to the same idempotent
  `subscription_payments` row (`UNIQUE(razorpay_payment_id)`), so whichever arrives first
  wins and the second is safely ignored rather than double-processed.
- **Real webhook raw-body handling.** `server/index.js` mounts
  `POST /api/webhooks/razorpay` with `express.raw()` *before* the global JSON parser,
  because signature verification needs the exact bytes Razorpay sent — re-serializing a
  parsed JSON object can change key order/whitespace and silently break every signature
  check. This is a common integration bug; it's handled correctly here.
- **Configurable pricing**, not scattered across files: plan prices live in the `plans`
  table (`scripts/seed-plans.js`), add-on unit rates live in one place
  (`server/utils/pricing.js`).

## What could not be tested in this sandbox

This build environment cannot reach `api.razorpay.com` (only a fixed allow-list of domains
like npm/GitHub are reachable), so a full live checkout could not be run end-to-end here.
What *was* tested (`npm run test:subscriptions`, 11/11 passing):

- The plans endpoint and org-scoping of `/api/subscriptions/current`.
- That `POST /api/subscriptions/create` fails clearly (503, explicit message) rather than
  faking success when Razorpay isn't configured — proving the "never fake payment
  verification" requirement by test, not just by comment.
- The signature-verification functions directly, with hand-computed HMAC signatures:
  correct signatures accepted, tampered ones rejected, mismatched payment IDs rejected,
  missing headers rejected — over real HTTP, hitting the actual webhook endpoint.

**To test a real payment:** set `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (Razorpay
Dashboard → Test Mode → API Keys) and `RAZORPAY_WEBHOOK_SECRET` (Dashboard → Webhooks →
create one pointing at `https://<your-domain>/api/webhooks/razorpay`) in `.env`, then use
Razorpay's documented test card/UPI credentials against `npm run test:subscriptions` or the
Subscription page in the app. Razorpay's test mode does not move real money.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/subscriptions/plans` | Public, no auth |
| GET | `/api/subscriptions/current` | Org-scoped |
| GET | `/api/subscriptions/payment-history` | Admin/Owner only |
| POST | `/api/subscriptions/create` | Creates a Razorpay order |
| POST | `/api/subscriptions/upgrade` | Same flow as create — see limitation below |
| POST | `/api/subscriptions/downgrade` | Same flow as create — see limitation below |
| POST | `/api/subscriptions/verify` | Verifies checkout signature, activates |
| POST | `/api/subscriptions/cancel` | Marks cancelled, access continues to period end |
| POST | `/api/subscriptions/reactivate` | Only within the still-paid period |
| POST | `/api/webhooks/razorpay` | Razorpay calls this, not the frontend |

## Documented remaining tasks (not faked, genuinely left for a later phase)

- **Proration.** Upgrade/downgrade currently start a brand-new paid period rather than
  crediting the unused portion of the current one. A correct proration calculation needs
  product decisions (credit vs. immediate charge-the-difference) that weren't specified.
- **Automatic period-end enforcement.** There's no background job yet that flips
  `active` → `payment_due` → `grace_period` → `suspended` as dates pass. This needs a
  scheduler (cron / worker), which belongs with the production deployment phase.
- **Aiventra Admin plan editor.** Done in Phase 3 — see
  [`docs/admin-control-center.md`](admin-control-center.md). Plan prices are now editable
  live from `/admin.html`, no longer requiring a script re-run.
- **Invoice/receipt PDFs and payment emails** for subscription payments (the hospital's own
  *patient* billing already generates these — the SaaS billing side doesn't yet).
