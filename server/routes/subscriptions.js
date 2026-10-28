const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const razorpay = require('../utils/razorpay');
const { computeInvoice } = require('../utils/pricing');

const router = express.Router();

async function logEvent(orgId, subscriptionId, eventType, detail, actor) {
  (await db.prepare(`INSERT INTO subscription_events (organization_id, subscription_id, event_type, detail, actor)
    VALUES (?,?,?,?,?)`).run(orgId, subscriptionId || null, eventType, detail || null, actor || 'system'));
}

// ---------- PLANS (public - shown on the pricing page before signup, and inside the app) ----------
router.get('/plans', async (req, res) => {
  const plans = (await db.prepare(`SELECT * FROM plans WHERE active = 1 ORDER BY display_order`).all())
    .map(p => ({ ...p, enabled_modules: JSON.parse(p.enabled_modules || '[]') }));
  res.json(plans);
});

// ---------- CURRENT SUBSCRIPTION ----------
router.get('/current', authenticate, requireOrgContext, async (req, res) => {
  const sub = (await db.prepare(`
    SELECT s.*, p.name as plan_name, p.code as plan_code, p.bed_limit, p.opd_limit, p.user_limit, p.doctor_limit, p.branch_limit
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.organization_id = ? ORDER BY s.id DESC LIMIT 1`).get(req.orgId));
  const org = (await db.prepare(`SELECT status, onboarding_completed FROM organizations WHERE id = ?`).get(req.orgId));
  res.json({ subscription: sub || null, organizationStatus: org.status });
});

router.get('/payment-history', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const rows = (await db.prepare(`SELECT * FROM subscription_payments WHERE organization_id = ? ORDER BY created_at DESC`).all(req.orgId));
  res.json(rows);
});

// ---------- CREATE (new subscription, upgrade, or renewal - all funnel through here and
// require a real, verified payment before going active) ----------
async function createSubscriptionHandler(req, res) {
  const orgId = req.orgId;
  const { plan_code, billing_cycle, additional_users, additional_doctors, additional_branches, addon_modules } = req.body;

  const plan = (await db.prepare(`SELECT * FROM plans WHERE code = ? AND active = 1`).get(plan_code));
  if (!plan) return res.status(400).json({ error: 'Unknown or inactive plan' });
  if (!['monthly', 'annual'].includes(billing_cycle)) return res.status(400).json({ error: 'billing_cycle must be monthly or annual' });

  const invoice = computeInvoice({
    plan, billingCycle: billing_cycle,
    additionalUsers: Number(additional_users) || 0,
    additionalDoctors: Number(additional_doctors) || 0,
    additionalBranches: Number(additional_branches) || 0
  });

  const info = (await db.prepare(`INSERT INTO subscriptions
    (organization_id, plan_id, billing_cycle, status, additional_users, additional_doctors, additional_branches,
     addon_modules, base_amount, gst_amount, total_amount)
    VALUES (?,?,?,'pending_payment',?,?,?,?,?,?,?)`)
    .run(orgId, plan.id, billing_cycle, Number(additional_users) || 0, Number(additional_doctors) || 0,
      Number(additional_branches) || 0, JSON.stringify(addon_modules || []), invoice.baseAmount, invoice.gstAmount, invoice.totalAmount));
  const subscriptionId = info.lastInsertRowid;

  let order;
  try {
    order = await razorpay.createOrder({
      amountInRupees: invoice.totalAmount,
      receipt: `sub-${subscriptionId}-org-${orgId}`,
      notes: { organization_id: String(orgId), subscription_id: String(subscriptionId), plan_code }
    });
  } catch (e) {
    (await logEvent(orgId, subscriptionId, 'order_creation_failed', e.message, `user:${req.user.id}`));
    const status = e.code === 'RAZORPAY_NOT_CONFIGURED' ? 503 : 502;
    return res.status(status).json({ error: e.code === 'RAZORPAY_NOT_CONFIGURED' ? e.message : 'Could not create payment order. Please try again.' });
  }

  (await db.prepare(`UPDATE subscriptions SET razorpay_order_id = ? WHERE id = ?`).run(order.id, subscriptionId));
  (await db.prepare(`INSERT INTO subscription_payments (organization_id, subscription_id, razorpay_order_id, amount, status)
    VALUES (?,?,?,?,'created')`).run(orgId, subscriptionId, order.id, invoice.totalAmount));

  (await logEvent(orgId, subscriptionId, 'created', `${plan.name} (${billing_cycle}), total ${invoice.totalAmount}`, `user:${req.user.id}`));

  res.json({
    subscriptionId,
    order: { id: order.id, amount: order.amount, currency: order.currency },
    keyId: process.env.RAZORPAY_KEY_ID, // safe to expose - this is the publishable key, not the secret
    invoice
  });
}

