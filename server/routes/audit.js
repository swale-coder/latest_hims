const express = require('express');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const rows = (await db.prepare(`SELECT * FROM audit_log WHERE organization_id = ? ORDER BY created_at DESC LIMIT 500`).all(req.orgId));
  res.json(rows);
});

module.exports = router;
