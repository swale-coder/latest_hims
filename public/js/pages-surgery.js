registerRoute('/surgery', async (params, content) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7);
  const active = await Api.get('/admissions?status=Active');

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Surgery / Procedures</h1><p class="sub">Record surgical procedures and instrument usage</p></div>
      <button class="btn btn-primary" id="new-surgery-btn">${Icon.plus} Record Surgery</button>
    </div>
    <div class="card">
      <div class="card-header"><h3>Active Patients</h3><p>Select a patient to view or record surgery details</p></div>
      <div class="table-wrap">
        ${active.length ? `<table><thead><tr><th>Patient</th><th>Bed</th><th>Diagnosis</th><th></th></tr></thead>
        <tbody>${active.map(a => `<tr>
          <td class="table-link" onclick="location.hash='#/patients/${a.patient_id}'">${esc(a.full_name)}</td>
          <td>${esc(a.bed_number || '-')}</td><td>${esc(a.diagnosis || '-')}</td>
          <td><button class="btn btn-sm btn-secondary" onclick="openSurgeryModal('${a.patient_id}', '${esc(a.full_name).replace(/'/g,"\\'")}', ${a.id})">Record Surgery</button></td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><p>No active admissions.</p></div>`}
      </div>
    </div>
  `;
  qs('#new-surgery-btn').onclick = () => openSurgeryModal();
});

function openSurgeryModal(prefillPid, prefillName, admissionId) {
  const { overlay, close } = openModal({
    title: prefillName ? `Record Surgery — ${prefillName}` : 'Record Surgery',
    size: 'lg',
    bodyHtml: `
      <div class="form-group"><label>Patient ID *</label><input type="text" id="s-pid" value="${prefillPid || ''}" placeholder="e.g. PAT-000001"></div>
      <div class="form-group"><label>Procedure / Surgery Name *</label><input type="text" id="s-name"></div>
      <div class="form-row">
        <div class="form-group"><label>Date</label><input type="date" id="s-date" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-group"><label>Time</label><input type="time" id="s-time"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Surgeon</label><input type="text" id="s-surgeon"></div>
        <div class="form-group"><label>Assistant</label><input type="text" id="s-assistant"></div>
      </div>
      <div class="form-group"><label>Anaesthetist</label><input type="text" id="s-anaesthetist"></div>
      <div class="form-group"><label>Diagnosis</label><input type="text" id="s-diagnosis"></div>
      <div class="form-group"><label>Procedure Notes</label><textarea id="s-notes" rows="2"></textarea></div>
      <div class="form-group"><label>Post-operative Notes</label><textarea id="s-postop" rows="2"></textarea></div>
      <div class="form-group"><label>Upload Document (optional)</label><input type="file" id="s-doc" accept=".pdf,.jpg,.jpeg,.png"></div>
      <button class="btn btn-primary btn-block" id="s-submit">Save Surgery Record</button>
    `,
    onMount: (overlay) => {
      qs('#s-submit', overlay).onclick = async () => {
        const pid = qs('#s-pid', overlay).value.trim().toUpperCase();
        const name = qs('#s-name', overlay).value.trim();
        if (!pid || !name) { toastError({ message: 'Patient ID and procedure name are required' }); return; }
        const btn = qs('#s-submit', overlay);
        btn.disabled = true; btn.textContent = 'Saving...';
        try {
          const fd = new FormData();
          fd.append('patient_id', pid);
          if (admissionId) fd.append('admission_id', admissionId);
          fd.append('procedure_name', name);
          fd.append('surgery_date', qs('#s-date', overlay).value);
          fd.append('surgery_time', qs('#s-time', overlay).value);
          fd.append('surgeon', qs('#s-surgeon', overlay).value);
          fd.append('assistant', qs('#s-assistant', overlay).value);
          fd.append('anaesthetist', qs('#s-anaesthetist', overlay).value);
          fd.append('diagnosis', qs('#s-diagnosis', overlay).value);
          fd.append('procedure_notes', qs('#s-notes', overlay).value);
          fd.append('post_op_notes', qs('#s-postop', overlay).value);
          const file = qs('#s-doc', overlay).files[0];
          if (file) fd.append('document', file);
          const res = await Api.post('/surgery', fd, true);
          toastSuccess('Surgery recorded');
          close();
          openSurgicalItemsModal(res.id, pid);
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Save Surgery Record'; }
      };
    }
  });
}

function openSurgicalItemsModal(surgeryId, patientId) {
  const items = [];
  const { overlay, close } = openModal({
    title: 'Add Surgical Instruments / Consumables',
    bodyHtml: `
      <p class="muted" style="margin-bottom:14px">Optionally record instruments and consumables used in this procedure.</p>
      <div class="form-row">
        <div class="form-group"><label>Item Name</label><input type="text" id="si-name" placeholder="e.g. Surgical Gloves"></div>
        <div class="form-group"><label>Category</label><input type="text" id="si-category" placeholder="e.g. Consumable"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Quantity</label><input type="number" id="si-qty" value="1"></div>
        <div class="form-group"><label>Batch Number</label><input type="text" id="si-batch"></div>
      </div>
      <button class="btn btn-secondary btn-block" id="si-add">Add Item</button>
      <div id="si-list" style="margin-top:14px"></div>
      <button class="btn btn-primary btn-block" id="si-done" style="margin-top:16px">Done</button>
    `,
    onMount: (overlay) => {
      const list = qs('#si-list', overlay);
      function renderList() {
        list.innerHTML = items.map(i => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:12.5px">
          <span>${esc(i.item_name)} ${i.item_category ? `(${esc(i.item_category)})` : ''}</span><span>Qty: ${i.quantity}</span></div>`).join('');
      }
      qs('#si-add', overlay).onclick = async () => {
        const item_name = qs('#si-name', overlay).value.trim();
        if (!item_name) return;
        const payload = { item_name, item_category: qs('#si-category', overlay).value, quantity: parseInt(qs('#si-qty', overlay).value, 10) || 1, batch_number: qs('#si-batch', overlay).value };
        try {
          await Api.post(`/surgery/${surgeryId}/items`, payload);
          items.push(payload);
          renderList();
          qs('#si-name', overlay).value = ''; qs('#si-category', overlay).value = ''; qs('#si-qty', overlay).value = '1'; qs('#si-batch', overlay).value = '';
          toastSuccess('Item added');
        } catch (e) { toastError(e); }
      };
      qs('#si-done', overlay).onclick = () => { close(); location.hash = `#/patients/${patientId}`; router(); };
    }
  });
}
