const express = require('express');
const db = require('../db');
const { authenticate, requireOrgContext } = require('../middleware/auth');

const router = express.Router();

// GET /api/dashboard — main dashboard payload consumed by public/js/pages-dashboard.js.
// Shape is fixed by the existing frontend; do not rename these fields without updating
// pages-dashboard.js too.
router.get('/', authenticate, requireOrgContext, async (req, res) => {
  try {
    const orgId = req.orgId;
    const today = new Date().toISOString().slice(0, 10);

    // ---- Beds ----
    const bedRows = (await db.prepare(
      `SELECT status, COUNT(*) c FROM beds WHERE organization_id = ? GROUP BY status`
    ).all(orgId));
    const beds = { total: 0, Available: 0, Occupied: 0, Cleaning: 0, Maintenance: 0, Reserved: 0 };
    for (const row of bedRows) {
      const count = Number(row.c);
      beds.total += count;
      if (beds[row.status] !== undefined) beds[row.status] = count;
    }
    beds.occupancyRate = beds.total ? Math.round((beds.Occupied / beds.total) * 100) : 0;

    // ---- OPD today ----
    const todayOPD = Number((await db.prepare(
      `SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date = ?`
    ).get(orgId, today)).c);

    const opdStatusRows = (await db.prepare(
      `SELECT status, COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date = ? GROUP BY status`
    ).all(orgId, today));
    const opdStatus = { waiting: 0, inConsultation: 0, completed: 0 };
    for (const row of opdStatusRows) {
      const count = Number(row.c);
      if (row.status === 'Waiting') opdStatus.waiting = count;
      else if (row.status === 'In Consultation') opdStatus.inConsultation = count;
      else if (row.status === 'Completed') opdStatus.completed = count;
    }

    // ---- Admissions / discharges today ----
    const todayAdmissions = Number((await db.prepare(
      `SELECT COUNT(*) c FROM admissions WHERE organization_id = ? AND date(admitted_at) = ?`
    ).get(orgId, today)).c);

    const todayDischarges = Number((await db.prepare(
      `SELECT COUNT(*) c FROM admissions WHERE organization_id = ? AND status = 'Discharged' AND date(discharged_at) = ?`
    ).get(orgId, today)).c);

    // ---- Current admissions (active) ----
    const currentAdmissions = (await db.prepare(`
      SELECT a.*, p.full_name, d.name as doctor_name, b.bed_number
      FROM admissions a
      JOIN patients p ON p.patient_id = a.patient_id AND p.organization_id = a.organization_id
      LEFT JOIN doctors d ON d.id = a.attending_doctor_id
      LEFT JOIN beds b ON b.id = a.bed_id
      WHERE a.organization_id = ? AND a.status = 'Active'
      ORDER BY a.admitted_at DESC
    `).all(orgId));

    // ---- Pending lab orders ----
    const pendingLab = (await db.prepare(`
      SELECT l.*, p.full_name
      FROM lab_orders l
      JOIN patients p ON p.patient_id = l.patient_id AND p.organization_id = l.organization_id
      WHERE l.organization_id = ? AND l.status != 'Report Generated'
      ORDER BY l.ordered_at DESC
    `).all(orgId));

    // ---- Today's surgeries ----
    const todaySurgeries = (await db.prepare(`
      SELECT s.*, p.full_name
      FROM surgeries s
      JOIN patients p ON p.patient_id = s.patient_id AND p.organization_id = s.organization_id
      WHERE s.organization_id = ? AND s.surgery_date = ?
      ORDER BY s.surgery_time ASC
    `).all(orgId, today));

    // ---- Recent activity ----
    const recentActivity = (await db.prepare(
      `SELECT * FROM patient_timeline WHERE organization_id = ? ORDER BY event_date DESC LIMIT 20`
    ).all(orgId));

    res.json({
      beds,
      todayOPD,
      todayAdmissions,
      todayDischarges,
      opdStatus,
      currentAdmissions,
      pendingLab,
      todaySurgeries,
      recentActivity
    });
  } catch (err) {
    console.error('GET /api/dashboard failed:', err);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

router.get('/summary', authenticate, requireOrgContext, async (req, res) => {
  const orgId = req.orgId;
  const today = new Date().toISOString().slice(0, 10);

  const totalPatients = (await db.prepare(`SELECT COUNT(*) c FROM patients WHERE organization_id = ?`).get(orgId)).c;
  const todayOpd = (await db.prepare(`SELECT COUNT(*) c FROM opd_visits WHERE organization_id = ? AND visit_date = ?`).get(orgId, today)).c;
  const activeAdmissions = (await db.prepare(`SELECT COUNT(*) c FROM admissions WHERE organization_id = ? AND status = 'Active'`).get(orgId)).c;
  const bedTotal = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ?`).get(orgId)).c;
  const bedOccupied = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ? AND status = 'Occupied'`).get(orgId)).c;
  const pendingLab = (await db.prepare(`SELECT COUNT(*) c FROM lab_orders WHERE organization_id = ? AND status != 'Report Generated'`).get(orgId)).c;
  const todayRevenue = (await db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM billing_transactions
    WHERE organization_id = ? AND type IN ('DEPOSIT','PAYMENT') AND date(created_at) = ?`).get(orgId, today)).s;
  const dischargesToday = (await db.prepare(`SELECT COUNT(*) c FROM admissions WHERE organization_id = ? AND status='Discharged' AND date(discharged_at) = ?`).get(orgId, today)).c;

  res.json({
    totalPatients, todayOpd, activeAdmissions,
    bedTotal, bedOccupied, bedOccupancyRate: bedTotal ? Math.round((bedOccupied / bedTotal) * 100) : 0,
    pendingLab, todayRevenue, dischargesToday
  });
});

router.get('/recent-activity', authenticate, requireOrgContext, async (req, res) => {
  const rows = (await db.prepare(`SELECT * FROM audit_log WHERE organization_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.orgId));
  res.json(rows);
});

router.get('/notifications', authenticate, requireOrgContext, async (req, res) => {
  const rows = (await db.prepare(`
    SELECT * FROM notifications
    WHERE organization_id = ? AND (target_role IS NULL OR target_role = ?)
    ORDER BY created_at DESC LIMIT 20`).all(req.orgId, req.user.role));
  res.json(rows);
});

module.exports = router;
