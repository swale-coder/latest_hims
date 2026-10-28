// ============================= UI HELPERS =============================
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function esc(s) { return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtDate(d) { if (!d) return '-'; try { return new Date(d.replace(' ', 'T')).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch(e) { return d; } }
function fmtDateTime(d) { if (!d) return '-'; try { return new Date(d.replace(' ', 'T')).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute:'2-digit' }); } catch(e) { return d; } }
function fmtTimeAgo(d) {
  if (!d) return '-';
  const diff = Date.now() - new Date(d.replace(' ', 'T')).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
function fmtINR(n) {
  const num = Number(n) || 0;
  return '₹' + num.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: num % 1 !== 0 ? 2 : 0 });
}
function badgeForBalance(balanceType) {
  const map = { CREDIT: 'badge-green', DUE: 'badge-red', SETTLED: 'badge-grey' };
  const label = { CREDIT: 'CREDIT', DUE: 'DUE', SETTLED: 'SETTLED' };
  return `<span class="badge ${map[balanceType] || 'badge-grey'}">${label[balanceType] || balanceType}</span>`;
}
function initials(name) {
  if (!name) return '?';
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function toast(msg, type) {
  let wrap = qs('.toast-wrap');
  if (!wrap) { wrap = el(`<div class="toast-wrap"></div>`); document.body.appendChild(wrap); }
  const t = el(`<div class="toast ${type || ''}">${esc(msg)}</div>`);
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}
function toastError(e) { toast(e && e.message ? e.message : 'Something went wrong', 'error'); }
function toastSuccess(msg) { toast(msg, 'success'); }

let activeModalCloseHandlers = [];
function openModal({ title, bodyHtml, size, onMount }) {
  const overlay = el(`<div class="modal-overlay">
    <div class="modal ${size === 'lg' ? 'modal-lg' : ''}">
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

function confirmDialog(message) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title: 'Please confirm',
      bodyHtml: `<p style="font-size:13.5px;color:var(--ink-soft)">${esc(message)}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
          <button class="btn btn-secondary" id="cd-cancel">Cancel</button>
          <button class="btn btn-danger" id="cd-ok">Confirm</button>
        </div>`,
      onMount: (overlay) => {
        overlay.querySelector('#cd-cancel').onclick = () => { close(); resolve(false); };
        overlay.querySelector('#cd-ok').onclick = () => { close(); resolve(true); };
      }
    });
  });
}

function badgeForBedStatus(status) {
  const map = { Available: 'badge-green', Occupied: 'badge-red', Cleaning: 'badge-amber', Maintenance: 'badge-grey', Reserved: 'badge-blue' };
  return `<span class="badge ${map[status] || 'badge-grey'}"><span class="badge-dot"></span>${status}</span>`;
}
function badgeForOpdStatus(status) {
  const map = { Waiting: 'badge-amber', 'In Consultation': 'badge-blue', Completed: 'badge-green', Cancelled: 'badge-grey' };
  return `<span class="badge ${map[status] || 'badge-grey'}">${status}</span>`;
}

// ============================= NAVIGATION CONFIG =============================
const NAV_ITEMS = [
  { hash: '#/dashboard', label: 'Dashboard', icon: 'dashboard', roles: null },
  { hash: '#/patients', label: 'Patients', icon: 'patients', roles: null },
  { hash: '#/opd', label: 'OPD', icon: 'opd', roles: null },
  { hash: '#/admissions', label: 'Admissions', icon: 'admissions', roles: null },
  { hash: '#/beds', label: 'Beds', icon: 'beds', roles: null },
  { hash: '#/consultation', label: 'Consultation', icon: 'clinical', roles: ['doctor'] },
  { hash: '#/lab', label: 'Lab', icon: 'lab', roles: ['lab_staff', 'doctor', 'hospital_admin', 'organization_owner'] },
  { hash: '#/surgery', label: 'Surgery', icon: 'surgery', roles: ['doctor', 'hospital_admin', 'organization_owner'] },
  { hash: '#/discharge', label: 'Discharge', icon: 'discharge', roles: null },
  { hash: '#/billing', label: 'Billing', icon: 'billing', roles: null },
  { hash: '#/reports', label: 'Reports', icon: 'reports', roles: ['hospital_admin', 'organization_owner', 'report_viewer', 'accountant', 'doctor'] },
  { hash: '#/ai', label: 'Ask AI', icon: 'ai', roles: ['hospital_admin', 'organization_owner', 'doctor'] },
  { hash: '#/administration', label: 'Administration', icon: 'admin', roles: ['hospital_admin', 'organization_owner'] },
  { hash: '#/subscription', label: 'Subscription', icon: 'billing', roles: ['organization_owner', 'hospital_admin'] },
  { hash: '#/onboarding', label: 'Setup Checklist', icon: 'settings', roles: ['organization_owner', 'hospital_admin'] },
  { hash: '#/settings', label: 'Settings', icon: 'settings', roles: ['hospital_admin', 'organization_owner'] },
];

function canSee(item) {
  if (!item.roles) return true;
  return item.roles.includes(Api.user.role);
}

// ============================= APP SHELL =============================
function renderShell() {
  const app = qs('#app');
  app.innerHTML = '';
  const user = Api.user;

  const sidebar = el(`
    <div class="sidebar" id="sidebar">
      <div class="sidebar-brand">
        <div class="sidebar-brand-mark">${initials(user.organization_name || 'Aiventra HMS')}</div>
        <div class="sidebar-brand-text"><b>${esc(user.organization_name || 'Hospital Management System')}</b><span>Hospital Management</span></div>
      </div>
      <div class="sidebar-nav" id="sidebar-nav"></div>
      <div class="sidebar-footer">
        <div class="sidebar-user-avatar">${initials(user.name)}</div>
        <div class="sidebar-user-meta"><b>${esc(user.name)}</b><span>${esc(user.role.replace('_',' '))}</span></div>
        <button class="logout-btn" id="logout-btn" title="Log out">${Icon.logout}</button>
      </div>
    </div>
  `);
  const nav = sidebar.querySelector('#sidebar-nav');
  NAV_ITEMS.filter(canSee).forEach(item => {
    const div = el(`<div class="nav-item" data-hash="${item.hash}">${Icon[item.icon]}<span>${item.label}</span></div>`);
    div.onclick = () => { window.location.hash = item.hash; closeMobileNav(); };
    nav.appendChild(div);
  });

  const main = el(`
    <div class="main">
      <div class="topbar">
        <div style="display:flex;align-items:center;gap:14px">
          <button class="icon-btn mobile-nav-toggle" id="mobile-nav-toggle">${Icon.menu}</button>
          <div class="topbar-title" id="topbar-title">Dashboard</div>
        </div>
        <div class="topbar-actions">
          <div class="global-search" id="global-search">
            <div style="position:relative">
              ${Icon.search}
              <input type="text" id="global-search-input" placeholder="Search Patient ID, name, mobile...">
            </div>
            <div class="search-results" id="global-search-results" style="display:none"></div>
          </div>
          <div class="dropdown" id="notif-dropdown">
            <button class="icon-btn" id="notif-btn">${Icon.bell}<span class="notif-dot" id="notif-dot" style="display:none"></span></button>
            <div class="dropdown-menu" id="notif-menu" style="display:none"></div>
          </div>
        </div>
      </div>
      <div class="content" id="content"></div>
    </div>
  `);

  app.appendChild(sidebar);
  app.appendChild(main);

  qs('#logout-btn').onclick = () => {
    Api.clearSession();
    window.location.hash = '#/login';
  };
  qs('#mobile-nav-toggle').onclick = () => sidebar.classList.toggle('open');

  setupGlobalSearch();
  setupNotifications();
}

function closeMobileNav() {
  const sidebar = qs('#sidebar');
  if (sidebar) sidebar.classList.remove('open');
}

function setActiveNav(hash) {
  qsa('.nav-item').forEach(i => i.classList.toggle('active', hash.startsWith(i.dataset.hash)));
  const item = NAV_ITEMS.find(n => hash.startsWith(n.hash));
  if (item) qs('#topbar-title').textContent = item.label;
}

function setupGlobalSearch() {
  const input = qs('#global-search-input');
  const results = qs('#global-search-results');
  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) { results.style.display = 'none'; return; }
    debounceTimer = setTimeout(async () => {
      try {
        const patients = await Api.get(`/patients/search?q=${encodeURIComponent(q)}`);
        results.innerHTML = '';
        if (patients.length === 0) {
          results.innerHTML = `<div class="search-result-item"><span class="muted">No patients found</span></div>`;
        } else {
          patients.forEach(p => {
            const item = el(`<div class="search-result-item">
              <b>${esc(p.full_name)}</b>
              <div class="meta">${esc(p.patient_id)} · ${esc(p.mobile)} · ${p.age || '-'} yrs, ${esc(p.gender || '-')}</div>
            </div>`);
            item.onclick = () => { window.location.hash = `#/patients/${p.patient_id}`; results.style.display = 'none'; input.value = ''; };
            results.appendChild(item);
          });
        }
        results.style.display = 'block';
      } catch (e) { /* silent */ }
    }, 250);
  });
  document.addEventListener('click', (e) => {
    if (!qs('#global-search').contains(e.target)) results.style.display = 'none';
  });
}

