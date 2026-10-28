const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, JWT_SECRET, ROLE_GROUPS } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');
const { sendEmail } = require('../utils/email');

const router = express.Router();

// Network-layer throttle on top of the per-account lockout below - slows down credential
// stuffing spread across many usernames from one IP, which a per-account lockout alone
// wouldn't catch. Set high enough that a hospital's shared front-desk network (many staff,
// one NAT IP, possible shift-change burst) won't trip it during normal use, while still
// making large-scale automated guessing impractical. Configurable via env vars so local
// development/testing (repeated manual login attempts while debugging) can loosen these
// without touching code - defaults are unchanged from before if the vars aren't set.
const LOGIN_RATE_LIMIT_WINDOW_MINUTES = parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES || '15', 10);
const LOGIN_RATE_LIMIT_MAX = parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '100', 10);
const loginLimiter = rateLimit({
  windowMs: LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000, max: LOGIN_RATE_LIMIT_MAX,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts from this network. Please try again later.' }
});

const VALID_ROLES = [
  'organization_owner', 'hospital_admin', 'doctor', 'receptionist',
  'accountant', 'pharmacy_staff', 'lab_staff', 'nurse', 'report_viewer'
];

// Requires at least 8 characters with one letter and one number - deliberately not
// requiring special characters, which pushes real users toward predictable substitutions
// (e.g. "Password1!") without meaningfully raising entropy against automated guessing.
function isWeakPassword(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must include at least one letter and one number';
  return null;
}

// Per-account lockout after repeated wrong passwords for THIS specific user - independent
// of the network-layer limiter above. This is what returns 429 during manual testing when
// you retype a wrong password a handful of times in a row. Also configurable via env vars
// for the same reason as the limiter above; defaults are unchanged if unset.
const MAX_FAILED_ATTEMPTS = parseInt(process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS || '5', 10);
const LOCKOUT_MINUTES = parseInt(process.env.LOGIN_LOCKOUT_MINUTES || '15', 10);

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, slug } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  // ---------- DYNAMIC TENANT VALIDATION (/hms/<slug> login) ----------
  // When the login request was made from a tenant-scoped URL (/hms/<slug>), the frontend
  // sends that slug along with the credentials. We resolve it to an organization BEFORE
  // touching credentials so a request against a slug that doesn't exist at all gets a clear
  // "hospital not found" response rather than a generic invalid-credentials message.
  // NOTE: this is defense-in-depth, not the primary guard - the frontend already resolves
  // the tenant via GET /api/hospital/tenant/:slug before ever showing the login form.
  let tenantOrg = null;
  if (slug) {
    tenantOrg = (await db.prepare(`SELECT * FROM organizations WHERE slug = ?`).get(String(slug).trim().toLowerCase()));
    if (!tenantOrg) return res.status(404).json({ error: 'Hospital not found' });
  }

  const user = (await db.prepare(`SELECT * FROM users WHERE username = ? AND active = 1`).get(username.trim().toLowerCase()));

  // Deliberately identical response shape whether the username exists or not, so a caller
  // can't use this endpoint to enumerate valid usernames.
  const invalidCreds = () => res.status(401).json({ error: 'Invalid username or password' });

  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.` });
  }

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    if (user) {
      const attempts = user.failed_login_attempts + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
        (await db.prepare(`UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?`).run(attempts, lockUntil, user.id));
        if (user.organization_id) (await logAudit({ orgId: user.organization_id, user: null, action: `Account locked after ${attempts} failed login attempts: ${user.username}` }));
      } else {
        (await db.prepare(`UPDATE users SET failed_login_attempts = ? WHERE id = ?`).run(attempts, user.id));
      }
    }
    return invalidCreds();
  }

  // Successful login clears any prior failed-attempt count.
  if (user.failed_login_attempts > 0 || user.locked_until) {
    (await db.prepare(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?`).run(user.id));
  }

  // Block login for hospital accounts whose organization is not in an accessible state.
  // Also used as the single source of truth for the organization's display name below,
  // so the name shown in the UI always comes from the organizations table (no duplicate
  // hardcoded copy) and reflects whichever tenant the logged-in user actually belongs to.
  let org = null;
  if (user.organization_id) {
    org = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(user.organization_id));
    if (!org || ['suspended', 'cancelled', 'expired'].includes(org.status)) {
      return res.status(403).json({ error: 'This hospital account is not currently active. Please contact Aiventra support.' });
    }
  }

  // A login attempted against a specific tenant URL (/hms/<slug>) must only succeed for a
  // user who actually belongs to THAT organization. The authenticated organization_id (from
  // the user's own row, never from the request) is authoritative here - a valid Hospital A
  // username/password can never be used to obtain a session by pointing the URL at Hospital B,
  // and a platform-admin account (organization_id null) can never log in through a hospital's
  // tenant URL at all.
  if (tenantOrg && (!org || org.id !== tenantOrg.id)) {
    return res.status(403).json({ error: 'This account does not have access to this hospital.' });
  }

  const payload = {
    id: user.id, name: user.name, username: user.username, role: user.role,
    organization_id: user.organization_id || null,
    organization_name: org ? org.name : null,
    organization_slug: org ? org.slug : null
  };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
  // Platform staff (organization_id NULL) log in without an organization context, so their
  // logins go to platform_audit_log instead of a hospital's own clinical audit_log (which
  // requires a non-null organization_id by design).
  if (user.organization_id) {
    (await logAudit({ orgId: user.organization_id, user: payload, action: 'User logged in' }));
  } else {
    (await db.prepare(`INSERT INTO platform_audit_log (admin_user_id, admin_name, action) VALUES (?,?,?)`)
      .run(user.id, user.name, 'Platform admin logged in'));
  }
  res.json({ token, user: payload });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// ---- Hospital / clinic signup (minimal onboarding: creates the organization + owner account) ----
