const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const { logTimeline, logAudit } = require('../utils/helpers');

const router = express.Router();

router.post('/notes', authenticate, requireOrgContext, authorize(ROLE_GROUPS.CARE_TEAM), async (req, res) => {
  const orgId = req.orgId;
  const { patient_id, admission_id, note_type, content } = req.body;
  if (!patient_id || !content) return res.status(400).json({ error: 'patient_id and content required' });
  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(patient_id, orgId));
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  if (req.user.role === 'nurse' && note_type === 'Doctor Note') {
    return res.status(403).json({ error: 'Nurses cannot add doctor notes' });
  }
  const info = (await db.prepare(`INSERT INTO clinical_notes (organization_id, patient_id, admission_id, note_type, content, user_id, role)
    VALUES (?,?,?,?,?,?,?)`).run(orgId, patient_id, admission_id || null, note_type || 'Progress Note', content, req.user.id, req.user.role));
  (await logTimeline(orgId, patient_id, note_type || 'Progress Note', content.slice(0, 80)));
  (await logAudit({ orgId, user: req.user, action: `Added ${note_type || 'clinical note'}`, patientId: patient_id }));
  res.json({ id: info.lastInsertRowid });
});

router.get('/notes/:patientId', authenticate, requireOrgContext, async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM clinical_notes WHERE patient_id = ? AND organization_id = ? ORDER BY created_at DESC`).all(req.params.patientId, req.orgId)));
});

router.post('/vitals', authenticate, requireOrgContext, authorize(ROLE_GROUPS.CARE_TEAM), async (req, res) => {
  const orgId = req.orgId;
  const { patient_id, admission_id, temperature, pulse, bp, spo2, resp_rate } = req.body;
  if (!patient_id) return res.status(400).json({ error: 'patient_id required' });
  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(patient_id, orgId));
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const info = (await db.prepare(`INSERT INTO vitals (organization_id, patient_id, admission_id, temperature, pulse, bp, spo2, resp_rate, recorded_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(orgId, patient_id, admission_id || null, temperature || null, pulse || null, bp || null,
      spo2 || null, resp_rate || null, req.user.id));
  (await logTimeline(orgId, patient_id, 'Vitals recorded', `BP ${bp || '-'}, Pulse ${pulse || '-'}, Temp ${temperature || '-'}`));
  res.json({ id: info.lastInsertRowid });
});

router.get('/vitals/:patientId', authenticate, requireOrgContext, async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM vitals WHERE patient_id = ? AND organization_id = ? ORDER BY recorded_at DESC`).all(req.params.patientId, req.orgId)));
});

module.exports = router;
