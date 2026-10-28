registerRoute('/lab', async (params, content) => {
  const canManage = ['lab_staff', 'hospital_admin', 'organization_owner'].includes(Api.user.role);
  const orders = canManage ? await Api.get('/lab/pending') : await Api.get('/lab/all');

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Laboratory</h1><p class="sub">${canManage ? 'Pending test orders' : 'All lab orders'}</p></div>
      <button class="btn btn-primary" id="lab-order-btn">${Icon.plus} Order Lab Test</button>
    </div>
    <div class="card">
      <div class="table-wrap">
        ${orders.length ? `<table><thead><tr><th>Patient</th><th>Test</th><th>Ordered</th><th>Status</th><th></th></tr></thead>
        <tbody>${orders.map(o => `<tr>
          <td class="table-link" onclick="location.hash='#/patients/${o.patient_id}'">${esc(o.full_name)}</td>
          <td>${esc(o.test_name)}</td><td>${fmtDateTime(o.ordered_at)}</td>
          <td><span class="badge badge-blue">${esc(o.status)}</span></td>
          <td>${canManage ? labActionButtons(o) : labReportLink(o)}</td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><p>No lab orders to show.</p></div>`}
      </div>
    </div>
  `;
  qs('#lab-order-btn').onclick = () => openLabOrderModal();
});

function labActionButtons(o) {
  if (o.status === 'Ordered') return `<button class="btn btn-sm btn-secondary" onclick="labTransition(${o.id}, 'collect')">Mark Sample Collected</button>`;
  if (o.status === 'Sample Collected') return `<button class="btn btn-sm btn-secondary" onclick="labTransition(${o.id}, 'processing')">Start Processing</button>`;
  if (o.status === 'Processing') return `<button class="btn btn-sm btn-primary" onclick="openLabResultModal(${o.id}, '${esc(o.test_name).replace(/'/g,"\\'")}')">Enter Result</button>`;
  return labReportLink(o) || '<span class="muted">Done</span>';
}
function labReportLink(o) {
  if (!o.report_file) return '';
  return `<a class="btn btn-sm btn-secondary" href="${esc(Api.fileUrl(o.report_file))}" target="_blank" rel="noopener">View Report</a>`;
}
async function labTransition(id, action) {
  try { await Api.put(`/lab/orders/${id}/${action}`); toastSuccess('Updated'); router(); } catch (e) { toastError(e); }
}

function openLabOrderModal() {
  const { overlay, close } = openModal({
    title: 'Order Lab Test',
    bodyHtml: `
      <div class="form-group"><label>Patient ID *</label><input type="text" id="lab-pid" placeholder="e.g. PAT-000001"></div>
      <div class="form-group"><label>Test Name *</label>
        <select id="lab-test">
          <option>Complete Blood Count (CBC)</option><option>Blood Sugar (Fasting)</option><option>Urine Routine</option>
          <option>X-Ray</option><option>Ultrasound</option><option>Liver Function Test</option><option>Kidney Function Test</option><option>Other</option>
        </select>
      </div>
      <button class="btn btn-primary btn-block" id="lab-order-submit">Order Test</button>
    `,
    onMount: (overlay) => {
      qs('#lab-order-submit', overlay).onclick = async () => {
        const pid = qs('#lab-pid', overlay).value.trim().toUpperCase();
        if (!pid) { toastError({ message: 'Patient ID is required' }); return; }
        try {
          await Api.post('/lab/orders', { patient_id: pid, test_name: qs('#lab-test', overlay).value });
          toastSuccess('Lab test ordered'); close(); router();
        } catch (e) { toastError(e); }
      };
    }
  });
}

function openLabResultModal(orderId, testName) {
  const { overlay, close } = openModal({
    title: `Enter Result — ${testName}`,
    bodyHtml: `
      <div class="form-group"><label>Result Summary</label><textarea id="lab-result-text" rows="4" placeholder="e.g. Hemoglobin: 13.2 g/dL, WBC: 7,200/uL - within normal limits"></textarea></div>
      <div class="form-group"><label>Upload Report (PDF/Image, optional)</label><input type="file" id="lab-result-file" accept=".pdf,.jpg,.jpeg,.png"></div>
      <button class="btn btn-primary btn-block" id="lab-result-submit">Finalize Report</button>
    `,
    onMount: (overlay) => {
      qs('#lab-result-submit', overlay).onclick = async () => {
        const btn = qs('#lab-result-submit', overlay);
        btn.disabled = true; btn.textContent = 'Saving...';
        try {
          const fd = new FormData();
          fd.append('result', qs('#lab-result-text', overlay).value);
          const file = qs('#lab-result-file', overlay).files[0];
          if (file) fd.append('report', file);
          await Api.put(`/lab/orders/${orderId}/result`, fd, true);
          toastSuccess('Report finalized'); close(); router();
        } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Finalize Report'; }
      };
    }
  });
}
