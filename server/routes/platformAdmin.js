const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requirePlatformAdmin } = require('../middleware/auth');

const router = express.Router();

async function logPlatformAction(adminUser, orgId, action, detail) {
  (await db.prepare(`INSERT INTO platform_audit_log (admin_user_id, admin_name, organization_id, action, detail)
    VALUES (?,?,?,?,?)`).run(adminUser.id, adminUser.name, orgId || null, action, detail || null));
}

// Every route below requires a verified aiventra_super_admin token. There is no hospital
// data isolation concern here in the usual sense (this IS the cross-organization view by
// design) - what matters instead is that ONLY aiventra_super_admin can reach it, and that
// every action taken is written to platform_audit_log, separate from any hospital's own
// clinical audit_log.
router.use(authenticate, requirePlatformAdmin);

// =========================================================================
// ORGANIZATIONS
// =========================================================================
router.get('/organizations', async (req, res) => {
  const { q, status } = req.query;
  let query = `SELECT o.*,
      (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id AND u.active = 1) as active_users,
      (SELECT COUNT(*) FROM patients p WHERE p.organization_id = o.id) as patient_count,
      (SELECT s.status FROM subscriptions s WHERE s.organization_id = o.id ORDER BY s.id DESC LIMIT 1) as subscription_status,
      (SELECT pl.name FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id WHERE s.organization_id = o.id ORDER BY s.id DESC LIMIT 1) as plan_name
    FROM organizations o WHERE 1=1`;
  const params = [];
  if (q) { query += ` AND (o.name LIKE ? OR o.slug LIKE ? OR o.contact_email LIKE ?)`; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { query += ` AND o.status = ?`; params.push(status); }
  query += ` ORDER BY o.created_at DESC`;
  res.json((await db.prepare(query).all(...params)));
});

// Tenant onboarding: creates a brand-new hospital + its owner account in one step, with NO
// source-code, route, or deployment changes required. As soon as this returns, the hospital
// is reachable at /hms/<slug> and its owner can log in immediately - this is the entire
// "add Hospital C after launch" story described in docs/tenant-isolation.md.
function slugify(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'hospital';
}

router.post('/organizations', async (req, res) => {
  const { hospital_name, slug: requestedSlug, org_type, city, state, contact_email, contact_phone, logo_url,
    owner_name, owner_email, owner_password } = req.body;

  if (!hospital_name || !owner_name || !owner_email) {
    return res.status(400).json({ error: 'Hospital name, owner name and owner email are required' });
  }
  if (logo_url && !/^https?:\/\//i.test(logo_url)) {
    return res.status(400).json({ error: 'Logo URL must be a full http(s):// URL' });
  }

  const username = owner_email.trim().toLowerCase();
  const existingUser = (await db.prepare(`SELECT id FROM users WHERE username = ?`).get(username));
  if (existingUser) return res.status(409).json({ error: 'A user account with this email already exists' });

  // Slug: platform admin can propose one (e.g. "abc-hospital"), otherwise it's derived from
  // the hospital name. Either way it must be unique - on a collision we tell the caller
  // rather than silently renaming their requested slug out from under them.
  let slug = slugify(requestedSlug || hospital_name);
  const slugTaken = (await db.prepare(`SELECT id FROM organizations WHERE slug = ?`).get(slug));
  if (slugTaken) {
    return res.status(409).json({ error: `Slug "${slug}" is already in use by another hospital. Please choose a different slug.` });
  }

  // If the platform admin doesn't set an initial password, generate one and return it ONCE
  // in the response - it is never stored or logged in plain text anywhere.
  const generatedPassword = owner_password || `Aiv${crypto.randomBytes(5).toString('hex')}7x`;
  const pwError = isWeakPasswordLocal(generatedPassword);
  if (pwError) return res.status(400).json({ error: pwError });

  const tx = db.transaction(async () => {
    const orgInfo = (await db.prepare(`
      INSERT INTO organizations (name, slug, org_type, status, city, state, contact_email, contact_phone, logo_path, onboarding_step, onboarding_completed)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 'hospital_profile', 0)
    `).run(hospital_name, slug, ['Hospital', 'Clinic', 'Nursing Home'].includes(org_type) ? org_type : 'Hospital',
      city || null, state || null, contact_email || username, contact_phone || null, logo_url || null));
    const orgId = orgInfo.lastInsertRowid;

    const hash = bcrypt.hashSync(generatedPassword, 10);
    const userInfo = (await db.prepare(`
      INSERT INTO users (organization_id, name, username, password_hash, role, phone)
      VALUES (?, ?, ?, ?, 'organization_owner', ?)
    `).run(orgId, owner_name, username, hash, contact_phone || null));

    return { orgId, userId: userInfo.lastInsertRowid };
  });

  const { orgId, userId } = (await tx());
  (await logPlatformAction(req.user, orgId, `Hospital created: "${hospital_name}" (slug: ${slug})`, `Owner account: ${username}`));

  res.json({
    organization: { id: orgId, name: hospital_name, slug, url: `/hms/${slug}` },
    owner: { id: userId, username, name: owner_name },
    // Only present when we generated it ourselves - the caller must copy it now and hand it
    // to the hospital; it is not recoverable afterwards (only a password reset can change it).
    temporaryPassword: owner_password ? undefined : generatedPassword
  });
});

// Same weak-password rule as server/routes/auth.js, duplicated locally rather than imported
// to avoid coupling this platform-only file to the hospital auth router's internals.
function isWeakPasswordLocal(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must include at least one letter and one number';
  return null;
}

router.get('/organizations/:id', async (req, res) => {
  const org = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(req.params.id));
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const subscription = (await db.prepare(`
    SELECT s.*, p.name as plan_name, p.code as plan_code FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id WHERE s.organization_id = ? ORDER BY s.id DESC LIMIT 1`).get(org.id));
  const users = (await db.prepare(`SELECT id, name, username, role, active, created_at FROM users WHERE organization_id = ? ORDER BY id`).all(org.id));
  const stats = {
    patients: (await db.prepare(`SELECT COUNT(*) c FROM patients WHERE organization_id = ?`).get(org.id)).c,
    admissions: (await db.prepare(`SELECT COUNT(*) c FROM admissions WHERE organization_id = ?`).get(org.id)).c,
    opdThisMonth: (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date >= date('now','start of month')`).get(org.id)).c,
    storageBytes: getOrgStorageBytes(org.id)
  };
  const paymentHistory = (await db.prepare(`SELECT * FROM subscription_payments WHERE organization_id = ? ORDER BY created_at DESC LIMIT 20`).all(org.id));
  const supportTickets = (await db.prepare(`SELECT * FROM support_tickets WHERE organization_id = ? ORDER BY created_at DESC`).all(org.id));

  res.json({ organization: org, subscription, users, stats, paymentHistory, supportTickets });
});

router.put('/organizations/:id/status', async (req, res) => {
  const { status, reason } = req.body;
  const valid = ['trial', 'active', 'payment_due', 'grace_period', 'suspended', 'cancelled', 'expired'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const org = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(req.params.id));
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  if (status === 'suspended') {
    (await db.prepare(`UPDATE organizations SET status=?, suspended_at=datetime('now'), suspended_reason=?, updated_at=datetime('now') WHERE id=?`)
      .run(status, reason || null, org.id));
  } else {
    (await db.prepare(`UPDATE organizations SET status=?, suspended_at=NULL, suspended_reason=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(status, org.id));
  }
  (await logPlatformAction(req.user, org.id, `Organization status changed: ${org.status} -> ${status}`, reason || null));
  res.json({ ok: true });
});

