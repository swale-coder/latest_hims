/**
 * test-security-hardening.js
 * Tests the account lockout (brute-force protection) added in this pass, plus a couple of
 * quick header/response sanity checks.
 */
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  \u2713 ${label}`); }
  else { fail++; failures.push(label); console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`); }
}
async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, body: json };
}

async function main() {
  console.log(`\nSecurity hardening test\nTarget: ${BASE}\n`);

  console.log('--- Security headers ---');
  const headRes = await fetch(`${BASE}/`);
  check('Content-Security-Policy header is present', !!headRes.headers.get('content-security-policy'));
  check('X-Frame-Options / frame-ancestors blocks embedding', (headRes.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
  check('X-Content-Type-Options: nosniff is present', headRes.headers.get('x-content-type-options') === 'nosniff');

  console.log('\n--- Account lockout (brute-force protection) ---');
  // Sign up a throwaway account to attack without touching the shared demo accounts.
  const email = `lockout-test-${Date.now()}@example.com`;
  const signup = await fetch(`${BASE}/api/auth/register-organization`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hospital_name: 'Lockout Test Hospital', owner_name: 'Test Owner', email, password: 'CorrectHorse1' })
  }).then(r => r.json());
  check('Test account created for lockout test', !!signup.token);

  let lastResult;
  for (let i = 0; i < 5; i++) {
    lastResult = await login(email, 'WrongPassword' + i);
  }
  check('5th consecutive wrong password still reports invalid credentials (lockout takes effect starting the next attempt)', lastResult.status === 401, `got ${lastResult.status}`);
  const sixthAttempt = await login(email, 'WrongPassword5');
  check('6th attempt (now locked) returns 429', sixthAttempt.status === 429, `got ${sixthAttempt.status}: ${JSON.stringify(sixthAttempt.body)}`);

  const correctButLocked = await login(email, 'CorrectHorse1');
  check('Even the CORRECT password is rejected while locked', correctButLocked.status === 429, `got ${correctButLocked.status}`);

  console.log('\n--- Password policy ---');
  const weakSignup = await fetch(`${BASE}/api/auth/register-organization`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hospital_name: 'Weak Pw Test', owner_name: 'X', email: `weakpw-${Date.now()}@example.com`, password: 'alllettersnodigits' })
  });
  check('Signup rejects a password with no digits (400)', weakSignup.status === 400, `got ${weakSignup.status}`);

  console.log('\n--- Username enumeration resistance ---');
  const noSuchUser = await login('definitely-does-not-exist-xyz', 'whatever123');
  const wrongPwRealUser = await login('owner.hospitala', 'definitelywrongpw1');
  check('Unknown username and wrong password for a real user return the same status', noSuchUser.status === wrongPwRealUser.status, `${noSuchUser.status} vs ${wrongPwRealUser.status}`);
  check('Both return the same generic error message', noSuchUser.body.error === wrongPwRealUser.body.error, `"${noSuchUser.body.error}" vs "${wrongPwRealUser.body.error}"`);

  console.log(`\n${'='.repeat(60)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(60)}\n`);
  if (fail > 0) { console.log('FAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); console.log(''); process.exit(1); }
  process.exit(0);
}

main().catch(e => { console.error('Test script crashed:', e); process.exit(1); });
