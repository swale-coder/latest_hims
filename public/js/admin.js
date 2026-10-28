// ---------------- shared UI helpers (kept self-contained rather than importing the
// hospital app's app.js, which carries hospital-only routing/role logic this page must
// never load) ----------------
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function esc(s) { return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtDate(d) { if (!d) return '-'; try { return new Date(d.replace(' ', 'T')).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch(e) { return d; } }
function fmtDateTime(d) { if (!d) return '-'; try { return new Date(d.replace(' ', 'T')).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch(e) { return d; } }
function fmtINR(n) { const num = Number(n) || 0; return '\u20b9' + num.toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function fmtBytes(n) { const num = Number(n) || 0; if (num < 1024) return num + ' B'; if (num < 1048576) return (num/1024).toFixed(1) + ' KB'; if (num < 1073741824) return (num/1048576).toFixed(1) + ' MB'; return (num/1073741824).toFixed(2) + ' GB'; }
function toast(msg, type) {
  let wrap = qs('.toast-wrap');
  if (!wrap) { wrap = el('<div class="toast-wrap"></div>'); document.body.appendChild(wrap); }
  const t = el(`<div class="toast ${type || ''}">${esc(msg)}</div>`);
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}
function openModal({ title, bodyHtml, onMount }) {
  const overlay = el(`<div class="modal-overlay">
    <div class="modal modal-lg">
      <div class="modal-header"><h3>${esc(title)}</h3><button class="modal-close">&times;</button></div>
      <div class="modal-body">${bodyHtml}</div>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  if (onMount) onMount(overlay, close);
  return { overlay, close };
}
const STATUS_BADGE = { trial: 'badge-blue', active: 'badge-green', payment_due: 'badge-amber', grace_period: 'badge-amber', suspended: 'badge-red', cancelled: 'badge-grey', expired: 'badge-grey' };
function statusBadge(status) { return `<span class="badge ${STATUS_BADGE[status] || 'badge-grey'}">${esc((status || '-').replace('_', ' '))}</span>`; }

// ---------------- API ----------------
const AdminApi = {
  token: localStorage.getItem('aiventra_admin_token'),
  async call(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      if (res.status === 401) { logout(); }
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }
    return data;
  },
  get(path) { return this.call('GET', path); },
  post(path, body) { return this.call('POST', path, body); },
  put(path, body) { return this.call('PUT', path, body); }
};

function logout() {
  localStorage.removeItem('aiventra_admin_token');
  AdminApi.token = null;
  render();
}

// ---------------- LOGIN ----------------
function renderLogin(root) {
  root.innerHTML = `
    <div class="admin-topbar"><div class="brand"><span class="dot"></span>Aiventra Admin Control Center</div></div>
    <div class="login-shell card card-pad">
      <h2 style="margin-bottom:4px">Platform Sign In</h2>
      <p class="hint" style="margin-bottom:18px">For Aiventra staff only. Hospital accounts cannot sign in here.</p>
      <form id="login-form">
        <label style="font-size:12.5px;font-weight:600;color:var(--ink-faint)">Username</label>
        <input type="text" id="login-username" required style="margin:4px 0 12px">
        <label style="font-size:12.5px;font-weight:600;color:var(--ink-faint)">Password</label>
        <input type="password" id="login-password" required style="margin:4px 0 16px">
        <button class="btn btn-primary btn-block" type="submit">Sign In</button>
      </form>
      <p id="login-error" class="hint" style="color:var(--red);margin-top:10px;display:none"></p>
    </div>`;

  qs('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = qs('#login-error');
    errBox.style.display = 'none';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: qs('#login-username').value, password: qs('#login-password').value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      if (data.user.role !== 'aiventra_super_admin') throw new Error('This login is for Aiventra platform staff only.');
      localStorage.setItem('aiventra_admin_token', data.token);
      AdminApi.token = data.token;
      render();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  });
}

// ---------------- SHELL + TABS ----------------
const TABS = [
  { id: 'organizations', label: 'Organizations' },
  { id: 'plans', label: 'Plans' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'support', label: 'Support Access' }
];
let activeTab = 'organizations';

function renderShell(root) {
  root.innerHTML = `
    <div class="admin-topbar">
      <div class="brand"><span class="dot"></span>Aiventra Admin Control Center</div>
      <button class="btn btn-secondary btn-sm" id="logout-btn">Sign Out</button>
    </div>
    <div class="admin-shell">
      <div class="tabs">${TABS.map(t => `<button class="tab-btn ${t.id === activeTab ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}</div>
      <div id="tab-content"></div>
    </div>`;

  qs('#logout-btn').onclick = logout;
  qsa('[data-tab]').forEach(btn => { btn.onclick = () => { activeTab = btn.dataset.tab; renderShell(root); }; });

  const content = qs('#tab-content');
  if (activeTab === 'organizations') renderOrganizations(content);
  if (activeTab === 'plans') renderPlans(content);
  if (activeTab === 'analytics') renderAnalytics(content);
  if (activeTab === 'support') renderSupport(content);
}

// ---------------- ORGANIZATIONS ----------------
async function renderOrganizations(content) {
  content.innerHTML = `<div class="card">
    <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
      <h3>Organizations</h3>
      <button class="btn btn-primary btn-sm" id="create-hospital-btn">+ Create Hospital</button>
    </div>
    <div class="card-pad" style="padding-bottom:0">
      <div class="filter-bar">
        <input type="text" id="org-search" placeholder="Search by name, slug, or email...">
        <select id="org-status-filter">
          <option value="">All statuses</option>
          <option value="trial">Trial</option><option value="active">Active</option>
          <option value="payment_due">Payment Due</option><option value="grace_period">Grace Period</option>
          <option value="suspended">Suspended</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option>
        </select>
      </div>
    </div>
    <div class="table-wrap"><table class="admin-table">
      <thead><tr><th>Hospital</th><th>Status</th><th>Plan</th><th>Users</th><th>Patients</th><th>Signed Up</th></tr></thead>
      <tbody id="org-rows"><tr><td colspan="6">Loading...</td></tr></tbody>
    </table></div>
  </div>`;

  async function load() {
    const q = qs('#org-search').value.trim();
    const status = qs('#org-status-filter').value;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    const orgs = await AdminApi.get(`/platform/organizations?${params}`);
    qs('#org-rows').innerHTML = orgs.length ? orgs.map(o => `
      <tr data-id="${o.id}">
        <td><strong>${esc(o.name)}</strong><div class="hint">${esc(o.slug)} &middot; ${esc(o.city || '')}</div></td>
        <td>${statusBadge(o.status)}</td>
        <td>${esc(o.plan_name || '-')}</td>
        <td>${o.active_users}</td>
        <td>${o.patient_count}</td>
        <td>${fmtDate(o.created_at)}</td>
      </tr>`).join('') : '<tr><td colspan="6">No organizations found.</td></tr>';
    qsa('tr[data-id]', qs('#org-rows')).forEach(row => { row.onclick = () => openOrgDetail(row.dataset.id); });
  }

  qs('#org-search').addEventListener('input', debounce(load, 300));
  qs('#org-status-filter').addEventListener('change', load);
  qs('#create-hospital-btn').onclick = () => openCreateHospitalModal(load);
  load();
}

// Tenant onboarding: create a brand-new hospital + owner account, with the resulting
// /hms/<slug> URL and login credentials shown once so they can be handed off. No code
// change, new route, or redeployment is ever needed for this - see docs/tenant-isolation.md.
function openCreateHospitalModal(onCreated) {
  let slugTouched = false;
  const { close } = openModal({
    title: 'Create Hospital',
    bodyHtml: `
      <div class="field-row">
        <div><label>Hospital Name</label><input type="text" id="ch-name" placeholder="e.g. ABC Hospital"></div>
        <div><label>Slug (used in the login URL)</label><input type="text" id="ch-slug" placeholder="e.g. abc-hospital"></div>
      </div>
      <p class="hint" id="ch-slug-preview" style="margin:-4px 0 12px">Login URL will be: <code>/hms/…</code></p>
      <div class="field-row">
        <div><label>Type</label>
          <select id="ch-type"><option>Hospital</option><option>Clinic</option><option>Nursing Home</option></select>
        </div>
        <div><label>Logo URL (optional)</label><input type="text" id="ch-logo" placeholder="https://..."></div>
      </div>
      <div class="field-row">
        <div><label>City</label><input type="text" id="ch-city"></div>
        <div><label>State</label><input type="text" id="ch-state"></div>
      </div>
      <div class="section-title">Hospital Owner Account</div>
      <div class="field-row">
        <div><label>Owner Name</label><input type="text" id="ch-owner-name"></div>
        <div><label>Owner Email (login username)</label><input type="text" id="ch-owner-email" placeholder="owner@hospital.example"></div>
      </div>
      <div><label>Initial Password (leave blank to auto-generate)</label><input type="text" id="ch-owner-password" placeholder="Min 8 chars, 1 letter + 1 number"></div>
      <p id="ch-error" class="hint" style="color:var(--red);display:none;margin-top:10px"></p>
      <button class="btn btn-primary btn-block" id="ch-submit" style="margin-top:16px">Create Hospital</button>
    `,
    onMount: (overlay) => {
      const nameInput = qs('#ch-name', overlay);
      const slugInput = qs('#ch-slug', overlay);
      const preview = qs('#ch-slug-preview', overlay);
      const updatePreview = () => { preview.innerHTML = `Login URL will be: <code>/hms/${esc(slugInput.value.trim() || '…')}</code>`; };
      nameInput.addEventListener('input', () => {
        if (!slugTouched) slugInput.value = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        updatePreview();
      });
      slugInput.addEventListener('input', () => { slugTouched = true; updatePreview(); });

      qs('#ch-submit', overlay).onclick = async () => {
        const errBox = qs('#ch-error', overlay);
        errBox.style.display = 'none';
        const body = {
          hospital_name: nameInput.value.trim(),
          slug: slugInput.value.trim(),
          org_type: qs('#ch-type', overlay).value,
          logo_url: qs('#ch-logo', overlay).value.trim() || undefined,
          city: qs('#ch-city', overlay).value.trim() || undefined,
          state: qs('#ch-state', overlay).value.trim() || undefined,
          owner_name: qs('#ch-owner-name', overlay).value.trim(),
          owner_email: qs('#ch-owner-email', overlay).value.trim(),
          owner_password: qs('#ch-owner-password', overlay).value.trim() || undefined
        };
        if (!body.hospital_name || !body.owner_name || !body.owner_email) {
          errBox.textContent = 'Hospital name, owner name and owner email are required.';
          errBox.style.display = 'block';
          return;
        }
        try {
          const result = await AdminApi.post('/platform/organizations', body);
          close();
          showHospitalCreatedModal(result);
          onCreated();
        } catch (e) {
          errBox.textContent = e.message;
          errBox.style.display = 'block';
        }
      };
    }
  });
}

function showHospitalCreatedModal(result) {
  const loginUrl = `${window.location.origin}${result.organization.url}`;
  openModal({
    title: 'Hospital Created',
    bodyHtml: `
      <p class="hint">This hospital is live immediately - no code change or redeployment was needed.</p>
      <div class="section-title">Login URL</div>
      <p><code>${esc(loginUrl)}</code></p>
      <div class="section-title">Owner Credentials</div>
      <p><strong>Username:</strong> ${esc(result.owner.username)}</p>
      ${result.temporaryPassword
        ? `<p><strong>Temporary Password:</strong> <code>${esc(result.temporaryPassword)}</code></p>
           <p class="hint" style="color:var(--red)">Copy this now - it will not be shown again. Share it with the hospital securely.</p>`
        : `<p class="hint">The password you set is now active for this account.</p>`}
    `
  });
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function openOrgDetail(id) {
  const data = await AdminApi.get(`/platform/organizations/${id}`);
  const { organization: org, subscription, users, stats, paymentHistory, supportTickets } = data;

  const { close } = openModal({
    title: org.name,
    bodyHtml: `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${statusBadge(org.status)}
        <span class="badge badge-grey">${esc(org.org_type)}</span>
        <span class="badge badge-grey">${esc(org.slug)}</span>
      </div>

      <div class="stat-grid" style="margin-bottom:18px">
        <div class="stat-card"><div class="label">Patients</div><div class="value">${stats.patients}</div></div>
        <div class="stat-card"><div class="label">Admissions</div><div class="value">${stats.admissions}</div></div>
        <div class="stat-card"><div class="label">OPD (this month)</div><div class="value">${stats.opdThisMonth}</div></div>
        <div class="stat-card"><div class="label">Storage Used</div><div class="value" style="font-size:18px">${fmtBytes(stats.storageBytes)}</div></div>
      </div>

      <p><strong>Subscription:</strong> ${subscription ? `${esc(subscription.plan_name)} (${esc(subscription.billing_cycle)}) - ${statusBadge(subscription.status)}` : 'No subscription yet'}</p>
      <p><strong>Contact:</strong> ${esc(org.contact_email || '-')} &middot; ${esc(org.contact_phone || '-')}</p>
      <p><strong>Onboarding:</strong> ${org.onboarding_completed ? 'Completed' : 'In progress (' + esc(org.onboarding_step) + ')'}</p>

      <div class="section-title">Status control</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <button class="btn btn-secondary btn-sm" data-status="active">Activate</button>
        <button class="btn btn-secondary btn-sm" data-status="suspended">Suspend</button>
        <button class="btn btn-secondary btn-sm" data-status="cancelled">Cancel</button>
      </div>

      <div class="section-title">Internal notes (Aiventra staff only, never shown to the hospital)</div>
      <textarea id="org-notes" style="width:100%;margin-bottom:8px">${esc(org.internal_notes || '')}</textarea>
      <button class="btn btn-secondary btn-sm" id="save-notes">Save Notes</button>

      <div class="section-title">Staff (${users.length})</div>
      <div class="table-wrap"><table class="admin-table">
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Active</th></tr></thead>
        <tbody>${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.role.replace('_',' '))}</td><td>${u.active ? 'Yes' : 'No'}</td></tr>`).join('') || '<tr><td colspan="4">No staff yet</td></tr>'}</tbody>
      </table></div>

      <div class="section-title">Support access</div>
      <button class="btn btn-secondary btn-sm" id="request-access">Request Support Access</button>
      <p class="hint" style="margin-top:6px">Access to this hospital's files/data requires the hospital's own admin to approve your request, and always expires automatically.</p>

      <div class="section-title">Support tickets (${supportTickets.length})</div>
      ${supportTickets.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Subject</th><th>Priority</th><th>Status</th><th>Raised</th></tr></thead>
      <tbody>${supportTickets.map(t => `<tr><td>${esc(t.subject)}</td><td>${esc(t.priority)}</td><td>${esc(t.status)}</td><td>${fmtDate(t.created_at)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="hint">No tickets raised.</p>'}
    `,
    onMount: (overlay) => {
      qsa('[data-status]', overlay).forEach(btn => {
        btn.onclick = async () => {
          const status = btn.dataset.status;
          let reason = null;
          if (status === 'suspended') reason = prompt('Reason for suspending this organization?') || '';
          try {
            await AdminApi.put(`/platform/organizations/${org.id}/status`, { status, reason });
            toast(`Organization ${status}`, 'success');
            close();
            renderShell(qs('#root'));
          } catch (e) { toast(e.message, 'error'); }
        };
      });
      qs('#save-notes', overlay).onclick = async () => {
        try {
          await AdminApi.put(`/platform/organizations/${org.id}/notes`, { notes: qs('#org-notes', overlay).value });
          toast('Notes saved', 'success');
        } catch (e) { toast(e.message, 'error'); }
      };
      qs('#request-access', overlay).onclick = async () => {
        const reason = prompt('Why do you need access to this hospital\'s data? (shown to the hospital admin for approval)');
        if (reason === null) return;
        try {
          await AdminApi.post(`/platform/support-access/${org.id}/request`, { reason });
          toast('Access request sent - waiting for hospital approval', 'success');
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}

// ---------------- PLANS ----------------
async function renderPlans(content) {
  content.innerHTML = `<div class="card">
    <div class="card-header"><h3>Plans</h3><p>Editable pricing - changes apply to new subscriptions immediately</p></div>
    <div class="table-wrap"><table class="admin-table">
      <thead><tr><th>Plan</th><th>Monthly</th><th>Annual</th><th>Setup Fee</th><th>GST</th><th>Status</th><th></th></tr></thead>
      <tbody id="plan-rows"><tr><td colspan="7">Loading...</td></tr></tbody>
    </table></div>
  </div>`;

  async function load() {
    const plans = await AdminApi.get('/platform/plans');
    qs('#plan-rows').innerHTML = plans.map(p => `
      <tr>
        <td><strong>${esc(p.name)}</strong><div class="hint">${esc(p.code)}</div></td>
        <td>${fmtINR(p.monthly_price)}</td>
        <td>${fmtINR(p.annual_price)}</td>
        <td>${fmtINR(p.installation_fee)}</td>
        <td>${p.gst_percent}%</td>
        <td><span class="badge ${p.active ? 'badge-green' : 'badge-grey'}">${p.active ? 'Active' : 'Inactive'}</span></td>
        <td style="white-space:nowrap">
          <button class="btn btn-secondary btn-sm" data-edit="${p.id}">Edit</button>
          <button class="btn btn-secondary btn-sm" data-toggle="${p.id}">${p.active ? 'Deactivate' : 'Activate'}</button>
        </td>
      </tr>`).join('');

    qsa('[data-edit]').forEach(btn => { btn.onclick = () => openPlanEditor(plans.find(p => p.id == btn.dataset.edit), load); });
    qsa('[data-toggle]').forEach(btn => {
      btn.onclick = async () => {
        try { await AdminApi.put(`/platform/plans/${btn.dataset.toggle}/toggle`, {}); toast('Plan updated', 'success'); load(); }
        catch (e) { toast(e.message, 'error'); }
      };
    });
  }
  load();
}

function openPlanEditor(plan, onSaved) {
  const { close } = openModal({
    title: `Edit ${plan.name}`,
    bodyHtml: `
      <div class="field-row">
        <div><label>Monthly Price (INR)</label><input type="number" id="p-monthly" value="${plan.monthly_price}"></div>
        <div><label>Annual Price (INR)</label><input type="number" id="p-annual" value="${plan.annual_price}"></div>
      </div>
      <div class="field-row">
        <div><label>Installation Fee (INR)</label><input type="number" id="p-install" value="${plan.installation_fee}"></div>
        <div><label>GST %</label><input type="number" id="p-gst" value="${plan.gst_percent}"></div>
      </div>
      <div class="field-row">
        <div><label>Bed Limit (blank = unlimited)</label><input type="number" id="p-beds" value="${plan.bed_limit ?? ''}"></div>
        <div><label>User Limit (blank = unlimited)</label><input type="number" id="p-users" value="${plan.user_limit ?? ''}"></div>
      </div>
      <div class="field-row">
        <div><label>OPD/month Limit (blank = unlimited)</label><input type="number" id="p-opd" value="${plan.opd_limit ?? ''}"></div>
        <div><label>Trial Days</label><input type="number" id="p-trial" value="${plan.trial_days}"></div>
      </div>
      <button class="btn btn-primary btn-block" id="save-plan">Save Changes</button>
    `,
    onMount: (overlay) => {
      qs('#save-plan', overlay).onclick = async () => {
        const val = (id) => { const v = qs(id, overlay).value; return v === '' ? null : Number(v); };
        try {
          await AdminApi.put(`/platform/plans/${plan.id}`, {
            monthly_price: val('#p-monthly'), annual_price: val('#p-annual'),
            installation_fee: val('#p-install'), gst_percent: val('#p-gst'),
            bed_limit: val('#p-beds'), user_limit: val('#p-users'), opd_limit: val('#p-opd'),
            trial_days: val('#p-trial')
          });
          toast('Plan saved', 'success');
          close();
          onSaved();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}

// ---------------- ANALYTICS ----------------
async function renderAnalytics(content) {
  content.innerHTML = '<div class="card card-pad">Loading...</div>';
  const a = await AdminApi.get('/platform/analytics');
  const cards = [
    ['Total Organizations', a.totalOrganizations],
    ['Trial Organizations', a.trialOrganizations],
    ['Active Subscriptions', a.activeSubscriptions],
    ['Monthly Recurring Revenue', fmtINR(a.mrr)],
    ['New Signups (30d)', a.newSignups30d],
    ['Active Users (platform-wide)', a.activeUsers],
    ['OPD Registrations (this month)', a.opdThisMonth],
    ['Failed Payments (30d)', a.failedPayments30d],
    ['Pending Onboarding', a.pendingOnboarding],
    ['Open Support Tickets', a.openSupportTickets],
    ['Total Storage Used', fmtBytes(a.totalStorageBytes)]
  ];
  content.innerHTML = `<div class="stat-grid">${cards.map(([label, value]) => `
    <div class="stat-card"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>
  `).join('')}</div>`;
}

// ---------------- SUPPORT ACCESS ----------------
async function renderSupport(content) {
  content.innerHTML = `<div class="card">
    <div class="card-header"><h3>Support Access Requests</h3><p>Every access to a hospital's data requires their explicit approval and expires automatically</p></div>
    <div class="table-wrap"><table class="admin-table">
      <thead><tr><th>Hospital</th><th>Status</th><th>Reason</th><th>Approved By</th><th>Expires</th><th>Requested</th></tr></thead>
      <tbody id="support-rows"><tr><td colspan="6">Loading...</td></tr></tbody>
    </table></div>
  </div>`;
  const rows = await AdminApi.get('/platform/support-access');
  qs('#support-rows').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${esc(r.organization_name)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${esc(r.reason || '-')}</td>
      <td>${esc(r.approved_by_name || '-')}</td>
      <td>${r.expires_at ? fmtDateTime(r.expires_at) : '-'}</td>
      <td>${fmtDateTime(r.created_at)}</td>
    </tr>`).join('') : '<tr><td colspan="6">No support access requests yet.</td></tr>';
}

// ---------------- BOOT ----------------
function render() {
  const root = qs('#root');
  if (!AdminApi.token) renderLogin(root);
  else renderShell(root);
}
render();