router.put('/organizations/:id/notes', async (req, res) => {
  const org = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(req.params.id));
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  (await db.prepare(`UPDATE organizations SET internal_notes = ?, updated_at = datetime('now') WHERE id = ?`).run(req.body.notes || '', org.id));
  (await logPlatformAction(req.user, org.id, 'Internal note updated', null));
  res.json({ ok: true });
});

function getOrgStorageBytes(orgId) {
  const dir = path.join(__dirname, '..', '..', 'uploads', `organization-${orgId}`);
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (d) => {
    fs.readdirSync(d, { withFileTypes: true }).forEach(entry => {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    });
  };
  try { walk(dir); } catch (e) { /* ignore transient FS errors */ }
  return total;
}

// =========================================================================
// PLANS (editable pricing configuration - closes the Phase 2 documented gap
// where plan prices could only be changed by re-running a seed script)
// =========================================================================
router.get('/plans', async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM plans ORDER BY display_order`).all())
    .map(p => ({ ...p, enabled_modules: JSON.parse(p.enabled_modules || '[]') })));
});

router.post('/plans', async (req, res) => {
  const b = req.body;
  if (!b.code || !b.name || b.monthly_price == null || b.annual_price == null) {
    return res.status(400).json({ error: 'code, name, monthly_price, annual_price are required' });
  }
  try {
    const info = (await db.prepare(`INSERT INTO plans
      (code, name, monthly_price, annual_price, installation_fee, gst_percent, bed_limit, opd_limit,
       user_limit, doctor_limit, branch_limit, storage_limit_gb, enabled_modules, trial_days, display_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.code, b.name, b.monthly_price, b.annual_price, b.installation_fee || 0, b.gst_percent ?? 18,
        b.bed_limit ?? null, b.opd_limit ?? null, b.user_limit ?? null, b.doctor_limit ?? null,
        b.branch_limit ?? null, b.storage_limit_gb ?? null, JSON.stringify(b.enabled_modules || []),
        b.trial_days ?? 14, b.display_order ?? 0));
    (await logPlatformAction(req.user, null, `Plan created: ${b.code}`, JSON.stringify(b)));
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'A plan with this code already exists' });
    res.status(500).json({ error: 'Could not create plan' });
  }
});

