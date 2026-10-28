const express = require('express');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const { logTimeline, logAudit, sendSMS, notify } = require('../utils/helpers');

const router = express.Router();

function pdfDir(orgId) {
  const dir = path.join(__dirname, '..', '..', 'uploads', `organization-${orgId}`, 'discharge-summaries');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- AUTO-GENERATE DRAFT FROM STORED PATIENT DATA ----------
router.post('/generate/:admissionId', authenticate, requireOrgContext, authorize(['doctor', ...ROLE_GROUPS.ADMIN]), async (req, res) => {
  const orgId = req.orgId;
  const admission = (await db.prepare(`SELECT * FROM admissions WHERE id = ? AND organization_id = ?`).get(req.params.admissionId, orgId));
  if (!admission) return res.status(404).json({ error: 'Admission not found' });
  if (admission.status !== 'Active') return res.status(400).json({ error: 'Admission is not active' });

  const existing = (await db.prepare(`SELECT * FROM discharge_summaries WHERE admission_id = ? AND organization_id = ?`).get(admission.id, orgId));
  if (existing) return res.json({ summary: existing });

  const pid = admission.patient_id;
  const notesRows = (await db.prepare(`SELECT content FROM clinical_notes WHERE admission_id = ? AND organization_id = ? ORDER BY created_at`).all(admission.id, orgId));
  const labRows = (await db.prepare(`SELECT test_name, result FROM lab_orders WHERE admission_id = ? AND organization_id = ?`).all(admission.id, orgId));
  const surgeryRows = (await db.prepare(`SELECT procedure_name, surgery_date FROM surgeries WHERE admission_id = ? AND organization_id = ?`).all(admission.id, orgId));
  const rxRows = (await db.prepare(`SELECT medicine, dose, frequency FROM prescriptions WHERE admission_id = ? AND organization_id = ?`).all(admission.id, orgId));
  const doctor = (await db.prepare(`SELECT * FROM doctors WHERE id = ? AND organization_id = ?`).get(admission.attending_doctor_id, orgId));

  const clinicalSummary = notesRows.map(n => n.content).join('\n') || 'No additional clinical notes recorded.';
  const investigations = labRows.map(l => `${l.test_name}: ${l.result || 'Pending'}`).join('\n') || 'No investigations recorded.';
  const procedures = surgeryRows.map(s => `${s.procedure_name} (${s.surgery_date || 'date not recorded'})`).join('\n') || 'No procedures performed.';
  const medications = rxRows.map(m => `${m.medicine} ${m.dose || ''} ${m.frequency || ''}`).join('\n') || 'No medications recorded.';

  const info = (await db.prepare(`INSERT INTO discharge_summaries
    (organization_id, admission_id, patient_id, diagnosis, reason_for_admission, clinical_summary, investigations, treatment_given,
     procedures, medications, condition_at_discharge, advice, follow_up, emergency_instructions, doctor_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orgId, admission.id, pid, admission.diagnosis, admission.reason, clinicalSummary, investigations,
      admission.proposed_treatment || '', procedures, medications, 'Stable', '', '',
      'In case of emergency, please contact the hospital immediately or visit the nearest emergency room.',
      doctor ? doctor.name : ''));

  const summary = (await db.prepare(`SELECT * FROM discharge_summaries WHERE id = ?`).get(info.lastInsertRowid));
  res.json({ summary });
});

// ---------- EDIT DRAFT ----------
router.put('/:id', authenticate, requireOrgContext, authorize(['doctor', ...ROLE_GROUPS.ADMIN]), async (req, res) => {
  const orgId = req.orgId;
  const summary = (await db.prepare(`SELECT * FROM discharge_summaries WHERE id = ? AND organization_id = ?`).get(req.params.id, orgId));
  if (!summary) return res.status(404).json({ error: 'Discharge summary not found' });
  if (summary.status === 'Finalized') return res.status(400).json({ error: 'Cannot edit a finalized discharge summary' });

  const fields = ['diagnosis', 'reason_for_admission', 'clinical_summary', 'investigations', 'treatment_given',
    'procedures', 'medications', 'condition_at_discharge', 'advice', 'follow_up', 'emergency_instructions', 'doctor_name'];
  const updates = [];
  const values = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  });
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id, orgId);
  (await db.prepare(`UPDATE discharge_summaries SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...values));
  res.json({ ok: true });
});

// ---------- FINALIZE + GENERATE PDF + DISCHARGE PATIENT ----------
router.post('/:id/finalize', authenticate, requireOrgContext, authorize(['doctor', ...ROLE_GROUPS.ADMIN]), async (req, res) => {
  const orgId = req.orgId;
  const summary = (await db.prepare(`SELECT * FROM discharge_summaries WHERE id = ? AND organization_id = ?`).get(req.params.id, orgId));
  if (!summary) return res.status(404).json({ error: 'Discharge summary not found' });
  if (summary.status === 'Finalized') return res.status(400).json({ error: 'Already finalized' });

  const admission = (await db.prepare(`SELECT * FROM admissions WHERE id = ? AND organization_id = ?`).get(summary.admission_id, orgId));
  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(summary.patient_id, orgId));
  const org = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(orgId));

  const filename = `discharge-${summary.patient_id}-${Date.now()}.pdf`;
  const filepath = path.join(pdfDir(orgId), filename);
  generateDischargePDF(filepath, { summary, admission, patient, org });
  const pdfUrl = `/uploads/organization-${orgId}/discharge-summaries/${filename}`;

  const tx = db.transaction(async () => {
    (await db.prepare(`UPDATE discharge_summaries SET status='Finalized', finalized_by=?, finalized_at=datetime('now'), pdf_path=? WHERE id=? AND organization_id=?`)
      .run(req.user.id, pdfUrl, summary.id, orgId));
    (await db.prepare(`UPDATE admissions SET status='Discharged', discharged_at=datetime('now') WHERE id=? AND organization_id=?`).run(admission.id, orgId));
    if (admission.bed_id) {
      (await db.prepare(`UPDATE beds SET status='Cleaning' WHERE id=? AND organization_id=?`).run(admission.bed_id, orgId));
      (await db.prepare(`UPDATE bed_allocations SET released_at=datetime('now') WHERE admission_id=? AND organization_id=? AND released_at IS NULL`).run(admission.id, orgId));
    }
  });
  (await tx());

  (await logTimeline(orgId, summary.patient_id, 'Patient discharged', `Discharge summary finalized`));
  if (admission.bed_id) (await logTimeline(orgId, summary.patient_id, 'Bed released for cleaning', ''));
  (await logAudit({ orgId, user: req.user, action: `Discharge finalized for admission ${admission.admission_number}`, patientId: summary.patient_id }));

  (await sendSMS(orgId, summary.patient_id, patient.mobile, 'Discharge',
    `Dear ${patient.full_name}, your discharge has been completed successfully. We wish you good health and a speedy recovery.`));
  (await notify(orgId, 'Discharge completed', `${patient.full_name} (${summary.patient_id}) discharged`, null));

  res.json({ ok: true, pdf: pdfUrl });
});