async function setupNotifications() {
  const btn = qs('#notif-btn');
  const menu = qs('#notif-menu');
  btn.onclick = async (e) => {
    e.stopPropagation();
    const open = menu.style.display === 'block';
    qsa('.dropdown-menu').forEach(m => m.style.display = 'none');
    if (open) return;
    try {
      const notifs = await Api.get('/notifications');
      menu.innerHTML = notifs.length ? notifs.map(n => `
        <div class="dropdown-item"><b>${esc(n.title)}</b><span>${esc(n.message || '')}</span>
        <div style="font-size:10.5px;color:var(--ink-faint);margin-top:3px">${fmtTimeAgo(n.created_at)}</div></div>
      `).join('') : `<div class="dropdown-item"><span>No notifications yet</span></div>`;
      menu.style.display = 'block';
    } catch (err) { /* silent */ }
  };
  document.addEventListener('click', () => { menu.style.display = 'none'; });
  try {
    const notifs = await Api.get('/notifications');
    qs('#notif-dot').style.display = notifs.length ? 'block' : 'none';
  } catch (e) {}
}

// ============================= ROUTER =============================
const routes = {}; // path-pattern -> handler(params)

function registerRoute(pattern, handler) { routes[pattern] = handler; }

function matchRoute(hash) {
  const path = hash.replace(/^#/, '') || '/dashboard';
  const parts = path.split('/').filter(Boolean);
  for (const pattern in routes) {
    const pParts = pattern.split('/').filter(Boolean);
    if (pParts.length !== parts.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < pParts.length; i++) {
      if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pParts[i] !== parts[i]) { match = false; break; }
    }
    if (match) return { handler: routes[pattern], params };
  }
  return null;
}

