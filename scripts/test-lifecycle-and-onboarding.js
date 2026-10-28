/**
 * test-lifecycle-and-onboarding.js
 * Tests the Phase 5 additions: onboarding checklist/status tracking, and the subscription
 * lifecycle sweep aging subscriptions and trial orgs through their statuses correctly.
 */
const db = require('../server/db');
const { runSweep } = require('./subscription-lifecycle-sweep');

const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  \u2713 ${label}`); }
  else { fail++; failures.push(label); console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`); }
}
async function login(username, password) {
  return fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }).then(r => r.json());
}
async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, body: json };
}

async function main() {
  console.log(`\nOnboarding + lifecycle sweep test\nTarget: ${BASE}\n`);

  console.log('--- Onboarding status/checklist ---');
  const signup = await api(null, 'POST', '/api/auth/register-organization', {
    hospital_name: 'Lifecycle Test Hospital', owner_name: 'Test Owner',
    email: `lifecycle-${Date.now()}@example.com`, password: 'TestPass123'
  });
  check('New org signup succeeds', signup.status === 200, JSON.stringify(signup.body));
  const token = signup.body.token;

  const status1 = await api(token, 'GET', '/api/onboarding/status');
  check('Onboarding status endpoint works', status1.status === 200, `got ${status1.status}`);
  check('trial_ends_at was set at signup', !!status1.body.trialEndsAt);
  check('Checklist starts incomplete', Object.values(status1.body.checklist).every(v => v === false), JSON.stringify(status1.body.checklist));

  const profileUpdate = await api(token, 'PUT', '/api/onboarding/profile', { bed_count: 20, expected_monthly_opd: 500 });
  check('Profile update succeeds', profileUpdate.status === 200, `got ${profileUpdate.status}`);
  const status2 = await api(token, 'GET', '/api/onboarding/status');
  check('hospitalProfile checklist item now true', status2.body.checklist.hospitalProfile === true);
  check('onboarding_step advanced past hospital_profile', status2.body.onboardingStep !== 'hospital_profile', status2.body.onboardingStep);

  const finish = await api(token, 'PUT', '/api/onboarding/step', { step: 'completed' });
  check('Marking onboarding complete succeeds', finish.status === 200);
  const status3 = await api(token, 'GET', '/api/onboarding/status');
  check('onboardingCompleted is now true', status3.body.onboardingCompleted === true);

  console.log('\n--- Subscription lifecycle sweep ---');
  // Fabricate an overdue active subscription directly in the DB to exercise the sweep
  // deterministically, rather than waiting real days for a real subscription to age.
  const org = (await db.prepare(`SELECT id FROM organizations WHERE name = 'Lifecycle Test Hospital'`).get());
  const plan = (await db.prepare(`SELECT id FROM plans WHERE code = 'clinic'`).get());
  const overduePeriodEnd = new Date(Date.now() - 1 * 86400000).toISOString(); // 1 day overdue -> active should flip to payment_due
  const subInfo = (await db.prepare(`INSERT INTO subscriptions (organization_id, plan_id, billing_cycle, status, current_period_start, current_period_end)
    VALUES (?, ?, 'monthly', 'active', datetime('now','-31 days'), ?)`).run(org.id, plan.id, overduePeriodEnd));
  (await db.prepare(`UPDATE organizations SET status = 'active' WHERE id = ?`).run(org.id));

  let results = await runSweep();
  check('Sweep moves an overdue active subscription to payment_due', results.activeToPaymentDue >= 1, JSON.stringify(results));
  let subAfter = (await db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(subInfo.lastInsertRowid));
  check('Subscription status is now payment_due', subAfter.status === 'payment_due', subAfter.status);
  let orgAfter = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(org.id));
  check('Organization status mirrors payment_due', orgAfter.status === 'payment_due', orgAfter.status);

  // Push it further overdue (4 days past period end) and re-run to see it enter grace_period.
  (await db.prepare(`UPDATE subscriptions SET current_period_end = datetime('now','-4 days') WHERE id = ?`).run(subInfo.lastInsertRowid));
  results = await runSweep();
  check('Sweep moves an overdue payment_due subscription to grace_period', results.paymentDueToGrace >= 1, JSON.stringify(results));
  subAfter = (await db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(subInfo.lastInsertRowid));
  check('Subscription status is now grace_period', subAfter.status === 'grace_period', subAfter.status);

  // Push it past the suspend threshold and re-run to see it suspend the organization.
  (await db.prepare(`UPDATE subscriptions SET current_period_end = datetime('now','-11 days') WHERE id = ?`).run(subInfo.lastInsertRowid));
  results = await runSweep();
  check('Sweep suspends an org after grace period expires', results.graceToSuspended >= 1, JSON.stringify(results));
  orgAfter = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(org.id));
  check('Organization status is now suspended', orgAfter.status === 'suspended', orgAfter.status);
  check('Suspension reason is recorded', !!orgAfter.suspended_reason);

  console.log('\n--- Trial expiry ---');
  const trialOrgInfo = (await db.prepare(`INSERT INTO organizations (name, slug, status, trial_ends_at) VALUES ('Expired Trial Test', ?, 'trial', datetime('now','-1 days'))`)
    .run(`expired-trial-test-${Date.now()}`));
  results = await runSweep();
  check('Sweep expires a trial org past its trial_ends_at', results.trialsExpired >= 1, JSON.stringify(results));
  const trialOrgAfter = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(trialOrgInfo.lastInsertRowid));
  check('Expired trial org status is now expired', trialOrgAfter.status === 'expired', trialOrgAfter.status);

  console.log('\n--- Sweep is idempotent (safe to run repeatedly) ---');
  const before = JSON.stringify((await db.prepare(`SELECT status FROM organizations WHERE id IN (?,?)`).all(org.id, trialOrgInfo.lastInsertRowid)));
  await runSweep(); await runSweep();
  const after = JSON.stringify((await db.prepare(`SELECT status FROM organizations WHERE id IN (?,?)`).all(org.id, trialOrgInfo.lastInsertRowid)));
  check('Running the sweep again does not change already-final statuses', before === after, `${before} vs ${after}`);

  console.log(`\n${'='.repeat(60)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(60)}\n`);
  if (fail > 0) { console.log('FAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); console.log(''); process.exit(1); }
  process.exit(0);
}

main().catch(e => { console.error('Test script crashed:', e); process.exit(1); });