// Full multi-step onboarding wizard (bed count, departments, staff invites, plan selection,
// payment) is a later phase — this endpoint creates a working, isolated tenant so the
// organization can start using the product and so tenant isolation can be exercised/tested.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many signup attempts from this network. Please try again later.' }
});

router.post('/register-organization', signupLimiter, async (req, res) => {
  const { hospital_name, owner_name, email, mobile, password, org_type, city, state } = req.body;
  if (!hospital_name || !owner_name || !email || !password) {
    return res.status(400).json({ error: 'Hospital name, owner name, email and password are required' });
  }
  const pwError = isWeakPassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  const username = email.trim().toLowerCase();
  const existing = (await db.prepare(`SELECT id FROM users WHERE username = ?`).get(username));
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  let slugBase = hospital_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'hospital';
  let slug = slugBase;
  let i = 1;
  while ((await db.prepare(`SELECT id FROM organizations WHERE slug = ?`).get(slug))) {
    slug = `${slugBase}-${++i}`;
  }

  const tx = db.transaction(async () => {
    const trialEndsAt = new Date(Date.now() + 14 * 86400000).toISOString(); // standard 14-day trial; extended per-plan trial_days apply once a plan is actually chosen
    const orgInfo = (await db.prepare(`
      INSERT INTO organizations (name, slug, org_type, status, city, state, contact_email, contact_phone, onboarding_step, trial_ends_at)
      VALUES (?, ?, ?, 'trial', ?, ?, ?, ?, 'hospital_profile', ?)
    `).run(hospital_name, slug, ['Hospital', 'Clinic', 'Nursing Home'].includes(org_type) ? org_type : 'Hospital',
      city || null, state || null, username, mobile || null, trialEndsAt));
    const orgId = orgInfo.lastInsertRowid;

    const hash = bcrypt.hashSync(password, 10);
    const userInfo = (await db.prepare(`
      INSERT INTO users (organization_id, name, username, password_hash, role, phone)
      VALUES (?, ?, ?, ?, 'organization_owner', ?)
    `).run(orgId, owner_name, username, hash, mobile || null));

    return { orgId, userId: userInfo.lastInsertRowid };
  });

  const { orgId, userId } = (await tx());
  (await logAudit({ orgId, user: { id: userId, name: owner_name, role: 'organization_owner' }, action: `Organization "${hospital_name}" registered (signup)` }));

  const payload = { id: userId, name: owner_name, username, role: 'organization_owner', organization_id: orgId, organization_slug: slug };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: payload, organization: { id: orgId, slug, name: hospital_name } });
});