router.put('/plans/:id', async (req, res) => {
  const plan = (await db.prepare(`SELECT * FROM plans WHERE id = ?`).get(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const b = req.body;
  const fields = {
    name: b.name ?? plan.name,
    monthly_price: b.monthly_price ?? plan.monthly_price,
    annual_price: b.annual_price ?? plan.annual_price,
    installation_fee: b.installation_fee ?? plan.installation_fee,
    gst_percent: b.gst_percent ?? plan.gst_percent,
    bed_limit: b.bed_limit !== undefined ? b.bed_limit : plan.bed_limit,
    opd_limit: b.opd_limit !== undefined ? b.opd_limit : plan.opd_limit,
    user_limit: b.user_limit !== undefined ? b.user_limit : plan.user_limit,
    doctor_limit: b.doctor_limit !== undefined ? b.doctor_limit : plan.doctor_limit,
    branch_limit: b.branch_limit !== undefined ? b.branch_limit : plan.branch_limit,
    storage_limit_gb: b.storage_limit_gb !== undefined ? b.storage_limit_gb : plan.storage_limit_gb,
    enabled_modules: b.enabled_modules ? JSON.stringify(b.enabled_modules) : plan.enabled_modules,
    trial_days: b.trial_days ?? plan.trial_days,
    display_order: b.display_order ?? plan.display_order
  };
  (await db.prepare(`UPDATE plans SET name=?, monthly_price=?, annual_price=?, installation_fee=?, gst_percent=?,
    bed_limit=?, opd_limit=?, user_limit=?, doctor_limit=?, branch_limit=?, storage_limit_gb=?,
    enabled_modules=?, trial_days=?, display_order=?, updated_at=datetime('now') WHERE id=?`)
    .run(fields.name, fields.monthly_price, fields.annual_price, fields.installation_fee, fields.gst_percent,
      fields.bed_limit, fields.opd_limit, fields.user_limit, fields.doctor_limit, fields.branch_limit,
      fields.storage_limit_gb, fields.enabled_modules, fields.trial_days, fields.display_order, plan.id));
  (await logPlatformAction(req.user, null, `Plan updated: ${plan.code}`, JSON.stringify(b)));
  res.json({ ok: true });
});

router.put('/plans/:id/toggle', async (req, res) => {
  const plan = (await db.prepare(`SELECT * FROM plans WHERE id = ?`).get(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  (await db.prepare(`UPDATE plans SET active = ?, updated_at = datetime('now') WHERE id = ?`).run(plan.active ? 0 : 1, plan.id));
  (await logPlatformAction(req.user, null, `Plan ${plan.active ? 'deactivated' : 'activated'}: ${plan.code}`, null));
  res.json({ ok: true });
});

// =========================================================================
// ANALYTICS
// =========================================================================
router.get('/analytics', async (req, res) => {
  const totalOrganizations = (await db.prepare(`SELECT COUNT(*) c FROM organizations`).get()).c;
  const trialOrganizations = (await db.prepare(`SELECT COUNT(*) c FROM organizations WHERE status = 'trial'`).get()).c;
  const activeSubscriptions = (await db.prepare(`SELECT COUNT(*) c FROM subscriptions WHERE status = 'active'`).get()).c;
  const newSignups30d = (await db.prepare(`SELECT COUNT(*) c FROM organizations WHERE created_at >= datetime('now','-30 days')`).get()).c;
  const activeUsers = (await db.prepare(`SELECT COUNT(*) c FROM users WHERE active = 1 AND organization_id IS NOT NULL`).get()).c;
  const opdThisMonth = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE visit_date >= date('now','start of month')`).get()).c;
  const failedPayments30d = (await db.prepare(`SELECT COUNT(*) c FROM subscription_payments WHERE status = 'failed' AND created_at >= datetime('now','-30 days')`).get()).c;
  const pendingOnboarding = (await db.prepare(`SELECT COUNT(*) c FROM organizations WHERE onboarding_completed = 0`).get()).c;
  const openSupportTickets = (await db.prepare(`SELECT COUNT(*) c FROM support_tickets WHERE status IN ('open','in_progress')`).get()).c;

  // MRR: active monthly subscriptions counted at face value, active annual subscriptions
  // divided by 12. GST-exclusive (base_amount), since GST is a pass-through, not revenue.
  const monthlyMRR = (await db.prepare(`SELECT COALESCE(SUM(base_amount),0) s FROM subscriptions WHERE status='active' AND billing_cycle='monthly'`).get()).s;
  const annualMRR = (await db.prepare(`SELECT COALESCE(SUM(base_amount),0) s FROM subscriptions WHERE status='active' AND billing_cycle='annual'`).get()).s;
  const mrr = Math.round((monthlyMRR + annualMRR / 12) * 100) / 100;

  const storageByOrg = (await db.prepare(`SELECT id FROM organizations`).all())
    .reduce((sum, o) => sum + getOrgStorageBytes(o.id), 0);

  res.json({
    totalOrganizations, trialOrganizations, activeSubscriptions, newSignups30d,
    activeUsers, opdThisMonth, failedPayments30d, pendingOnboarding, openSupportTickets,
    mrr, totalStorageBytes: storageByOrg
  });
});

// =========================================================================
// SUPPORT ACCESS (Aiventra admin requests -> hospital must approve -> auto-expires)
// =========================================================================
router.get('/support-access', async (req, res) => {
  res.json((await db.prepare(`
    SELECT r.*, o.name as organization_name, u.name as approved_by_name
    FROM support_access_requests r
    JOIN organizations o ON o.id = r.organization_id
    LEFT JOIN users u ON u.id = r.approved_by
    ORDER BY r.created_at DESC`).all()));
});

router.post('/support-access/:orgId/request', async (req, res) => {
  const org = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(req.params.orgId));
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const info = (await db.prepare(`INSERT INTO support_access_requests (organization_id, requested_by, reason) VALUES (?,?,?)`)
    .run(org.id, req.user.id, req.body.reason || null));
  (await logPlatformAction(req.user, org.id, 'Support access requested', req.body.reason || null));
  res.json({ id: info.lastInsertRowid });
});

router.put('/support-access/:id/revoke', async (req, res) => {
  const request = (await db.prepare(`SELECT * FROM support_access_requests WHERE id = ?`).get(req.params.id));
  if (!request) return res.status(404).json({ error: 'Request not found' });
  (await db.prepare(`UPDATE support_access_requests SET status = 'revoked' WHERE id = ?`).run(request.id));
  (await logPlatformAction(req.user, request.organization_id, 'Support access self-revoked', null));
  res.json({ ok: true });
});

router.get('/audit-log', async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM platform_audit_log ORDER BY created_at DESC LIMIT 300`).all()));
});

// =========================================================================
// MARKETING LEADS (from the public site's Book a Demo / Contact forms)
// =========================================================================
router.get('/leads', async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM marketing_leads ORDER BY created_at DESC LIMIT 300`).all()));
});

router.put('/leads/:id/status', async (req, res) => {
  const valid = ['new', 'contacted', 'converted', 'closed'];
  if (!valid.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  (await db.prepare(`UPDATE marketing_leads SET status = ? WHERE id = ?`).run(req.body.status, req.params.id));
  res.json({ ok: true });
});

module.exports = router;
