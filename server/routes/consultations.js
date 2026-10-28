const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const { logTimeline, logAudit, notify } = require('../utils/helpers');

const router = express.Router();

router.get('/today/:doctorId', authenticate, requireOrgContext, authorize(['doctor', ...ROLE_GROUPS.ADMIN]), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = (await db.prepare(`
    SELECT o.*, p.full_name, p.age, p.gender, p.mobile
    FROM opd_visits o JOIN patients p ON p.patient_id = o.patient_id AND p.organization_id = o.organization_id
    WHERE o.organization_id = ? AND o.doctor_id = ? AND o.visit_date = ? AND o.status != 'Cancelled'
    ORDER BY o.token_number ASC`).all(req.orgId, req.params.doctorId, date));
  res.json(rows);
});

router.post('/', authenticate, requireOrgContext, authorize('doctor'), async (req, res) => {
  const orgId = req.orgId;
  const {
    opd_visit_id, patient_id, doctor_id, chief_complaint, symptoms, diagnosis,
    vitals, clinical_notes, treatment, medicines, lab_investigations, advice,
    follow_up_date, decision
  } = req.body;

  if (!patient_id || !doctor_id) return res.status(400).json({ error: 'patient_id and doctor_id required' });
  if (!['OPD Treatment', 'Recommend Admission'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be OPD Treatment or Recommend Admission' });
  }

  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(patient_id, orgId));
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  if (opd_visit_id) {
    const visit = (await db.prepare(`SELECT * FROM opd_visits WHERE id = ? AND organization_id = ?`).get(opd_visit_id, orgId));
    if (!visit) return res.status(404).json({ error: 'OPD visit not found' });
  }

  const info = (await db.prepare(`INSERT INTO consultations
    (organization_id, opd_visit_id, patient_id, doctor_id, chief_complaint, symptoms, diagnosis, vitals, clinical_notes,
     treatment, medicines, lab_investigations, advice, follow_up_date, decision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orgId, opd_visit_id || null, patient_id, doctor_id, chief_complaint || null, symptoms || null, diagnosis || null,
      vitals ? JSON.stringify(vitals) : null, clinical_notes || null, treatment || null, medicines || null,
      lab_investigations || null, advice || null, follow_up_date || null, decision));

  if (opd_visit_id) (await db.prepare(`UPDATE opd_visits SET status='Completed' WHERE id = ? AND organization_id = ?`).run(opd_visit_id, orgId));

  (await logTimeline(orgId, patient_id, 'OPD consultation', diagnosis || 'Consultation completed'));
  if (decision === 'Recommend Admission') {
    (await logTimeline(orgId, patient_id, 'Admission recommended', diagnosis || ''));
    (await notify(orgId, 'Admission pending', `${patient_id} recommended for admission by doctor`, 'receptionist'));
  }
  (await logAudit({ orgId, user: req.user, action: `Consultation recorded (${decision})`, patientId: patient_id }));

  res.json({ id: info.lastInsertRowid });
});

// Patients recommended for admission but not yet admitted
router.get('/pending-admissions', authenticate, requireOrgContext, async (req, res) => {
  const rows = (await db.prepare(`
    SELECT c.*, p.full_name, p.age, p.gender, p.mobile, d.name as doctor_name
    FROM consultations c
    JOIN patients p ON p.patient_id = c.patient_id AND p.organization_id = c.organization_id
    LEFT JOIN doctors d ON d.id = c.doctor_id
    WHERE c.organization_id = ? AND c.decision = 'Recommend Admission'
    AND c.patient_id NOT IN (SELECT patient_id FROM admissions WHERE status = 'Active' AND organization_id = c.organization_id)
    AND c.id IN (SELECT MAX(id) FROM consultations WHERE organization_id = ? GROUP BY patient_id)
    ORDER BY c.created_at DESC`).all(req.orgId, req.orgId));
  res.json(rows);
});

module.exports = router;
