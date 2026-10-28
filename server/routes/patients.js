const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const { nextPatientId, logTimeline, logAudit, maskAadhaar } = require('../utils/helpers');

const router = express.Router();

// ---- Organization-scoped upload storage: uploads/organization-<id>/... ----
// Every file is written under its owning organization's own folder, and every
// download/read must independently verify organization ownership (see below and
// the static file guard mounted in server/index.js).
const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads');
function orgUploadDir(orgId) {
  const dir = path.join(UPLOAD_ROOT, `organization-${orgId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, orgUploadDir(req.orgId)),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only PDF, JPG, PNG files are allowed'));
  }
});

function calcAge(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d)) return null;
  const diff = Date.now() - d.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

// ---------- FIND OR CREATE PATIENT (core identity logic, scoped to one organization) ----------
async function findExistingPatient(orgId, { mobile, aadhaar_number }) {
  if (mobile) {
    const byMobile = await db.prepare(`SELECT * FROM patients WHERE organization_id = ? AND mobile = ?`).get(orgId, mobile.trim());
    if (byMobile) return byMobile;
  }
  if (aadhaar_number) {
    const byAadhaar = await db.prepare(`SELECT * FROM patients WHERE organization_id = ? AND aadhaar_number = ?`).get(orgId, aadhaar_number.trim());
    if (byAadhaar) return byAadhaar;
  }
  return null;
}

router.post('/find-or-create', authenticate, requireOrgContext, async (req, res) => {
  await handleFindOrCreate(req, res, req.orgId, req.user);
});

// Public endpoint for QR self-registration (no staff auth, but org is identified by slug)
router.post('/public/find-or-create', async (req, res) => {
  const org = await resolvePublicOrg(req, res);
  if (!org) return;
  await handleFindOrCreate(req, res, org.id, null);
});

async function resolvePublicOrg(req, res) {
  const slug = (req.query.org || req.body.org || '').trim();
  if (!slug) { res.status(400).json({ error: 'Missing hospital identifier (org).' }); return null; }
  const org = await db.prepare(`SELECT * FROM organizations WHERE slug = ?`).get(slug);
  if (!org || !['trial', 'active', 'payment_due', 'grace_period'].includes(org.status)) {
    res.status(404).json({ error: 'Hospital not found or not currently accepting registrations.' });
    return null;
  }
  return org;
}

async function handleFindOrCreate(req, res, orgId, user) {
  const { full_name, mobile, address, gender, dob, age, aadhaar_number, emergency_contact_name, emergency_contact_phone } = req.body;
  if (!full_name || !mobile) return res.status(400).json({ error: 'Full name and mobile number are required' });
  if (!/^[0-9]{10}$/.test(mobile.replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number' });
  }

  const existing = await findExistingPatient(orgId, { mobile, aadhaar_number });
  if (existing) {
    return res.json({ patient: existing, isNew: false, message: 'Patient record found.' });
  }

  const patientId = (await nextPatientId());
  const computedAge = age || calcAge(dob);
  const info = await db.prepare(`INSERT INTO patients
    (organization_id, patient_id, full_name, mobile, address, gender, dob, age, aadhaar_number, emergency_contact_name, emergency_contact_phone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orgId, patientId, full_name.trim(), mobile.trim(), address || null, gender || null, dob || null,
      computedAge || null, aadhaar_number || null, emergency_contact_name || null, emergency_contact_phone || null);

  (await logTimeline(orgId, patientId, 'Patient registered', `Registered via ${user ? 'hospital staff' : 'QR self-registration'}`));
  (await logAudit({ orgId, user, action: `Registered new patient ${patientId}`, patientId }));

  const patient = await db.prepare(`SELECT * FROM patients WHERE id = ?`).get(info.lastInsertRowid);
  res.json({ patient, isNew: true, message: 'New patient registered.' });
}

// ---------- SEARCH ----------
router.get('/search', authenticate, requireOrgContext, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const like = `%${q}%`;
  const rows = await db.prepare(`
    SELECT * FROM patients
    WHERE organization_id = ? AND (patient_id LIKE ? OR full_name LIKE ? OR mobile LIKE ? OR dob LIKE ?)
    ORDER BY id DESC LIMIT 25`).all(req.orgId, like, like, like, like);
  res.json(rows);
});

