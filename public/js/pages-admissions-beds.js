// ============================= ADMISSIONS =============================
registerRoute('/admissions', async (params, content) => {
  const [active, pending] = await Promise.all([
    Api.get('/admissions?status=Active'),
    Api.get('/consultations/pending-admissions')
  ]);

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Admissions</h1><p class="sub">Manage hospital admissions and bed assignments</p></div>
      <button class="btn btn-primary" id="new-admission-btn">${Icon.plus} Admit Patient</button>
    </div>

    ${pending.length ? `
    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><h3>Pending Admissions</h3><span class="muted" style="font-size:12px">Recommended by doctors, not yet admitted</span></div>
      <div class="table-wrap"><table><thead><tr><th>Patient</th><th>Doctor</th><th>Diagnosis</th><th></th></tr></thead>
        <tbody>${pending.map(p => `<tr>
          <td class="table-link" onclick="location.hash='#/patients/${p.patient_id}'">${esc(p.full_name)} <span class="mono muted">(${p.patient_id})</span></td>
          <td>${esc(p.doctor_name || '-')}</td><td>${esc(p.diagnosis || '-')}</td>
          <td><button class="btn btn-sm btn-primary" onclick="openAdmitPatientModal('${p.patient_id}', '${esc(p.full_name).replace(/'/g,"\\'")}')">Admit Patient</button></td>
        </tr>`).join('')}</tbody></table></div>
    </div>` : ''}

    <div class="card">
      <div class="card-header"><h3>Currently Admitted</h3><span class="muted" style="font-size:12px">${active.length} active</span></div>
      <div class="table-wrap">
        ${active.length ? `<table><thead><tr><th>Admission No.</th><th>Patient</th><th>Bed</th><th>Doctor</th><th>Diagnosis</th><th>Admitted</th></tr></thead>
        <tbody>${active.map(a => `<tr>
          <td class="mono">${a.admission_number}</td>
          <td class="table-link" onclick="location.hash='#/patients/${a.patient_id}'">${esc(a.full_name)}</td>
          <td>${esc(a.bed_number || '-')} ${a.room_name ? `<span class="muted">(${esc(a.room_name)})</span>` : ''}</td>
          <td>${esc(a.attending_doctor_name || '-')}</td><td>${esc(a.diagnosis || '-')}</td><td>${fmtDate(a.admitted_at)}</td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><p>No patients currently admitted.</p></div>`}
      </div>
    </div>
  `;
  qs('#new-admission-btn').onclick = () => openAdmitPatientModal();
});