async function router() {
  const hash = window.location.hash || '#/dashboard';

  // Keep the page-level background in sync with the login screen (see .login-bg in style.css).
  document.documentElement.classList.toggle('login-bg', hash === '#/login' || !Api.token);

  if (hash === '#/login') {
    renderLoginPage();
    return;
  }

  if (!Api.token) {
    window.location.hash = '#/login';
    return;
  }

  if (!qs('.sidebar')) renderShell();
  setActiveNav(hash);
  closeMobileNav();

  const matched = matchRoute(hash);
  const content = qs('#content');
  if (!content) return;

  if (!matched) {
    content.innerHTML = `<div class="empty-state"><p>Page not found.</p></div>`;
    return;
  }

  content.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
  try {
    await matched.handler(matched.params, content);
  } catch (e) {
    console.error(e);
    content.innerHTML = `<div class="empty-state"><p>Could not load this page. ${esc(e.message || '')}</p></div>`;
  }
}

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
  if (Api.token && Api.user) router();
  else window.location.hash = '#/login';
});

// ============================= LOGIN PAGE =============================
function renderLoginPage() {
  const app = qs('#app');
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-brand">
          <div class="login-brand-mark">A</div>
          <div><h2>Aiventra HMS</h2><span>Hospital Management System</span></div>
        </div>
        <div id="login-error" style="display:none" class="login-error"></div>
        <form id="login-form">
          <div class="form-group">
            <label>Username</label>
            <input type="text" id="login-username" placeholder="e.g. owner.hospitala" autocomplete="username" required>
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" id="login-password" placeholder="Enter your password" autocomplete="current-password" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="login-submit">Log In</button>
          <p style="text-align:center;margin-top:12px;font-size:13.5px"><a href="/marketing/forgot-password.html" style="color:var(--teal-600,#155EEF)">Forgot your password?</a></p>
        </form>
        <div class="demo-creds">
          <b>Demo credentials (Hospital A - City Care Hospital)</b>
          <table>
            <tr><td>Owner</td><td class="mono">owner.hospitala / admin123</td></tr>
            <tr><td>Manager</td><td class="mono">manager.hospitala / manager123</td></tr>
            <tr><td>Reception</td><td class="mono">reception.hospitala / reception123</td></tr>
            <tr><td>Doctor</td><td class="mono">dr.sharma.hospitala / doctor123</td></tr>
            <tr><td>Nurse</td><td class="mono">nurse.anita.hospitala / nurse123</td></tr>
            <tr><td>Lab Staff</td><td class="mono">lab.deepa.hospitala / lab123</td></tr>
          </table>
          <p style="font-size:12px;color:var(--ink-faint,#7c8a9a);margin-top:8px">Run <code>npm run seed</code> to create these. A second hospital ("sunrise") is also seeded with matching .hospitalb credentials.</p>
        </div>
      </div>
    </div>
  `;
  qs('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = qs('#login-submit');
    const errBox = qs('#login-error');
    errBox.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Logging in...';
    try {
      const username = qs('#login-username').value.trim();
      const password = qs('#login-password').value;
      const data = await Api.post('/auth/login', { username, password });
      Api.setSession(data.token, data.user);
      window.location.hash = '#/dashboard';
      router();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Log In';
    }
  };
}