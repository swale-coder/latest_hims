const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');

const router = express.Router();

router.get('/overview', authenticate, requireOrgContext, async (req, res) => {
  const orgId = req.orgId;
  const total = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE organization_id = ?`).get(orgId)).c;
  const byStatus = (await db.prepare(`SELECT status, COUNT(*) c FROM beds WHERE organization_id = ? GROUP BY status`).all(orgId));
  const counts = { Available: 0, Occupied: 0, Reserved: 0, Cleaning: 0, Maintenance: 0 };
  byStatus.forEach(r => counts[r.status] = r.c);
  res.json({ total, ...counts, occupancyRate: total ? Math.round((counts.Occupied / total) * 100) : 0 });
});

router.get('/floor-view', authenticate, requireOrgContext, async (req, res) => {
  const orgId = req.orgId;
  const floors = (await db.prepare(`SELECT * FROM floors WHERE organization_id = ? ORDER BY floor_number`).all(orgId));
  const result = await Promise.all(floors.map(async f => {
    const rooms = (await db.prepare(`SELECT * FROM rooms WHERE floor_id = ? AND organization_id = ? ORDER BY name`).all(f.id, orgId));
    const roomsWithBeds = await Promise.all(rooms.map(async r => {
      const beds = (await db.prepare(`
        SELECT b.*, p.full_name as patient_name, p.patient_id, a.id as admission_id
        FROM beds b
        LEFT JOIN admissions a ON a.bed_id = b.id AND a.status = 'Active' AND a.organization_id = b.organization_id
        LEFT JOIN patients p ON p.patient_id = a.patient_id AND p.organization_id = b.organization_id
        WHERE b.room_id = ? AND b.organization_id = ? ORDER BY b.bed_number`).all(r.id, orgId));
      return { ...r, beds };
    }));
    return { ...f, rooms: roomsWithBeds };
  }));
  res.json(result);
});

router.get('/available', authenticate, requireOrgContext, async (req, res) => {
  const rows = (await db.prepare(`
    SELECT b.*, r.name as room_name, r.room_type, f.name as floor_name, f.id as floor_id
    FROM beds b
    JOIN rooms r ON r.id = b.room_id
    JOIN floors f ON f.id = r.floor_id
    WHERE b.organization_id = ? AND b.status = 'Available'
    ORDER BY f.floor_number, r.name, b.bed_number`).all(req.orgId));
  res.json(rows);
});

router.put('/:id/clean-complete', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN.concat(['nurse'])), async (req, res) => {
  const bed = (await db.prepare(`SELECT * FROM beds WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  if (bed.status !== 'Cleaning') return res.status(400).json({ error: 'Bed is not currently in Cleaning status' });
  (await db.prepare(`UPDATE beds SET status = 'Available' WHERE id = ? AND organization_id = ?`).run(bed.id, req.orgId));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Bed ${bed.bed_number} marked Available after cleaning` }));
  res.json({ ok: true });
});

module.exports = router;
