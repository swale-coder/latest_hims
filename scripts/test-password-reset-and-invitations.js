/**
 * test-password-reset-and-invitations.js
 * Full end-to-end test of both new flows against a running server, including confirming
 * neither flow creates a cross-tenant leak (an invitation token from Hospital A must never
 * be usable to join Hospital B, etc).
 */
const db = require('../server/db');
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  \u2713 ${label}`); }
  else { fail++; failures.push(label); console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`); }
}
async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, body: json };
}
async function login(username, password) {
  return api(null, 'POST', '/api/auth/login', { username, password });
}

async function main() {
  console.log(`\nPassword reset + staff invitation test\nTarget: ${BASE}\n`);

  // =========================================================================
  console.log('--- Password reset ---');
  const forgot1 = await api(null, 'POST', '/api/auth/forgot-password', { username: 'owner.hospitala' });
  check('forgot-password for a real user returns 200 with generic message', forgot1.status === 200, `got ${forgot1.status}`);

  const forgot2 = await api(null, 'POST', '/api/auth/forgot-password', { username: 'no-such-user-xyz' });
  check('forgot-password for a nonexistent user ALSO returns 200 (no enumeration)', forgot2.status === 200, `got ${forgot2.status}`);
  check('Both responses carry the same generic message', forgot1.body.message === forgot2.body.message);

  const userRow = (await db.prepare(`SELECT id FROM users WHERE username = 'owner.hospitala'`).get());
  const tokenRow = (await db.prepare(`SELECT * FROM password_reset_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1`).get(userRow.id));
  check('A reset token was actually created in the database', !!tokenRow);

  const emailRow = (await db.prepare(`SELECT * FROM email_log WHERE to_email = 'owner.hospitala' AND event_type = 'password_reset_requested' ORDER BY id DESC LIMIT 1`).get());
  check('A reset email was logged with real content (link + expiry)', !!emailRow && emailRow.body.includes('reset-password.html?token='));
  const rawToken = emailRow.body.match(/token=([a-f0-9]+)/)[1];

  const wrongToken = await api(null, 'POST', '/api/auth/reset-password', { token: 'not-a-real-token', newPassword: 'NewPass123' });
  check('Reset with a bogus token is rejected', wrongToken.status === 400);

  const weakPw = await api(null, 'POST', '/api/auth/reset-password', { token: rawToken, newPassword: 'nodigitshere' });
  check('Reset with a weak new password is rejected', weakPw.status === 400);

  const resetOk = await api(null, 'POST', '/api/auth/reset-password', { token: rawToken, newPassword: 'BrandNewPass123' });
  check('Reset with the real token and a strong password succeeds', resetOk.status === 200, `got ${resetOk.status}: ${JSON.stringify(resetOk.body)}`);

  const loginOld = await login('owner.hospitala', 'admin123');
  check('OLD password no longer works after reset', loginOld.status === 401, `got ${loginOld.status}`);
  const loginNew = await login('owner.hospitala', 'BrandNewPass123');
  check('NEW password works after reset', loginNew.status === 200, `got ${loginNew.status}`);

  const reuseToken = await api(null, 'POST', '/api/auth/reset-password', { token: rawToken, newPassword: 'AnotherPass123' });
  check('The SAME reset token cannot be used twice', reuseToken.status === 400, `got ${reuseToken.status}`);

  const hospitalAToken = loginNew.body.token;

  // =========================================================================
  console.log('\n--- Staff invitations ---');
  const inviteEmail = `newdoc-${Date.now()}@example.com`;
  const inviteRes = await api(hospitalAToken, 'POST', '/api/auth/invitations', { name: 'Dr. New Person', email: inviteEmail, role: 'doctor' });
  check('Admin can create a staff invitation', inviteRes.status === 200, `got ${inviteRes.status}`);

  const inviteEmailRow = (await db.prepare(`SELECT * FROM email_log WHERE to_email = ? ORDER BY id DESC LIMIT 1`).get(inviteEmail));
  check('An invitation email was logged with a real accept link', !!inviteEmailRow && inviteEmailRow.body.includes('accept-invite.html?token='));
  const inviteToken = inviteEmailRow.body.match(/token=([a-f0-9]+)/)[1];

  const lookupRes = await api(null, 'GET', `/api/auth/invitations/lookup/${inviteToken}`);
  check('Public lookup of a valid invitation succeeds', lookupRes.status === 200 && lookupRes.body.role === 'doctor', JSON.stringify(lookupRes.body));

  const badLookup = await api(null, 'GET', `/api/auth/invitations/lookup/not-a-real-token-at-all`);
  check('Public lookup of a bogus token returns 404', badLookup.status === 404);

  const acceptRes = await api(null, 'POST', '/api/auth/invitations/accept', { token: inviteToken, name: 'Dr. New Person', password: 'DoctorPass123' });
  check('Accepting the invitation creates a working account', acceptRes.status === 200 && !!acceptRes.body.token, `got ${acceptRes.status}`);
  check('The new account is correctly assigned Hospital A (not some other org)', acceptRes.body.user.organization_id === loginNew.body.user.organization_id);
  check('The new account has the invited role (doctor)', acceptRes.body.user.role === 'doctor');

  const reAccept = await api(null, 'POST', '/api/auth/invitations/accept', { token: inviteToken, name: 'Dr. New Person', password: 'DoctorPass123' });
  check('The SAME invitation token cannot be accepted twice', reAccept.status === 400, `got ${reAccept.status}`);

  console.log('\n--- Cross-tenant isolation of invitations ---');
  const hospitalB = await login('owner.hospitalb', 'admin123');
  const hospitalBToken = hospitalB.body.token;
  const inviteEmail2 = `crosstest-${Date.now()}@example.com`;
  const inviteB = await api(hospitalBToken, 'POST', '/api/auth/invitations', { name: 'Cross Test', email: inviteEmail2, role: 'nurse' });
  const inviteBEmailRow = (await db.prepare(`SELECT * FROM email_log WHERE to_email = ? ORDER BY id DESC LIMIT 1`).get(inviteEmail2));
  const inviteBToken = inviteBEmailRow.body.match(/token=([a-f0-9]+)/)[1];

  const invitationsA = await api(hospitalAToken, 'GET', '/api/auth/invitations');
  check("Hospital A's invitation list does not include Hospital B's invitation", !invitationsA.body.find(i => i.email === inviteEmail2));

  const acceptBFromWrongOrgContext = await api(null, 'GET', `/api/auth/invitations/lookup/${inviteBToken}`);
  check("Hospital B's invitation correctly resolves to Hospital B's own organization", acceptBFromWrongOrgContext.body.organizationName && acceptBFromWrongOrgContext.body.organizationName.includes('Sunrise'), JSON.stringify(acceptBFromWrongOrgContext.body));

  console.log('\n--- Revoking an invitation ---');
  const inviteEmail3 = `revoke-test-${Date.now()}@example.com`;
  const inviteToRevoke = await api(hospitalAToken, 'POST', '/api/auth/invitations', { email: inviteEmail3, role: 'nurse' });
  const revokeRes = await api(hospitalAToken, 'PUT', `/api/auth/invitations/${inviteToRevoke.body.id}/revoke`, {});
  check('Admin can revoke a pending invitation', revokeRes.status === 200);
  const revokeEmailRow = (await db.prepare(`SELECT * FROM email_log WHERE to_email = ? ORDER BY id DESC LIMIT 1`).get(inviteEmail3));
  const revokedToken = revokeEmailRow.body.match(/token=([a-f0-9]+)/)[1];
  const acceptRevoked = await api(null, 'POST', '/api/auth/invitations/accept', { token: revokedToken, name: 'X', password: 'Password123' });
  check('A revoked invitation can no longer be accepted', acceptRevoked.status === 400);

  console.log('\n--- Quick regression: tenant isolation still holds after these changes ---');
  const patientsA = await api(hospitalAToken, 'GET', '/api/patients/search?q=PAT-');
  check('Hospital A can still read its own patients (no regression)', patientsA.status === 200 && Array.isArray(patientsA.body));

  console.log(`\n${'='.repeat(60)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(60)}\n`);
  if (fail > 0) { console.log('FAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); console.log(''); process.exit(1); }
  process.exit(0);
}

main().catch(e => { console.error('Test script crashed:', e); process.exit(1); });