router.post('/create', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), createSubscriptionHandler);
// Upgrade/downgrade both funnel through the same create-a-new-subscription-and-pay flow as a
// brand new subscription. Proration of the currently active period is a documented remaining
// task (see docs/subscriptions.md) rather than an invented credit calculation.
router.post('/upgrade', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), createSubscriptionHandler);
router.post('/downgrade', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), createSubscriptionHandler);

// ---------- VERIFY (called by the frontend right after Razorpay Checkout succeeds) ----------
// This is the ONLY place a subscription is allowed to become 'active' from client-initiated
// action, and only after the signature is verified server-side. The webhook handler below is
// the authoritative backstop for cases where the browser closes before this call completes.
router.post('/verify', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const orgId = req.orgId;
  const { subscriptionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!subscriptionId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields' });
  }

  const subscription = (await db.prepare(`SELECT * FROM subscriptions WHERE id = ? AND organization_id = ?`).get(subscriptionId, orgId));
  if (!subscription) return res.status(404).json({ error: 'Subscription not found' });
  if (subscription.razorpay_order_id !== razorpay_order_id) {
    return res.status(400).json({ error: 'Order ID does not match this subscription' });
  }

  const valid = razorpay.verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
  if (!valid) {
    (await logEvent(orgId, subscriptionId, 'payment_failed', 'Signature verification failed', `user:${req.user.id}`));
    (await db.prepare(`UPDATE subscription_payments SET status='failed', failure_reason='Invalid signature' WHERE razorpay_order_id = ?`).run(razorpay_order_id));
    return res.status(400).json({ error: 'Payment verification failed. If money was deducted, it will be refunded automatically; contact support if it is not reflected within a few days.' });
  }

  (await activateSubscription({ orgId, subscription, razorpay_order_id, razorpay_payment_id, razorpay_signature, actor: `user:${req.user.id}` }));
  res.json({ ok: true, status: 'active' });
});

