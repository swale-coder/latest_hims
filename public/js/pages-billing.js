// ============================= BILLING MODULE =============================
const BILLING_CHARGE_CATEGORIES = ['Room', 'Doctor', 'Nursing', 'Lab', 'Medicine', 'Surgery', 'Procedure', 'Other'];
const BILLING_PAYMENT_METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque'];

function canManageBilling() { return ['organization_owner', 'hospital_admin', 'receptionist'].includes(Api.user.role); }
function canManageRates() { return ['organization_owner', 'hospital_admin'].includes(Api.user.role); }

function txnBadge(type) {
  const map = { DEPOSIT: 'badge-green', CHARGE: 'badge-blue', PAYMENT: 'badge-amber', REFUND: 'badge-grey' };
  return `<span class="badge ${map[type] || 'badge-grey'}">${type}</span>`;
}

// ============================= BILLING DASHBOARD =============================
registerRoute('/billing', async (params, content) => {
  content.innerHTML = `
    <div class="page-header"><div><h1>Billing</h1><p class="sub">Advance deposits, treatment charges, and patient balances</p></div></div>
    <div class="tabs" id="billing-tabs">
      ${['Overview', 'Rate Master'].map((t, i) => `<div class="tab-btn ${i === 0 ? 'active' : ''}" data-tab="${t}">${t}</div>`).join('')}
    </div>
    <div id="billing-tab-content"></div>
  `;
  const container = qs('#billing-tab-content');
  const loaders = { 'Overview': loadBillingOverviewTab, 'Rate Master': loadRateMasterTab };
  qsa('.tab-btn', qs('#billing-tabs')).forEach(btn => {
    btn.onclick = () => {
      qsa('.tab-btn', qs('#billing-tabs')).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loaders[btn.dataset.tab](container);
    };
  });
  loadBillingOverviewTab(container);
});

