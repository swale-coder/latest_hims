const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { JWT_SECRET } = require('./middleware/auth');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

// ---------- SECURITY HEADERS ----------
// A real, working CSP scoped to what this app actually loads - not left disabled. Inline
// <script>/style attributes are allowed because this is a static-file app with no build
// step to inject per-request nonces (a genuine, documented trade-off - see docs/security.md);
// everything else is locked down (no plugins, no framing, no cross-origin form posts).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com'],
      // The pre-existing hospital app UI (patients/OPD/lab/billing/etc pages) uses inline
      // onclick="" handlers throughout rather than addEventListener - a real, pre-existing
      // architecture choice, not something introduced by this hardening pass. Refactoring
      // every one of those call sites to event listeners is real future work (tracked in
      // docs/security.md) but out of scope to rush through here without full re-testing of
      // every page. Helmet defaults this to 'none', which would silently break most buttons
      // in the app, so it's explicitly allowed here rather than left to fail silently.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
      frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"] // this app should never be embedded in someone else's iframe
    }
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false
}));

// ---------- HTTPS ENFORCEMENT (production only, behind a reverse proxy) ----------
// Relies on the proxy setting X-Forwarded-Proto, standard for nginx/most load balancers.
// `app.set('trust proxy', 1)` is required for req.secure / X-Forwarded-* to be trusted at
// all - without it Express ignores these headers by default (correctly, since otherwise a
// client could spoof them directly against an app with no proxy in front).
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    res.redirect(301, `https://${req.headers.host}${req.url}`);
  });
}

// CORS: wide open by default for local development (no origin restriction needed when
// everything runs on localhost). In production, ALLOWED_ORIGINS should be set to the real
// domains (app./admin./marketing) so the API doesn't accept cross-origin requests from
// arbitrary third-party sites. Bearer-token auth (not cookies) already limits the practical
// impact of this being open - a malicious site can't read another origin's localStorage
// token - but restricting it is still correct defense-in-depth, not just theater.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
} : {}));

// ---------- RAZORPAY WEBHOOK: must be mounted BEFORE express.json() ----------
// Webhook signature verification (server/utils/razorpay.js) needs the EXACT raw bytes
// Razorpay sent, not a re-serialized JSON object (which can differ in key order/whitespace
// and would make every signature check fail). So this one route gets express.raw() instead
// of the global JSON parser, and the parsed body is only used after the signature checks out.
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json', limit: '1mb' }), (req, res, next) => {
  req.rawBody = req.body; // Buffer
  require('./routes/subscriptions').handleWebhook(req, res).catch(next);
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 });
app.use('/api/', limiter);

// Static files (public marketing/app shell only — never the uploads directory, see below)
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- ORGANIZATION-SCOPED FILE ACCESS ----------
// Every uploaded file lives under uploads/organization-<id>/... . This guard authenticates
// the requester (Bearer header OR ?token= for <img>/<a> tags that can't set headers), then
// verifies the requested organization-<id> segment matches the token's own organization_id
// before ever touching the filesystem. No file is served from a blanket express.static.
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

