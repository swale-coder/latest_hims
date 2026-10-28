const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');

const router = express.Router();
const REPORT_VIEWERS = ROLE_GROUPS.ADMIN.concat(['report_viewer', 'doctor', 'accountant']);

router.get('/daily-opd', authenticate, requireOrgContext, authorize(REPORT_VIEWERS), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = (await db.prepare(`
    SELECT o.opd_number, p.patient_id, p.full_name, dep.name as department, d.name as doctor, o.status, o.created_at
    FROM opd_visits o JOIN patients p ON p.patient_id=o.patient_id AND p.organization_id = o.organization_id
    LEFT JOIN departments dep ON dep.id=o.department_id
    LEFT JOIN doctors d ON d.id=o.doctor_id
    WHERE o.organization_id = ? AND o.visit_date = ? ORDER BY o.created_at`).all(req.orgId, date));
  res.json(rows);
});

router.get('/daily-admissions', authenticate, requireOrgContext, authorize(REPORT_VIEWERS), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = (await db.prepare(`
    SELECT a.admission_number, p.patient_id, p.full_name, d.name as doctor, b.bed_number, a.admission_type, a.admitted_at
    FROM admissions a JOIN patients p ON p.patient_id=a.patient_id AND p.organization_id = a.organization_id
    LEFT JOIN doctors d ON d.id=a.attending_doctor_id
    LEFT JOIN beds b ON b.id=a.bed_id
    WHERE a.organization_id = ? AND date(a.admitted_at) = ? ORDER BY a.admitted_at`).all(req.orgId, date));
  res.json(rows);
});

router.get('/daily-discharges', authenticate, requireOrgContext, authorize(REPORT_VIEWERS), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = (await db.prepare(`
    SELECT a.admission_number, p.patient_id, p.full_name, a.discharged_at
    FROM admissions a JOIN patients p ON p.patient_id=a.patient_id AND p.organization_id = a.organization_id
    WHERE a.organization_id = ? AND date(a.discharged_at) = ? ORDER BY a.discharged_at`).all(req.orgId, date));
  res.json(rows);
});

router.get('/bed-occupancy', authenticate, requireOrgContext, authorize(REPORT_VIEWERS), async (req, res) => {
  const rows = (await db.prepare(`
    SELECT f.name as floor, r.name as room, r.room_type,
      COUNT(b.id) as total, SUM(CASE WHEN b.status='Occupied' THEN 1 ELSE 0 END) as occupied,
      SUM(CASE WHEN b.status='Available' THEN 1 ELSE 0 END) as available
    FROM beds b
    JOIN rooms r ON r.id=b.room_id AND r.organization_id = b.organization_id
    JOIN floors f ON f.id=r.floor_id AND f.organization_id = b.organization_id
    WHERE b.organization_id = ?
    GROUP BY r.id ORDER BY f.floor_number, r.name`).all(req.orgId));
  res.json(rows);
});

router.get('/clinical-pending-lab', authenticate, requireOrgContext, authorize(REPORT_VIEWERS), async (req, res) => {
  res.json((await db.prepare(`
    SELECT l.*, p.full_name FROM lab_orders l JOIN patients p ON p.patient_id=l.patient_id AND p.organization_id = l.organization_id
    WHERE l.organization_id = ? AND l.status != 'Report Generated' ORDER BY l.ordered_at`).all(req.orgId)));
});

router.get('/clinical-completed-lab', authenticate, requireOrgContext, authorize(REPORT_VIEWERS), async (req, res) => {
  res.json((await db.prepare(`
    SELECT l.*, p.full_name FROM lab_orders l JOIN patients p ON p.patient_id=l.patient_id AND p.organization_id = l.organization_id
    WHERE l.organization_id = ? AND l.status = 'Report Generated' ORDER BY l.finalized_at DESC LIMIT 100`).all(req.orgId)));
});

router.get('/management-summary', authenticate, requireOrgContext, authorize(REPORT_VIEWERS), async (req, res) => {
  const orgId = req.orgId;
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const admissions = (await db.prepare(`SELECT COUNT(*) c FROM admissions WHERE organization_id = ? AND date(admitted_at) BETWEEN ? AND ?`).get(orgId, from, to)).c;
  const discharges = (await db.prepare(`SELECT COUNT(*) c FROM admissions WHERE organization_id = ? AND date(discharged_at) BETWEEN ? AND ?`).get(orgId, from, to)).c;
  const opd = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date BETWEEN ? AND ?`).get(orgId, from, to)).c;
  const surgeries = (await db.prepare(`SELECT COUNT(*) c FROM surgeries WHERE organization_id = ? AND surgery_date BETWEEN ? AND ?`).get(orgId, from, to)).c;
  const totalBeds = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ?`).get(orgId)).c;
  const occupied = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ? AND status='Occupied'`).get(orgId)).c;
  res.json({
    from, to, admissions, discharges, opd, surgeries, totalBeds, occupied,
    occupancyRate: totalBeds ? Math.round((occupied / totalBeds) * 100) : 0
  });
});

module.exports = router;
