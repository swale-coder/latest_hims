const express = require('express');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const db = require('../db');
const { authenticate, authorize, requireOrgContext, ROLE_GROUPS } = require('../middleware/auth');
const {
  nextBillingAccountNumber, nextInvoiceNumber, computeBillingBalance,
  logTimeline, logAudit, notify
} = require('../utils/helpers');

const router = express.Router();

function invoiceDir(orgId) {
  const dir = path.join(__dirname, '..', '..', 'uploads', `organization-${orgId}`, 'billing-invoices');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function receiptDir(orgId) {
  const dir = path.join(__dirname, '..', '..', 'uploads', `organization-${orgId}`, 'billing-receipts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const FONT_REGULAR = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

const CHARGE_CATEGORIES = ['Room', 'Doctor', 'Nursing', 'Lab', 'Medicine', 'Surgery', 'Procedure', 'Other'];
const PAYMENT_METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque'];

function fmtINR(n) {
  const num = Number(n) || 0;
  return '\u20b9' + num.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: num % 1 !== 0 ? 2 : 0 });
}

// ---------- helper: get account (org-scoped) with patient + admission info, 404 if missing ----------
async function getAccountOr404(orgId, id, res) {
  const account = (await db.prepare(`
    SELECT ba.*, a.admission_number, a.status as admission_status, p.full_name, p.mobile
    FROM billing_accounts ba
    JOIN admissions a ON a.id = ba.admission_id AND a.organization_id = ba.organization_id
    JOIN patients p ON p.patient_id = ba.patient_id AND p.organization_id = ba.organization_id
    WHERE ba.id = ? AND ba.organization_id = ?`).get(id, orgId));
  if (!account) { res.status(404).json({ error: 'Billing account not found' }); return null; }
  return account;
}

// =========================================================================
// DASHBOARD SUMMARY
// =========================================================================
router.get('/summary', authenticate, requireOrgContext, async (req, res) => {
  const orgId = req.orgId;
  const today = new Date().toISOString().slice(0, 10);

  const todayDeposits = (await db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM billing_transactions WHERE organization_id = ? AND type='DEPOSIT' AND date(created_at)=?`).get(orgId, today)).s;
  const todayCharges = (await db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM billing_transactions WHERE organization_id = ? AND type='CHARGE' AND date(created_at)=?`).get(orgId, today)).s;
  const todayPayments = (await db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM billing_transactions WHERE organization_id = ? AND type='PAYMENT' AND date(created_at)=?`).get(orgId, today)).s;

  const accounts = (await db.prepare(`
    SELECT ba.id, ba.account_number, ba.patient_id, ba.admission_id, ba.status,
           a.admission_number, a.status as admission_status, p.full_name
    FROM billing_accounts ba
    JOIN admissions a ON a.id = ba.admission_id AND a.organization_id = ba.organization_id
    JOIN patients p ON p.patient_id = ba.patient_id AND p.organization_id = ba.organization_id
    WHERE ba.organization_id = ?
    ORDER BY ba.created_at DESC`).all(orgId));

  let outstanding = 0;
  const rows = [];
  for (const acc of accounts) {
    const bal = (await computeBillingBalance(acc.id));
    if (bal.balanceType === 'DUE') outstanding += bal.amountDue;
    rows.push({ ...acc, ...bal });
  }

  res.json({
    todayDeposits, todayCharges,
    todayCollection: todayDeposits + todayPayments,
    outstanding,
    accounts: rows
  });
});

// =========================================================================
// RATE MASTER
// =========================================================================
router.get('/rates', authenticate, requireOrgContext, async (req, res) => {
  res.json((await db.prepare(`SELECT * FROM billing_rates WHERE organization_id = ? ORDER BY category, name`).all(req.orgId)));
});

router.post('/rates', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const { category, name, rate, unit } = req.body;
  if (!category || !name) return res.status(400).json({ error: 'Category and service name are required' });
  const info = (await db.prepare(`INSERT INTO billing_rates (organization_id, category, name, rate, unit) VALUES (?,?,?,?,?)`)
    .run(req.orgId, category, name, rate === '' || rate === undefined ? null : Number(rate), unit || ''));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Rate added: ${category} - ${name}` }));
  res.json((await db.prepare(`SELECT * FROM billing_rates WHERE id = ? AND organization_id = ?`).get(info.lastInsertRowid, req.orgId)));
});

