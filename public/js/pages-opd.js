// ============================= OPD DASHBOARD =============================
registerRoute('/opd', async (params, content) => {
  const [summary, queue] = await Promise.all([Api.get('/opd/summary'), Api.get('/opd/queue')]);

  content.innerHTML = `
    <div class="page-header">
      <div><h1>OPD Today</h1><p class="sub">${fmtDate(new Date().toISOString())}</p></div>
      <button class="btn btn-primary" id="opd-new-btn">${Icon.plus} New OPD Registration</button>
    </div>

    <div class="grid grid-4" style="margin-bottom:20px">
      <div class="stat-card accent-teal"><div class="stat-label">Total Patients</div><div class="stat-value">${summary.total}</div></div>
      <div class="stat-card accent-amber"><div class="stat-label">Waiting</div><div class="stat-value">${summary.waiting}</div></div>
      <div class="stat-card accent-blue"><div class="stat-label">In Consultation</div><div class="stat-value">${summary.inConsultation}</div></div>
      <div class="stat-card accent-green"><div class="stat-label">Completed</div><div class="stat-value">${summary.completed}</div></div>
    </div>
    <div class="grid grid-2" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-label">New Patients</div><div class="stat-value">${summary.newPatients}</div></div>
      <div class="stat-card"><div class="stat-label">Returning Patients</div><div class="stat-value">${summary.returning}</div></div>
    </div>

    <div class="card">
      <div class="card-header"><h3>Queue</h3></div>
      <div class="table-wrap">
        ${queue.length ? `<table><thead><tr><th>Token</th><th>Patient</th><th>Doctor</th><th>Department</th><th>Status</th><th></th></tr></thead>
        <tbody>${queue.map(q => `<tr>
          <td>${q.token_number || '-'}</td>
          <td class="table-link" onclick="location.hash='#/patients/${q.patient_id}'">${esc(q.full_name)}</td>
          <td>${esc(q.doctor_name || '-')}</td><td>${esc(q.department_name || '-')}</td>
          <td>${badgeForOpdStatus(q.status)}</td>
          <td>
            ${q.status === 'Waiting' ? `<button class="btn btn-sm btn-secondary" onclick="updateOpdStatus(${q.id}, 'In Consultation')">Start</button>` : ''}
            ${q.status === 'In Consultation' ? `<button class="btn btn-sm btn-secondary" onclick="updateOpdStatus(${q.id}, 'Completed')">Complete</button>` : ''}
          </td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><p>No OPD visits registered today yet.</p></div>`}
      </div>
    </div>
  `;
  qs('#opd-new-btn').onclick = () => openOpdRegistrationModal();
});

async function updateOpdStatus(id, status) {
  try {
    await Api.put(`/opd/${id}/status`, { status });
    toastSuccess('Status updated');
    router();
  } catch (e) { toastError(e); }
}

// ============================= DOCTOR CONSULTATION =============================
registerRoute('/consultation', async (params, content) => {
  const doctors = await Api.get('/hospital/doctors');
  const myDoctor = doctors.find(d => d.user_id === Api.user.id) || doctors[0];

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Consultation</h1><p class="sub">Today's patients${myDoctor ? ` — ${esc(myDoctor.name)}` : ''}</p></div>
      <div class="form-group" style="margin-bottom:0;max-width:260px">
        <select id="consult-doctor-select">${doctors.map(d => `<option value="${d.id}" ${myDoctor && d.id===myDoctor.id ? 'selected':''}>${esc(d.name)}</option>`).join('')}</select>
      </div>
    </div>
    <div class="card" id="consult-list-card"><div class="loading-spin"><div class="spinner"></div></div></div>
  `;

  async function loadList(doctorId) {
    const list = await Api.get(`/consultations/today/${doctorId}`);
    const card = qs('#consult-list-card');
    if (!list.length) { card.innerHTML = `<div class="empty-state"><p>No patients in today's queue for this doctor.</p></div>`; return; }
    card.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Token</th><th>Patient</th><th>Age/Gender</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(v => `<tr>
        <td>${v.token_number || '-'}</td>
        <td class="table-link" onclick="location.hash='#/patients/${v.patient_id}'">${esc(v.full_name)}</td>
        <td>${v.age || '-'} / ${esc(v.gender || '-')}</td>
        <td>${badgeForOpdStatus(v.status)}</td>
        <td>${v.status !== 'Completed' ? `<button class="btn btn-sm btn-primary" onclick="openConsultModal('${v.patient_id}', ${v.id}, ${doctorId}, '${esc(v.full_name).replace(/'/g,"\\'")}')">Consult</button>` : `<span class="muted">Done</span>`}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  qs('#consult-doctor-select').onchange = (e) => loadList(e.target.value);
  if (myDoctor) loadList(myDoctor.id);
});

function openConsultModal(patientId, opdVisitId, doctorId, patientName) {
  const { overlay, close } = openModal({
    title: `Consultation — ${patientName} (${patientId})`,
    size: 'lg',
    bodyHtml: `
      <div class="form-row">
        <div class="form-group"><label>Chief Complaint</label><input type="text" id="c-complaint"></div>
        <div class="form-group"><label>Symptoms</label><input type="text" id="c-symptoms"></div>
      </div>
      <div class="section-title" style="margin-top:0">Vitals</div>
      <div class="form-row">
        <div class="form-group"><label>Temperature</label><input type="text" id="c-temp" placeholder="98.6 F"></div>
        <div class="form-group"><label>Pulse</label><input type="text" id="c-pulse" placeholder="78 bpm"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Blood Pressure</label><input type="text" id="c-bp" placeholder="120/80"></div>
        <div class="form-group"><label>SpO2</label><input type="text" id="c-spo2" placeholder="98%"></div>
      </div>
      <div class="form-group"><label>Diagnosis</label><input type="text" id="c-diagnosis"></div>
      <div class="form-group"><label>Clinical Notes</label><textarea id="c-notes" rows="2"></textarea></div>
      <div class="form-group"><label>Treatment</label><textarea id="c-treatment" rows="2"></textarea></div>
      <div class="form-row">
        <div class="form-group"><label>Medicines</label><input type="text" id="c-medicines" placeholder="e.g. Paracetamol 500mg BD"></div>
        <div class="form-group"><label>Lab Investigations</label><input type="text" id="c-lab" placeholder="e.g. CBC, X-Ray"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Advice</label><input type="text" id="c-advice"></div>
        <div class="form-group"><label>Follow-up Date</label><input type="date" id="c-followup"></div>
      </div>
      <div class="section-title" style="margin-top:0">Decision</div>
      <div class="form-group">
        <select id="c-decision">
          <option value="OPD Treatment">OPD Treatment</option>
          <option value="Recommend Admission">Recommend Admission (Hospitalization required)</option>
        </select>
      </div>
      <button class="btn btn-primary btn-block" id="c-submit">Save Consultation</button>
    `,
    onMount: (overlay) => {
      qs('#c-submit', overlay).onclick = async () => {
        const btn = qs('#c-submit', overlay);
        btn.disabled = true; btn.textContent = 'Saving...';
        try {
          await Api.post('/consultations', {
            opd_visit_id: opdVisitId, patient_id: patientId, doctor_id: doctorId,
            chief_complaint: qs('#c-complaint', overlay).value,
            symptoms: qs('#c-symptoms', overlay).value,
            vitals: { temperature: qs('#c-temp', overlay).value, pulse: qs('#c-pulse', overlay).value, bp: qs('#c-bp', overlay).value, spo2: qs('#c-spo2', overlay).value },
            diagnosis: qs('#c-diagnosis', overlay).value,
            clinical_notes: qs('#c-notes', overlay).value,
            treatment: qs('#c-treatment', overlay).value,
            medicines: qs('#c-medicines', overlay).value,
            lab_investigations: qs('#c-lab', overlay).value,
            advice: qs('#c-advice', overlay).value,
            follow_up_date: qs('#c-followup', overlay).value,
            decision: qs('#c-decision', overlay).value,
          });
          toastSuccess('Consultation saved');
          close();
          router();
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Save Consultation'; }
      };
    }
  });
}