app.get('/uploads/organization-:orgId/*', async (req, res) => {
  const header = req.headers.authorization;
  const token = (header && header.startsWith('Bearer ')) ? header.split(' ')[1] : req.query.token;
  if (!token) return res.status(401).json({ error: 'Authentication required to access this file' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const requestedOrgId = parseInt(req.params.orgId, 10);
  const isPlatformAdmin = payload.role === 'aiventra_super_admin';
  if (!isPlatformAdmin && payload.organization_id !== requestedOrgId) {
    return res.status(403).json({ error: 'You do not have access to this file' });
  }
  // Platform admin file access requires an approved, unexpired support_access_requests row
  // for this organization AND this admin - never granted by default, always hospital-approved
  // (see server/routes/support.js for the approval endpoint) and always time-boxed.
  if (isPlatformAdmin) {
    const approved = (await db.prepare(`
      SELECT * FROM support_access_requests
      WHERE organization_id = ? AND requested_by = ? AND status = 'approved' AND expires_at > datetime('now')
      ORDER BY approved_at DESC LIMIT 1`).get(requestedOrgId, payload.id));
    if (!approved) {
      return res.status(403).json({ error: 'No approved, active support session for this hospital. Request access and wait for hospital approval.' });
    }
  }

  let relPath;
  try { relPath = decodeURIComponent(req.params[0]); } catch (e) { return res.status(400).json({ error: 'Invalid file name' }); }
  const allowedRoot = path.resolve(path.join(UPLOAD_ROOT, `organization-${requestedOrgId}`));
  const resolved = path.resolve(allowedRoot, relPath);
  if (resolved !== allowedRoot && !resolved.startsWith(allowedRoot + path.sep)) return res.status(400).json({ error: 'Invalid path' }); // path traversal guard
  let stat;
  try { stat = fs.statSync(resolved); } catch (e) { stat = null; }
  if (!stat || !stat.isFile()) return res.status(404).json({ error: 'This file is no longer available. It may have been moved or deleted.' });

  // PDFs/images open inline in the browser; other types (DOC/XLS...) download with their name.
  const ext = path.extname(resolved).toLowerCase();
  const inlineTypes = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const disp = inlineTypes.includes(ext) ? 'inline' : 'attachment';
  const safeName = path.basename(resolved).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Disposition', `${disp}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(resolved, (err) => { if (err && !res.headersSent) res.status(err.status || 404).json({ error: 'File could not be read' }); });
});

// Public QR self-registration page also needs to load its own static assets normally
// via the public/ static handler above (index.html, css, js) — those are not tenant data.

// ---------- API ROUTES ----------
app.use('/api/auth', require('./routes/auth'));
app.use('/api/hospital', require('./routes/hospitalConfig'));
app.use('/api/patients', require('./routes/patients'));
app.use('/api/opd', require('./routes/opd'));
app.use('/api/consultations', require('./routes/consultations'));
app.use('/api/admissions', require('./routes/admissions'));
app.use('/api/beds', require('./routes/beds'));
app.use('/api/clinical', require('./routes/clinical'));
app.use('/api/lab', require('./routes/lab'));
app.use('/api/surgery', require('./routes/surgery'));
app.use('/api/medication', require('./routes/medication'));
app.use('/api/discharge', require('./routes/discharge'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/qr', require('./routes/qr'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/onboarding', require('./routes/onboarding'));
app.use('/api/support', require('./routes/support'));
app.use('/api/platform', require('./routes/platformAdmin'));
app.use('/api', require('./routes/marketingLeads'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Fallback to SPA for any non-API GET route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---------- ERROR HANDLER (never expose raw errors) ----------
app.use((err, req, res, next) => {
  console.error(err);
  if (err.message && err.message.includes('Only PDF, JPG, PNG')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function start() {
  // Create schema (if needed) and apply small additive migrations BEFORE anything else
  // touches the database - every seed step and the app itself depend on this.
  await db.init();

  // Ensure the four standard subscription plans and billing demo data exist. Both are
  // idempotent - no-op after the first run.
  try { await require('../scripts/seed-plans').run(); } catch (e) { console.error('Plan seed skipped:', e.message); }
  try { await require('./seedBilling').run(); } catch (e) { console.error('Billing demo seed skipped:', e.message); }

  app.listen(PORT, () => {
    console.log(`\n  Aiventra Hospital Management System running at http://localhost:${PORT}\n`);

    // Single-instance in-process scheduler for the subscription lifecycle sweep. Fine for
    // local development and a single-server deployment; a real multi-instance production
    // deployment should run scripts/subscription-lifecycle-sweep.js as an external cron job
    // instead, so the sweep runs exactly once regardless of how many app instances are up
    // (see docs/deployment.md).
    const { runSweep } = require('../scripts/subscription-lifecycle-sweep');
    setTimeout(() => { runSweep().catch(e => console.error('Lifecycle sweep failed:', e.message)); }, 5000);
    setInterval(() => { runSweep().catch(e => console.error('Lifecycle sweep failed:', e.message)); }, 60 * 60 * 1000);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