router.put('/rates/:id', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const rateRow = (await db.prepare(`SELECT * FROM billing_rates WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!rateRow) return res.status(404).json({ error: 'Rate not found' });
  const { category, name, rate, unit } = req.body;
  (await db.prepare(`UPDATE billing_rates SET category=?, name=?, rate=?, unit=?, updated_at=datetime('now') WHERE id=? AND organization_id=?`)
    .run(category ?? rateRow.category, name ?? rateRow.name,
      rate === '' || rate === undefined ? rateRow.rate : Number(rate), unit ?? rateRow.unit, req.params.id, req.orgId));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Rate updated: ${category || rateRow.category} - ${name || rateRow.name}` }));
  res.json((await db.prepare(`SELECT * FROM billing_rates WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId)));
});

router.put('/rates/:id/toggle', authenticate, requireOrgContext, authorize(ROLE_GROUPS.ADMIN), async (req, res) => {
  const rateRow = (await db.prepare(`SELECT * FROM billing_rates WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!rateRow) return res.status(404).json({ error: 'Rate not found' });
  (await db.prepare(`UPDATE billing_rates SET active = ?, updated_at=datetime('now') WHERE id = ? AND organization_id = ?`).run(rateRow.active ? 0 : 1, req.params.id, req.orgId));
  (await logAudit({ orgId: req.orgId, user: req.user, action: `Rate ${rateRow.active ? 'disabled' : 'enabled'}: ${rateRow.category} - ${rateRow.name}` }));
  res.json((await db.prepare(`SELECT * FROM billing_rates WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId)));
});

// =========================================================================
// BILLING ACCOUNT (one per admission, created lazily)
// =========================================================================
router.get('/account/by-admission/:admissionId', authenticate, requireOrgContext, async (req, res) => {
  const orgId = req.orgId;
  const admission = (await db.prepare(`SELECT * FROM admissions WHERE id = ? AND organization_id = ?`).get(req.params.admissionId, orgId));
  if (!admission) return res.status(404).json({ error: 'Admission not found' });

  let account = (await db.prepare(`SELECT * FROM billing_accounts WHERE admission_id = ? AND organization_id = ?`).get(admission.id, orgId));
  if (!account) {
    const info = (await db.prepare(`INSERT INTO billing_accounts (organization_id, account_number, patient_id, admission_id) VALUES (?,?,?,?)`)
      .run(orgId, (await nextBillingAccountNumber()), admission.patient_id, admission.id));
    account = (await db.prepare(`SELECT * FROM billing_accounts WHERE id = ?`).get(info.lastInsertRowid));
  }

  const full = (await getAccountOr404(orgId, account.id, res));
  if (!full) return;
  const balance = (await computeBillingBalance(account.id));
  const transactions = (await db.prepare(`SELECT * FROM billing_transactions WHERE account_id = ? AND organization_id = ? ORDER BY created_at DESC, id DESC`).all(account.id, orgId));
  const invoices = (await db.prepare(`SELECT * FROM invoices WHERE account_id = ? AND organization_id = ? ORDER BY created_at DESC`).all(account.id, orgId));

  res.json({ account: full, balance, transactions, invoices });
});

router.get('/account/:id', authenticate, requireOrgContext, async (req, res) => {
  const account = (await getAccountOr404(req.orgId, req.params.id, res));
  if (!account) return;
  const balance = (await computeBillingBalance(account.id));
  const transactions = (await db.prepare(`SELECT * FROM billing_transactions WHERE account_id = ? AND organization_id = ? ORDER BY created_at DESC, id DESC`).all(account.id, req.orgId));
  const invoices = (await db.prepare(`SELECT * FROM invoices WHERE account_id = ? AND organization_id = ? ORDER BY created_at DESC`).all(account.id, req.orgId));
  res.json({ account, balance, transactions, invoices });
});

router.get('/account/:id/ledger', authenticate, requireOrgContext, async (req, res) => {
  const account = (await getAccountOr404(req.orgId, req.params.id, res));
  if (!account) return;
  const rows = (await db.prepare(`SELECT * FROM billing_transactions WHERE account_id = ? AND organization_id = ? ORDER BY created_at ASC, id ASC`).all(account.id, req.orgId));
  let running = 0;
  const ledger = rows.map(r => {
    if (r.type === 'DEPOSIT' || r.type === 'PAYMENT') running += r.amount;
    else running -= r.amount;
    return { ...r, runningBalance: Math.round(running * 100) / 100 };
  }).reverse();
  res.json({ account, ledger });
});

// ---------- ADD DEPOSIT ----------
router.post('/account/:id/deposit', authenticate, requireOrgContext, authorize(ROLE_GROUPS.BILLING), async (req, res) => {
  const orgId = req.orgId;
  const account = (await getAccountOr404(orgId, req.params.id, res));
  if (!account) return;
  const { amount, payment_method, reference, notes } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter a valid deposit amount' });
  if (!payment_method) return res.status(400).json({ error: 'Payment method is required' });

  const info = (await db.prepare(`INSERT INTO billing_transactions
    (organization_id, account_id, type, description, amount, payment_method, reference, notes, created_by, created_by_name)
    VALUES (?, ?, 'DEPOSIT', ?, ?, ?, ?, ?, ?, ?)`)
    .run(orgId, account.id, 'Advance Deposit', amt, payment_method, reference || null, notes || null, req.user.id, req.user.name));
  (await db.prepare(`UPDATE billing_accounts SET updated_at = datetime('now') WHERE id = ? AND organization_id = ?`).run(account.id, orgId));

  const txn = (await db.prepare(`SELECT * FROM billing_transactions WHERE id = ?`).get(info.lastInsertRowid));
  (await generateReceiptPDF(orgId, txn, account, 'Advance Deposit Receipt'));

  (await logTimeline(orgId, account.patient_id, 'Advance deposit received', `${fmtINR(amt)} via ${payment_method} (Admission ${account.admission_number})`));
  (await logAudit({ orgId, user: req.user, action: `Deposit of ${fmtINR(amt)} added for admission ${account.admission_number}`, patientId: account.patient_id }));

  res.json({ ok: true, transaction: (await db.prepare(`SELECT * FROM billing_transactions WHERE id = ?`).get(txn.id)), balance: (await computeBillingBalance(account.id)) });
});

// ---------- ADD CHARGE ----------
router.post('/account/:id/charge', authenticate, requireOrgContext, authorize(ROLE_GROUPS.BILLING), async (req, res) => {
  const orgId = req.orgId;
  const account = (await getAccountOr404(orgId, req.params.id, res));
  if (!account) return;
  const { category, description, quantity, rate } = req.body;
  if (!category || !CHARGE_CATEGORIES.includes(category)) return res.status(400).json({ error: 'A valid charge category is required' });
  if (!description) return res.status(400).json({ error: 'Description is required' });
  const qty = Number(quantity) > 0 ? Number(quantity) : 1;
  const unitPrice = Number(rate);
  if (!unitPrice || unitPrice <= 0) return res.status(400).json({ error: 'Enter a valid rate' });
  const amount = Math.round(qty * unitPrice * 100) / 100;

  const info = (await db.prepare(`INSERT INTO billing_transactions
    (organization_id, account_id, type, category, description, quantity, unit_price, amount, created_by, created_by_name)
    VALUES (?, ?, 'CHARGE', ?, ?, ?, ?, ?, ?, ?)`)
    .run(orgId, account.id, category, description, qty, unitPrice, amount, req.user.id, req.user.name));
  (await db.prepare(`UPDATE billing_accounts SET updated_at = datetime('now') WHERE id = ? AND organization_id = ?`).run(account.id, orgId));

  (await logTimeline(orgId, account.patient_id, 'Charge added to bill', `${category}: ${description} \u2014 ${fmtINR(amount)}`));
  (await logAudit({ orgId, user: req.user, action: `Charge added (${category}: ${description}, ${fmtINR(amount)}) for admission ${account.admission_number}`, patientId: account.patient_id }));

  res.json({ ok: true, transaction: (await db.prepare(`SELECT * FROM billing_transactions WHERE id = ?`).get(info.lastInsertRowid)), balance: (await computeBillingBalance(account.id)) });
});

// ---------- COLLECT ADDITIONAL PAYMENT ----------
router.post('/account/:id/payment', authenticate, requireOrgContext, authorize(ROLE_GROUPS.BILLING), async (req, res) => {
  const orgId = req.orgId;
  const account = (await getAccountOr404(orgId, req.params.id, res));
  if (!account) return;
  const { amount, payment_method, reference, notes } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter a valid payment amount' });
  if (!payment_method) return res.status(400).json({ error: 'Payment method is required' });

  const info = (await db.prepare(`INSERT INTO billing_transactions
    (organization_id, account_id, type, description, amount, payment_method, reference, notes, created_by, created_by_name)
    VALUES (?, ?, 'PAYMENT', ?, ?, ?, ?, ?, ?, ?)`)
    .run(orgId, account.id, 'Additional Payment', amt, payment_method, reference || null, notes || null, req.user.id, req.user.name));
  (await db.prepare(`UPDATE billing_accounts SET updated_at = datetime('now') WHERE id = ? AND organization_id = ?`).run(account.id, orgId));

  const txn = (await db.prepare(`SELECT * FROM billing_transactions WHERE id = ?`).get(info.lastInsertRowid));
  (await generateReceiptPDF(orgId, txn, account, 'Payment Receipt'));

  (await logTimeline(orgId, account.patient_id, 'Payment collected', `${fmtINR(amt)} via ${payment_method} (Admission ${account.admission_number})`));
  (await logAudit({ orgId, user: req.user, action: `Payment of ${fmtINR(amt)} collected for admission ${account.admission_number}`, patientId: account.patient_id }));
  (await notify(orgId, 'Payment collected', `${fmtINR(amt)} collected from ${account.full_name}`, null));

  res.json({ ok: true, transaction: (await db.prepare(`SELECT * FROM billing_transactions WHERE id = ?`).get(txn.id)), balance: (await computeBillingBalance(account.id)) });
});

// ---------- PROCESS REFUND ----------
router.post('/account/:id/refund', authenticate, requireOrgContext, authorize(ROLE_GROUPS.BILLING), async (req, res) => {
  const orgId = req.orgId;
  const account = (await getAccountOr404(orgId, req.params.id, res));
  if (!account) return;
  const { amount, payment_method, reference, reason } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter a valid refund amount' });
  if (!payment_method) return res.status(400).json({ error: 'Refund method is required' });

  const balance = (await computeBillingBalance(account.id));
  if (amt > balance.availableBalance + 0.01) {
    return res.status(400).json({ error: `Refund cannot exceed the refundable balance of ${fmtINR(balance.availableBalance)}` });
  }

  const info = (await db.prepare(`INSERT INTO billing_transactions
    (organization_id, account_id, type, description, amount, payment_method, reference, notes, created_by, created_by_name)
    VALUES (?, ?, 'REFUND', ?, ?, ?, ?, ?, ?, ?)`)
    .run(orgId, account.id, 'Refund', amt, payment_method, reference || null, reason || null, req.user.id, req.user.name));
  (await db.prepare(`UPDATE billing_accounts SET updated_at = datetime('now') WHERE id = ? AND organization_id = ?`).run(account.id, orgId));

  const txn = (await db.prepare(`SELECT * FROM billing_transactions WHERE id = ?`).get(info.lastInsertRowid));
  (await generateReceiptPDF(orgId, txn, account, 'Refund Receipt'));

  (await logTimeline(orgId, account.patient_id, 'Refund processed', `${fmtINR(amt)} via ${payment_method} (Admission ${account.admission_number})`));
  (await logAudit({ orgId, user: req.user, action: `Refund of ${fmtINR(amt)} processed for admission ${account.admission_number}`, patientId: account.patient_id }));

  res.json({ ok: true, transaction: (await db.prepare(`SELECT * FROM billing_transactions WHERE id = ?`).get(txn.id)), balance: (await computeBillingBalance(account.id)) });
});

// ---------- GENERATE INTERIM / FINAL BILL ----------
router.post('/account/:id/invoice', authenticate, requireOrgContext, authorize(ROLE_GROUPS.BILLING), async (req, res) => {
  const orgId = req.orgId;
  const account = (await getAccountOr404(orgId, req.params.id, res));
  if (!account) return;
  const type = req.body.type === 'Final' ? 'Final' : 'Interim';

  const balance = (await computeBillingBalance(account.id));
  const charges = (await db.prepare(`SELECT * FROM billing_transactions WHERE account_id = ? AND organization_id = ? AND type = 'CHARGE' ORDER BY created_at ASC`).all(account.id, orgId));
  const invoiceNumber = (await nextInvoiceNumber());

  const info = (await db.prepare(`INSERT INTO invoices
    (organization_id, account_id, invoice_number, type, total_charges, deposit_amount, additional_payments, refunds, balance_amount, balance_type, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orgId, account.id, invoiceNumber, type, balance.charges, balance.deposits, balance.payments, balance.refunds,
      Math.abs(balance.netBalance), balance.balanceType, req.user.id));

  const invoiceId = info.lastInsertRowid;
  const filename = `${type.toLowerCase()}-bill-${invoiceNumber}.pdf`;
  const filepath = path.join(invoiceDir(orgId), filename);
  (await generateBillPDF(orgId, filepath, { type, invoiceNumber, account, charges, balance }));
  const pdfUrl = `/uploads/organization-${orgId}/billing-invoices/${filename}`;
  (await db.prepare(`UPDATE invoices SET pdf_path = ? WHERE id = ? AND organization_id = ?`).run(pdfUrl, invoiceId, orgId));

  (await logTimeline(orgId, account.patient_id, `${type} bill generated`, `${invoiceNumber} \u2014 Total charges ${fmtINR(balance.charges)}`));
  (await logAudit({ orgId, user: req.user, action: `${type} bill ${invoiceNumber} generated for admission ${account.admission_number}`, patientId: account.patient_id }));

  res.json({ ok: true, invoice: (await db.prepare(`SELECT * FROM invoices WHERE id = ? AND organization_id = ?`).get(invoiceId, orgId)), pdf: pdfUrl });
});

router.get('/invoice/:id', authenticate, requireOrgContext, async (req, res) => {
  const row = (await db.prepare(`SELECT * FROM invoices WHERE id = ? AND organization_id = ?`).get(req.params.id, req.orgId));
  if (!row) return res.status(404).json({ error: 'Invoice not found' });
  res.json(row);
});

// =========================================================================
// PDF GENERATION
// =========================================================================
function pdfHeader(doc, title, hospitalName) {
  doc.font(FONT_BOLD).fontSize(18).fillColor('#0B1730').text(hospitalName || 'Hospital', { align: 'center' });
  doc.font(FONT_REGULAR).fontSize(10).fillColor('#667085').text('Powered by Aiventra Hospital Management System', { align: 'center' });
  doc.moveDown(0.5);
  doc.font(FONT_BOLD).fontSize(16).fillColor('#111').text(title, { align: 'center', underline: true });
  doc.moveDown();
}

function kvRow(doc, label, value, opts = {}) {
  const LEFT = 50, RIGHT = 545, LABEL_W = opts.labelWidth || 160;
  const y = doc.y;
  doc.font(FONT_REGULAR).fontSize(10).fillColor('#555').text(label, LEFT, y, { width: LABEL_W, lineBreak: false });
  doc.font(opts.bold ? FONT_BOLD : FONT_REGULAR).fillColor(opts.color || '#111')
    .text(value || '-', LEFT + LABEL_W, y, { width: RIGHT - LEFT - LABEL_W, lineBreak: false });
  doc.moveDown(0.7);
}

function amountRow(doc, description, amount, opts = {}) {
  const LEFT = 50, RIGHT = 545;
  const y = doc.y;
  doc.font(opts.bold ? FONT_BOLD : FONT_REGULAR).fontSize(opts.fontSize || 10).fillColor(opts.color || '#111')
    .text(description, LEFT, y, { width: 330, lineBreak: false });
  doc.font(opts.bold ? FONT_BOLD : FONT_REGULAR).fontSize(opts.fontSize || 10).fillColor(opts.color || '#111')
    .text(amount, LEFT, y, { width: RIGHT - LEFT, align: 'right', lineBreak: false });
  doc.moveDown(opts.spacing || 0.7);
}

async function generateBillPDF(orgId, filepath, { type, invoiceNumber, account, charges, balance }) {
  const org = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(orgId));
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(fs.createWriteStream(filepath));

  pdfHeader(doc, type === 'Final' ? 'FINAL BILL' : 'INTERIM BILL', org && org.name);

  kvRow(doc, 'Bill No:', invoiceNumber);
  kvRow(doc, 'Date:', new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }));
  kvRow(doc, 'Patient:', account.full_name);
  kvRow(doc, 'Patient ID:', account.patient_id);
  kvRow(doc, 'Admission No:', account.admission_number);
  doc.moveDown(0.4);

  doc.font(FONT_BOLD).fontSize(12).fillColor('#155EEF').text('Charges', 50, doc.y);
  doc.moveDown(0.4);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#e4e9ee').stroke();
  doc.moveDown(0.4);

  if (charges.length === 0) {
    doc.font(FONT_REGULAR).fontSize(10).fillColor('#555').text('No charges recorded yet.', 50, doc.y);
    doc.moveDown(0.7);
  } else {
    charges.forEach(c => amountRow(doc, `${c.category} \u2014 ${c.description}`, fmtINR(c.amount)));
  }
  doc.moveDown(0.2);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#e4e9ee').stroke();
  doc.moveDown(0.5);

  amountRow(doc, 'TOTAL', fmtINR(balance.charges), { bold: true, fontSize: 11, spacing: 1 });

  kvRow(doc, 'Advance Deposit:', fmtINR(balance.deposits));
  if (balance.payments > 0) kvRow(doc, 'Additional Payments:', fmtINR(balance.payments));
  if (balance.refunds > 0) kvRow(doc, 'Refunds:', fmtINR(balance.refunds));
  doc.moveDown(0.4);

  const balanceLabel = balance.balanceType === 'DUE' ? 'AMOUNT DUE'
    : (balance.balanceType === 'SETTLED' ? 'SETTLED \u2014 BALANCE \u20b90' : 'AVAILABLE BALANCE');
  const balanceColor = balance.balanceType === 'DUE' ? '#d64545' : '#1f8a5f';
  if (balance.balanceType === 'SETTLED') {
    doc.font(FONT_BOLD).fontSize(13).fillColor(balanceColor).text(balanceLabel, 50, doc.y);
  } else {
    amountRow(doc, balanceLabel, fmtINR(Math.abs(balance.netBalance)), { bold: true, fontSize: 13, color: balanceColor });
  }

  doc.moveDown(2);
  doc.font(FONT_REGULAR).fontSize(9).fillColor('#7c8a9a').text(
    type === 'Interim'
      ? 'This is an interim bill generated during the course of treatment and does not close the billing account.'
      : 'This is the final settlement bill generated at discharge.',
    50, doc.y, { align: 'center', width: 495 });

  doc.end();
}

