// ============================= PATIENTS LIST =============================
registerRoute('/patients', async (params, content) => {
  content.innerHTML = `
    <div class="page-header">
      <div><h1>Patients</h1><p class="sub">Search and manage patient records</p></div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-secondary" id="qr-btn">${Icon.qr} OPD QR Code</button>
        <button class="btn btn-primary" id="new-patient-btn">${Icon.plus} New OPD Registration</button>
      </div>
    </div>
    <div class="card">
      <div class="card-pad">
        <div class="form-group" style="max-width:420px;margin-bottom:0">
          <label>Search by Patient ID, name, mobile, or date of birth</label>
          <input type="text" id="patient-search-input" placeholder="e.g. PAT-000001, Ahmed Khan, 9812345601">
        </div>
      </div>
      <div class="table-wrap" id="patient-results"></div>
    </div>
  `;

  const resultsBox = qs('#patient-results');
  async function loadResults(q) {
    resultsBox.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
    const rows = q ? await Api.get(`/patients/search?q=${encodeURIComponent(q)}`) : await Api.get(`/patients/search?q=PAT-`);
    if (rows.length === 0) { resultsBox.innerHTML = `<div class="empty-state"><p>No patients found. Try a different search, or register a new patient.</p></div>`; return; }
    resultsBox.innerHTML = `<table><thead><tr><th>Patient ID</th><th>Name</th><th>Mobile</th><th>Age / Gender</th><th>Registered</th></tr></thead>
      <tbody>${rows.map(p => `<tr>
        <td class="table-link mono" onclick="location.hash='#/patients/${p.patient_id}'">${esc(p.patient_id)}</td>
        <td>${esc(p.full_name)}</td><td>${esc(p.mobile)}</td><td>${p.age || '-'} / ${esc(p.gender || '-')}</td>
        <td>${fmtDate(p.created_at)}</td>
      </tr>`).join('')}</tbody></table>`;
  }
  loadResults('');
  let debounce;
  qs('#patient-search-input').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => loadResults(e.target.value.trim()), 250);
  });

  qs('#new-patient-btn').onclick = () => openOpdRegistrationModal();
  qs('#qr-btn').onclick = () => openQrModal();
});

async function openQrModal() {
  const { overlay } = openModal({
    title: 'OPD Self-Registration QR Code',
    bodyHtml: `<div class="qr-panel" id="qr-panel"><div class="loading-spin"><div class="spinner"></div></div></div>`,
  });
  try {
    const data = await Api.get('/qr/opd-registration');
    qs('#qr-panel', overlay).innerHTML = `
      <img src="${data.qrImage}" alt="OPD Registration QR">
      <p style="margin-top:14px;font-weight:650">SCAN TO REGISTER FOR OPD</p>
      <p class="muted" style="font-size:12px;margin-top:4px">${esc(data.url)}</p>
      <a href="${data.qrImage}" download="opd-registration-qr.png" class="btn btn-secondary btn-sm" style="margin-top:14px">${Icon.download} Download QR</a>
    `;
  } catch (e) { console.error('QR error:', e); qs('#qr-panel', overlay).innerHTML = `<p class="muted">Could not generate QR code. ${esc(e.message || '')}</p>`; }
}

