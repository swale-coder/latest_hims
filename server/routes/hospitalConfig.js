const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');

const router = express.Router();

// ---------- PUBLIC TENANT RESOLUTION (dynamic /hms/:slug login) ----------
// Deliberately UNAUTHENTICATED - this is what powers the login page itself, before anyone
// has a session. It only ever returns branding-safe fields (name, org type, logo, and
// whether the org is currently accessible) - never anything else from the organizations row,
// and never any hospital data. The actual login attempt is still validated server-side
// against the authenticated user's own organization_id in server/routes/auth.js - this
// endpoint only decides what the login page LOOKS like, never who gets in.
router.get('/tenant/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Hospital slug is required' });

  const org = (await db.prepare(`SELECT id, name, slug, org_type, status, logo_path FROM organizations WHERE slug = ?`).get(slug));
  if (!org) return res.status(404).json({ error: 'Hospital not found' });

  // logo_path is currently set by Aiventra platform admins as a direct https:// URL (see
  // POST /api/platform/organizations) rather than an uploaded file, so it can be safely
  // returned to an unauthenticated caller as-is. Anything that isn't a well-formed http(s)
  // URL is ignored here so the login page falls back to default Aiventra branding instead of
  // trying to load a bad src.
  const logoUrl = (org.logo_path && /^https?:\/\//i.test(org.logo_path)) ? org.logo_path : null;

  res.json({
    name: org.name,
    slug: org.slug,
    orgType: org.org_type,
    logoUrl,
    // 'suspended' / 'cancelled' / 'expired' organizations still resolve (so the login page
    // can show the real hospital name rather than a confusing "not found"), but the actual
    // login attempt is still blocked with a clear message by /api/auth/login.
    active: !['suspended', 'cancelled', 'expired'].includes(org.status)
  });
});

// ---------- FLOORS ----------
router.get('/floors', authenticate, requireOrgContext, async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM floors WHERE organization_id = ? ORDER BY floor_number`).all(req.orgId)));
});

router.post('/floors', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { name, floor_number } = req.body;
  if (!name || floor_number === undefined) return res.status(400).json({ error: 'name and floor_number required' });
  const info = (await db.prepare(`INSERT INTO floors (organization_id, name, floor_number) VALUES (?, ?, ?)`).run(req.orgId, name, floor_number));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Added floor ${name}` }));
  res.json({ id: info.lastInsertRowid });
});

