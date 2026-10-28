const express = require('express');
const db = require('../db');
const { authenticate, requireOrgContext } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, requireOrgContext, async (req, res) => {
  const rows = (await db.prepare(`
    SELECT * FROM notifications
    WHERE organization_id = ? AND (target_role IS NULL OR target_role = ?)
    ORDER BY created_at DESC LIMIT 50`).all(req.orgId, req.user.role));
  res.json(rows);
});

router.put('/:id/read', authenticate, requireOrgContext, async (req, res) => {
  const row = (await db.prepare(`SELECT * FROM notifications WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!row) return res.status(404).json({ error: 'Notification not found' });
  (await db.prepare(`UPDATE notifications SET read_status = 1 WHERE id = ? AND organization_id = ?`).run(req.params.id, req.orgId));
  res.json({ ok: true });
});

module.exports = router;
