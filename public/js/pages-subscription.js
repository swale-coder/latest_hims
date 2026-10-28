// Loads the Razorpay Checkout script on demand (only when a hospital admin actually opens
// this page and clicks Subscribe) rather than on every page load.
function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the payment form. Please check your internet connection.'));
    document.body.appendChild(s);
  });
}

function planCard(plan, cycle, current) {
  const price = cycle === 'annual' ? plan.annual_price : plan.monthly_price;
  const period = cycle === 'annual' ? '/year' : '/month';
  const isCurrent = current && current.plan_code === plan.code && ['active', 'trial'].includes(current.status);
  const modules = (plan.enabled_modules || []).join(', ');
  return `
    <div class="card plan-card ${isCurrent ? 'plan-card-current' : ''}" style="padding:20px">
      ${isCurrent ? '<div class="badge badge-blue" style="margin-bottom:8px">Current Plan</div>' : ''}
      <h3 style="margin:0 0 4px">${esc(plan.name)}</h3>
      <div style="font-size:28px;font-weight:700;color:var(--navy,#0B1730)">${fmtINR(price)}<span style="font-size:14px;font-weight:400;color:var(--muted,#667085)">${period}</span></div>
      <p class="hint" style="margin:8px 0">+ ${fmtINR(plan.installation_fee)} one-time setup, ${plan.gst_percent}% GST applies</p>
      <ul style="font-size:13px;color:var(--muted,#667085);padding-left:18px;margin:12px 0">
        <li>${plan.bed_limit ? plan.bed_limit + ' beds' : 'Unlimited beds'}</li>
        <li>${plan.opd_limit ? plan.opd_limit + ' OPD registrations/mo' : 'Unlimited OPD'}</li>
        <li>${plan.user_limit ? plan.user_limit + ' staff users' : 'Unlimited users'}</li>
        <li>${plan.branch_limit ? plan.branch_limit + ' branch(es)' : 'Unlimited branches'}</li>
      </ul>
      <p class="hint" style="font-size:12px">Modules: ${esc(modules)}</p>
      <button class="btn ${isCurrent ? 'btn-secondary' : 'btn-primary'}" data-plan="${plan.code}" data-cycle="${cycle}" style="width:100%;margin-top:8px" ${isCurrent ? 'disabled' : ''}>
        ${isCurrent ? 'Active' : 'Subscribe'}
      </button>
    </div>`;
}

registerRoute('/subscription', async (params, content) => {
  const [plans, currentData] = await Promise.all([Api.get('/subscriptions/plans'), Api.get('/subscriptions/current')]);
  const current = currentData.subscription;
  let cycle = 'monthly';

  function render() {
    content.innerHTML = `
      <div class="page-header"><div><h1>Subscription & Billing</h1><p class="sub">Your Aiventra hospital management subscription</p></div></div>

      ${current ? `
      <div class="card" style="margin-bottom:20px;padding:16px 20px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
          <div>
            <strong>${esc(current.plan_name)}</strong> &mdash; ${esc(current.billing_cycle)}
            <span class="badge ${current.status === 'active' ? 'badge-green' : (current.status === 'trial' ? 'badge-blue' : 'badge-red')}" style="margin-left:8px">${esc(current.status.replace('_',' '))}</span>
            ${current.current_period_end ? `<div class="hint">Renews / expires ${fmtDate(current.current_period_end)}</div>` : ''}
          </div>
          ${['active','payment_due','grace_period'].includes(current.status) ? '<button class="btn btn-secondary" id="cancel-sub">Cancel Subscription</button>' : ''}
        </div>
      </div>` : `<div class="card" style="margin-bottom:20px;padding:16px 20px"><p>No subscription yet. Choose a plan below to get started.</p></div>`}

      <div class="toggle-group" style="margin-bottom:16px">
        <button class="toggle-btn ${cycle === 'monthly' ? 'active' : ''}" id="cycle-monthly">Monthly</button>
        <button class="toggle-btn ${cycle === 'annual' ? 'active' : ''}" id="cycle-annual">Annual (2 months free)</button>
      </div>

      <div class="grid grid-4" id="plans-grid">
        ${plans.map(p => planCard(p, cycle, current)).join('')}
      </div>

      <p class="hint" style="margin-top:20px">Payments are processed securely via Razorpay. Aiventra never stores your card or bank details.</p>
    `;

    qs('#cycle-monthly').onclick = () => { cycle = 'monthly'; render(); };
    qs('#cycle-annual').onclick = () => { cycle = 'annual'; render(); };

    qsa('[data-plan]').forEach(btn => {
      btn.onclick = () => subscribeToPlan(btn.dataset.plan, btn.dataset.cycle);
    });

    if (qs('#cancel-sub')) {
      qs('#cancel-sub').onclick = async () => {
        if (!confirm('Cancel your subscription? You will keep access until the end of the current billing period.')) return;
        try {
          await Api.post('/subscriptions/cancel', {});
          toast('Subscription cancelled', 'success');
          window.location.reload();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  }

  async function subscribeToPlan(planCode, billingCycle) {
    try {
      const created = await Api.post('/subscriptions/create', { plan_code: planCode, billing_cycle: billingCycle });

      await loadRazorpayScript();
      const rzp = new window.Razorpay({
        key: created.keyId,
        amount: created.order.amount,
        currency: created.order.currency,
        order_id: created.order.id,
        name: 'Aiventra Hospital Management System',
        description: `${planCode} plan - ${billingCycle}`,
        theme: { color: '#155EEF' },
        handler: async (response) => {
          try {
            await Api.post('/subscriptions/verify', {
              subscriptionId: created.subscriptionId,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature
            });
            toast('Payment verified - subscription active!', 'success');
            window.location.reload();
          } catch (e) {
            toast(e.message, 'error');
          }
        }
      });
      rzp.open();
    } catch (e) {
      if (e.message && e.message.includes('not configured')) {
        toast('Payments are not yet configured on this server. Add RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET to .env.', 'error');
      } else {
        toast(e.message, 'error');
      }
    }
  }

  render();
});