async function openAdmitPatientModal(prefillPid, prefillName) {
  const [doctors, availableBeds, floors] = await Promise.all([
    Api.get('/hospital/doctors'), Api.get('/beds/available'), Api.get('/hospital/floors')
  ]);

  const { overlay, close } = openModal({
    title: 'Admit Patient',
    size: 'lg',
    bodyHtml: `
      <div class="form-group">
        <label>Patient ID *</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="adm-pid" value="${prefillPid || ''}" placeholder="Search or enter Patient ID" style="flex:1">
          <button class="btn btn-secondary btn-sm" id="adm-fetch-btn">Fetch</button>
        </div>
        <div id="adm-patient-preview" style="margin-top:10px"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Attending Doctor *</label><select id="adm-doctor">${doctors.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Admission Type</label><select id="adm-type"><option>Normal</option><option>Emergency</option></select></div>
      </div>
      <div class="form-group"><label>Reason for Admission</label><input type="text" id="adm-reason"></div>
      <div class="form-group"><label>Diagnosis</label><input type="text" id="adm-diagnosis"></div>
      <div class="form-group"><label>Proposed Treatment</label><textarea id="adm-treatment" rows="2"></textarea></div>
      <div class="section-title" style="margin-top:0">Bed Allocation</div>
      <div class="form-row">
        <div class="form-group"><label>Floor</label><select id="adm-floor"><option value="">All floors</option>${floors.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Available Bed</label><select id="adm-bed"><option value="">No bed (assign later)</option></select></div>
      </div>
      <button class="btn btn-primary btn-block" id="adm-submit">Admit Patient</button>
    `,
    onMount: (overlay) => {
      let patientData = null;
      function renderBedOptions(floorId) {
        const beds = floorId ? availableBeds.filter(b => String(b.floor_id) === String(floorId)) : availableBeds;
        qs('#adm-bed', overlay).innerHTML = `<option value="">No bed (assign later)</option>` +
          beds.map(b => `<option value="${b.id}">${esc(b.bed_number)} — ${esc(b.room_name)} (${esc(b.floor_name)})</option>`).join('');
      }
      renderBedOptions('');
      qs('#adm-floor', overlay).onchange = (e) => renderBedOptions(e.target.value);

      async function fetchPatient() {
        const pid = qs('#adm-pid', overlay).value.trim().toUpperCase();
        if (!pid) return;
        try {
          const res = await Api.get(`/patients/${pid}`);
          patientData = res.patient;
          qs('#adm-patient-preview', overlay).innerHTML = `
            <div class="card card-pad" style="background:var(--teal-50)">
              <b>${esc(patientData.full_name)}</b> <span class="muted">${patientData.age || '-'} yrs, ${esc(patientData.gender || '-')}</span><br>
              <span class="muted" style="font-size:12px">${esc(patientData.mobile)} · ${esc(patientData.address || 'No address on file')}</span>
            </div>`;
        } catch (e) {
          qs('#adm-patient-preview', overlay).innerHTML = `<p class="hint" style="color:var(--red)">Patient not found. Please check the Patient ID.</p>`;
          patientData = null;
        }
      }
      qs('#adm-fetch-btn', overlay).onclick = fetchPatient;
      if (prefillPid) fetchPatient();

      qs('#adm-submit', overlay).onclick = async () => {
        if (!patientData) { toastError({ message: 'Please fetch a valid patient first' }); return; }
        const doctorId = qs('#adm-doctor', overlay).value;
        const btn = qs('#adm-submit', overlay);
        btn.disabled = true; btn.textContent = 'Admitting...';
        try {
          const res = await Api.post('/admissions', {
            patient_id: patientData.patient_id,
            attending_doctor_id: doctorId,
            reason: qs('#adm-reason', overlay).value,
            diagnosis: qs('#adm-diagnosis', overlay).value,
            proposed_treatment: qs('#adm-treatment', overlay).value,
            admission_type: qs('#adm-type', overlay).value,
            bed_id: qs('#adm-bed', overlay).value || null
          });
          toastSuccess(`Patient admitted — ${res.admission.admission_number}`);
          close();
          router();
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Admit Patient'; }
      };
    }
  });
}

// ============================= BED MANAGEMENT =============================
registerRoute('/beds', async (params, content) => {
  const [overview, floorView] = await Promise.all([Api.get('/beds/overview'), Api.get('/beds/floor-view')]);

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Bed Management</h1><p class="sub">Real-time floor-wise bed status</p></div>
    </div>
    <div class="grid grid-4" style="margin-bottom:24px">
      <div class="stat-card accent-teal"><div class="stat-label">Total Beds</div><div class="stat-value">${overview.total}</div></div>
      <div class="stat-card accent-red"><div class="stat-label">Occupied</div><div class="stat-value">${overview.Occupied}</div></div>
      <div class="stat-card accent-green"><div class="stat-label">Available</div><div class="stat-value">${overview.Available}</div></div>
      <div class="stat-card accent-amber"><div class="stat-label">Cleaning / Maintenance</div><div class="stat-value">${overview.Cleaning + overview.Maintenance}</div></div>
    </div>
    <div id="floor-view"></div>
  `;

  const floorViewEl = qs('#floor-view');
  floorViewEl.innerHTML = floorView.map(f => `
    <div class="floor-block">
      <div class="floor-title">${Icon.building.replace('width="24" height="24"','width="16" height="16"')} ${esc(f.name)}</div>
      ${f.rooms.map(r => `
        <div class="room-block">
          <div class="room-title">${esc(r.name)} — ${esc(r.room_type)}</div>
          <div class="bed-grid">
            ${r.beds.map(b => `
              <div class="bed-tile ${b.status.toLowerCase()}" data-bed-id="${b.id}">
                <div class="bed-num">${esc(b.bed_number)}</div>
                <div class="bed-status">${b.status}</div>
                ${b.patient_name ? `<div class="bed-patient">${esc(b.patient_name)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');

  const isAdmin = ['hospital_admin', 'organization_owner', 'nurse'].includes(Api.user.role);
  if (isAdmin) {
    qsa('.bed-tile', floorViewEl).forEach(tile => {
      tile.style.cursor = 'pointer';
      tile.onclick = () => openBedActionModal(tile.dataset.bedId);
    });
  }
});

async function openBedActionModal(bedId) {
  const beds = await Api.get('/hospital/beds');
  const bed = beds.find(b => String(b.id) === String(bedId));
  if (!bed) return;

  const { overlay, close } = openModal({
    title: `Bed ${bed.bed_number} — ${bed.room_name}`,
    bodyHtml: `
      <p class="muted" style="margin-bottom:14px">Current status: ${badgeForBedStatus(bed.status)}</p>
      <div class="form-group"><label>Change Status</label>
        <select id="bed-status-select">
          <option value="Available" ${bed.status==='Available'?'selected':''}>Available</option>
          <option value="Occupied" ${bed.status==='Occupied'?'selected':''} ${bed.status!=='Occupied'?'disabled':''}>Occupied</option>
          <option value="Reserved" ${bed.status==='Reserved'?'selected':''}>Reserved</option>
          <option value="Cleaning" ${bed.status==='Cleaning'?'selected':''}>Cleaning</option>
          <option value="Maintenance" ${bed.status==='Maintenance'?'selected':''}>Maintenance</option>
        </select>
        <p class="hint">Occupied beds must be released via patient discharge, then go through Cleaning before becoming Available.</p>
      </div>
      <button class="btn btn-primary btn-block" id="bed-status-submit">Update Status</button>
      ${bed.status === 'Cleaning' ? `<button class="btn btn-secondary btn-block" style="margin-top:8px" id="bed-clean-complete">Mark Cleaning Complete → Available</button>` : ''}
    `,
    onMount: (overlay) => {
      qs('#bed-status-submit', overlay).onclick = async () => {
        try {
          await Api.put(`/hospital/beds/${bedId}/status`, { status: qs('#bed-status-select', overlay).value });
          toastSuccess('Bed status updated');
          close(); router();
        } catch (e) { toastError(e); }
      };
      const cleanBtn = qs('#bed-clean-complete', overlay);
      if (cleanBtn) cleanBtn.onclick = async () => {
        try { await Api.put(`/beds/${bedId}/clean-complete`); toastSuccess('Bed is now Available'); close(); router(); }
        catch (e) { toastError(e); }
      };
    }
  });
}
