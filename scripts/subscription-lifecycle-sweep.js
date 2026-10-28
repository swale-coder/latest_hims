/**
 * subscription-lifecycle-sweep.js
 * ----------------------------------------------------------------------------
 * Closes the gap flagged in docs/subscriptions.md: nothing was automatically moving a
 * subscription through active -> payment_due -> grace_period -> suspended as dates passed,
 * and nothing was expiring a trial organization that never subscribed.
 *
 * This sweep is idempotent and safe to run as often as you like - it only moves records
 * forward when their own dates say it's time, and every transition is written to
 * subscription_events (or platform_audit_log for trial expiry) for a visible audit trail.
 *
 * Timing (documented, adjustable constants below):
 *   active        -> payment_due     : the moment current_period_end passes
 *   payment_due   -> grace_period    : 3 days after current_period_end
 *   grace_period  -> suspended       : 10 days after current_period_end (7 days into grace)
 *   cancelled     -> (org) cancelled : once current_period_end passes (access already promised
 *                                      to continue only until then)
 *   trial (no paid subscription ever) -> expired : once organizations.trial_ends_at passes
 *
 * Run once: node scripts/subscription-lifecycle-sweep.js
 * Run continuously: server/index.js schedules this automatically every hour for local/single-
 * instance deployments. For a real multi-instance production deployment, run this as a
 * proper cron job / worker instead of relying on an in-process interval - see
 * docs/deployment.md.
 */
const db = require('../server/db');

const GRACE_PERIOD_START_DAYS = 3;   // payment_due -> grace_period
const SUSPEND_AFTER_DAYS = 10;       // (from period end) grace_period -> suspended

async function logSubscriptionEvent(orgId, subscriptionId, eventType, detail) {
  await db.prepare(`INSERT INTO subscription_events (organization_id, subscription_id, event_type, detail, actor)
    VALUES (?,?,?,?,'system')`).run(orgId, subscriptionId || null, eventType, detail || null);
}

async function runSweep() {
  const now = new Date();
  const results = { activeToPaymentDue: 0, paymentDueToGrace: 0, graceToSuspended: 0, cancelledFinalized: 0, trialsExpired: 0 };

  // ---- active -> payment_due ----
  const overdueActive = await db.prepare(`SELECT * FROM subscriptions WHERE status = 'active' AND current_period_end < datetime('now')`).all();
  for (const sub of overdueActive) {
    await db.prepare(`UPDATE subscriptions SET status='payment_due', updated_at=datetime('now') WHERE id = ?`).run(sub.id);
    await db.prepare(`UPDATE organizations SET status='payment_due', updated_at=datetime('now') WHERE id = ?`).run(sub.organization_id);
    await logSubscriptionEvent(sub.organization_id, sub.id, 'auto_payment_due', `Period ended ${sub.current_period_end}, no renewal payment received`);
    results.activeToPaymentDue++;
  }

  // ---- payment_due -> grace_period ----
  const overduePaymentDue = await db.prepare(`
    SELECT * FROM subscriptions WHERE status = 'payment_due'
    AND current_period_end < datetime('now', ?)`).all(`-${GRACE_PERIOD_START_DAYS} days`);
  for (const sub of overduePaymentDue) {
    const graceEnds = new Date(new Date(sub.current_period_end).getTime() + SUSPEND_AFTER_DAYS * 86400000).toISOString();
    await db.prepare(`UPDATE subscriptions SET status='grace_period', grace_period_ends_at=?, updated_at=datetime('now') WHERE id = ?`).run(graceEnds, sub.id);
    await db.prepare(`UPDATE organizations SET status='grace_period', updated_at=datetime('now') WHERE id = ?`).run(sub.organization_id);
    await logSubscriptionEvent(sub.organization_id, sub.id, 'auto_grace_period', `${GRACE_PERIOD_START_DAYS} days overdue - entering grace period, suspends ${graceEnds}`);
    results.paymentDueToGrace++;
  }

  // ---- grace_period -> suspended ----
  const overdueGrace = await db.prepare(`
    SELECT * FROM subscriptions WHERE status = 'grace_period'
    AND current_period_end < datetime('now', ?)`).all(`-${SUSPEND_AFTER_DAYS} days`);
  for (const sub of overdueGrace) {
    await db.prepare(`UPDATE subscriptions SET status='suspended', updated_at=datetime('now') WHERE id = ?`).run(sub.id);
    await db.prepare(`UPDATE organizations SET status='suspended', suspended_at=datetime('now'), suspended_reason='Automatic: grace period expired without payment', updated_at=datetime('now') WHERE id = ?`).run(sub.organization_id);
    await logSubscriptionEvent(sub.organization_id, sub.id, 'auto_suspended', `Grace period expired ${SUSPEND_AFTER_DAYS} days after period end without payment`);
    results.graceToSuspended++;
  }

  // ---- cancelled subscriptions: finalize once the already-paid period has actually ended ----
  const endedCancellations = await db.prepare(`
    SELECT * FROM subscriptions WHERE status = 'cancelled' AND current_period_end IS NOT NULL AND current_period_end < datetime('now')`).all();
  for (const sub of endedCancellations) {
    const org = await db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(sub.organization_id);
    if (org && org.status !== 'cancelled') {
      await db.prepare(`UPDATE organizations SET status='cancelled', updated_at=datetime('now') WHERE id = ?`).run(sub.organization_id);
      await logSubscriptionEvent(sub.organization_id, sub.id, 'auto_cancellation_finalized', 'Paid period ended after cancellation');
      results.cancelledFinalized++;
    }
  }

  // ---- trial organizations that never subscribed and have run past their trial window ----
  const expiredTrials = await db.prepare(`
    SELECT * FROM organizations WHERE status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < datetime('now')`).all();
  for (const org of expiredTrials) {
    await db.prepare(`UPDATE organizations SET status='expired', updated_at=datetime('now') WHERE id = ?`).run(org.id);
    await db.prepare(`INSERT INTO platform_audit_log (admin_name, organization_id, action, detail) VALUES ('system', ?, 'Trial expired automatically', ?)`)
      .run(org.id, `Trial ended ${org.trial_ends_at} with no subscription ever created`);
    results.trialsExpired++;
  }

  return results;
}

if (require.main === module) {
  (async () => {
    await db.init();
    const results = await runSweep();
    console.log('Subscription lifecycle sweep complete:', results);
    await db.pool.end();
  })().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runSweep };
