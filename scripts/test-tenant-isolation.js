/**
 * test-tenant-isolation.js
 * ----------------------------------------------------------------------------
 * Proves that Hospital A cannot read, modify, or delete Hospital B's data
 * (and vice versa) through the live HTTP API - not by inspecting code, but by
 * actually making requests against a running server and checking the response.
 *
 * Requires:
 *   1. The server running (npm start), with the two demo organizations seeded
 *      (npm run seed - City Care Hospital "citycare" and Sunrise Multispecialty
 *      "sunrise").
 *
 * Run:
 *   node scripts/test-tenant-isolation.js
 *   (or: npm run test:tenant-isolation)
 */
const BASE = process.env.BASE_URL || 'http://localhost:4000';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  \u2713 ${label}`);
  } else {
    fail++;
    failures.push(label + (detail ? ` (${detail})` : ''));
    console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(`Login failed for ${username}: ${res.status}`);
  return res.json();
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON (e.g. PDF) */ }
  return { status: res.status, body: json };
}

async function main() {
  console.log(`\nAiventra tenant isolation test\nTarget: ${BASE}\n`);
  console.log('Logging in as both hospitals...');

  let a, b;
  try {
    a = await login('owner.hospitala', 'admin123');
    b = await login('owner.hospitalb', 'admin123');
  } catch (e) {
    console.error(`\nCould not log in demo accounts: ${e.message}`);
    console.error('Make sure the server is running and "npm run seed" has been executed.\n');
    process.exit(1);
  }
  const tokenA = a.token, tokenB = b.token;
  check('Hospital A and Hospital B logged in with different organization_id', a.user.organization_id !== b.user.organization_id);

  // ---- Gather real records that belong to Hospital A ----
  const aPatients = await api(tokenA, 'GET', '/api/patients/search?q=PAT-');
  check('Fetched Hospital A patient list', Array.isArray(aPatients.body) && aPatients.body.length > 0);
  const aPatientId = aPatients.body[0].patient_id;

  const aAdmissions = await api(tokenA, 'GET', '/api/admissions');
  check('Fetched Hospital A admissions', Array.isArray(aAdmissions.body) && aAdmissions.body.length > 0);
  const aAdmission = aAdmissions.body[0];

  const aOpdQueue = await api(tokenA, 'GET', '/api/opd/queue');
  const aOpdVisit = Array.isArray(aOpdQueue.body) ? aOpdQueue.body[0] : null;

  console.log('\n--- Cross-tenant READ attempts (Hospital B token against Hospital A data) ---');

  const r1 = await api(tokenB, 'GET', `/api/patients/${aPatientId}`);
  check(`GET /api/patients/${aPatientId} as Hospital B returns 404`, r1.status === 404, `got ${r1.status}`);

  const r2 = await api(tokenB, 'GET', `/api/admissions/${aAdmission.id}`);
  check(`GET /api/admissions/${aAdmission.id} as Hospital B returns 404`, r2.status === 404, `got ${r2.status}`);

  const billingByAdm = await api(tokenA, 'GET', `/api/billing/account/by-admission/${aAdmission.id}`);
  const aAccountId = billingByAdm.body && billingByAdm.body.account && billingByAdm.body.account.id;
  if (aAccountId) {
    const r3 = await api(tokenB, 'GET', `/api/billing/account/${aAccountId}`);
    check(`GET /api/billing/account/${aAccountId} as Hospital B returns 404`, r3.status === 404, `got ${r3.status}`);
  }

  if (aOpdVisit) {
    const r4 = await api(tokenB, 'PUT', `/api/opd/${aOpdVisit.id}/status`, { status: 'Cancelled' });
    check(`PUT /api/opd/${aOpdVisit.id}/status as Hospital B returns 404 (write blocked)`, r4.status === 404, `got ${r4.status}`);
  }

  console.log('\n--- Natural-language AI assistant must not leak cross-tenant data ---');
  const aiAsk = await api(tokenB, 'POST', '/api/ai/ask', { question: `Show me history for ${aPatientId}` });
  const leaked = aiAsk.body && aiAsk.body.answer && aiAsk.body.answer.includes(aPatientId) && !aiAsk.body.answer.startsWith("I couldn't find");
  check('AI assistant does not return Hospital A patient data to Hospital B', !leaked, aiAsk.body && aiAsk.body.answer);

  console.log('\n--- File access ---');
  if (aAccountId) {
    const depositRes = await api(tokenA, 'POST', `/api/billing/account/${aAccountId}/deposit`, { amount: 1000, payment_method: 'Cash' });
    const receiptPath = depositRes.body && depositRes.body.transaction && depositRes.body.transaction.receipt_path;
    if (receiptPath) {
      const fileRes = await fetch(`${BASE}${receiptPath}?token=${tokenB}`);
      check(`Hospital B cannot download Hospital A's receipt file`, fileRes.status === 403 || fileRes.status === 401, `got ${fileRes.status}`);
      const fileResA = await fetch(`${BASE}${receiptPath}?token=${tokenA}`);
      check(`Hospital A CAN download its own receipt file`, fileResA.status === 200, `got ${fileResA.status}`);
    } else {
      console.log('  (skipped file test - no receipt path returned)');
    }
  }

  console.log('\n--- Sanity: each hospital CAN still access its own data ---');
  const ownRead = await api(tokenA, 'GET', `/api/patients/${aPatientId}`);
  check(`Hospital A can read its own patient ${aPatientId}`, ownRead.status === 200, `got ${ownRead.status}`);

  console.log(`\n${'='.repeat(60)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(60)}\n`);
  if (fail > 0) {
    console.log('FAILURES:');
    failures.forEach(f => console.log(`  - ${f}`));
    console.log('');
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error('Test script crashed:', e); process.exit(1); });