async function loadBillingOverviewTab(container) {
  container.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
  const d = await Api.get('/billing/summary');
  container.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:20px">
      <div class="stat-card accent-teal"><div class="stat-label">Today's Deposits</div><div class="stat-value">${fmtINR(d.todayDeposits)}</div></div>
      <div class="stat-card accent-blue"><div class="stat-label">Today's Charges</div><div class="stat-value">${fmtINR(d.todayCharges)}</div></div>
      <div class="stat-card accent-green"><div class="stat-label">Today's Collection</div><div class="stat-value">${fmtINR(d.todayCollection)}</div></div>
      <div class="stat-card accent-red"><div class="stat-label">Outstanding Amount</div><div class="stat-value">${fmtINR(d.outstanding)}</div></div>
    </div>
    <div class="card">
      <div class="card-header"><h3>Billing Accounts</h3><span class="muted" style="font-size:12px">${d.accounts.length} account${d.accounts.length === 1 ? '' : 's'}</span></div>
      <div class="table-wrap">
        ${d.accounts.length ? `<table><thead><tr><th>Patient</th><th>Admission</th><th>Deposit</th><th>Charges</th><th>Balance</th><th>Status</th></tr></thead>
        <tbody>${d.accounts.map(a => `<tr>
          <td class="table-link" onclick="location.hash='#/patients/${a.patient_id}'">${esc(a.full_name)}</td>
          <td class="mono">${esc(a.admission_number)}</td>
          <td>${fmtINR(a.deposits)}</td>
          <td>${fmtINR(a.charges)}</td>
          <td style="font-weight:650">${a.balanceType === 'DUE' ? fmtINR(a.amountDue) : fmtINR(a.availableBalance)}</td>
          <td>${badgeForBalance(a.balanceType)}</td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><p>No billing accounts yet. An account is created automatically the first time billing is used on an admission.</p></div>`}
      </div>
    </div>
  `;
}

// ============================= RATE MASTER =============================
async function loadRateMasterTab(container) {
  container.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
  const rates = await Api.get('/billing/rates');
  container.innerHTML = `
    <div class="page-header" style="margin-bottom:14px"><div><p class="sub" style="margin:0">Standard prices staff can reference while adding charges</p></div>
      ${canManageRates() ? `<button class="btn btn-primary btn-sm" id="add-rate-btn">${Icon.plus} Add Rate</button>` : ''}
    </div>
    <div class="card">
      <div class="table-wrap">
        ${rates.length ? `<table><thead><tr><th>Category</th><th>Service</th><th>Rate</th><th>Status</th>${canManageRates() ? '<th></th>' : ''}</tr></thead>
        <tbody>${rates.map(r => `<tr>
          <td>${esc(r.category)}</td><td>${esc(r.name)}</td>
          <td>${r.rate !== null && r.rate !== undefined ? fmtINR(r.rate) + esc(r.unit || '') : '—'}</td>
          <td><span class="badge ${r.active ? 'badge-green' : 'badge-grey'}">${r.active ? 'Active' : 'Disabled'}</span></td>
          ${canManageRates() ? `<td style="white-space:nowrap;display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" onclick="openEditRateModal(${r.id})">${Icon.edit}</button>
            <button class="btn btn-secondary btn-sm" onclick="toggleRate(${r.id})">${r.active ? 'Disable' : 'Enable'}</button>
          </td>` : ''}
        </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><p>No rates configured yet.</p></div>`}
      </div>
    </div>
  `;
  if (canManageRates()) qs('#add-rate-btn').onclick = () => openAddRateModal();
}

function openAddRateModal() {
  const { overlay, close } = openModal({
    title: 'Add Rate',
    bodyHtml: `
      <div class="form-group"><label>Category *</label>
        <select id="rt-category">${BILLING_CHARGE_CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label>Service Name *</label><input type="text" id="rt-name" placeholder="e.g. Deluxe Room"></div>
      <div class="form-row">
        <div class="form-group"><label>Rate (₹)</label><input type="number" id="rt-rate" min="0" step="0.01" placeholder="e.g. 5000"></div>
        <div class="form-group"><label>Unit (optional)</label><input type="text" id="rt-unit" placeholder="e.g. /day"></div>
      </div>
      <button class="btn btn-primary btn-block" id="rt-submit">Save Rate</button>
    `,
    onMount: (overlay) => {
      qs('#rt-submit', overlay).onclick = async () => {
        const btn = qs('#rt-submit', overlay);
        const name = qs('#rt-name', overlay).value.trim();
        if (!name) { toastError({ message: 'Service name is required' }); return; }
        btn.disabled = true; btn.textContent = 'Saving...';
        try {
          await Api.post('/billing/rates', {
            category: qs('#rt-category', overlay).value, name,
            rate: qs('#rt-rate', overlay).value, unit: qs('#rt-unit', overlay).value.trim()
          });
          toastSuccess('Rate added');
          close();
          loadRateMasterTab(qs('#billing-tab-content'));
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Save Rate'; }
      };
    }
  });
}

async function openEditRateModal(id) {
  const rates = await Api.get('/billing/rates');
  const r = rates.find(x => x.id === id);
  if (!r) return;
  const { overlay, close } = openModal({
    title: 'Edit Rate',
    bodyHtml: `
      <div class="form-group"><label>Category *</label>
        <select id="rt-category">${BILLING_CHARGE_CATEGORIES.map(c => `<option ${c === r.category ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label>Service Name *</label><input type="text" id="rt-name" value="${esc(r.name)}"></div>
      <div class="form-row">
        <div class="form-group"><label>Rate (₹)</label><input type="number" id="rt-rate" min="0" step="0.01" value="${r.rate !== null && r.rate !== undefined ? r.rate : ''}"></div>
        <div class="form-group"><label>Unit (optional)</label><input type="text" id="rt-unit" value="${esc(r.unit || '')}"></div>
      </div>
      <button class="btn btn-primary btn-block" id="rt-submit">Save Changes</button>
    `,
    onMount: (overlay) => {
      qs('#rt-submit', overlay).onclick = async () => {
        const btn = qs('#rt-submit', overlay);
        btn.disabled = true; btn.textContent = 'Saving...';
        try {
          await Api.put(`/billing/rates/${id}`, {
            category: qs('#rt-category', overlay).value, name: qs('#rt-name', overlay).value.trim(),
            rate: qs('#rt-rate', overlay).value, unit: qs('#rt-unit', overlay).value.trim()
          });
          toastSuccess('Rate updated');
          close();
          loadRateMasterTab(qs('#billing-tab-content'));
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Save Changes'; }
      };
    }
  });
}

async function toggleRate(id) {
  try {
    await Api.put(`/billing/rates/${id}/toggle`);
    toastSuccess('Rate status updated');
    loadRateMasterTab(qs('#billing-tab-content'));
  } catch (e) { toastError(e); }
}

// ============================= REUSABLE BILLING ACCOUNT PANEL =============================
// Used both on the Patient 360 "Billing" tab and inside the discharge modal.
async function renderBillingPanel(container, admissionId) {
  container.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
  let data;
  try {
    data = await Api.get(`/billing/account/by-admission/${admissionId}`);
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><p>Could not load billing account. ${esc(e.message || '')}</p></div>`;
    return;
  }

  const { account, balance, transactions, invoices } = data;
  const manage = canManageBilling();
  const balanceColor = balance.balanceType === 'DUE' ? 'var(--red)' : (balance.balanceType === 'SETTLED' ? 'var(--ink-faint)' : 'var(--green)');
  const balanceLabel = balance.balanceType === 'DUE' ? 'AMOUNT DUE' : (balance.balanceType === 'SETTLED' ? 'SETTLED' : 'AVAILABLE BALANCE');
  const balanceValue = balance.balanceType === 'DUE' ? balance.amountDue : (balance.balanceType === 'SETTLED' ? 0 : balance.availableBalance);

  container.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <h3>Account Summary</h3>
        <span class="muted" style="font-size:12px">${esc(account.account_number)} · ${esc(account.admission_number)}</span>
      </div>
      <div class="card-pad">
        ${infoRow('Advance Deposit', fmtINR(balance.deposits))}
        ${infoRow('Total Charges', fmtINR(balance.charges))}
        ${balance.payments > 0 ? infoRow('Additional Payments', fmtINR(balance.payments)) : ''}
        ${balance.refunds > 0 ? infoRow('Refunds', fmtINR(balance.refunds)) : ''}
        <div class="divider"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
          <span style="font-weight:700;font-size:14px;letter-spacing:.02em">${balanceLabel}</span>
          <span style="font-weight:800;font-size:24px;color:${balanceColor}">${fmtINR(balanceValue)}</span>
        </div>
      </div>
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px">
      ${manage ? `<button class="btn btn-primary btn-sm" id="bp-deposit">${Icon.plus} Add Deposit</button>` : ''}
      ${manage ? `<button class="btn btn-secondary btn-sm" id="bp-charge">${Icon.plus} Add Charge</button>` : ''}
      ${manage && balance.balanceType === 'DUE' ? `<button class="btn btn-danger btn-sm" id="bp-payment">${Icon.rupee} Collect Payment</button>` : ''}
      ${manage && balance.balanceType === 'CREDIT' ? `<button class="btn btn-secondary btn-sm" id="bp-refund">${Icon.wallet} Process Refund</button>` : ''}
      <button class="btn btn-secondary btn-sm" id="bp-ledger">${Icon.receipt} View Ledger</button>
      ${manage ? `<button class="btn btn-secondary btn-sm" id="bp-bill">${Icon.download} Generate Bill</button>` : ''}
    </div>

    <div class="card">
      <div class="card-header"><h3>Recent Transactions</h3></div>
      <div class="table-wrap">
        ${transactions.length ? `<table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Amount</th><th>Method</th></tr></thead>
        <tbody>${transactions.slice(0, 8).map(t => `<tr>
          <td>${fmtDateTime(t.created_at)}</td>
          <td>${txnBadge(t.type)}</td>
          <td>${esc(t.category ? t.category + ' — ' + t.description : t.description)}</td>
          <td>${fmtINR(t.amount)}</td>
          <td>${esc(t.payment_method || '-')}</td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><p>No transactions yet. Start by adding the advance deposit.</p></div>`}
      </div>
    </div>

    ${invoices.length ? `
    <div class="card" style="margin-top:16px">
      <div class="card-header"><h3>Bills Generated</h3></div>
      <div class="table-wrap">
        <table><thead><tr><th>Invoice No.</th><th>Type</th><th>Date</th><th>Total Charges</th><th>Balance</th><th></th></tr></thead>
        <tbody>${invoices.map(inv => `<tr>
          <td class="mono">${esc(inv.invoice_number)}</td>
          <td><span class="badge ${inv.type === 'Final' ? 'badge-blue' : 'badge-grey'}">${inv.type}</span></td>
          <td>${fmtDate(inv.created_at)}</td>
          <td>${fmtINR(inv.total_charges)}</td>
          <td>${badgeForBalance(inv.balance_type)} ${fmtINR(inv.balance_amount)}</td>
          <td>${inv.pdf_path ? `<a class="btn btn-secondary btn-sm" href="${Api.fileUrl(inv.pdf_path)}" target="_blank">${Icon.download}</a>` : '-'}</td>
        </tr>`).join('')}</tbody></table>
      </div>
    </div>` : ''}
  `;

  if (manage) {
    qs('#bp-deposit', container).onclick = () => openDepositModal(account.id, () => renderBillingPanel(container, admissionId));
    qs('#bp-charge', container).onclick = () => openChargeModal(account.id, () => renderBillingPanel(container, admissionId));
    const payBtn = qs('#bp-payment', container); if (payBtn) payBtn.onclick = () => openPaymentModal(account.id, balance, () => renderBillingPanel(container, admissionId));
    const refBtn = qs('#bp-refund', container); if (refBtn) refBtn.onclick = () => openRefundModal(account.id, balance, () => renderBillingPanel(container, admissionId));
    qs('#bp-bill', container).onclick = () => openGenerateBillModal(account.id);
  }
  qs('#bp-ledger', container).onclick = () => openLedgerModal(account.id, account);
}

// ---------- ADD DEPOSIT ----------
function openDepositModal(accountId, onDone) {
  const { overlay, close } = openModal({
    title: 'Add Advance Deposit',
    bodyHtml: `
      <div class="form-group"><label>Amount (₹) *</label><input type="number" id="dep-amount" min="1" step="0.01" placeholder="e.g. 100000"></div>
      <div class="form-group"><label>Payment Method *</label><select id="dep-method">${BILLING_PAYMENT_METHODS.map(m => `<option>${m}</option>`).join('')}</select></div>
      <div class="form-group"><label>Transaction Reference</label><input type="text" id="dep-ref" placeholder="e.g. UPI123456"></div>
      <div class="form-group"><label>Notes</label><textarea id="dep-notes" rows="2"></textarea></div>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="btn btn-secondary btn-block" id="dep-cancel">Cancel</button>
        <button class="btn btn-primary btn-block" id="dep-save">Save Deposit</button>
      </div>
    `,
    onMount: (overlay, close) => {
      qs('#dep-cancel', overlay).onclick = close;

      qs('#dep-save', overlay).onclick = async () => {
        const btn = qs('#dep-save', overlay);
        const amount = Number(qs('#dep-amount', overlay).value);

        if (!amount || amount <= 0) {
          toastError({ message: 'Enter a valid amount' });
          return;
        }

        btn.disabled = true;
        btn.textContent = 'Saving...';

        try {
          const res = await Api.post(`/billing/account/${accountId}/deposit`, {
            amount,
            payment_method: qs('#dep-method', overlay).value,
            reference: qs('#dep-ref', overlay).value.trim(),
            notes: qs('#dep-notes', overlay).value.trim()
          });

          toastSuccess('Deposit recorded');

          close();

          if (res.transaction && res.transaction.receipt_path) {
            window.open(Api.fileUrl(res.transaction.receipt_path), '_blank');
          }

          onDone && onDone();

        } catch (e) {
          toastError(e);
          btn.disabled = false;
          btn.textContent = 'Save Deposit';
        }
      };
    }
  });
}

// ---------- ADD CHARGE ----------
async function openChargeModal(accountId, onDone) {
  let rates = [];
  try { rates = await Api.get('/billing/rates'); } catch (e) { /* rate master optional */ }

  const { overlay, close } = openModal({
    title: 'Add Charge',
    bodyHtml: `
      <div class="form-group"><label>Category *</label>
        <select id="chg-category">${BILLING_CHARGE_CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select>
      </div>
      ${rates.length ? `<div class="form-group"><label>Quick pick from Rate Master (optional)</label>
        <select id="chg-quickpick"><option value="">— Select a service —</option>
          ${rates.filter(r => r.active).map(r => `<option value="${r.id}" data-category="${esc(r.category)}" data-name="${esc(r.name)}" data-rate="${r.rate !== null && r.rate !== undefined ? r.rate : ''}">${esc(r.category)} — ${esc(r.name)}${r.rate !== null && r.rate !== undefined ? ' (' + fmtINR(r.rate) + esc(r.unit || '') + ')' : ''}</option>`).join('')}
        </select></div>` : ''}
      <div class="form-group"><label>Description *</label><input type="text" id="chg-desc" placeholder="e.g. CBC Blood Test"></div>
      <div class="form-row">
        <div class="form-group"><label>Quantity</label><input type="number" id="chg-qty" min="0.01" step="0.01" value="1"></div>
        <div class="form-group"><label>Rate (₹) *</label><input type="number" id="chg-rate" min="0" step="0.01"></div>
      </div>
      <div class="form-group"><label>Total</label><div id="chg-total" style="font-size:19px;font-weight:750;color:var(--teal-700)">₹0</div></div>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="btn btn-secondary btn-block" id="chg-cancel">Cancel</button>
        <button class="btn btn-primary btn-block" id="chg-save">Add Charge</button>
      </div>
    `,
    onMount: (overlay,close) => {
      const qtyEl = qs('#chg-qty', overlay), rateEl = qs('#chg-rate', overlay), totalEl = qs('#chg-total', overlay);
      function recalc() { totalEl.textContent = fmtINR((Number(qtyEl.value) || 0) * (Number(rateEl.value) || 0)); }
      qtyEl.addEventListener('input', recalc);
      rateEl.addEventListener('input', recalc);
      const qp = qs('#chg-quickpick', overlay);
      if (qp) qp.addEventListener('change', () => {
        const opt = qp.selectedOptions[0];
        if (!opt || !opt.value) return;
        qs('#chg-category', overlay).value = opt.dataset.category;
        qs('#chg-desc', overlay).value = opt.dataset.name;
        if (opt.dataset.rate) rateEl.value = opt.dataset.rate;
        recalc();
      });
      qs('#chg-cancel', overlay).onclick = close;
      qs('#chg-save', overlay).onclick = async () => {
        const btn = qs('#chg-save', overlay);
        const description = qs('#chg-desc', overlay).value.trim();
        const rate = Number(rateEl.value);
        if (!description) { toastError({ message: 'Description is required' }); return; }
        if (!rate || rate <= 0) { toastError({ message: 'Enter a valid rate' }); return; }
        btn.disabled = true; btn.textContent = 'Adding...';
        try {
          await Api.post(`/billing/account/${accountId}/charge`, {
            category: qs('#chg-category', overlay).value, description,
            quantity: Number(qtyEl.value) || 1, rate
          });
          toastSuccess('Charge added');
          close();
          onDone && onDone();
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Add Charge'; }
      };
    }
  });
}

// ---------- COLLECT ADDITIONAL PAYMENT ----------
function openPaymentModal(accountId, balance, onDone) {
  const { overlay, close } = openModal({
    title: 'Collect Payment',
    bodyHtml: `
      <p class="hint" style="margin-bottom:14px;font-size:13px">Amount Due: <b style="color:var(--red)">${fmtINR(balance.amountDue)}</b></p>
      <div class="form-group"><label>Amount (₹) *</label><input type="number" id="pay-amount" min="1" step="0.01" value="${balance.amountDue}"></div>
      <div class="form-group"><label>Payment Method *</label><select id="pay-method">${BILLING_PAYMENT_METHODS.map(m => `<option>${m}</option>`).join('')}</select></div>
      <div class="form-group"><label>Transaction Reference</label><input type="text" id="pay-ref"></div>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="btn btn-secondary btn-block" id="pay-cancel">Cancel</button>
        <button class="btn btn-primary btn-block" id="pay-save">Collect Payment</button>
      </div>
    `,
    onMount: (overlay, close) => {
      qs('#pay-cancel', overlay).onclick = close;
      qs('#pay-save', overlay).onclick = async () => {
        const btn = qs('#pay-save', overlay);
        const amount = Number(qs('#pay-amount', overlay).value);
        if (!amount || amount <= 0) { toastError({ message: 'Enter a valid amount' }); return; }
        btn.disabled = true; btn.textContent = 'Processing...';
        try {
          const res = await Api.post(`/billing/account/${accountId}/payment`, {
            amount, payment_method: qs('#pay-method', overlay).value, reference: qs('#pay-ref', overlay).value.trim()
          });
          toastSuccess('Payment collected');
          close();
          if (res.transaction && res.transaction.receipt_path) window.open(Api.fileUrl(res.transaction.receipt_path), '_blank');
          onDone && onDone();
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Collect Payment'; }
      };
    }
  });
}

// ---------- PROCESS REFUND ----------
function openRefundModal(accountId, balance, onDone) {
  const { overlay, close } = openModal({
    title: 'Process Refund',
    bodyHtml: `
      <p class="hint" style="margin-bottom:14px;font-size:13px">Refundable Balance: <b style="color:var(--green)">${fmtINR(balance.availableBalance)}</b></p>
      <div class="form-group"><label>Refund Amount (₹) *</label><input type="number" id="ref-amount" min="1" max="${balance.availableBalance}" step="0.01" value="${balance.availableBalance}"></div>
      <div class="form-group"><label>Refund Method *</label><select id="ref-method">${BILLING_PAYMENT_METHODS.map(m => `<option>${m}</option>`).join('')}</select></div>
      <div class="form-group"><label>Transaction Reference</label><input type="text" id="ref-ref"></div>
      <div class="form-group"><label>Reason</label><textarea id="ref-reason" rows="2" placeholder="e.g. Unused deposit balance at discharge"></textarea></div>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="btn btn-secondary btn-block" id="ref-cancel">Cancel</button>
        <button class="btn btn-primary btn-block" id="ref-save">Process Refund</button>
      </div>
    `,
    onMount: (overlay, close) => {
      qs('#ref-cancel', overlay).onclick = close;
      qs('#ref-save', overlay).onclick = async () => {
        const btn = qs('#ref-save', overlay);
        const amount = Number(qs('#ref-amount', overlay).value);
        if (!amount || amount <= 0) { toastError({ message: 'Enter a valid amount' }); return; }
        const ok = await confirmDialog(`Process a refund of ${fmtINR(amount)}? This cannot be undone.`);
        if (!ok) return;
        btn.disabled = true; btn.textContent = 'Processing...';
        try {
          const res = await Api.post(`/billing/account/${accountId}/refund`, {
            amount, payment_method: qs('#ref-method', overlay).value,
            reference: qs('#ref-ref', overlay).value.trim(), reason: qs('#ref-reason', overlay).value.trim()
          });
          toastSuccess('Refund processed');
          close();
          if (res.transaction && res.transaction.receipt_path) window.open(Api.fileUrl(res.transaction.receipt_path), '_blank');
          onDone && onDone();
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Process Refund'; }
      };
    }
  });
}

// ---------- VIEW LEDGER ----------
function openLedgerModal(accountId, account) {
  openModal({
    title: `Billing Ledger — ${account.account_number}`,
    size: 'lg',
    bodyHtml: `<div class="loading-spin"><div class="spinner"></div></div>`,
    onMount: async (overlay) => {
      let data;
      try { data = await Api.get(`/billing/account/${accountId}/ledger`); }
      catch (e) { qs('.modal-body', overlay).innerHTML = `<div class="empty-state"><p>Could not load ledger.</p></div>`; return; }
      const rows = data.ledger;
      qs('.modal-body', overlay).innerHTML = rows.length ? `
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
        <tbody>${rows.map(r => {
          const isCredit = r.type === 'DEPOSIT' || r.type === 'PAYMENT';
          return `<tr>
            <td>${fmtDate(r.created_at)}</td>
            <td>${txnBadge(r.type)}</td>
            <td>${esc(r.category ? r.category + ' — ' + r.description : r.description)}</td>
            <td>${isCredit ? '—' : fmtINR(r.amount)}</td>
            <td>${isCredit ? fmtINR(r.amount) : '—'}</td>
            <td style="font-weight:650">${fmtINR(r.runningBalance)}</td>
          </tr>`;
        }).join('')}</tbody></table></div>
      ` : `<div class="empty-state"><p>No transactions recorded yet.</p></div>`;
    }
  });
}

// ---------- GENERATE BILL ----------
function openGenerateBillModal(accountId) {
  const { overlay, close } = openModal({
    title: 'Generate Bill',
    bodyHtml: `
      <div class="form-group"><label>Bill Type</label>
        <select id="bill-type">
          <option value="Interim">Interim Bill — does not close the billing account</option>
          <option value="Final">Final Bill — for discharge / settlement</option>
        </select>
      </div>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="btn btn-secondary btn-block" id="bill-cancel">Cancel</button>
        <button class="btn btn-primary btn-block" id="bill-save">Generate &amp; Download</button>
      </div>
    `,
    onMount: (overlay,close) => {
      qs('#bill-cancel', overlay).onclick = close;
      qs('#bill-save', overlay).onclick = async () => {
        const btn = qs('#bill-save', overlay);
        btn.disabled = true; btn.textContent = 'Generating...';
        try {
          const res = await Api.post(`/billing/account/${accountId}/invoice`, { type: qs('#bill-type', overlay).value });
          toastSuccess('Bill generated');
          close();
          window.open(Api.fileUrl(res.pdf), '_blank');
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Generate & Download'; }
      };
    }
  });
}

// ============================= PATIENT 360 "BILLING" TAB =============================
function renderBillingTab(container, data) {
  const admissions = data.admissions || [];
  if (!admissions.length) {
    container.innerHTML = `<div class="card card-pad"><div class="empty-state"><p>No admissions yet. A billing account is created automatically once the patient is admitted.</p></div></div>`;
    return;
  }
  const defaultAdm = data.activeAdmission ? data.activeAdmission.id : admissions[0].id;
  container.innerHTML = `
    ${admissions.length > 1 ? `
      <div class="form-group" style="max-width:380px;margin-bottom:16px">
        <label>Admission</label>
        <select id="billing-admission-select">
          ${admissions.map(a => `<option value="${a.id}" ${a.id === defaultAdm ? 'selected' : ''}>${esc(a.admission_number)} — ${esc(a.status)} (${fmtDate(a.admitted_at)})</option>`).join('')}
        </select>
      </div>` : ''}
    <div id="billing-panel-wrap"></div>
  `;
  const panelWrap = qs('#billing-panel-wrap');
  renderBillingPanel(panelWrap, defaultAdm);
  const sel = qs('#billing-admission-select');
  if (sel) sel.addEventListener('change', () => renderBillingPanel(panelWrap, Number(sel.value)));
}