// ---- User management (organization admins only, scoped to their own organization) ----
router.get('/users', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const users = (await db.prepare(`SELECT id, name, username, role, phone, department, active, created_at
    FROM users WHERE organization_id = ? ORDER BY id`).all(req.orgId));
  res.json(users);
});

router.post('/users', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { name, username, password, role, phone, department } = req.body;
  if (!name || !username || !password || !role) return res.status(400).json({ error: 'Missing required fields' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const pwError = isWeakPassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = (await db.prepare(`INSERT INTO users (organization_id, name, username, password_hash, role, phone, department)
      VALUES (?,?,?,?,?,?,?)`)
      .run(req.orgId, name, username.trim().toLowerCase(), hash, role, phone || null, department || null));
    (await logAudit({ orgId: req.orgId, user: req.user, action: `Created user ${username} (${role})` }));
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Could not create user' });
  }
});

router.put('/users/:id/status', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { active } = req.body;
  const user = (await db.prepare(`SELECT * FROM users WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  (await db.prepare(`UPDATE users SET active = ? WHERE id = ? AND organization_id = ?`).run(active ? 1 : 0, req.params.id, req.orgId));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Set user ${req.params.id} active=${active}` }));
  res.json({ ok: true });
});

// =========================================================================
// PASSWORD RESET
// =========================================================================
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests from this network. Please try again later.' }
});

function hashToken(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }

router.post('/forgot-password', resetLimiter, async (req, res) => {
  const { username } = req.body;
  // Always the same response whether or not the account exists - the same enumeration
  // protection already applied to /login.
  const genericResponse = { message: "If an account exists with that username, we've sent password reset instructions." };
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const user = (await db.prepare(`SELECT * FROM users WHERE username = ? AND active = 1`).get(username.trim().toLowerCase()));
  if (!user) return res.json(genericResponse);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60000).toISOString(); // 1 hour
  (await db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES (?,?,?,?)`)
    .run(user.id, hashToken(rawToken), expiresAt, req.ip));

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const resetLink = `${baseUrl}/marketing/reset-password.html?token=${rawToken}`;
  (await sendEmail(user.organization_id, user.username, 'Reset your Aiventra password',
    `Hi ${user.name},\n\nSomeone requested a password reset for your Aiventra account. If this was you, click the link below within the next hour:\n\n${resetLink}\n\nIf you didn't request this, you can safely ignore this email - your password will not change.`,
    'password_reset_requested'));

  res.json(genericResponse);
});

router.post('/reset-password', resetLimiter, async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });
  const pwError = isWeakPassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });

  const record = (await db.prepare(`SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`)
    .get(hashToken(token)));
  if (!record) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });

  const user = (await db.prepare(`SELECT * FROM users WHERE id = ?`).get(record.user_id));
  if (!user) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });

  const hash = bcrypt.hashSync(newPassword, 10);
  (await db.prepare(`UPDATE users SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?`).run(hash, user.id));
  (await db.prepare(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?`).run(record.id));

  if (user.organization_id) (await logAudit({ orgId: user.organization_id, user: null, action: `Password reset via email link: ${user.username}` }));
  res.json({ ok: true, message: 'Your password has been reset. You can now log in.' });
});

// =========================================================================
// STAFF INVITATIONS
// =========================================================================
router.get('/invitations', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  res.json((await db.prepare(`SELECT id, email, name, role, status, expires_at, created_at, accepted_at
    FROM invitations WHERE organization_id = ? ORDER BY created_at DESC`).all(req.orgId)));
});

router.post('/invitations', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { email, name, role } = req.body;
  if (!email || !role) return res.status(400).json({ error: 'Email and role are required' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const cleanEmail = email.trim().toLowerCase();

  const existingUser = (await db.prepare(`SELECT id FROM users WHERE username = ?`).get(cleanEmail));
  if (existingUser) return res.status(409).json({ error: 'An account with this email already exists' });

  // A fresh invite supersedes any still-pending one for the same email, rather than piling
  // up multiple valid links for the same person.
  (await db.prepare(`UPDATE invitations SET status = 'revoked' WHERE organization_id = ? AND email = ? AND status = 'pending'`)
    .run(req.orgId, cleanEmail));

  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString(); // 7 days
  const info = (await db.prepare(`INSERT INTO invitations (organization_id, email, name, role, token_hash, invited_by, expires_at)
    VALUES (?,?,?,?,?,?,?)`).run(req.orgId, cleanEmail, name || null, role, hashToken(rawToken), req.user.id, expiresAt));

  const org = (await db.prepare(`SELECT name FROM organizations WHERE id = ?`).get(req.orgId));
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const acceptLink = `${baseUrl}/accept-invite.html?token=${rawToken}`;
  (await sendEmail(req.orgId, cleanEmail, `You've been invited to join ${org.name} on Aiventra`,
    `Hi${name ? ' ' + name : ''},\n\n${req.user.name} has invited you to join ${org.name} on Aiventra as a ${role.replace('_', ' ')}.\n\nAccept your invitation within the next 7 days:\n\n${acceptLink}`,
    'staff_invitation'));

  (await logAudit({ orgId: req.orgId, user: req.user, action: `Invited ${cleanEmail} as ${role}` }));
  res.json({ id: info.lastInsertRowid });
});