router.get('/:id', authenticate, requireOrgContext, async (req, res) => {
  const row = (await db.prepare(`SELECT * FROM discharge_summaries WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

function generateDischargePDF(filepath, { summary, admission, patient, org }) {
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(fs.createWriteStream(filepath));

  const hospitalName = (org && org.name) || 'Hospital';
  doc.fontSize(18).fillColor('#0B1730').text(hospitalName, { align: 'center' });
  doc.fontSize(10).fillColor('#667085').text('Powered by Aiventra Hospital Management System', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(16).fillColor('#111').text('DISCHARGE SUMMARY', { align: 'center', underline: true });
  doc.moveDown();

  const row = (label, value) => {
    doc.fontSize(10).fillColor('#555').text(label, { continued: true, width: 150 });
    doc.fillColor('#111').text(value || '-');
  };

  doc.fontSize(12).fillColor('#155EEF').text('Patient Information');
  doc.moveDown(0.3);
  row('Patient ID:', summary.patient_id);
  row('Name:', patient.full_name);
  row('Age / Gender:', `${patient.age || '-'} / ${patient.gender || '-'}`);
  row('Mobile:', patient.mobile);
  row('Admission Number:', admission.admission_number);
  row('Admission Date:', admission.admitted_at);
  row('Discharge Date:', new Date().toISOString());
  row('Attending Doctor:', summary.doctor_name);
  doc.moveDown();

  const section = (title, content) => {
    doc.fontSize(12).fillColor('#155EEF').text(title);
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#111').text(content || '-', { align: 'left' });
    doc.moveDown(0.6);
  };

  section('Diagnosis', summary.diagnosis);
  section('Reason for Admission', summary.reason_for_admission);
  section('Clinical Summary', summary.clinical_summary);
  section('Investigations', summary.investigations);
  section('Treatment Given', summary.treatment_given);
  section('Procedures / Surgery', summary.procedures);
  section('Medications', summary.medications);
  section('Condition at Discharge', summary.condition_at_discharge);
  section('Advice', summary.advice);
  section('Follow-up', summary.follow_up);
  section('Emergency Contact Instructions', summary.emergency_instructions);

  doc.moveDown(2);
  doc.fontSize(10).text('_______________________', 350);
  doc.text('Doctor Signature', 350);
  doc.text(summary.doctor_name || '', 350);

  doc.end();
}

module.exports = router;