async function activateSubscription({ orgId, subscription, razorpay_order_id, razorpay_payment_id, razorpay_signature, actor }) {
  const now = new Date();
  const periodDays = subscription.billing_cycle === 'annual' ? 365 : 30;
  const periodEnd = new Date(now.getTime() + periodDays * 86400000).toISOString();

  const tx = db.transaction(async () => {
    // UNIQUE(razorpay_payment_id) makes this idempotent: a duplicate call (e.g. both the
    // browser's /verify call and the webhook firing for the same payment) will throw on the
    // second attempt, which we treat as "already processed" rather than double-activating.
    try {
      (await db.prepare(`UPDATE subscription_payments SET razorpay_payment_id = ?, razorpay_signature = ?, status='captured', verified_at = datetime('now')
        WHERE razorpay_order_id = ? AND status != 'captured'`).run(razorpay_payment_id, razorpay_signature || null, razorpay_order_id));
    } catch (e) {
      if (e.message.includes('UNIQUE')) return false; // already processed by the other path
      throw e;
    }

    (await db.prepare(`UPDATE subscriptions SET status='active', current_period_start = datetime('now'), current_period_end = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(periodEnd, subscription.id));
    (await db.prepare(`UPDATE organizations SET status='active', updated_at = datetime('now') WHERE id = ?`).run(orgId));
    return true;
  });

  const activated = (await tx());
  if (activated) (await logEvent(orgId, subscription.id, 'payment_verified', `Payment ${razorpay_payment_id} verified, period ends ${periodEnd}`, actor));
}

// ---------- CANCEL ----------
router.post('/cancel', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const orgId = req.orgId;
  const sub = (await db.prepare(`SELECT * FROM subscriptions WHERE organization_id = ? AND status IN ('active','payment_due','grace_period','trial') ORDER BY id DESC LIMIT 1`).get(orgId));
  if (!sub) return res.status(404).json({ error: 'No active subscription to cancel' });

  (await db.prepare(`UPDATE subscriptions SET status='cancelled', cancelled_at = datetime('now'), cancel_reason = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(req.body.reason || null, sub.id));
  // Access continues until the end of the already-paid period, then a background job (see
  // docs/subscriptions.md "remaining tasks") would flip the organization to 'cancelled'.
  (await logEvent(orgId, sub.id, 'cancelled', req.body.reason || 'No reason given', `user:${req.user.id}`));
  res.json({ ok: true });
});

router.post('/reactivate', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const orgId = req.orgId;
  const sub = (await db.prepare(`SELECT * FROM subscriptions WHERE organization_id = ? ORDER BY id DESC LIMIT 1`).get(orgId));
  if (!sub || sub.status !== 'cancelled') return res.status(400).json({ error: 'No cancelled subscription found to reactivate' });
  if (sub.current_period_end && new Date(sub.current_period_end) < new Date()) {
    return res.status(400).json({ error: 'This subscription period has already ended. Please subscribe again via /api/subscriptions/create.' });
  }
  (await db.prepare(`UPDATE subscriptions SET status='active', cancelled_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(sub.id));
  (await db.prepare(`UPDATE organizations SET status='active' WHERE id = ?`).run(orgId));
  (await logEvent(orgId, sub.id, 'reactivated', null, `user:${req.user.id}`));
  res.json({ ok: true });
});

// ---------- RAZORPAY WEBHOOK ----------
// Mounted separately in server/index.js with raw-body parsing (signature verification needs
// the exact bytes Razorpay sent, not the JSON-reparsed object). See index.js for why.
async function handleWebhook(req, res) {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.rawBody; // Buffer, set by the raw-body middleware in index.js

  const valid = razorpay.verifyWebhookSignature(rawBody, signature);
  if (!valid) {
    (await logEvent(null, null, 'webhook_signature_invalid', `Invalid signature on webhook from ${req.ip}`, 'webhook'));
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Malformed webhook payload' }); }

  const paymentEntity = event.payload && event.payload.payment && event.payload.payment.entity;
  const orderId = paymentEntity && paymentEntity.order_id;
  const paymentId = paymentEntity && paymentEntity.id;

  if (!orderId) {
    // Not a payment event we act on (e.g. a different Razorpay event type) - acknowledge and ignore.
    return res.status(200).json({ ok: true, ignored: true });
  }

  const paymentRow = (await db.prepare(`SELECT * FROM subscription_payments WHERE razorpay_order_id = ?`).get(orderId));
  if (!paymentRow) return res.status(200).json({ ok: true, ignored: true }); // order not from this platform

  const subscription = (await db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(paymentRow.subscription_id));

  (await db.prepare(`UPDATE subscription_payments SET raw_webhook_event = ? WHERE id = ?`).run(JSON.stringify(event).slice(0, 8000), paymentRow.id));

  if (event.event === 'payment.captured' && paymentId) {
    (await activateSubscription({
      orgId: paymentRow.organization_id, subscription,
      razorpay_order_id: orderId, razorpay_payment_id: paymentId,
      razorpay_signature: null, actor: 'webhook'
    }));
  } else if (event.event === 'payment.failed') {
    (await db.prepare(`UPDATE subscription_payments SET status='failed', failure_reason = ? WHERE razorpay_order_id = ?`)
      .run((paymentEntity && paymentEntity.error_description) || 'Payment failed', orderId));
    (await logEvent(paymentRow.organization_id, paymentRow.subscription_id, 'payment_failed', (paymentEntity && paymentEntity.error_description) || 'Payment failed', 'webhook'));
  } else {
    (await logEvent(paymentRow.organization_id, paymentRow.subscription_id, 'webhook_received', event.event, 'webhook'));
  }

  res.status(200).json({ ok: true });
}

module.exports = router;
module.exports.handleWebhook = handleWebhook;
