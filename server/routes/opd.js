const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const { nextOpdNumber, nextPatientId, logTimeline, logAudit, sendSMS, notify } = require('../utils/helpers');
const { resolvePublicOrg } = require('./patients');

const router = express.Router();

async function nextTokenNumber(orgId, doctorId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = (await db.prepare(`SELECT MAX(token_number) as m FROM opd_visits WHERE organization_id = ? AND doctor_id = ? AND visit_date = ?`)
    .get(orgId, doctorId, today));
  return (row && row.m ? row.m : 0) + 1;
}

async function createVisit(orgId, { patient, department_id, doctor_id, source }) {
  const opdNumber = (await nextOpdNumber());
  const token = doctor_id ? (await nextTokenNumber(orgId, doctor_id)) : null;
  const info = (await db.prepare(`INSERT INTO opd_visits (organization_id, opd_number, patient_id, department_id, doctor_id, token_number, source)
    VALUES (?,?,?,?,?,?,?)`).run(orgId, opdNumber, patient.patient_id, department_id || null, doctor_id || null, token, source));

  (await logTimeline(orgId, patient.patient_id, 'OPD registration', `OPD Number ${opdNumber}`));
  (await sendSMS(orgId, patient.patient_id, patient.mobile, 'OPD Registration',
    `Dear ${patient.full_name}, your OPD registration was successful. Your Patient ID is ${patient.patient_id}. Thank you.`));
  (await notify(orgId, 'New OPD registration', `${patient.full_name} (${patient.patient_id}) registered for OPD`, 'receptionist'));

  return (await db.prepare(`SELECT * FROM opd_visits WHERE id = ?`).get(info.lastInsertRowid));
}

// Staff registration: patient already found/created client-side via /patients/find-or-create
router.post('/register', authenticate, requireOrgContext, authorize(ROLE_GROUPS.FRONT_DESK), async (req, res) => {
  const { patient_id, department_id, doctor_id } = req.body;
  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(patient_id, req.orgId));
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const visit = (await createVisit(req.orgId, { patient, department_id, doctor_id, source: 'staff' }));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `OPD registration ${visit.opd_number}`, patientId: patient_id }));
  res.json({ visit });
});

// Public QR self-registration: creates/finds patient AND registers OPD visit in one call.
// The hospital is identified by ?org=<slug>, never by a client-supplied numeric id.
router.post('/public/register', async (req, res) => {
  const org = (await resolvePublicOrg(req, res));
  if (!org) return;
  const orgId = org.id;
  const { full_name, mobile, address, gender, dob, age, emergency_contact_name, emergency_contact_phone } = req.body;
  if (!full_name || !mobile) return res.status(400).json({ error: 'Full name and mobile number are required' });
  if (!/^[0-9]{10}$/.test(mobile.replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number' });
  }

  let patient = (await db.prepare(`SELECT * FROM patients WHERE organization_id = ? AND mobile = ?`).get(orgId, mobile.trim()));
  let isNew = false;
  if (!patient) {
    const patientId = (await nextPatientId());
    const info = (await db.prepare(`INSERT INTO patients (organization_id, patient_id, full_name, mobile, address, gender, dob, age, emergency_contact_name, emergency_contact_phone)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(orgId, patientId, full_name.trim(), mobile.trim(), address || null, gender || null, dob || null, age || null,
        emergency_contact_name || null, emergency_contact_phone || null));
    patient = (await db.prepare(`SELECT * FROM patients WHERE id = ?`).get(info.lastInsertRowid));
    isNew = true;
    (await logTimeline(orgId, patientId, 'Patient registered', 'Registered via QR self-registration'));
  }

  const visit = (await createVisit(orgId, { patient, source: 'qr_self' }));
  res.json({ patient, visit, isNew, message: isNew ? 'New patient registered.' : 'Patient record found.' });
});

// ---------- QUEUE / DASHBOARD ----------
router.get('/queue', authenticate, requireOrgContext, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = (await db.prepare(`
    SELECT o.*, p.full_name, p.mobile, p.age, p.gender, d.name as doctor_name, dep.name as department_name
    FROM opd_visits o
    JOIN patients p ON p.patient_id = o.patient_id AND p.organization_id = o.organization_id
    LEFT JOIN doctors d ON d.id = o.doctor_id
    LEFT JOIN departments dep ON dep.id = o.department_id
    WHERE o.organization_id = ? AND o.visit_date = ?
    ORDER BY o.created_at ASC`).all(req.orgId, date));
  res.json(rows);
});

router.get('/summary', authenticate, requireOrgContext, async (req, res) => {
  const orgId = req.orgId;
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const total = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date = ?`).get(orgId, date)).c;
  const waiting = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date = ? AND status='Waiting'`).get(orgId, date)).c;
  const inConsultation = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date = ? AND status='In Consultation'`).get(orgId, date)).c;
  const completed = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date = ? AND status='Completed'`).get(orgId, date)).c;
  const cancelled = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date = ? AND status='Cancelled'`).get(orgId, date)).c;
  const newPatients = (await db.prepare(`SELECT COUNT(DISTINCT p.patient_id) c FROM patients p
    JOIN opd_visits o ON o.patient_id = p.patient_id AND o.organization_id = p.organization_id
    WHERE p.organization_id = ? AND o.visit_date = ? AND date(p.created_at) = ?`).get(orgId, date, date)).c;
  res.json({ total, waiting, inConsultation, completed, cancelled, newPatients, returning: total - newPatients });
});

router.put('/:id/status', authenticate, requireOrgContext, async (req, res) => {
  const { status } = req.body;
  const valid = ['Waiting', 'In Consultation', 'Completed', 'Cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const visit = (await db.prepare(`SELECT * FROM opd_visits WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!visit) return res.status(404).json({ error: 'OPD visit not found' });
  (await db.prepare(`UPDATE opd_visits SET status = ? WHERE id = ? AND organization_id = ?`).run(status, req.params.id, req.orgId));
  res.json({ ok: true });
});

module.exports = router;
