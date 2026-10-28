const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();

// Generous but real rate limit - this is a public, unauthenticated endpoint reachable from
// the marketing site by anyone, so it needs its own guard against spam/abuse independent of
// the general /api/ limiter.
const leadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });

function validateLead(body) {
  if (!body.name || !body.name.trim()) return 'Name is required';
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return 'A valid email is required';
  return null;
}

router.post('/demo-requests', leadLimiter, async (req, res) => {
  const err = validateLead(req.body);
  if (err) return res.status(400).json({ error: err });
  const { name, hospital_name, email, phone, city, message } = req.body;
  const info = (await db.prepare(`INSERT INTO marketing_leads (lead_type, name, hospital_name, email, phone, city, message)
    VALUES ('demo_request', ?, ?, ?, ?, ?, ?)`)
    .run(name.trim(), hospital_name || null, email.trim(), phone || null, city || null, message || null));
  res.json({ id: info.lastInsertRowid, message: "Thanks — we'll reach out within one business day to schedule your demo." });
});

router.post('/contact', leadLimiter, async (req, res) => {
  const err = validateLead(req.body);
  if (err) return res.status(400).json({ error: err });
  const { name, email, phone, message } = req.body;
  const info = (await db.prepare(`INSERT INTO marketing_leads (lead_type, name, email, phone, message)
    VALUES ('contact', ?, ?, ?, ?)`)
    .run(name.trim(), email.trim(), phone || null, message || null));
  res.json({ id: info.lastInsertRowid, message: "Thanks for reaching out — we'll get back to you shortly." });
});

module.exports = router;