function openOpdRegistrationModal() {
  const { overlay, close } = openModal({
    title: 'New OPD Registration',
    size: 'lg',
    bodyHtml: `
      <div id="opd-reg-step1">
        <div class="form-row">
          <div class="form-group"><label>Full Name *</label><input type="text" id="reg-name" required></div>
          <div class="form-group"><label>Mobile Number *</label><input type="tel" id="reg-mobile" maxlength="10" placeholder="10-digit mobile" required></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Gender</label>
            <select id="reg-gender"><option value="">Select</option><option>Male</option><option>Female</option><option>Other</option></select>
          </div>
          <div class="form-group"><label>Date of Birth</label><input type="date" id="reg-dob"></div>
        </div>
        <div class="form-group"><label>Address</label><textarea id="reg-address" rows="2"></textarea></div>
        <div class="form-row">
          <div class="form-group"><label>Emergency Contact Name</label><input type="text" id="reg-ec-name"></div>
          <div class="form-group"><label>Emergency Contact Phone</label><input type="tel" id="reg-ec-phone" maxlength="10"></div>
        </div>
        <div id="reg-found-note"></div>
        <div class="form-row">
          <div class="form-group"><label>Department</label><select id="reg-dept"></select></div>
          <div class="form-group"><label>Doctor</label><select id="reg-doctor"></select></div>
        </div>
        <button class="btn btn-primary btn-block" id="reg-submit">Register &amp; Generate Token</button>
      </div>
      <div id="opd-reg-success" style="display:none;text-align:center;padding:10px 0">
        <div style="width:52px;height:52px;border-radius:50%;background:var(--green-bg);color:var(--green);display:flex;align-items:center;justify-content:center;margin:0 auto 14px">${Icon.check}</div>
        <h3 style="margin-bottom:6px">OPD Registration Successful</h3>
        <p class="muted" id="reg-success-msg" style="margin-bottom:18px"></p>
        <div class="card" style="text-align:left;padding:16px 18px" id="reg-success-details"></div>
        <button class="btn btn-primary" style="margin-top:16px" id="reg-close-btn">Done</button>
      </div>
    `,
    onMount: async (overlay) => {
      const depts = await Api.get('/hospital/departments');
      const doctors = await Api.get('/hospital/doctors');
      qs('#reg-dept', overlay).innerHTML = `<option value="">Select department</option>` + depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
      qs('#reg-doctor', overlay).innerHTML = `<option value="">Select doctor</option>` + doctors.map(d => `<option value="${d.id}">${esc(d.name)} — ${esc(d.department_name || '')}</option>`).join('');

      qs('#reg-submit', overlay).onclick = async () => {
        const btn = qs('#reg-submit', overlay);
        const full_name = qs('#reg-name', overlay).value.trim();
        const mobile = qs('#reg-mobile', overlay).value.trim();
        if (!full_name || !mobile) { toastError({ message: 'Name and mobile number are required' }); return; }
        btn.disabled = true; btn.textContent = 'Registering...';
        try {
          const found = await Api.post('/patients/find-or-create', {
            full_name, mobile,
            gender: qs('#reg-gender', overlay).value,
            dob: qs('#reg-dob', overlay).value,
            address: qs('#reg-address', overlay).value,
            emergency_contact_name: qs('#reg-ec-name', overlay).value,
            emergency_contact_phone: qs('#reg-ec-phone', overlay).value,
          });
          const visitRes = await Api.post('/opd/register', {
            patient_id: found.patient.patient_id,
            department_id: qs('#reg-dept', overlay).value || null,
            doctor_id: qs('#reg-doctor', overlay).value || null,
          });
          qs('#opd-reg-step1', overlay).style.display = 'none';
          qs('#opd-reg-success', overlay).style.display = 'block';
          qs('#reg-success-msg', overlay).textContent = found.message;
          qs('#reg-success-details', overlay).innerHTML = `
            <div style="display:flex;justify-content:space-between;padding:6px 0"><span class="muted">Patient Name</span><b>${esc(found.patient.full_name)}</b></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0"><span class="muted">Patient ID</span><b class="mono">${esc(found.patient.patient_id)}</b></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0"><span class="muted">OPD Number</span><b class="mono">${esc(visitRes.visit.opd_number)}</b></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0"><span class="muted">Token Number</span><b>${visitRes.visit.token_number || '-'}</b></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0"><span class="muted">Date</span><b>${fmtDate(visitRes.visit.visit_date)}</b></div>
          `;
        } catch (e) {
          toastError(e);
        } finally {
          btn.disabled = false; btn.textContent = 'Register & Generate Token';
        }
      };
      qs('#reg-close-btn', overlay).onclick = () => { close(); if (location.hash === '#/opd') router(); if (location.hash === '#/patients') router(); };
    }
  });
}

