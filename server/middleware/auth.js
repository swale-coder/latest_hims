const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'hms-dev-secret-change-in-production-2026';

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('FATAL: JWT_SECRET must be set via environment variable in production.');
  process.exit(1);
}

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

// ---------- TENANT CONTEXT ----------
// Every hospital-scoped route must call this AFTER authenticate(). It derives the
// organization id EXCLUSIVELY from the verified JWT payload (never from req.body,
// req.params or req.query) and exposes it as req.orgId for use in every query.
// Aiventra platform staff (aiventra_super_admin, organization_id === null) are blocked
// from hospital-data routes here — they must use the separate platform admin routes.
function requireOrgContext(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!req.user.organization_id) {
    return res.status(403).json({ error: 'This account is not attached to a hospital organization.' });
  }
  req.orgId = req.user.organization_id;
  next();
}

// Platform-only routes (Aiventra Admin Control Center)
function requirePlatformAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'aiventra_super_admin') {
    return res.status(403).json({ error: 'Aiventra platform admin access required.' });
  }
  next();
}

// Role groups (new SaaS role names — see docs/tenant-isolation.md for the full list)
const ROLE_GROUPS = {
  ADMIN: ['organization_owner', 'hospital_admin'],
  CLINICAL_EDIT: ['doctor'],
  CARE_TEAM: ['doctor', 'nurse'],
  FRONT_DESK: ['receptionist', 'hospital_admin', 'organization_owner'],
  BILLING: ['receptionist', 'accountant', 'hospital_admin', 'organization_owner'],
  LAB: ['lab_staff', 'doctor', 'hospital_admin', 'organization_owner'],
  ALL_STAFF: ['organization_owner', 'hospital_admin', 'receptionist', 'doctor', 'nurse', 'lab_staff', 'pharmacy_staff', 'accountant', 'report_viewer']
};

function authorize(...allowedRoles) {
  const roles = allowedRoles.flat();
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

module.exports = { authenticate, authorize, requireOrgContext, requirePlatformAdmin, JWT_SECRET, ROLE_GROUPS };
