// Idempotent demo-data seeder for the Billing & Advance Deposit module.
// Runs once per organization at startup - safe to call every time the server starts.
const db = require('./db');
const { nextBillingAccountNumber, logTimeline } = require('./utils/helpers');

async function run() {
  await seedRateMasterForAllOrgs();
  const orgs = await db.prepare(`SELECT id FROM organizations`).all();
  for (const o of orgs) await seedDemoBillingAccounts(o.id);
}

async function seedRateMasterForAllOrgs() {
  const orgs = await db.prepare(`SELECT id FROM organizations`).all();
  const ins = db.prepare(`INSERT INTO billing_rates (organization_id, category, name, rate, unit) VALUES (?,?,?,?,?)`);
  const rates = [
    ['Room', 'General Ward', 2500, '/day'],
    ['Room', 'Deluxe Room', 5000, '/day'],
    ['Room', 'ICU', 8000, '/day'],
    ['Doctor', 'Consultation', 1500, ''],
    ['Doctor', 'Follow-up Visit', 800, ''],
    ['Nursing', 'Nursing Care', 1000, '/day'],
    ['Lab', 'Complete Blood Count (CBC)', 500, ''],
    ['Lab', 'X-Ray', 800, ''],
    ['Lab', 'Blood Sugar Test', 300, ''],
    ['Medicine', 'Pharmacy Charges', null, ''],
    ['Surgery', 'General Surgery Package', 35000, ''],
    ['Procedure', 'Minor Procedure', 3000, '']
  ];
  for (const o of orgs) {
    const count = (await db.prepare(`SELECT COUNT(*) c FROM billing_rates WHERE organization_id = ?`).get(o.id)).c;
    if (count > 0) continue;
    for (const r of rates) await ins.run(o.id, ...r);
  }
}

async function seedDemoBillingAccounts(orgId) {
  const count = (await db.prepare(`SELECT COUNT(*) c FROM billing_accounts WHERE organization_id = ?`).get(orgId)).c;
  if (count > 0) return;

  const staffUser = await db.prepare(`SELECT id, name FROM users WHERE organization_id = ? AND role = 'receptionist' LIMIT 1`).get(orgId);
  const createdBy = staffUser ? staffUser.id : null;
  const createdByName = staffUser ? staffUser.name : 'system';

  const insAccount = db.prepare(`INSERT INTO billing_accounts (organization_id, account_number, patient_id, admission_id) VALUES (?,?,?,?)`);
  const insTxn = db.prepare(`INSERT INTO billing_transactions
    (organization_id, account_id, type, category, description, quantity, unit_price, amount, payment_method, reference, notes, created_by, created_by_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  async function openAccount(admission) {
    if (!admission) return null;
    const info = await insAccount.run(orgId, await nextBillingAccountNumber(), admission.patient_id, admission.id);
    return { id: info.lastInsertRowid, admission };
  }
  async function deposit(accountId, amount, method, reference) {
    await insTxn.run(orgId, accountId, 'DEPOSIT', null, 'Advance Deposit', 1, amount, amount, method, reference || null, null, createdBy, createdByName);
  }
  async function charge(accountId, category, description, amount) {
    await insTxn.run(orgId, accountId, 'CHARGE', category, description, 1, amount, amount, null, null, null, createdBy, createdByName);
  }
  async function payment(accountId, amount, method, reference) {
    await insTxn.run(orgId, accountId, 'PAYMENT', null, 'Additional Payment', 1, amount, amount, method, reference || null, null, createdBy, createdByName);
  }

  // Pick up to 4 active/discharged admissions for this org to hang demo billing scenarios on
  // (previously hardcoded to fixed admission numbers - now generic per organization).
  const admissions = await db.prepare(`SELECT * FROM admissions WHERE organization_id = ? ORDER BY id ASC LIMIT 4`).all(orgId);
  const scenarios = [
    { deposit: 100000, method: 'UPI', ref: 'UPI123456', charges: [['Room', 'Deluxe Room (3 days)', 15000], ['Doctor', 'Attending Physician Fee', 5000], ['Lab', 'CBC + Blood Sugar Panel', 7500], ['Medicine', 'Ward Medicines & Consumables', 18500], ['Surgery', 'Surgical Procedure Package', 35000]] },
    { deposit: 50000, method: 'Cash', ref: null, charges: [['Room', 'General Ward (4 days)', 20000], ['Doctor', 'Attending Physician Fee', 8000], ['Lab', 'Diagnostic Panel', 6000], ['Medicine', 'Medicines & Consumables', 13000], ['Procedure', 'Minor Procedure', 15000]] },
    { deposit: 200000, method: 'Bank Transfer', ref: 'NEFT-88213', charges: [['Room', 'ICU (5 days)', 40000], ['Doctor', 'Specialist Consultations', 15000], ['Lab', 'Investigations', 10000], ['Medicine', 'Medicines & Consumables', 20000], ['Surgery', 'Surgical Package', 35000]] },
    { deposit: 40000, method: 'UPI', ref: 'UPI778812', charges: [['Room', 'General Ward (3 days)', 7500], ['Doctor', 'Consultation & Follow-up', 3000], ['Lab', 'Post-partum Panel', 1500], ['Medicine', 'Medicines', 33000]], extraPayment: 5000 }
  ];

  for (let i = 0; i < admissions.length; i++) {
    const admission = admissions[i];
    const scenario = scenarios[i];
    if (!scenario) continue;
    const acc = await openAccount(admission);
    if (!acc) continue;
    await deposit(acc.id, scenario.deposit, scenario.method, scenario.ref);
    for (const c of scenario.charges) await charge(acc.id, c[0], c[1], c[2]);
    if (scenario.extraPayment) await payment(acc.id, scenario.extraPayment, 'Cash', null);
    await logTimeline(orgId, acc.admission.patient_id, 'Billing account opened', `Account created for admission ${acc.admission.admission_number}`);
  }

  console.log(`Demo billing accounts seeded for organization ${orgId}.`);
}

module.exports = { run };
