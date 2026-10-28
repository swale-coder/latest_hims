registerRoute('/administration', async (params, content) => {
  content.innerHTML = `
    <div class="page-header"><div><h1>Administration</h1><p class="sub">Configure hospital structure, users, and departments</p></div></div>
    <div class="tabs" id="admin-tabs">
      ${['Hospital Structure','Users','Doctors','Departments','Support','Audit Log'].map((t,i) => `<div class="tab-btn ${i===0?'active':''}" data-tab="${t}">${t}</div>`).join('')}
    </div>
    <div id="admin-content"></div>
  `;
  const container = qs('#admin-content');
  const loaders = {
    'Hospital Structure': loadStructureTab, 'Users': loadUsersTab, 'Doctors': loadDoctorsTab,
    'Departments': loadDepartmentsTab, 'Support': loadSupportTab, 'Audit Log': loadAuditTab
  };
  qsa('.tab-btn', qs('#admin-tabs')).forEach(btn => {
    btn.onclick = () => { qsa('.tab-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); loaders[btn.dataset.tab](container); };
  });
  loadStructureTab(container);
});

async function loadStructureTab(container) {
  container.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
  const summary = await Api.get('/hospital/structure-summary');
  container.innerHTML = `
    <div class="page-header" style="margin-bottom:14px"><div></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" id="add-floor-btn">${Icon.plus} Add Floor</button>
        <button class="btn btn-secondary btn-sm" id="add-room-btn">${Icon.plus} Add Room</button>
        <button class="btn btn-primary btn-sm" id="add-bed-btn">${Icon.plus} Add Bed</button>
      </div>
    </div>
    <div id="structure-view"></div>
  `;
  const view = qs('#structure-view');
  view.innerHTML = summary.length ? summary.map(f => `
    <div class="floor-block">
      <div class="floor-title">${esc(f.name)}</div>
      ${f.rooms.map(r => `
        <div class="room-block">
          <div class="room-title">${esc(r.name)} — ${esc(r.room_type)} (${r.beds.length} beds)</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${r.beds.map(b => `<span class="badge ${b.status==='Available'?'badge-green':'badge-red'}">${esc(b.bed_number)} · ${b.status}</span>`).join('')}
          </div>
        </div>
      `).join('') || '<p class="muted" style="font-size:12.5px">No rooms configured on this floor.</p>'}
    </div>
  `).join('') : `<div class="empty-state"><p>No floors configured yet. Add your first floor to get started.</p></div>`;

  qs('#add-floor-btn').onclick = () => openAddFloorModal();
  qs('#add-room-btn').onclick = () => openAddRoomModal();
  qs('#add-bed-btn').onclick = () => openAddBedModal();
}

function openAddFloorModal() {
  const { overlay, close } = openModal({
    title: 'Add Floor',
    bodyHtml: `
      <div class="form-group"><label>Floor Name *</label><input type="text" id="f-name" placeholder="e.g. Floor 3"></div>
      <div class="form-group"><label>Floor Number *</label><input type="number" id="f-num" placeholder="e.g. 3"></div>
      <button class="btn btn-primary btn-block" id="f-submit">Add Floor</button>
    `,
    onMount: (overlay) => {
      qs('#f-submit', overlay).onclick = async () => {
        try {
          await Api.post('/hospital/floors', { name: qs('#f-name', overlay).value, floor_number: parseInt(qs('#f-num', overlay).value, 10) });
          toastSuccess('Floor added'); close(); router();
        } catch (e) { toastError(e); }
      };
    }
  });
}
async function openAddRoomModal() {
  const floors = await Api.get('/hospital/floors');
  const { overlay, close } = openModal({
    title: 'Add Room / Ward',
    bodyHtml: `
      <div class="form-group"><label>Floor *</label><select id="r-floor">${floors.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></div>
      <div class="form-group"><label>Room / Ward Name *</label><input type="text" id="r-name" placeholder="e.g. Ward C"></div>
      <div class="form-group"><label>Room Type *</label><select id="r-type"><option>Ward</option><option>Common Room</option><option>Deluxe Room</option></select></div>
      <button class="btn btn-primary btn-block" id="r-submit">Add Room</button>
    `,
    onMount: (overlay) => {
      qs('#r-submit', overlay).onclick = async () => {
        try {
          await Api.post('/hospital/rooms', { floor_id: qs('#r-floor', overlay).value, name: qs('#r-name', overlay).value, room_type: qs('#r-type', overlay).value });
          toastSuccess('Room added'); close(); router();
        } catch (e) { toastError(e); }
      };
    }
  });
}
async function openAddBedModal() {
  const rooms = await Api.get('/hospital/rooms');
  const { overlay, close } = openModal({
    title: 'Add Bed',
    bodyHtml: `
      <div class="form-group"><label>Room / Ward *</label><select id="b-room">${rooms.map(r => `<option value="${r.id}">${esc(r.floor_name)} — ${esc(r.name)}</option>`).join('')}</select></div>
      <div class="form-group"><label>Bed Number *</label><input type="text" id="b-num" placeholder="e.g. 211"></div>
      <button class="btn btn-primary btn-block" id="b-submit">Add Bed</button>
    `,
    onMount: (overlay) => {
      qs('#b-submit', overlay).onclick = async () => {
        try {
          await Api.post('/hospital/beds', { room_id: qs('#b-room', overlay).value, bed_number: qs('#b-num', overlay).value });
          toastSuccess('Bed added'); close(); router();
        } catch (e) { toastError(e); }
      };
    }
  });
}

async function loadUsersTab(container) {
  container.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
  const [users, invitations] = await Promise.all([
    Api.get('/auth/users'),
    ['organization_owner', 'hospital_admin'].includes(Api.user.role) ? Api.get('/auth/invitations') : Promise.resolve([])
  ]);
  const canCreate = ['organization_owner', 'hospital_admin'].includes(Api.user.role);
  const pendingInvites = invitations.filter(i => i.status === 'pending');

  container.innerHTML = `
    <div class="page-header" style="margin-bottom:14px"><div></div>
      ${canCreate ? `<button class="btn btn-secondary btn-sm" id="invite-user-btn">${Icon.plus} Invite Staff</button>
      <button class="btn btn-primary btn-sm" id="add-user-btn">${Icon.plus} Add User Directly</button>` : ''}
    </div>
    ${tableCard('Users', ['Name','Username','Role','Department','Status'],
      users.map(u => [u.name, u.username, `<span class="badge badge-blue">${u.role.replace('_',' ')}</span>`, u.department || '-',
        `<span class="badge ${u.active ? 'badge-green' : 'badge-grey'}">${u.active ? 'Active' : 'Inactive'}</span>`]))}

    ${canCreate && pendingInvites.length ? tableCard('Pending Invitations', ['Email','Role','Invited','Expires','Action'],
      pendingInvites.map(i => [i.email, i.role.replace('_',' '), fmtDateTime(i.created_at), fmtDateTime(i.expires_at),
        `<button class="btn btn-secondary btn-sm" data-revoke-invite="${i.id}">Revoke</button>`])) : ''}
  `;
  if (canCreate) {
    qs('#add-user-btn').onclick = () => openAddUserModal();
    qs('#invite-user-btn').onclick = () => openInviteStaffModal();
    qsa('[data-revoke-invite]').forEach(btn => {
      btn.onclick = async () => {
        try { await Api.put(`/auth/invitations/${btn.dataset.revokeInvite}/revoke`, {}); toastSuccess('Invitation revoked'); router(); }
        catch (e) { toastError(e); }
      };
    });
  }
}

function openInviteStaffModal() {
  const { overlay, close } = openModal({
    title: 'Invite Staff Member',
    bodyHtml: `
      <p class="hint" style="margin-bottom:14px">We'll send an invitation link the staff member can use to set their own password.</p>
      <div class="form-group"><label>Full Name</label><input type="text" id="inv-name"></div>
      <div class="form-group"><label>Email *</label><input type="email" id="inv-email"></div>
      <div class="form-group"><label>Role *</label>
        <select id="inv-role"><option value="hospital_admin">Hospital Admin / Manager</option><option value="receptionist">Reception / OPD Staff</option>
        <option value="doctor">Doctor</option><option value="nurse">Nurse</option><option value="lab_staff">Lab Staff</option><option value="pharmacy_staff">Pharmacy / Store Staff</option>
        <option value="accountant">Accountant</option><option value="report_viewer">Report Viewer</option></select>
      </div>
      <button class="btn btn-primary btn-block" id="inv-submit">Send Invitation</button>
    `,
    onMount: (overlay) => {
      qs('#inv-submit', overlay).onclick = async () => {
        try {
          await Api.post('/auth/invitations', {
            name: qs('#inv-name', overlay).value, email: qs('#inv-email', overlay).value, role: qs('#inv-role', overlay).value
          });
          toastSuccess('Invitation sent'); close(); router();
        } catch (e) { toastError(e); }
      };
    }
  });
}

function openAddUserModal() {
  const { overlay, close } = openModal({
    title: 'Add User',
    bodyHtml: `
      <div class="form-row">
        <div class="form-group"><label>Full Name *</label><input type="text" id="u-name"></div>
        <div class="form-group"><label>Username *</label><input type="text" id="u-username"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Password *</label><input type="password" id="u-password"></div>
        <div class="form-group"><label>Role *</label>
          <select id="u-role"><option value="hospital_admin">Hospital Admin / Manager</option><option value="receptionist">Reception / OPD Staff</option>
          <option value="doctor">Doctor</option><option value="nurse">Nurse</option><option value="lab_staff">Lab Staff</option><option value="pharmacy_staff">Pharmacy / Store Staff</option>
          <option value="accountant">Accountant</option><option value="report_viewer">Report Viewer</option></select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Phone</label><input type="tel" id="u-phone"></div>
        <div class="form-group"><label>Department</label><input type="text" id="u-department"></div>
      </div>
      <button class="btn btn-primary btn-block" id="u-submit">Create User</button>
    `,
    onMount: (overlay) => {
      qs('#u-submit', overlay).onclick = async () => {
        try {
          await Api.post('/auth/users', {
            name: qs('#u-name', overlay).value, username: qs('#u-username', overlay).value, password: qs('#u-password', overlay).value,
            role: qs('#u-role', overlay).value, phone: qs('#u-phone', overlay).value, department: qs('#u-department', overlay).value
          });
          toastSuccess('User created'); close(); router();
        } catch (e) { toastError(e); }
      };
    }
  });
}

async function loadDoctorsTab(container) {
  container.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
  const [doctors, depts] = await Promise.all([Api.get('/hospital/doctors'), Api.get('/hospital/departments')]);
  container.innerHTML = `
    <div class="page-header" style="margin-bottom:14px"><div></div><button class="btn btn-primary btn-sm" id="add-doctor-btn">${Icon.plus} Add Doctor</button></div>
    ${tableCard('Doctors', ['Name','Department','Qualification'], doctors.map(d => [d.name, d.department_name || '-', d.qualification || '-']))}
  `;
  qs('#add-doctor-btn').onclick = () => {
    const { overlay, close } = openModal({
      title: 'Add Doctor',
      bodyHtml: `
        <div class="form-group"><label>Name *</label><input type="text" id="doc-name"></div>
        <div class="form-group"><label>Department</label><select id="doc-dept"><option value="">Select</option>${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Qualification</label><input type="text" id="doc-qual" placeholder="e.g. MBBS, MD"></div>
        <button class="btn btn-primary btn-block" id="doc-submit">Add Doctor</button>
      `,
      onMount: (overlay) => {
        qs('#doc-submit', overlay).onclick = async () => {
          try {
            await Api.post('/hospital/doctors', { name: qs('#doc-name', overlay).value, department_id: qs('#doc-dept', overlay).value || null, qualification: qs('#doc-qual', overlay).value });
            toastSuccess('Doctor added'); close(); router();
          } catch (e) { toastError(e); }
        };
      }
    });
  };
}

async function loadDepartmentsTab(container) {
  container.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
  const depts = await Api.get('/hospital/departments');
  container.innerHTML = `
    <div class="page-header" style="margin-bottom:14px"><div></div><button class="btn btn-primary btn-sm" id="add-dept-btn">${Icon.plus} Add Department</button></div>
    ${tableCard('Departments', ['Name'], depts.map(d => [d.name]))}
  `;
  qs('#add-dept-btn').onclick = () => {
    const { overlay, close } = openModal({
      title: 'Add Department',
      bodyHtml: `<div class="form-group"><label>Department Name *</label><input type="text" id="dept-name"></div><button class="btn btn-primary btn-block" id="dept-submit">Add</button>`,
      onMount: (overlay) => {
        qs('#dept-submit', overlay).onclick = async () => {
          try { await Api.post('/hospital/departments', { name: qs('#dept-name', overlay).value }); toastSuccess('Department added'); close(); router(); }
          catch (e) { toastError(e); }
        };
      }
    });
  };
}

async function loadAuditTab(container) {
  container.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
  const logs = await Api.get('/audit?limit=150');
  container.innerHTML = tableCard('Audit Log', ['User','Role','Action','Patient','Date'],
    logs.map(l => [l.user_name || 'system', l.role || '-', l.action, l.patient_id || '-', fmtDateTime(l.created_at)]));
}

async function loadSupportTab(container) {
  container.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
  const [requests, tickets] = await Promise.all([Api.get('/support/access-requests'), Api.get('/support/tickets')]);

  const pending = requests.filter(r => r.status === 'pending');
  container.innerHTML = `
    <div class="page-header" style="margin-bottom:14px"><div><h3>Aiventra Support Access Requests</h3>
      <p class="sub">Aiventra staff need your explicit approval to view this hospital's data. Access always expires automatically.</p></div>
    </div>
    <div id="access-requests-view"></div>

    <div class="page-header" style="margin:28px 0 14px"><div><h3>Support Tickets</h3></div>
      <button class="btn btn-primary btn-sm" id="raise-ticket-btn">${typeof Icon !== 'undefined' ? Icon.plus : '+'} Raise Ticket</button>
    </div>
    <div id="tickets-view"></div>
  `;

  function renderRequests() {
    qs('#access-requests-view').innerHTML = requests.length ? tableCard(null, ['Requested', 'Reason', 'Status', 'Action'],
      requests.map(r => [
        fmtDateTime(r.created_at), r.reason || '-',
        `<span class="badge ${r.status === 'approved' ? 'badge-green' : (r.status === 'pending' ? 'badge-amber' : 'badge-grey')}">${r.status}</span>`,
        r.status === 'pending' ? `<button class="btn btn-secondary btn-sm" data-approve="${r.id}">Approve</button> <button class="btn btn-secondary btn-sm" data-deny="${r.id}">Deny</button>` : (r.expires_at ? `Expires ${fmtDateTime(r.expires_at)}` : '-')
      ])) : '<p class="hint">No support access requests from Aiventra yet.</p>';

    qsa('[data-approve]').forEach(btn => {
      btn.onclick = async () => {
        try { await Api.put(`/support/access-requests/${btn.dataset.approve}/approve`, { hours: 4 }); toastSuccess('Access approved for 4 hours'); router(); }
        catch (e) { toastError(e); }
      };
    });
    qsa('[data-deny]').forEach(btn => {
      btn.onclick = async () => {
        try { await Api.put(`/support/access-requests/${btn.dataset.deny}/deny`, {}); toastSuccess('Request denied'); router(); }
        catch (e) { toastError(e); }
      };
    });
  }
  renderRequests();

  qs('#tickets-view').innerHTML = tickets.length ? tableCard(null, ['Subject', 'Priority', 'Status', 'Raised'],
    tickets.map(t => [t.subject, t.priority, t.status, fmtDateTime(t.created_at)])) : '<p class="hint">No support tickets raised yet.</p>';

  qs('#raise-ticket-btn').onclick = () => {
    const { overlay, close } = openModal({
      title: 'Raise a Support Ticket',
      bodyHtml: `
        <div class="form-group"><label>Subject *</label><input type="text" id="ticket-subject"></div>
        <div class="form-group"><label>Description</label><textarea id="ticket-description"></textarea></div>
        <div class="form-group"><label>Priority</label>
          <select id="ticket-priority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option></select>
        </div>
        <button class="btn btn-primary btn-block" id="ticket-submit">Submit</button>`,
      onMount: (overlay) => {
        qs('#ticket-submit', overlay).onclick = async () => {
          try {
            await Api.post('/support/tickets', {
              subject: qs('#ticket-subject', overlay).value,
              description: qs('#ticket-description', overlay).value,
              priority: qs('#ticket-priority', overlay).value
            });
            toastSuccess('Ticket submitted');
            close();
            router();
          } catch (e) { toastError(e); }
        };
      }
    });
  };
}