router.put('/invitations/:id/revoke', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const invitation = (await db.prepare(`SELECT * FROM invitations WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
  if (invitation.status !== 'pending') return res.status(400).json({ error: `This invitation is already ${invitation.status}` });
  (await db.prepare(`UPDATE invitations SET status = 'revoked' WHERE id = ?`).run(invitation.id));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Revoked invitation for ${invitation.email}` }));
  res.json({ ok: true });
});

// Public - the invitee has no account yet, so this cannot require authentication.
router.get('/invitations/lookup/:token', async (req, res) => {
  const invitation = (await db.prepare(`SELECT i.*, o.name as organization_name FROM invitations i
    JOIN organizations o ON o.id = i.organization_id
    WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > datetime('now')`).get(hashToken(req.params.token)));
  if (!invitation) return res.status(404).json({ error: 'This invitation link is invalid or has expired.' });
  res.json({ email: invitation.email, name: invitation.name, role: invitation.role, organizationName: invitation.organization_name });
});

router.post('/invitations/accept', resetLimiter, async (req, res) => {
  const { token, name, password } = req.body;
  if (!token || !name || !password) return res.status(400).json({ error: 'Name and password are required' });
  const pwError = isWeakPassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  const invitation = (await db.prepare(`SELECT * FROM invitations WHERE token_hash = ? AND status = 'pending' AND expires_at > datetime('now')`)
    .get(hashToken(token)));
  if (!invitation) return res.status(400).json({ error: 'This invitation link is invalid or has expired.' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const tx = db.transaction(async () => {
      const userInfo = (await db.prepare(`INSERT INTO users (organization_id, name, username, password_hash, role) VALUES (?,?,?,?,?)`)
        .run(invitation.organization_id, name, invitation.email, hash, invitation.role));
      (await db.prepare(`UPDATE invitations SET status = 'accepted', accepted_at = datetime('now'), accepted_user_id = ? WHERE id = ?`)
        .run(userInfo.lastInsertRowid, invitation.id));
      return userInfo.lastInsertRowid;
    });
    const userId = (await tx());

    (await logAudit({ orgId: invitation.organization_id, user: { id: userId, name, role: invitation.role }, action: `Accepted invitation, account created (${invitation.role})` }));

    const org = (await db.prepare(`SELECT name, slug FROM organizations WHERE id = ?`).get(invitation.organization_id));
    const payload = { id: userId, name, username: invitation.email, role: invitation.role, organization_id: invitation.organization_id, organization_name: org ? org.name : null, organization_slug: org ? org.slug : null };
    const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token: jwtToken, user: payload });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'An account with this email already exists' });
    res.status(500).json({ error: 'Could not create your account' });
  }
});

module.exports = router;