async function generateReceiptPDF(orgId, txn, account, title) {
  const org = (await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(orgId));
  const filename = `receipt-${txn.type.toLowerCase()}-${txn.id}-${Date.now()}.pdf`;
  const filepath = path.join(receiptDir(orgId), filename);
  const doc = new PDFDocument({ margin: 50, size: 'A5' });
  doc.pipe(fs.createWriteStream(filepath));

  pdfHeader(doc, title, org && org.name);
  kvRow(doc, 'Receipt No:', `RCT-${String(txn.id).padStart(6, '0')}`, { labelWidth: 130 });
  kvRow(doc, 'Date:', new Date(txn.created_at.replace(' ', 'T')).toLocaleString('en-IN'), { labelWidth: 130 });
  kvRow(doc, 'Patient:', account.full_name, { labelWidth: 130 });
  kvRow(doc, 'Patient ID:', account.patient_id, { labelWidth: 130 });
  kvRow(doc, 'Admission No:', account.admission_number, { labelWidth: 130 });
  doc.moveDown(0.5);
  kvRow(doc, 'Amount:', fmtINR(txn.amount), { labelWidth: 130, bold: true });
  kvRow(doc, 'Method:', txn.payment_method || '-', { labelWidth: 130 });
  if (txn.reference) kvRow(doc, 'Reference:', txn.reference, { labelWidth: 130 });
  if (txn.notes) kvRow(doc, 'Notes / Reason:', txn.notes, { labelWidth: 130 });
  doc.moveDown(2);
  doc.font(FONT_REGULAR).fontSize(9).fillColor('#7c8a9a').text('Computer-generated receipt. No signature required.', 50, doc.y, { align: 'center', width: 420 });
  doc.end();

  const pdfUrl = `/uploads/organization-${orgId}/billing-receipts/${filename}`;
  (await db.prepare(`UPDATE billing_transactions SET receipt_path = ? WHERE id = ? AND organization_id = ?`).run(pdfUrl, txn.id, orgId));
  return pdfUrl;
}

module.exports = router;
module.exports.CHARGE_CATEGORIES = CHARGE_CATEGORIES;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
