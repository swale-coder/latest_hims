// Single source of truth for SaaS subscription pricing math. Per-plan base prices live in
// the `plans` table (editable via scripts/seed-plans.js today; a DB-editable UI is part of
// the Aiventra Admin Control Center phase, not yet built). Add-on unit rates below are the
// only place they are defined - nothing else in the codebase should hardcode a rupee amount
// for an add-on.
const ADDON_MONTHLY_RATES = {
  user: 199,
  doctor: 499,
  branch: 2999
};
// Annual add-on pricing mirrors the ~17% (2-months-free) discount pattern used on the base
// plans (annual_price is roughly 10x monthly rather than 12x).
const ADDON_ANNUAL_RATES = {
  user: ADDON_MONTHLY_RATES.user * 10,
  doctor: ADDON_MONTHLY_RATES.doctor * 10,
  branch: ADDON_MONTHLY_RATES.branch * 10
};

function computeInvoice({ plan, billingCycle, additionalUsers = 0, additionalDoctors = 0, additionalBranches = 0 }) {
  const rates = billingCycle === 'annual' ? ADDON_ANNUAL_RATES : ADDON_MONTHLY_RATES;
  const basePlanAmount = billingCycle === 'annual' ? plan.annual_price : plan.monthly_price;

  const addonAmount =
    (additionalUsers || 0) * rates.user +
    (additionalDoctors || 0) * rates.doctor +
    (additionalBranches || 0) * rates.branch;

  const baseAmount = Math.round((basePlanAmount + addonAmount) * 100) / 100;
  const gstAmount = Math.round(baseAmount * (plan.gst_percent / 100) * 100) / 100;
  const totalAmount = Math.round((baseAmount + gstAmount) * 100) / 100;

  return { baseAmount, gstAmount, totalAmount, addonAmount, basePlanAmount };
}

module.exports = { computeInvoice, ADDON_MONTHLY_RATES, ADDON_ANNUAL_RATES };
