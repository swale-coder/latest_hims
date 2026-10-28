const express = require('express');
const os = require('os');
const QRCode = require('qrcode');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');

const router = express.Router();

// A QR code is scanned by a PHONE, so it must encode an address the phone can reach.
// "localhost"/127.0.0.1 only means "this phone" when scanned. Priority:
//   1. PUBLIC_BASE_URL env (production domain / fixed LAN address)
//   2. explicit ?baseUrl= (existing behaviour)
//   3. the request host - but if that is localhost, substitute this machine's LAN IP.
function resolveBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (req.query.baseUrl) return String(req.query.baseUrl).replace(/\/+$/, '');
  const host = req.get('host') || '';
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    const port = host.match(/:(\d+)$/);
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) return `${req.protocol}://${a.address}${port ? ':' + port[1] : ''}`;
      }
    }
  }
  return `${req.protocol}://${host}`;
}

router.get('/opd-registration', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const org = (await db.prepare(`SELECT slug FROM organizations WHERE id = ?`).get(req.orgId));
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const baseUrl = resolveBaseUrl(req);
  // The org slug is embedded in the QR target so the public self-registration page
  // knows which hospital's tenant to register the walk-in patient against.
  const url = `${baseUrl}/opd-register.html?org=${encodeURIComponent(org.slug)}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: '#155EEF', light: '#FFFFFF' } });
    res.json({ url, qrImage: dataUrl });
  } catch (e) {
    console.error('QR generation failed:', e);
    res.status(500).json({ error: 'Could not generate QR code' });
  }
});

module.exports = router;
