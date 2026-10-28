/**
 * seed-plans.js
 * Seeds the four standard Aiventra subscription plans. Safe to run repeatedly - it only
 * inserts plans that don't already exist (matched by `code`), so editing prices for an
 * existing plan should be done via the Aiventra Admin plan editor (a later phase), not by
 * re-running this script.
 *
 * Run: node scripts/seed-plans.js   (also runs automatically once at first server start)
 */
const db = require('../server/db');

const PLANS = [
  {
    code: 'clinic', name: 'Aiventra Clinic', display_order: 1,
    monthly_price: 2999, annual_price: 29990, installation_fee: 4999, gst_percent: 18,
    bed_limit: 10, opd_limit: 500, user_limit: 5, doctor_limit: 3, branch_limit: 1, storage_limit_gb: 5,
    enabled_modules: ['opd', 'billing'], trial_days: 14
  },
  {
    code: 'small_hospital', name: 'Aiventra Small Hospital', display_order: 2,
    monthly_price: 6999, annual_price: 69990, installation_fee: 9999, gst_percent: 18,
    bed_limit: 30, opd_limit: 2000, user_limit: 20, doctor_limit: 10, branch_limit: 1, storage_limit_gb: 25,
    enabled_modules: ['opd', 'ipd', 'billing', 'lab', 'pharmacy'], trial_days: 14
  },
  {
    code: 'hospital', name: 'Aiventra Hospital', display_order: 3,
    monthly_price: 14999, annual_price: 149990, installation_fee: 19999, gst_percent: 18,
    bed_limit: 100, opd_limit: 8000, user_limit: 60, doctor_limit: 30, branch_limit: 3, storage_limit_gb: 100,
    enabled_modules: ['opd', 'ipd', 'billing', 'lab', 'pharmacy', 'surgery', 'reports', 'ai'], trial_days: 14
  },
  {
    code: 'enterprise', name: 'Aiventra Enterprise', display_order: 4,
    monthly_price: 34999, annual_price: 349990, installation_fee: 49999, gst_percent: 18,
    bed_limit: null, opd_limit: null, user_limit: null, doctor_limit: null, branch_limit: null, storage_limit_gb: null,
    enabled_modules: ['opd', 'ipd', 'billing', 'lab', 'pharmacy', 'surgery', 'reports', 'ai', 'audit', 'multi_branch'],
    trial_days: 30
  }
];

async function run() {
  const ins = db.prepare(`INSERT INTO plans
    (code, name, monthly_price, annual_price, installation_fee, gst_percent, bed_limit, opd_limit,
     user_limit, doctor_limit, branch_limit, storage_limit_gb, enabled_modules, trial_days, display_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let created = 0;
  for (const p of PLANS) {
    const existing = await db.prepare(`SELECT id FROM plans WHERE code = ?`).get(p.code);
    if (existing) continue;
    await ins.run(
      p.code, p.name, p.monthly_price, p.annual_price, p.installation_fee, p.gst_percent,
      p.bed_limit, p.opd_limit, p.user_limit, p.doctor_limit, p.branch_limit, p.storage_limit_gb,
      JSON.stringify(p.enabled_modules), p.trial_days, p.display_order
    );
    created++;
  }
  console.log(created > 0 ? `Seeded ${created} plan(s).` : 'Plans already seeded - nothing to do.');
}

if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
module.exports = { run };