// ============================= PATIENT 360 PROFILE =============================
registerRoute('/patients/:pid', async (params, content) => {
  const data = await Api.get(`/patients/${params.pid}`);
  const p = data.patient;
  const isAdmitted = data.currentStatus === 'Admitted';

  content.innerHTML = `
    <div class="patient-header">
      <div class="ph-left">
        <div class="ph-avatar">${initials(p.full_name)}</div>
        <div>
          <div class="ph-name">${esc(p.full_name)}</div>
          <div class="ph-meta">${p.age || '-'} years · ${esc(p.gender || '-')} · ${esc(p.mobile)}</div>
          <div class="ph-id">${esc(p.patient_id)}</div>
        </div>
      </div>
      <div class="ph-right">
        <div class="ph-stat"><div class="label">Status</div><div class="value">${isAdmitted ? '🟢 Admitted' : 'Not Admitted'}</div></div>
        ${isAdmitted ? `<div class="ph-stat"><div class="label">Bed</div><div class="value">${esc(data.activeAdmission.bed_number || '-')}</div></div>` : ''}
        ${isAdmitted ? `<div class="ph-stat"><div class="label">Doctor</div><div class="value">${esc(data.activeAdmission.attending_doctor_name || '-')}</div></div>` : ''}
      </div>
    </div>

    <div class="tabs" id="patient-tabs">
      ${['Overview','Timeline','OPD','Admissions','Clinical','Lab','Surgery','Medication','Billing','Documents','Discharge'].map((t,i) =>
        `<div class="tab-btn ${i===0?'active':''}" data-tab="${t}">${t}</div>`).join('')}
    </div>
    <div id="patient-tab-content"></div>
  `;

  const tabContent = qs('#patient-tab-content');
  function renderTab(tab) {
    if (tab === 'Overview') renderOverviewTab(tabContent, data);
    else if (tab === 'Timeline') renderTimelineTab(tabContent, data);
    else if (tab === 'OPD') renderOpdTab(tabContent, data);
    else if (tab === 'Admissions') renderAdmissionsTab(tabContent, data);
    else if (tab === 'Clinical') renderClinicalTab(tabContent, data);
    else if (tab === 'Lab') renderLabTab(tabContent, data);
    else if (tab === 'Surgery') renderSurgeryTab(tabContent, data);
    else if (tab === 'Medication') renderMedicationTab(tabContent, data);
    else if (tab === 'Billing') renderBillingTab(tabContent, data);
    else if (tab === 'Documents') renderDocumentsTab(tabContent, data);
    else if (tab === 'Discharge') renderDischargeTab(tabContent, data);
  }
  qsa('.tab-btn').forEach(btn => {
    btn.onclick = () => { qsa('.tab-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderTab(btn.dataset.tab); };
  });
  renderTab('Overview');
});

function renderOverviewTab(container, data) {
  const p = data.patient;
  container.innerHTML = `
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <div class="card-header"><h3>Patient Information</h3></div>
        <div class="card-pad">
          ${infoRow('Patient ID', p.patient_id)}
          ${infoRow('Full Name', p.full_name)}
          ${infoRow('Mobile', p.mobile)}
          ${infoRow('Gender', p.gender)}
          ${infoRow('Date of Birth', p.dob ? fmtDate(p.dob) : '-')}
          ${infoRow('Age', p.age)}
          ${infoRow('Address', p.address)}
          ${infoRow('Aadhaar', p.aadhaar_number || 'Not on file')}
          ${infoRow('Emergency Contact', p.emergency_contact_name ? `${p.emergency_contact_name} (${p.emergency_contact_phone || '-'})` : '-')}
          ${infoRow('Registered', fmtDate(p.created_at))}
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>Summary</h3></div>
        <div class="card-pad">
          ${infoRow('OPD Visits', data.opdVisits.length)}
          ${infoRow('Admissions', data.admissions.length)}
          ${infoRow('Lab Tests', data.labOrders.length)}
          ${infoRow('Surgeries', data.surgeries.length)}
          ${infoRow('Discharge Summaries', data.discharges.length)}
          ${data.activeAdmission ? `
            <div class="divider"></div>
            <div style="font-size:12.5px;font-weight:650;margin-bottom:8px">Active Admission</div>
            ${infoRow('Admission No.', data.activeAdmission.admission_number)}
            ${infoRow('Bed', data.activeAdmission.bed_number)}
            ${infoRow('Diagnosis', data.activeAdmission.diagnosis)}
            <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="location.hash='#/discharge'">Go to Discharge</button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}
function infoRow(label, value) {
  return `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line-soft);font-size:13px">
    <span class="muted">${esc(label)}</span><span style="font-weight:600;text-align:right;max-width:60%">${esc(value === undefined || value === null || value === '' ? '-' : value)}</span>
  </div>`;
}

function renderTimelineTab(container, data) {
  if (!data.timeline.length) { container.innerHTML = `<div class="card card-pad"><div class="empty-state"><p>No timeline events yet.</p></div></div>`; return; }
  container.innerHTML = `<div class="card card-pad">
    <div class="timeline">
      ${data.timeline.map(t => `<div class="timeline-item">
        <div class="t-event">${esc(t.event)}</div>
        ${t.detail ? `<div class="t-detail">${esc(t.detail)}</div>` : ''}
        <div class="t-date">${fmtDateTime(t.event_date)}</div>
      </div>`).join('')}
    </div>
  </div>`;
}

function renderOpdTab(container, data) {
  container.innerHTML = tableCard('OPD Visits', ['OPD Number','Date','Department','Doctor','Status'],
    data.opdVisits.map(o => [o.opd_number, fmtDate(o.visit_date), o.department_name || '-', o.doctor_name || '-', badgeForOpdStatus(o.status)]));
}
function renderAdmissionsTab(container, data) {
  container.innerHTML = tableCard('Admissions', ['Admission No.','Admitted','Bed','Doctor','Diagnosis','Status'],
    data.admissions.map(a => [a.admission_number, fmtDate(a.admitted_at), a.bed_number || '-', a.attending_doctor_name || '-', a.diagnosis || '-',
      `<span class="badge ${a.status === 'Active' ? 'badge-green' : 'badge-grey'}">${a.status}</span>`]));
}
function renderClinicalTab(container, data) {
  const notesHtml = data.clinicalNotes.length ? data.clinicalNotes.map(n => `
    <div class="card card-pad" style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px">
        <span class="badge badge-blue">${esc(n.note_type)}</span>
        <span class="muted" style="font-size:11.5px">${fmtDateTime(n.created_at)} · ${esc(n.role)}</span>
      </div>
      <p style="font-size:13px">${esc(n.content)}</p>
    </div>`).join('') : `<div class="empty-state"><p>No clinical notes recorded.</p></div>`;

  const vitalsHtml = data.vitals.length ? tableCard('Vitals', ['Date','Temp','Pulse','BP','SpO2','Resp Rate'],
    data.vitals.map(v => [fmtDateTime(v.recorded_at), v.temperature || '-', v.pulse || '-', v.bp || '-', v.spo2 || '-', v.resp_rate || '-'])) : '';

  container.innerHTML = `<div class="section-title">Clinical Notes</div>${notesHtml}<div class="section-title">Vitals</div>${vitalsHtml || '<div class="empty-state"><p>No vitals recorded.</p></div>'}`;
}
function fileViewLink(path, label) {
  if (!path) return '-';
  return `<a class="btn btn-secondary btn-sm" href="${esc(Api.fileUrl(path))}" target="_blank" rel="noopener">${Icon.download} ${label || 'View'}</a>`;
}
function renderLabTab(container, data) {
  container.innerHTML = tableCard('Lab Orders', ['Test','Ordered','Status','Result','Report File'],
    data.labOrders.map(l => [l.test_name, fmtDateTime(l.ordered_at), `<span class="badge badge-blue">${l.status}</span>`, l.result || '-', fileViewLink(l.report_file, 'View Report')]));
}
function renderSurgeryTab(container, data) {
  if (!data.surgeries.length) { container.innerHTML = `<div class="card card-pad"><div class="empty-state"><p>No surgeries recorded.</p></div></div>`; return; }
  container.innerHTML = data.surgeries.map(s => `
    <div class="card card-pad" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:10px">
        <div><b style="font-size:14.5px">${esc(s.procedure_name)}</b><div class="muted" style="font-size:12px">${fmtDate(s.surgery_date)} ${s.surgery_time ? '· ' + s.surgery_time : ''}</div></div>
      </div>
      ${infoRow('Surgeon', s.surgeon)}${infoRow('Assistant', s.assistant)}${infoRow('Anaesthetist', s.anaesthetist)}
      ${infoRow('Diagnosis', s.diagnosis)}${infoRow('Notes', s.procedure_notes)}${infoRow('Post-op Notes', s.post_op_notes)}
      ${s.document_file ? `<div style="margin-top:10px">${fileViewLink(s.document_file, 'View Document')}</div>` : ''}
    </div>`).join('');
}
function renderMedicationTab(container, data) {
  container.innerHTML = tableCard('Prescriptions', ['Medicine','Dose','Route','Frequency','Start','End'],
    data.prescriptions.map(m => [m.medicine, m.dose || '-', m.route || '-', m.frequency || '-', fmtDate(m.start_date), m.end_date ? fmtDate(m.end_date) : '-']));
}
function renderDocumentsTab(container, data) {
  container.innerHTML = `
    <div class="page-header" style="margin-bottom:14px"><div></div>
      <button class="btn btn-secondary btn-sm" id="upload-doc-btn">${Icon.plus} Upload Document</button>
    </div>
    ${tableCard('Patient Documents', ['Type','Number','Status','Uploaded','File'],
      data.documents.map(d => [d.doc_type, d.doc_number ? `<span class="mono">${esc(d.doc_number)}</span>` : '-',
        `<span class="badge ${d.verification_status === 'Verified' ? 'badge-green' : 'badge-amber'}">${d.verification_status}</span>`,
        fmtDate(d.uploaded_at), fileViewLink(d.file_path, 'View')]))}
  `;
  qs('#upload-doc-btn').onclick = () => openDocumentUploadModal(data.patient.patient_id);
}
function renderDischargeTab(container, data) {
  if (!data.discharges.length) { container.innerHTML = `<div class="card card-pad"><div class="empty-state"><p>No discharge summaries yet.</p></div></div>`; return; }
  container.innerHTML = data.discharges.map(ds => `
    <div class="card card-pad" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span class="badge ${ds.status === 'Finalized' ? 'badge-green' : 'badge-amber'}">${ds.status}</span>
        <span class="muted" style="font-size:12px">${fmtDate(ds.created_at)}</span>
      </div>
      ${infoRow('Diagnosis', ds.diagnosis)}${infoRow('Condition at Discharge', ds.condition_at_discharge)}${infoRow('Doctor', ds.doctor_name)}
      ${ds.pdf_path ? `<a class="btn btn-secondary btn-sm" style="margin-top:10px" href="${Api.fileUrl(ds.pdf_path)}" target="_blank">${Icon.download} View PDF</a>` : ''}
    </div>`).join('');
}

function tableCard(title, headers, rows) {
  return `<div class="card">
    <div class="card-header"><h3>${esc(title)}</h3></div>
    <div class="table-wrap">
      ${rows.length ? `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : `<div class="empty-state"><p>No records found.</p></div>`}
    </div>
  </div>`;
}

function openDocumentUploadModal(patientId) {
  const { overlay, close } = openModal({
    title: 'Upload Patient Document',
    bodyHtml: `
      <div class="form-group"><label>Document Type *</label>
        <select id="doc-type"><option value="Aadhaar">Aadhaar</option><option value="PAN">PAN</option><option value="Other">Other</option></select>
      </div>
      <div class="form-group"><label>Document Number</label><input type="text" id="doc-number" placeholder="Will be masked for unauthorized users"></div>
      <div class="form-group"><label>File (PDF, JPG, PNG)</label><input type="file" id="doc-file" accept=".pdf,.jpg,.jpeg,.png"></div>
      <p class="hint">Documents are securely stored with access control and audit logging, per hospital data protection policy.</p>
      <button class="btn btn-primary btn-block" id="doc-upload-submit" style="margin-top:10px">Upload</button>
    `,
    onMount: (overlay) => {
      qs('#doc-upload-submit', overlay).onclick = async () => {
        const btn = qs('#doc-upload-submit', overlay);
        btn.disabled = true; btn.textContent = 'Uploading...';
        try {
          const fd = new FormData();
          fd.append('doc_type', qs('#doc-type', overlay).value);
          fd.append('doc_number', qs('#doc-number', overlay).value);
          const file = qs('#doc-file', overlay).files[0];
          if (file) fd.append('file', file);
          await Api.post(`/patients/${patientId}/documents`, fd, true);
          toastSuccess('Document uploaded');
          close();
          router();
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Upload'; }
      };
    }
  });
}
