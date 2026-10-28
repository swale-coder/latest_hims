const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext } = require('../middleware/auth');
const { logTimeline, logAudit } = require('../utils/helpers');

const router = express.Router();

router.post('/prescriptions', authenticate, requireOrgContext, authorize(['doctor']), async (req, res) => {
  const orgId = req.orgId;
  const { patient_id, admission_id, medicine, dose, route, frequency, start_date, end_date } = req.body;
  if (!patient_id || !medicine) return res.status(400).json({ error: 'patient_id and medicine required' });
  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(patient_id, orgId));
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const info = (await db.prepare(`INSERT INTO prescriptions (organization_id, patient_id, admission_id, medicine, dose, route, frequency, start_date, end_date, prescribed_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(orgId, patient_id, admission_id || null, medicine, dose || null, route || null, frequency || null,
      start_date || null, end_date || null, req.user.id));
  (await logTimeline(orgId, patient_id, 'Medicine prescribed', `${medicine} ${dose || ''}`));
  (await logAudit({ orgId, user: req.user, action: `Prescribed ${medicine}`, patientId: patient_id }));
  res.json({ id: info.lastInsertRowid });
});

router.get('/prescriptions/:patientId', authenticate, requireOrgContext, async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM prescriptions WHERE patient_id = ? AND organization_id = ? ORDER BY created_at DESC`).all(req.params.patientId, req.orgId)));
});

router.post('/administer', authenticate, requireOrgContext, authorize(['nurse', 'doctor']), async (req, res) => {
  const orgId = req.orgId;
  const { prescription_id, patient_id, notes } = req.body;
  if (!prescription_id || !patient_id) return res.status(400).json({ error: 'prescription_id and patient_id required' });
  const rx = (await db.prepare(`SELECT * FROM prescriptions WHERE id = ? AND organization_id = ?`).get(prescription_id, orgId));
  if (!rx) return res.status(404).json({ error: 'Prescription not found' });
  const info = (await db.prepare(`INSERT INTO medication_administration (organization_id, prescription_id, patient_id, administered_by, notes)
    VALUES (?,?,?,?,?)`).run(orgId, prescription_id, patient_id, req.user.id, notes || null));
  (await logTimeline(orgId, patient_id, 'Medication administered', rx.medicine));
  res.json({ id: info.lastInsertRowid });
});

router.get('/administration/:patientId', authenticate, requireOrgContext, async (req, res) => {
  res.json((await db.prepare(`
    SELECT ma.*, p.medicine, p.dose FROM medication_administration ma
    JOIN prescriptions p ON p.id = ma.prescription_id AND p.organization_id = ma.organization_id
    WHERE ma.patient_id = ? AND ma.organization_id = ? ORDER BY ma.administered_at DESC`).all(req.params.patientId, req.orgId)));
});

module.exports = router;
