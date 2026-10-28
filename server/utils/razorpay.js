const crypto = require('crypto');

// Lazily require the SDK so the server can still boot (e.g. for local dev without
// Razorpay keys configured) and only fails when a payment route is actually hit.
let Razorpay = null;
try { Razorpay = require('razorpay'); } catch (e) { /* not installed yet - handled below */ }

let client = null;
function getClient() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    const err = new Error('Razorpay is not configured on this server. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    err.code = 'RAZORPAY_NOT_CONFIGURED';
    throw err;
  }
  if (!Razorpay) {
    const err = new Error('The razorpay package is not installed. Run npm install.');
    err.code = 'RAZORPAY_NOT_CONFIGURED';
    throw err;
  }
  if (!client) {
    client = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  }
  return client;
}

// Creates a real Razorpay order via the official SDK. amountInRupees is converted to paise
// (Razorpay's base unit) here so callers always work in rupees.
async function createOrder({ amountInRupees, receipt, notes }) {
  const rz = getClient();
  return rz.orders.create({
    amount: Math.round(amountInRupees * 100),
    currency: 'INR',
    receipt,
    notes: notes || {}
  });
}

// Verifies the signature returned to the browser after Razorpay Checkout completes.
// Per Razorpay's documented scheme: HMAC-SHA256 of "<order_id>|<payment_id>" using the
// account's key secret, must equal the signature Razorpay sent back.
// https://razorpay.com/docs/payments/server-integration/nodejs/payment-gateway/build-integration/#step-5-verify-payment-signature
function verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!process.env.RAZORPAY_KEY_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  return timingSafeEqualHex(expected, razorpay_signature);
}

// Verifies an inbound webhook call. Per Razorpay's documented scheme: HMAC-SHA256 of the
// exact raw request body using the separately-configured Webhook Secret (NOT the API key
// secret), compared to the X-Razorpay-Signature header.
// https://razorpay.com/docs/webhooks/validate-test/#validate-webhooks-and-events
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return timingSafeEqualHex(expected, signatureHeader);
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch (e) {
    return false; // malformed hex, e.g. an attacker sending a non-hex signature
  }
}

module.exports = { createOrder, verifyPaymentSignature, verifyWebhookSignature };