// ---------- GET SINGLE PATIENT (full 360 profile) — every join below is additionally
// pinned to organization_id so a guessed/incremented patient_id from another hospital
// returns 404, never another hospital's data. ----------
router.get('/:patientId', authenticate, requireOrgContext, async (req, res) => {
  const pid = req.params.patientId;
  const orgId = req.orgId;
  const patient = await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(pid, orgId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const isSensitiveAllowed = ROLE_GROUPS.ADMIN.concat(['doctor', 'nurse']).includes(req.user.role);

  const opdVisits = await db.prepare(`
    SELECT o.*, d.name as doctor_name, dep.name as department_name FROM opd_visits o
    LEFT JOIN doctors d ON d.id = o.doctor_id
    LEFT JOIN departments dep ON dep.id = o.department_id
    WHERE o.patient_id = ? AND o.organization_id = ? ORDER BY o.created_at DESC`).all(pid, orgId);

  const consultations = await db.prepare(`
    SELECT c.*, d.name as doctor_name FROM consultations c
    LEFT JOIN doctors d ON d.id = c.doctor_id
    WHERE c.patient_id = ? AND c.organization_id = ? ORDER BY c.created_at DESC`).all(pid, orgId);

  const admissions = await db.prepare(`
    SELECT a.*, ad.name as attending_doctor_name, b.bed_number, r.name as room_name, f.name as floor_name
    FROM admissions a
    LEFT JOIN doctors ad ON ad.id = a.attending_doctor_id
    LEFT JOIN beds b ON b.id = a.bed_id
    LEFT JOIN rooms r ON r.id = b.room_id
    LEFT JOIN floors f ON f.id = r.floor_id
    WHERE a.patient_id = ? AND a.organization_id = ? ORDER BY a.admitted_at DESC`).all(pid, orgId);

  const clinicalNotes = await db.prepare(`SELECT * FROM clinical_notes WHERE patient_id = ? AND organization_id = ? ORDER BY created_at DESC`).all(pid, orgId);
  const vitals = await db.prepare(`SELECT * FROM vitals WHERE patient_id = ? AND organization_id = ? ORDER BY recorded_at DESC`).all(pid, orgId);
  const prescriptions = await db.prepare(`SELECT * FROM prescriptions WHERE patient_id = ? AND organization_id = ? ORDER BY created_at DESC`).all(pid, orgId);
  const labOrders = await db.prepare(`SELECT * FROM lab_orders WHERE patient_id = ? AND organization_id = ? ORDER BY ordered_at DESC`).all(pid, orgId);
  const surgeries = await db.prepare(`SELECT * FROM surgeries WHERE patient_id = ? AND organization_id = ? ORDER BY created_at DESC`).all(pid, orgId);
  const discharges = await db.prepare(`SELECT * FROM discharge_summaries WHERE patient_id = ? AND organization_id = ? ORDER BY created_at DESC`).all(pid, orgId);
  const timeline = await db.prepare(`SELECT * FROM patient_timeline WHERE patient_id = ? AND organization_id = ? ORDER BY event_date DESC`).all(pid, orgId);
  let documents = await db.prepare(`SELECT * FROM patient_documents WHERE patient_id = ? AND organization_id = ? ORDER BY uploaded_at DESC`).all(pid, orgId);

  documents = documents.map(d => ({ ...d, doc_number: isSensitiveAllowed ? d.doc_number : maskAadhaar(d.doc_number) }));

  const activeAdmission = admissions.find(a => a.status === 'Active');

  res.json({
    patient: { ...patient, aadhaar_number: isSensitiveAllowed ? patient.aadhaar_number : maskAadhaar(patient.aadhaar_number) },
    currentStatus: activeAdmission ? 'Admitted' : 'Not Admitted',
    activeAdmission: activeAdmission || null,
    opdVisits, consultations, admissions, clinicalNotes, vitals,
    prescriptions, labOrders, surgeries, discharges, timeline, documents
  });
});

// ---------- DOCUMENTS ----------
router.post('/:patientId/documents', authenticate, requireOrgContext, authorize(ROLE_GROUPS.FRONT_DESK.concat(['doctor', 'nurse'])), upload.single('file'), async (req, res) => {
  const pid = req.params.patientId;
  const patient = await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(pid, req.orgId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const { doc_type, doc_number } = req.body;
  if (!doc_type) return res.status(400).json({ error: 'Document type required' });

  const filePath = req.file ? `/uploads/organization-${req.orgId}/${req.file.filename}` : null;
  const info = await db.prepare(`INSERT INTO patient_documents (organization_id, patient_id, doc_type, doc_number, file_path, uploaded_by)
    VALUES (?,?,?,?,?,?)`).run(req.orgId, pid, doc_type, doc_number || null, filePath, req.user.id);

  (await logAudit({ orgId: req.orgId, user: req.user, action: `Uploaded ${doc_type} document`, patientId: pid }));
  (await logTimeline(req.orgId, pid, 'Document uploaded', doc_type));
  res.json({ id: info.lastInsertRowid });
});

router.put('/documents/:id/verify', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { status } = req.body;
  const doc = await db.prepare(`SELECT * FROM patient_documents WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  await db.prepare(`UPDATE patient_documents SET verification_status = ? WHERE id = ? AND organization_id = ?`).run(status, req.params.id, req.orgId);
  res.json({ ok: true });
});

module.exports = router;
module.exports.resolvePublicOrg = resolvePublicOrg;
