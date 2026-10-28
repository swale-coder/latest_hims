/**
 * test-platform-admin.js
 * Exercises the Aiventra Admin Control Center end-to-end against a running server:
 *   - A hospital account (even an owner) cannot reach /api/platform/* routes.
 *   - A platform admin CAN reach them, and sees data across both demo hospitals.
 *   - The plan editor's changes are immediately reflected in the public plans list.
 *   - Support access requires the HOSPITAL to approve, not the platform admin to grant
 *     itself access, and file access is rejected before approval and allowed after.
 *
 * Requires: server running, "npm run seed" done, and a platform admin created via
 *   node scripts/create-super-admin.js "Name" <username> <password>
 *
 * Run: SUPERADMIN_USER=<username> SUPERADMIN_PASS=<password> node scripts/test-platform-admin.js
 */
const BASE = process.env.BASE_URL || 'http://localhost:4000';
const SUPERADMIN_USER = process.env.SUPERADMIN_USER || 'superadmin';
const SUPERADMIN_PASS = process.env.SUPERADMIN_PASS || 'AiventraAdmin2026';

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log(`  \u2713 ${label}`); }
  else { fail++; failures.push(label); console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`); }
}
async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return res.json();
}
async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, body: json };
}

async function main() {
  console.log(`\nAiventra Admin Control Center test\nTarget: ${BASE}\n`);

  const hospitalA = await login('owner.hospitala', 'admin123');
  const superadmin = await login(SUPERADMIN_USER, SUPERADMIN_PASS);
  if (!hospitalA.token) { console.error('Could not log in owner.hospitala - run npm run seed first.'); process.exit(1); }
  if (!superadmin.token) { console.error(`Could not log in "${SUPERADMIN_USER}" - create one with scripts/create-super-admin.js first.`); process.exit(1); }

  console.log('--- Platform routes are off-limits to hospital accounts ---');
  const blocked = await api(hospitalA.token, 'GET', '/api/platform/organizations');
  check('Hospital owner token gets 403 on /api/platform/organizations', blocked.status === 403, `got ${blocked.status}`);

  console.log('\n--- Platform admin can see across all organizations ---');
  const orgs = await api(superadmin.token, 'GET', '/api/platform/organizations');
  check('Platform admin can list organizations', orgs.status === 200 && Array.isArray(orgs.body), `got ${orgs.status}`);
  check('Platform admin sees BOTH demo hospitals', orgs.body && orgs.body.length >= 2, `saw ${orgs.body && orgs.body.length}`);

  const cityCare = orgs.body.find(o => o.slug === 'citycare');
  check('City Care Hospital is visible to the platform admin', !!cityCare);

  if (cityCare) {
    const detail = await api(superadmin.token, 'GET', `/api/platform/organizations/${cityCare.id}`);
    check('Org detail endpoint returns stats and users', detail.status === 200 && detail.body.stats && Array.isArray(detail.body.users), `got ${detail.status}`);
  }

  console.log('\n--- Analytics reflect real seeded data ---');
  const analytics = await api(superadmin.token, 'GET', '/api/platform/analytics');
  check('Analytics endpoint returns totalOrganizations >= 2', analytics.body && analytics.body.totalOrganizations >= 2, JSON.stringify(analytics.body));

  console.log('\n--- Plan editor changes are live immediately ---');
  const plans = await api(superadmin.token, 'GET', '/api/platform/plans');
  const clinicPlan = plans.body.find(p => p.code === 'clinic');
  const newPrice = clinicPlan.monthly_price === 3499 ? 2999 : 3499; // toggle so re-runs still change something
  const updateRes = await api(superadmin.token, 'PUT', `/api/platform/plans/${clinicPlan.id}`, { monthly_price: newPrice });
  check('Plan price update succeeds', updateRes.status === 200, `got ${updateRes.status}`);
  const publicPlans = await api(null, 'GET', '/api/subscriptions/plans');
  const updatedClinic = publicPlans.body.find(p => p.code === 'clinic');
  check('Updated price is immediately visible on the public plans endpoint', updatedClinic && updatedClinic.monthly_price === newPrice, `expected ${newPrice}, got ${updatedClinic && updatedClinic.monthly_price}`);

  console.log('\n--- Support access must be hospital-approved, not self-granted ---');
  const reqRes = await api(superadmin.token, 'POST', `/api/platform/support-access/${cityCare.id}/request`, { reason: 'Automated test - investigating a reported bug' });
  check('Platform admin can create a support access request', reqRes.status === 200, `got ${reqRes.status}`);
  const requestId = reqRes.body.id;

  const pendingList = await api(hospitalA.token, 'GET', '/api/support/access-requests');
  const pendingRow = pendingList.body.find(r => r.id === requestId);
  check('The hospital can see the pending request', !!pendingRow, `got ${JSON.stringify(pendingList.body)}`);

  // Before approval: platform admin must NOT be able to download a file from this org.
  const billingAcc = await api(hospitalA.token, 'GET', '/api/billing/summary');
  const anyAccount = billingAcc.body && billingAcc.body.accounts && billingAcc.body.accounts[0];
  let receiptPath = null;
  if (anyAccount) {
    // Create a fresh deposit so a receipt PDF definitely exists to test file access against
    // (seed data's demo transactions don't generate PDFs, only live API calls do).
    const depositRes = await api(hospitalA.token, 'POST', `/api/billing/account/${anyAccount.id}/deposit`, { amount: 500, payment_method: 'Cash' });
    receiptPath = depositRes.body && depositRes.body.transaction && depositRes.body.transaction.receipt_path;
  }
  if (receiptPath) {
    const beforeApproval = await fetch(`${BASE}${receiptPath}?token=${superadmin.token}`);
    check('Platform admin CANNOT download a file before the hospital approves access', beforeApproval.status === 403, `got ${beforeApproval.status}`);
  } else {
    console.log('  (skipped pre-approval file check - no receipt found in demo data)');
  }

  const approveRes = await api(hospitalA.token, 'PUT', `/api/support/access-requests/${requestId}/approve`, { hours: 1 });
  check('Hospital admin can approve the request', approveRes.status === 200, `got ${approveRes.status}`);

  if (receiptPath) {
    const afterApproval = await fetch(`${BASE}${receiptPath}?token=${superadmin.token}`);
    check('Platform admin CAN download the file AFTER approval', afterApproval.status === 200, `got ${afterApproval.status}`);
  }

  // Hospital B must not be affected by or visible in Hospital A's approval.
  const hospitalB = await login('owner.hospitalb', 'admin123');
  const bPending = await api(hospitalB.token, 'GET', '/api/support/access-requests');
  check("Hospital B's own access-request list does not include Hospital A's request", !bPending.body.find(r => r.id === requestId));

  console.log(`\n${'='.repeat(60)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(60)}\n`);
  if (fail > 0) { console.log('FAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); console.log(''); process.exit(1); }
  process.exit(0);
}

main().catch(e => { console.error('Test script crashed:', e); process.exit(1); });
