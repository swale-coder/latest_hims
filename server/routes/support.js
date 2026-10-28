const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');

const router = express.Router();

// ---------- SUPPORT TICKETS ----------
router.get('/tickets', authenticate, requireOrgContext, async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM support_tickets WHERE organization_id = ? ORDER BY created_at DESC`).all(req.orgId)));
});

router.post('/tickets', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { subject, description, priority } = req.body;
  if (!subject) return res.status(400).json({ error: 'Subject is required' });
  const validPriority = ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal';
  const info = (await db.prepare(`INSERT INTO support_tickets (organization_id, raised_by, subject, description, priority)
    VALUES (?,?,?,?,?)`).run(req.orgId, req.user.id, subject, description || null, validPriority));
  res.json({ id: info.lastInsertRowid });
});

// ---------- SUPPORT ACCESS APPROVAL ----------
// Aiventra staff cannot grant themselves access to a hospital's data - only the hospital's
// own admin/owner can approve a pending request, and it always carries an expiry.
router.get('/access-requests', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM support_access_requests WHERE organization_id = ? ORDER BY created_at DESC`).all(req.orgId)));
});

router.put('/access-requests/:id/approve', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const request = (await db.prepare(`SELECT * FROM support_access_requests WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: `This request is already ${request.status}` });

  const hours = Math.min(Math.max(Number(req.body.hours) || 4, 1), 24); // 1-24 hour window, default 4
  const expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
  (await db.prepare(`UPDATE support_access_requests SET status='approved', approved_by=?, approved_at=datetime('now'), expires_at=? WHERE id=?`)
    .run(req.user.id, expiresAt, request.id));
  res.json({ ok: true, expiresAt });
});

router.put('/access-requests/:id/deny', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const request = (await db.prepare(`SELECT * FROM support_access_requests WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: `This request is already ${request.status}` });
  (await db.prepare(`UPDATE support_access_requests SET status='denied' WHERE id=?`).run(request.id));
  res.json({ ok: true });
});

module.exports = router;
