registerRoute('/discharge', async (params, content) => {
  const active = await Api.get('/admissions?status=Active');

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Discharge Management</h1><p class="sub">Generate and finalize discharge summaries</p></div>
    </div>
    <div class="card">
      <div class="card-header"><h3>Active Admissions</h3></div>
      <div class="table-wrap">
        ${active.length ? `<table><thead><tr><th>Patient</th><th>Bed</th><th>Doctor</th><th>Admitted</th><th></th></tr></thead>
        <tbody>${active.map(a => `<tr>
          <td class="table-link" onclick="location.hash='#/patients/${a.patient_id}'">${esc(a.full_name)}</td>
          <td>${esc(a.bed_number || '-')}</td><td>${esc(a.attending_doctor_name || '-')}</td><td>${fmtDate(a.admitted_at)}</td>
          <td><button class="btn btn-sm btn-primary" onclick="openDischargeModal(${a.id}, '${esc(a.full_name).replace(/'/g,"\\'")}', '${a.patient_id}')">Discharge Patient</button></td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><p>No active admissions to discharge.</p></div>`}
      </div>
    </div>
  `;
});

async function openDischargeModal(admissionId, patientName, patientId) {
  const { overlay, close } = openModal({
    title: `Discharge Summary — ${patientName}`,
    size: 'lg',
    bodyHtml: `<div class="loading-spin"><div class="spinner"></div></div>`,
    onMount: async (overlay) => {
      let summary;
      try {
        const res = await Api.post(`/discharge/generate/${admissionId}`);
        summary = res.summary;
      } catch (e) { toastError(e); close(); return; }

      const readOnly = summary.status === 'Finalized';
      qs('.modal-body', overlay).innerHTML = `
        <div class="section-title" style="margin-top:0">Billing</div>
        <div id="ds-billing-panel" style="margin-bottom:22px"></div>
        <div class="section-title">Discharge Summary</div>
        ${readOnly ? `<div class="badge badge-green" style="margin-bottom:14px">Finalized</div>` : `<p class="hint" style="margin-bottom:14px">Auto-generated from the patient's stored medical record. Review and edit before finalizing.</p>`}
        <div class="form-group"><label>Diagnosis</label><textarea id="ds-diagnosis" rows="2" ${readOnly?'disabled':''}>${esc(summary.diagnosis)}</textarea></div>
        <div class="form-group"><label>Reason for Admission</label><textarea id="ds-reason" rows="2" ${readOnly?'disabled':''}>${esc(summary.reason_for_admission)}</textarea></div>
        <div class="form-group"><label>Clinical Summary</label><textarea id="ds-clinical" rows="3" ${readOnly?'disabled':''}>${esc(summary.clinical_summary)}</textarea></div>
        <div class="form-group"><label>Investigations</label><textarea id="ds-invest" rows="2" ${readOnly?'disabled':''}>${esc(summary.investigations)}</textarea></div>
        <div class="form-group"><label>Treatment Given</label><textarea id="ds-treatment" rows="2" ${readOnly?'disabled':''}>${esc(summary.treatment_given)}</textarea></div>
        <div class="form-group"><label>Procedures / Surgery</label><textarea id="ds-procedures" rows="2" ${readOnly?'disabled':''}>${esc(summary.procedures)}</textarea></div>
        <div class="form-group"><label>Medications</label><textarea id="ds-medications" rows="2" ${readOnly?'disabled':''}>${esc(summary.medications)}</textarea></div>
        <div class="form-group"><label>Condition at Discharge</label><input type="text" id="ds-condition" value="${esc(summary.condition_at_discharge)}" ${readOnly?'disabled':''}></div>
        <div class="form-group"><label>Advice</label><textarea id="ds-advice" rows="2" ${readOnly?'disabled':''}>${esc(summary.advice)}</textarea></div>
        <div class="form-group"><label>Follow-up</label><input type="text" id="ds-followup" value="${esc(summary.follow_up)}" ${readOnly?'disabled':''}></div>
        <div class="form-group"><label>Emergency Contact Instructions</label><textarea id="ds-emergency" rows="2" ${readOnly?'disabled':''}>${esc(summary.emergency_instructions)}</textarea></div>
        <div class="form-group"><label>Doctor</label><input type="text" id="ds-doctor" value="${esc(summary.doctor_name)}" ${readOnly?'disabled':''}></div>
        ${!readOnly ? `
        <div style="display:flex;gap:10px;margin-top:10px">
          <button class="btn btn-secondary btn-block" id="ds-save-draft">Save Draft</button>
          <button class="btn btn-primary btn-block" id="ds-finalize">Finalize &amp; Generate PDF</button>
        </div>` : `<a class="btn btn-primary btn-block" href="${Api.fileUrl(summary.pdf_path)}" target="_blank" style="margin-top:10px">${Icon.download} View PDF</a>`}
      `;

      renderBillingPanel(qs('#ds-billing-panel', overlay), admissionId);

      function collectFields() {
        return {
          diagnosis: qs('#ds-diagnosis', overlay).value, reason_for_admission: qs('#ds-reason', overlay).value,
          clinical_summary: qs('#ds-clinical', overlay).value, investigations: qs('#ds-invest', overlay).value,
          treatment_given: qs('#ds-treatment', overlay).value, procedures: qs('#ds-procedures', overlay).value,
          medications: qs('#ds-medications', overlay).value, condition_at_discharge: qs('#ds-condition', overlay).value,
          advice: qs('#ds-advice', overlay).value, follow_up: qs('#ds-followup', overlay).value,
          emergency_instructions: qs('#ds-emergency', overlay).value, doctor_name: qs('#ds-doctor', overlay).value
        };
      }

      const saveBtn = qs('#ds-save-draft', overlay);
      if (saveBtn) saveBtn.onclick = async () => {
        try { await Api.put(`/discharge/${summary.id}`, collectFields()); toastSuccess('Draft saved'); }
        catch (e) { toastError(e); }
      };
      const finalizeBtn = qs('#ds-finalize', overlay);
      if (finalizeBtn) finalizeBtn.onclick = async () => {
        const ok = await confirmDialog('Finalize this discharge summary? This will generate the PDF, discharge the patient, and release the bed for cleaning. This cannot be undone.');
        if (!ok) return;
        finalizeBtn.disabled = true; finalizeBtn.textContent = 'Finalizing...';
        try {
          await Api.put(`/discharge/${summary.id}`, collectFields());
          const res = await Api.post(`/discharge/${summary.id}/finalize`);
          toastSuccess('Patient discharged successfully');
          close();
          window.open(Api.fileUrl(res.pdf), '_blank');
          router();
        } catch (e) { toastError(e); finalizeBtn.disabled = false; finalizeBtn.textContent = 'Finalize & Generate PDF'; }
      };
    }
  });
}
