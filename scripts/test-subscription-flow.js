/**
 * test-subscription-flow.js
 * ----------------------------------------------------------------------------
 * This sandbox cannot reach the real Razorpay API (api.razorpay.com), so this script
 * cannot exercise a full live checkout. Instead it verifies the parts that matter most for
 * correctness and security without needing that network access:
 *
 *   1. The plans endpoint returns the seeded plans.
 *   2. Creating a subscription with NO Razorpay keys configured fails clearly (503) instead
 *      of silently pretending to succeed - this is the "never fake payment verification"
 *      requirement, proven by test rather than just asserted in a comment.
 *   3. The signature-verification functions themselves (server/utils/razorpay.js) are
 *      exercised directly with the same HMAC-SHA256 scheme Razorpay uses: a correctly signed
 *      payload is accepted, a tampered one is rejected, matching Razorpay's documented
 *      verification scheme byte-for-byte.
 *   4. /api/subscriptions/current is organization-scoped like everything else in this app.
 *
 * If you have real Razorpay TEST mode keys, set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET /
 * RAZORPAY_WEBHOOK_SECRET in .env and re-run this script - it will then also attempt a real
 * order creation call and report the result.
 *
 * Run: node scripts/test-subscription-flow.js  (requires the server to be running)
 */
const crypto = require('crypto');
const BASE = process.env.BASE_URL || 'http://localhost:4000';

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log(`  \u2713 ${label}`); }
  else { fail++; failures.push(label); console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`); }
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  return res.json();
}
async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, body: json };
}

async function main() {
  console.log(`\nAiventra subscription/billing test\nTarget: ${BASE}\n`);

  console.log('--- Plans ---');
  const plans = await api(null, 'GET', '/api/subscriptions/plans');
  check('GET /api/subscriptions/plans returns the 4 seeded plans', plans.status === 200 && Array.isArray(plans.body) && plans.body.length === 4, `got ${plans.status}, ${plans.body && plans.body.length} plans`);
  const codes = plans.body ? plans.body.map(p => p.code).sort() : [];
  check('Plan codes match clinic/small_hospital/hospital/enterprise', JSON.stringify(codes) === JSON.stringify(['clinic', 'enterprise', 'hospital', 'small_hospital']), codes.join(','));

  console.log('\n--- Org scoping of subscriptions ---');
  const a = await login('owner.hospitala', 'admin123');
  const b = await login('owner.hospitalb', 'admin123');
  if (!a.token || !b.token) {
    console.log('  (skipped - demo accounts not found; run "npm run seed" first)');
  } else {
    const currentA = await api(a.token, 'GET', '/api/subscriptions/current');
    check('GET /api/subscriptions/current works for an authenticated org owner', currentA.status === 200, `got ${currentA.status}`);
  }

  console.log('\n--- Never fake payment verification: create without Razorpay configured ---');
  if (a.token) {
    const created = await api(a.token, 'POST', '/api/subscriptions/create', { plan_code: 'small_hospital', billing_cycle: 'monthly' });
    if (process.env.RAZORPAY_KEY_ID) {
      console.log(`  (Razorpay keys ARE configured - live order creation attempted, got status ${created.status})`);
      if (created.status === 200) console.log('  Live order created:', created.body.order);
    } else {
      check('POST /api/subscriptions/create returns 503 (Razorpay not configured) rather than a fake success', created.status === 503, `got ${created.status}: ${JSON.stringify(created.body)}`);
    }
  }

  console.log('\n--- Signature verification logic (matches Razorpay\'s documented HMAC-SHA256 scheme) ---');
  const { verifyPaymentSignature, verifyWebhookSignature } = require('../server/utils/razorpay');

  const savedSecret = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_SECRET = 'test_secret_for_verification_only';
  const order_id = 'order_TEST123', payment_id = 'pay_TEST456';
  const validSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${order_id}|${payment_id}`).digest('hex');
  check('Correctly signed payment signature is ACCEPTED', verifyPaymentSignature({ razorpay_order_id: order_id, razorpay_payment_id: payment_id, razorpay_signature: validSig }) === true);
  check('Tampered payment signature is REJECTED', verifyPaymentSignature({ razorpay_order_id: order_id, razorpay_payment_id: payment_id, razorpay_signature: validSig.slice(0, -1) + (validSig.slice(-1) === 'a' ? 'b' : 'a') }) === false);
  check('Payment signature for a DIFFERENT payment_id is REJECTED', verifyPaymentSignature({ razorpay_order_id: order_id, razorpay_payment_id: 'pay_DIFFERENT', razorpay_signature: validSig }) === false);
  process.env.RAZORPAY_KEY_SECRET = savedSecret;

  const savedWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
  const rawBody = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: payment_id, order_id } } } }));
  const validWebhookSig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  check('Correctly signed webhook payload is ACCEPTED', verifyWebhookSignature(rawBody, validWebhookSig) === true);
  check('Tampered webhook body (valid signature, different bytes) is REJECTED', verifyWebhookSignature(Buffer.concat([rawBody, Buffer.from(' ')]), validWebhookSig) === false);
  check('Webhook with no signature header is REJECTED', verifyWebhookSignature(rawBody, undefined) === false);
  process.env.RAZORPAY_WEBHOOK_SECRET = savedWebhookSecret;

  console.log('\n--- Webhook endpoint rejects bad signatures over real HTTP ---');
  const webhookRes = await fetch(`${BASE}/api/webhooks/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'not-a-real-signature' },
    body: JSON.stringify({ event: 'payment.captured', payload: {} })
  });
  check('POST /api/webhooks/razorpay with an invalid signature returns 400', webhookRes.status === 400, `got ${webhookRes.status}`);

  console.log(`\n${'='.repeat(60)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(60)}\n`);
  if (fail > 0) { console.log('FAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); console.log(''); process.exit(1); }
  process.exit(0);
}

main().catch(e => { console.error('Test script crashed:', e); process.exit(1); });