router.delete('/floors/:id', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const floor = (await db.prepare(`SELECT * FROM floors WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!floor) return res.status(404).json({ error: 'Floor not found' });
  const rooms = (await db.prepare(`SELECT COUNT(*) c FROM rooms WHERE floor_id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (rooms.c > 0) return res.status(400).json({ error: 'Cannot delete floor with rooms. Remove rooms first.' });
  (await db.prepare(`DELETE FROM floors WHERE id = ? AND organization_id = ?`).run(req.params.id, req.orgId));
  res.json({ ok: true });
});

// ---------- ROOMS ----------
router.get('/rooms', authenticate, requireOrgContext, async (req, res) => {
  const rows = (await db.prepare(`
    SELECT r.*, f.name as floor_name, f.floor_number
    FROM rooms r JOIN floors f ON f.id = r.floor_id AND f.organization_id = r.organization_id
    WHERE r.organization_id = ?
    ORDER BY f.floor_number, r.name`).all(req.orgId));
  res.json(rows);
});

router.post('/rooms', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { floor_id, name, room_type } = req.body;
  if (!floor_id || !name || !room_type) return res.status(400).json({ error: 'floor_id, name, room_type required' });
  const validTypes = ['Ward', 'Common Room', 'Deluxe Room'];
  if (!validTypes.includes(room_type)) return res.status(400).json({ error: 'Invalid room type' });
  const floor = (await db.prepare(`SELECT * FROM floors WHERE id = ? AND organization_id = ?`).get(floor_id, req.orgId));
  if (!floor) return res.status(404).json({ error: 'Floor not found' });
  const info = (await db.prepare(`INSERT INTO rooms (organization_id, floor_id, name, room_type) VALUES (?,?,?,?)`).run(req.orgId, floor_id, name, room_type));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Added room ${name} (${room_type})` }));
  res.json({ id: info.lastInsertRowid });
});

router.delete('/rooms/:id', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const room = (await db.prepare(`SELECT * FROM rooms WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const beds = (await db.prepare(`SELECT COUNT(*) c FROM beds WHERE room_id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (beds.c > 0) return res.status(400).json({ error: 'Cannot delete room with beds. Remove beds first.' });
  (await db.prepare(`DELETE FROM rooms WHERE id = ? AND organization_id = ?`).run(req.params.id, req.orgId));
  res.json({ ok: true });
});

// ---------- BEDS ----------
router.get('/beds', authenticate, requireOrgContext, async (req, res) => {
  const rows = (await db.prepare(`
    SELECT b.*, r.name as room_name, r.room_type, f.name as floor_name, f.floor_number, f.id as floor_id
    FROM beds b
    JOIN rooms r ON r.id = b.room_id AND r.organization_id = b.organization_id
    JOIN floors f ON f.id = r.floor_id AND f.organization_id = b.organization_id
    WHERE b.organization_id = ?
    ORDER BY f.floor_number, r.name, b.bed_number`).all(req.orgId));
  res.json(rows);
});

router.post('/beds', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { room_id, bed_number } = req.body;
  if (!room_id || !bed_number) return res.status(400).json({ error: 'room_id and bed_number required' });
  const room = (await db.prepare(`SELECT * FROM rooms WHERE id = ? AND organization_id = ?`).get(room_id, req.orgId));
  if (!room) return res.status(404).json({ error: 'Room not found' });
  try {
    const info = (await db.prepare(`INSERT INTO beds (organization_id, room_id, bed_number) VALUES (?,?,?)`).run(req.orgId, room_id, bed_number));
    (await logAudit({ orgId: req.orgId, user: req.user, action: `Added bed ${bed_number}` }));
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Bed number already exists on this platform. Try a different number, e.g. include a hospital-specific prefix.' });
    res.status(500).json({ error: 'Could not add bed' });
  }
});

router.put('/beds/:id/status', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN.concat(['nurse'])), async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['Available', 'Occupied', 'Reserved', 'Cleaning', 'Maintenance'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const bed = (await db.prepare(`SELECT * FROM beds WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  if (bed.status === 'Occupied' && status === 'Available') {
    return res.status(400).json({ error: 'Occupied beds must go through Cleaning before becoming Available' });
  }
  (await db.prepare(`UPDATE beds SET status = ? WHERE id = ? AND organization_id = ?`).run(status, req.params.id, req.orgId));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Bed ${bed.bed_number} status changed`, oldValue: bed.status, newValue: status }));
  res.json({ ok: true });
});

router.delete('/beds/:id', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const bed = (await db.prepare(`SELECT * FROM beds WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!bed) return res.status(404).json({ error: 'Bed not found' });
  if (bed.status === 'Occupied') return res.status(400).json({ error: 'Cannot delete an occupied bed' });
  (await db.prepare(`DELETE FROM beds WHERE id = ? AND organization_id = ?`).run(req.params.id, req.orgId));
  res.json({ ok: true });
});

// ---------- DEPARTMENTS ----------
router.get('/departments', authenticate, requireOrgContext, async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM departments WHERE organization_id = ? ORDER BY name`).all(req.orgId)));
});

router.post('/departments', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const info = (await db.prepare(`INSERT INTO departments (organization_id, name) VALUES (?, ?)`).run(req.orgId, name));
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ error: 'Department already exists' });
  }
});

// ---------- DOCTORS ----------
router.get('/doctors', authenticate, requireOrgContext, async (req, res) => {
  const rows = (await db.prepare(`
    SELECT d.*, dep.name as department_name
    FROM doctors d LEFT JOIN departments dep ON dep.id = d.department_id AND dep.organization_id = d.organization_id
    WHERE d.organization_id = ? AND d.active = 1 ORDER BY d.name`).all(req.orgId));
  res.json(rows);
});

router.post('/doctors', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { name, department_id, qualification, user_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = (await db.prepare(`INSERT INTO doctors (organization_id, name, department_id, qualification, user_id) VALUES (?,?,?,?,?)`)
    .run(req.orgId, name, department_id || null, qualification || null, user_id || null));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Added doctor ${name}` }));
  res.json({ id: info.lastInsertRowid });
});

// ---------- HOSPITAL SETTINGS (per-organization key/value) ----------
router.get('/settings', authenticate, requireOrgContext, async (req, res) => {
  const rows = (await db.prepare(`SELECT * FROM hospital_settings WHERE organization_id = ?`).all(req.orgId));
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

router.put('/settings', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const updates = req.body || {};
  const stmt = db.prepare(`INSERT INTO hospital_settings (organization_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value`);
  const tx = db.transaction(async (entries) => {
    for (const [k, v] of entries) await stmt.run(req.orgId, k, String(v));
  });
  (await tx(Object.entries(updates)));
  (await logAudit({ orgId: req.orgId, user: req.user, action: 'Updated hospital settings' }));
  res.json({ ok: true });
});

// ---------- STRUCTURE SUMMARY ----------
router.get('/structure-summary', authenticate, requireOrgContext, async (req, res) => {
  const floors = (await db.prepare(`SELECT * FROM floors WHERE organization_id = ? ORDER BY floor_number`).all(req.orgId));
  const result = await Promise.all(floors.map(async f => {
    const rooms = (await db.prepare(`SELECT * FROM rooms WHERE floor_id = ? AND organization_id = ?`).all(f.id, req.orgId));
    const roomsWithBeds = await Promise.all(rooms.map(async r => ({
      ...r,
      beds: (await db.prepare(`SELECT * FROM beds WHERE room_id = ? AND organization_id = ? ORDER BY bed_number`).all(r.id, req.orgId))
    })));
    return { ...f, rooms: roomsWithBeds };
  }));
  res.json(result);
});

module.exports = router;
