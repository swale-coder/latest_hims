const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authenticate, authorize, requireOrgContext } = require('../middleware/auth');
const { logTimeline, logAudit } = require('../utils/helpers');

const router = express.Router();

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
  limits: { fileSize: 15 * 1024 * 1024 }
});

router.post('/', authenticate, requireOrgContext, authorize(['doctor', 'hospital_admin', 'organization_owner']), upload.single('document'), async (req, res) => {
  const orgId = req.orgId;
  const {
    patient_id, admission_id, procedure_name, surgery_date, surgery_time,
    surgeon, assistant, anaesthetist, diagnosis, procedure_notes, post_op_notes
  } = req.body;
  if (!patient_id || !procedure_name) return res.status(400).json({ error: 'patient_id and procedure_name required' });
  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(patient_id, orgId));
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const filePath = req.file ? `/uploads/organization-${orgId}/${req.file.filename}` : null;
  const info = (await db.prepare(`INSERT INTO surgeries
    (organization_id, patient_id, admission_id, procedure_name, surgery_date, surgery_time, surgeon, assistant, anaesthetist,
     diagnosis, procedure_notes, post_op_notes, document_file, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orgId, patient_id, admission_id || null, procedure_name, surgery_date || null, surgery_time || null,
      surgeon || null, assistant || null, anaesthetist || null, diagnosis || null, procedure_notes || null,
      post_op_notes || null, filePath, req.user.id));

  (await logTimeline(orgId, patient_id, 'Surgery performed', procedure_name));
  (await logAudit({ orgId, user: req.user, action: `Recorded surgery: ${procedure_name}`, patientId: patient_id }));
  res.json({ id: info.lastInsertRowid });
});

router.get('/:patientId', authenticate, requireOrgContext, async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM surgeries WHERE patient_id = ? AND organization_id = ? ORDER BY created_at DESC`).all(req.params.patientId, req.orgId)));
});

router.get('/detail/:id', authenticate, requireOrgContext, async (req, res) => {
  const surgery = (await db.prepare(`SELECT * FROM surgeries WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!surgery) return res.status(404).json({ error: 'Not found' });
  const items = (await db.prepare(`SELECT * FROM surgical_items WHERE surgery_id = ? AND organization_id = ?`).all(req.params.id, req.orgId));
  res.json({ ...surgery, items });
});

router.post('/:surgeryId/items', authenticate, requireOrgContext, authorize(['doctor', 'nurse', 'hospital_admin', 'organization_owner']), async (req, res) => {
  const orgId = req.orgId;
  const { item_name, item_category, quantity, batch_number, usage_date } = req.body;
  const surgery = (await db.prepare(`SELECT * FROM surgeries WHERE id = ? AND organization_id = ?`).get(req.params.surgeryId, orgId));
  if (!surgery) return res.status(404).json({ error: 'Surgery not found' });
  if (!item_name) return res.status(400).json({ error: 'item_name required' });

  const info = (await db.prepare(`INSERT INTO surgical_items
    (organization_id, surgery_id, patient_id, item_name, item_category, quantity, batch_number, usage_date, recorded_by)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(orgId, req.params.surgeryId, surgery.patient_id, item_name, item_category || null, quantity || 1,
      batch_number || null, usage_date || surgery.surgery_date, req.user.id));
  res.json({ id: info.lastInsertRowid });
});

module.exports = router;
