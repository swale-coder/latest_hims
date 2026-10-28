const db = require('../db');

// ---------- Sequential ID Generators ----------
// NOTE: these business identifiers are intentionally GLOBAL across the whole platform
// (not per-organization) — see the design note at the top of server/schema.sql.
async function nextPatientId() {
  const row = (await db.prepare(`SELECT patient_id FROM patients ORDER BY id DESC LIMIT 1`).get());
  let n = 1;
  if (row) n = parseInt(row.patient_id.split('-')[1], 10) + 1;
  return `PAT-${String(n).padStart(6, '0')}`;
}

async function nextOpdNumber() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const row = (await db.prepare(`SELECT opd_number FROM opd_visits WHERE opd_number LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`OPD-${today}-%`));
  let n = 1;
  if (row) n = parseInt(row.opd_number.split('-')[2], 10) + 1;
  return `OPD-${today}-${String(n).padStart(4, '0')}`;
}

async function nextAdmissionNumber() {
  const year = new Date().getFullYear();
  const row = (await db.prepare(`SELECT admission_number FROM admissions WHERE admission_number LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`ADM-${year}-%`));
  let n = 1;
  if (row) n = parseInt(row.admission_number.split('-')[2], 10) + 1;
  return `ADM-${year}-${String(n).padStart(5, '0')}`;
}

async function nextBillingAccountNumber() {
  const row = (await db.prepare(`SELECT account_number FROM billing_accounts ORDER BY id DESC LIMIT 1`).get());
  let n = 1;
  if (row) n = parseInt(row.account_number.split('-')[1], 10) + 1;
  return `BILL-${String(n).padStart(6, '0')}`;
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const row = (await db.prepare(`SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`INV-${year}-%`));
  let n = 1;
  if (row) n = parseInt(row.invoice_number.split('-')[2], 10) + 1;
  return `INV-${year}-${String(n).padStart(5, '0')}`;
}

// ---------- BILLING BALANCE (single source of truth - backend authoritative) ----------
// account_id passed in is always fetched via an organization_id-filtered query upstream,
// so no separate org filter is required here.
async function computeBillingBalance(accountId) {
  const sumType = async (type) => (await db.prepare(
    `SELECT COALESCE(SUM(amount),0) s FROM billing_transactions WHERE account_id = ? AND type = ?`
  ).get(accountId, type)).s;

  const deposits = (await sumType('DEPOSIT'));
  const charges = (await sumType('CHARGE'));
  const payments = (await sumType('PAYMENT'));
  const refunds = (await sumType('REFUND'));
  const net = Math.round((deposits + payments - charges - refunds) * 100) / 100;

  let balanceType = 'SETTLED';
  if (net > 0) balanceType = 'CREDIT';
  else if (net < 0) balanceType = 'DUE';

  return {
    deposits, charges, payments, refunds,
    netBalance: net,
    balanceType,
    availableBalance: net > 0 ? net : 0,
    amountDue: net < 0 ? Math.abs(net) : 0
  };
}

// ---------- Timeline ----------
async function logTimeline(orgId, patientId, event, detail = '') {
  (await db.prepare(`INSERT INTO patient_timeline (organization_id, patient_id, event, detail) VALUES (?, ?, ?, ?)`)
    .run(orgId, patientId, event, detail));
}

// ---------- Audit Log ----------
async function logAudit({ orgId, user, action, patientId = null, oldValue = null, newValue = null }) {
  (await db.prepare(`INSERT INTO audit_log (organization_id, user_id, user_name, role, action, patient_id, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(orgId, user ? user.id : null, user ? user.name : 'system', user ? user.role : 'system',
      action, patientId, oldValue, newValue));
}

// ---------- SMS (simulated provider - configurable in real deployment) ----------
async function sendSMS(orgId, patientId, phone, eventType, message) {
  (await db.prepare(`INSERT INTO sms_log (organization_id, patient_id, phone, event_type, message) VALUES (?, ?, ?, ?, ?)`)
    .run(orgId, patientId, phone, eventType, message));
}

// ---------- Aadhaar masking ----------
function maskAadhaar(num) {
  if (!num) return null;
  const clean = num.replace(/\s/g, '');
  if (clean.length < 4) return 'XXXX-XXXX-XXXX';
  return `XXXX-XXXX-${clean.slice(-4)}`;
}

// ---------- Notification ----------
async function notify(orgId, title, message, targetRole = null) {
  (await db.prepare(`INSERT INTO notifications (organization_id, title, message, target_role) VALUES (?, ?, ?, ?)`)
    .run(orgId, title, message, targetRole));
}

module.exports = {
  nextPatientId, nextOpdNumber, nextAdmissionNumber,
  nextBillingAccountNumber, nextInvoiceNumber, computeBillingBalance,
  logTimeline, logAudit, sendSMS, maskAadhaar, notify
};
