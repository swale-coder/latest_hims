const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');

const router = express.Router();

// The onboarding sequence. Stored as free text on organizations.onboarding_step so it can
// be extended later without a schema change; validated against this list here.
const STEPS = ['signup', 'hospital_profile', 'plan_selection', 'structure_setup', 'staff_invites', 'completed'];

router.get('/status', authenticate, requireOrgContext, async (req, res) => {
  const org = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(req.orgId));
  const subscription = (await db.prepare(`SELECT * FROM subscriptions WHERE organization_id = ? ORDER BY id DESC LIMIT 1`).get(req.orgId));
  const bedCount = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ?`).get(req.orgId)).c;
  const staffCount = (await db.prepare(`SELECT COUNT(*) c FROM users WHERE organization_id = ? AND active = 1`).get(req.orgId)).c;

  const checklist = {
    hospitalProfile: !!(org.bed_count && org.expected_monthly_opd),
    planSelected: !!subscription,
    structureSetUp: bedCount > 0,
    staffInvited: staffCount > 1 // more than just the owner
  };

  res.json({
    organization: org,
    onboardingStep: org.onboarding_step,
    onboardingCompleted: !!org.onboarding_completed,
    trialEndsAt: org.trial_ends_at,
    checklist
  });
});

router.put('/profile', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { bed_count, expected_monthly_opd, gstin, registration_number, invoice_prefix, patient_id_prefix, contact_email, contact_phone, city, state } = req.body;

  (await db.prepare(`UPDATE organizations SET
    bed_count = COALESCE(?, bed_count),
    expected_monthly_opd = COALESCE(?, expected_monthly_opd),
    gstin = COALESCE(?, gstin),
    registration_number = COALESCE(?, registration_number),
    invoice_prefix = COALESCE(?, invoice_prefix),
    patient_id_prefix = COALESCE(?, patient_id_prefix),
    contact_email = COALESCE(?, contact_email),
    contact_phone = COALESCE(?, contact_phone),
    city = COALESCE(?, city),
    state = COALESCE(?, state),
    onboarding_step = CASE WHEN onboarding_step = 'hospital_profile' THEN 'plan_selection' ELSE onboarding_step END,
    updated_at = datetime('now')
    WHERE id = ?`)
    .run(bed_count ?? null, expected_monthly_opd ?? null, gstin || null, registration_number || null,
      invoice_prefix || null, patient_id_prefix || null, contact_email || null, contact_phone || null,
      city || null, state || null, req.orgId));

  (await logAudit({ orgId: req.orgId, user: req.user, action: 'Updated hospital profile (onboarding)' }));
  res.json({ ok: true });
});

router.put('/step', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { step } = req.body;
  if (!STEPS.includes(step)) return res.status(400).json({ error: 'Invalid onboarding step' });
  const completed = step === 'completed' ? 1 : 0;
  (await db.prepare(`UPDATE organizations SET onboarding_step = ?, onboarding_completed = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(step, completed, req.orgId));
  if (completed) (await logAudit({ orgId: req.orgId, user: req.user, action: 'Onboarding completed' }));
  res.json({ ok: true });
});

module.exports = router;
