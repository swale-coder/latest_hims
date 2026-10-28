const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const { nextAdmissionNumber, logTimeline, logAudit, sendSMS, notify } = require('../utils/helpers');

const router = express.Router();

// ---------- CREATE ADMISSION ----------
router.post('/', authenticate, requireOrgContext, authorize(ROLE_GROUPS.FRONT_DESK), async (req, res) => {
  const orgId = req.orgId;
  const {
    patient_id, referring_doctor_id, attending_doctor_id, department_id,
    reason, diagnosis, proposed_treatment, admission_type, bed_id
  } = req.body;

  if (!patient_id || !attending_doctor_id) {
    return res.status(400).json({ error: 'patient_id and attending_doctor_id are required' });
  }

  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(patient_id, orgId));
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const activeAdmission = (await db.prepare(`SELECT * FROM admissions WHERE patient_id = ? AND organization_id = ? AND status = 'Active'`).get(patient_id, orgId));
  if (activeAdmission) return res.status(400).json({ error: 'Patient already has an active admission' });

  let bed = null;
  if (bed_id) {
    bed = (await db.prepare(`SELECT * FROM beds WHERE id = ? AND organization_id = ?`).get(bed_id, orgId));
    if (!bed) return res.status(404).json({ error: 'Bed not found' });
    if (bed.status !== 'Available') return res.status(400).json({ error: `Bed ${bed.bed_number} is not available (status: ${bed.status})` });
  }

  const admissionNumber = (await nextAdmissionNumber());

  const tx = db.transaction(async () => {
    const info = (await db.prepare(`INSERT INTO admissions
      (organization_id, admission_number, patient_id, referring_doctor_id, attending_doctor_id, department_id,
       reason, diagnosis, proposed_treatment, admission_type, bed_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orgId, admissionNumber, patient_id, referring_doctor_id || null, attending_doctor_id, department_id || null,
        reason || null, diagnosis || null, proposed_treatment || null, admission_type || 'Normal', bed_id || null));

    const admissionId = info.lastInsertRowid;

    if (bed) {
      (await db.prepare(`UPDATE beds SET status = 'Occupied' WHERE id = ? AND organization_id = ?`).run(bed.id, orgId));
      (await db.prepare(`INSERT INTO bed_allocations (organization_id, bed_id, admission_id, patient_id) VALUES (?,?,?,?)`)
        .run(orgId, bed.id, admissionId, patient_id));
    }
    return admissionId;
  });

  const admissionId = (await tx());

  (await logTimeline(orgId, patient_id, 'Patient admitted', `Admission ${admissionNumber}`));
  if (bed) (await logTimeline(orgId, patient_id, 'Bed assigned', `Bed ${bed.bed_number}`));
  (await logAudit({ orgId, user: req.user, action: `Admission created ${admissionNumber}`, patientId: patient_id }));

  (await sendSMS(orgId, patient_id, patient.mobile, 'Admission',
    `Dear ${patient.full_name}, you have been admitted. Admission No: ${admissionNumber}.${bed ? ` Your assigned bed is ${bed.bed_number}.` : ''} We wish you a smooth recovery.`));
  (await notify(orgId, 'Patient admitted', `${patient.full_name} (${patient_id}) admitted - ${admissionNumber}`, null));

  const admission = (await db.prepare(`SELECT * FROM admissions WHERE id = ?`).get(admissionId));
  res.json({ admission });
});

// ---------- ASSIGN / CHANGE BED FOR EXISTING ADMISSION ----------
router.post('/:id/assign-bed', authenticate, requireOrgContext, authorize(ROLE_GROUPS.FRONT_DESK.concat(['nurse'])), async (req, res) => {
  const orgId = req.orgId;
  const { bed_id } = req.body;
  const admission = (await db.prepare(`SELECT * FROM admissions WHERE id = ? AND organization_id = ?`).get(req.params.id, orgId));
  if (!admission) return res.status(404).json({ error: 'Admission not found' });
  if (admission.status !== 'Active') return res.status(400).json({ error: 'Admission is not active' });

  const bed = (await db.prepare(`SELECT * FROM beds WHERE id = ? AND organization_id = ?`).get(bed_id, orgId));
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  if (bed.status !== 'Available') return res.status(400).json({ error: `Bed ${bed.bed_number} is not available` });

  const tx = db.transaction(async () => {
    if (admission.bed_id) {
      (await db.prepare(`UPDATE beds SET status = 'Cleaning' WHERE id = ? AND organization_id = ?`).run(admission.bed_id, orgId));
      (await db.prepare(`UPDATE bed_allocations SET released_at = datetime('now') WHERE bed_id = ? AND admission_id = ? AND organization_id = ? AND released_at IS NULL`)
        .run(admission.bed_id, admission.id, orgId));
    }
    (await db.prepare(`UPDATE admissions SET bed_id = ? WHERE id = ? AND organization_id = ?`).run(bed.id, admission.id, orgId));
    (await db.prepare(`UPDATE beds SET status = 'Occupied' WHERE id = ? AND organization_id = ?`).run(bed.id, orgId));
    (await db.prepare(`INSERT INTO bed_allocations (organization_id, bed_id, admission_id, patient_id) VALUES (?,?,?,?)`)
      .run(orgId, bed.id, admission.id, admission.patient_id));
  });
  (await tx());

  (await logTimeline(orgId, admission.patient_id, 'Bed assigned', `Bed ${bed.bed_number}`));
  (await logAudit({ orgId, user: req.user, action: `Bed ${bed.bed_number} assigned`, patientId: admission.patient_id }));
  res.json({ ok: true });
});

// ---------- LIST ADMISSIONS ----------
router.get('/', authenticate, requireOrgContext, async (req, res) => {
  const status = req.query.status;
  let query = `
    SELECT a.*, p.full_name, p.age, p.gender, p.mobile, d.name as attending_doctor_name,
           b.bed_number, r.name as room_name, r.room_type, f.name as floor_name
    FROM admissions a
    JOIN patients p ON p.patient_id = a.patient_id AND p.organization_id = a.organization_id
    LEFT JOIN doctors d ON d.id = a.attending_doctor_id
    LEFT JOIN beds b ON b.id = a.bed_id
    LEFT JOIN rooms r ON r.id = b.room_id
    LEFT JOIN floors f ON f.id = r.floor_id
    WHERE a.organization_id = ?`;
  const params = [req.orgId];
  if (status) { query += ` AND a.status = ?`; params.push(status); }
  query += ` ORDER BY a.admitted_at DESC`;
  res.json((await db.prepare(query).all(...params)));
});

router.get('/:id', authenticate, requireOrgContext, async (req, res) => {
  const row = (await db.prepare(`
    SELECT a.*, p.full_name, p.age, p.gender, p.mobile, d.name as attending_doctor_name,
           b.bed_number, r.name as room_name, r.room_type, f.name as floor_name
    FROM admissions a
    JOIN patients p ON p.patient_id = a.patient_id AND p.organization_id = a.organization_id
    LEFT JOIN doctors d ON d.id = a.attending_doctor_id
    LEFT JOIN beds b ON b.id = a.bed_id
    LEFT JOIN rooms r ON r.id = b.room_id
    LEFT JOIN floors f ON f.id = r.floor_id
    WHERE a.id = ? AND a.organization_id = ?`).get(req.params.id, req.orgId));
  if (!row) return res.status(404).json({ error: 'Admission not found' });
  res.json(row);
});

module.exports = router;
