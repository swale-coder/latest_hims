const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const { logTimeline, logAudit, notify } = require('../utils/helpers');

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
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only PDF, JPG, PNG files are allowed'));
  }
});

router.post('/orders', authenticate, requireOrgContext, authorize(['doctor', ...ROLE_GROUPS.ADMIN]), async (req, res) => {
  const orgId = req.orgId;
  const { patient_id, admission_id, test_name } = req.body;
  if (!patient_id || !test_name) return res.status(400).json({ error: 'patient_id and test_name required' });
  const patient = (await db.prepare(`SELECT * FROM patients WHERE patient_id = ? AND organization_id = ?`).get(patient_id, orgId));
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const info = (await db.prepare(`INSERT INTO lab_orders (organization_id, patient_id, admission_id, test_name, ordered_by) VALUES (?,?,?,?,?)`)
    .run(orgId, patient_id, admission_id || null, test_name, req.user.id));
  (await logTimeline(orgId, patient_id, 'Lab test ordered', test_name));
  (await logAudit({ orgId, user: req.user, action: `Ordered lab test: ${test_name}`, patientId: patient_id }));
  (await notify(orgId, 'New lab order', `${test_name} ordered for ${patient_id}`, 'lab_staff'));
  res.json({ id: info.lastInsertRowid });
});

router.get('/pending', authenticate, requireOrgContext, authorize(ROLE_GROUPS.LAB), async (req, res) => {
  const rows = (await db.prepare(`
    SELECT l.*, p.full_name, p.age, p.gender
    FROM lab_orders l JOIN patients p ON p.patient_id = l.patient_id AND p.organization_id = l.organization_id
    WHERE l.organization_id = ? AND l.status != 'Report Generated'
    ORDER BY l.ordered_at ASC`).all(req.orgId));
  res.json(rows);
});

router.get('/all', authenticate, requireOrgContext, async (req, res) => {
  const rows = (await db.prepare(`
    SELECT l.*, p.full_name FROM lab_orders l JOIN patients p ON p.patient_id = l.patient_id AND p.organization_id = l.organization_id
    WHERE l.organization_id = ?
    ORDER BY l.ordered_at DESC LIMIT 200`).all(req.orgId));
  res.json(rows);
});

router.get('/:patientId', authenticate, requireOrgContext, async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM lab_orders WHERE patient_id = ? AND organization_id = ? ORDER BY ordered_at DESC`).all(req.params.patientId, req.orgId)));
});

router.put('/orders/:id/collect', authenticate, requireOrgContext, authorize(ROLE_GROUPS.LAB), async (req, res) => {
  const order = (await db.prepare(`SELECT * FROM lab_orders WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!order) return res.status(404).json({ error: 'Lab order not found' });
  (await db.prepare(`UPDATE lab_orders SET status = 'Sample Collected', sample_collected_at = datetime('now') WHERE id = ? AND organization_id = ?`).run(req.params.id, req.orgId));
  (await logTimeline(req.orgId, order.patient_id, 'Blood/lab sample collected', order.test_name));
  res.json({ ok: true });
});

router.put('/orders/:id/processing', authenticate, requireOrgContext, authorize(ROLE_GROUPS.LAB), async (req, res) => {
  const order = (await db.prepare(`SELECT * FROM lab_orders WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!order) return res.status(404).json({ error: 'Lab order not found' });
  (await db.prepare(`UPDATE lab_orders SET status = 'Processing' WHERE id = ? AND organization_id = ?`).run(req.params.id, req.orgId));
  res.json({ ok: true });
});

router.put('/orders/:id/result', authenticate, requireOrgContext, authorize(ROLE_GROUPS.LAB), upload.single('report'), async (req, res) => {
  const order = (await db.prepare(`SELECT * FROM lab_orders WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!order) return res.status(404).json({ error: 'Lab order not found' });
  const { result } = req.body;
  const filePath = req.file ? `/uploads/organization-${req.orgId}/${req.file.filename}` : null;
  (await db.prepare(`UPDATE lab_orders SET status = 'Report Generated', result = ?, report_file = COALESCE(?, report_file),
    finalized_by = ?, finalized_at = datetime('now') WHERE id = ? AND organization_id = ?`)
    .run(result || null, filePath, req.user.id, req.params.id, req.orgId));
  (await logTimeline(req.orgId, order.patient_id, 'Lab report uploaded', order.test_name));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Finalized lab report: ${order.test_name}`, patientId: order.patient_id }));
  (await notify(req.orgId, 'Lab report completed', `${order.test_name} report ready for ${order.patient_id}`, 'doctor'));
  res.json({ ok: true });
});

module.exports = router;
