registerRoute('/reports', async (params, content) => {
  content.innerHTML = `
    <div class="page-header"><div><h1>Reports</h1><p class="sub">Operational reports across the hospital</p></div></div>
    <div class="tabs" id="report-tabs">
      ${['Daily OPD','Daily Admissions','Daily Discharges','Bed Occupancy','Pending Lab','Completed Lab','Management Summary'].map((t,i) =>
        `<div class="tab-btn ${i===0?'active':''}" data-tab="${t}">${t}</div>`).join('')}
    </div>
    <div id="report-content"></div>
  `;
  const reportContent = qs('#report-content');

  async function loadReport(tab) {
    reportContent.innerHTML = `<div class="loading-spin"><div class="spinner"></div></div>`;
    const today = new Date().toISOString().slice(0, 10);
    if (tab === 'Daily OPD') {
      const rows = await Api.get(`/reports/daily-opd?date=${today}`);
      reportContent.innerHTML = tableCard('Daily OPD — ' + fmtDate(today), ['OPD No.','Patient','Department','Doctor','Status'],
        rows.map(r => [r.opd_number, r.full_name, r.department || '-', r.doctor || '-', badgeForOpdStatus(r.status)]));
    } else if (tab === 'Daily Admissions') {
      const rows = await Api.get(`/reports/daily-admissions?date=${today}`);
      reportContent.innerHTML = tableCard('Daily Admissions — ' + fmtDate(today), ['Admission No.','Patient','Doctor','Bed','Type'],
        rows.map(r => [r.admission_number, r.full_name, r.doctor || '-', r.bed_number || '-', r.admission_type]));
    } else if (tab === 'Daily Discharges') {
      const rows = await Api.get(`/reports/daily-discharges?date=${today}`);
      reportContent.innerHTML = tableCard('Daily Discharges — ' + fmtDate(today), ['Admission No.','Patient','Discharged At'],
        rows.map(r => [r.admission_number, r.full_name, fmtDateTime(r.discharged_at)]));
    } else if (tab === 'Bed Occupancy') {
      const rows = await Api.get('/reports/bed-occupancy');
      reportContent.innerHTML = tableCard('Bed Occupancy by Room', ['Floor','Room','Type','Total','Occupied','Available'],
        rows.map(r => [r.floor, r.room, r.room_type, r.total, r.occupied, r.available]));
    } else if (tab === 'Pending Lab') {
      const rows = await Api.get('/reports/clinical-pending-lab');
      reportContent.innerHTML = tableCard('Pending Lab Tests', ['Patient','Test','Status','Ordered'],
        rows.map(r => [r.full_name, r.test_name, r.status, fmtDateTime(r.ordered_at)]));
    } else if (tab === 'Completed Lab') {
      const rows = await Api.get('/reports/clinical-completed-lab');
      reportContent.innerHTML = tableCard('Completed Lab Reports', ['Patient','Test','Result','Finalized'],
        rows.map(r => [r.full_name, r.test_name, r.result || '-', fmtDateTime(r.finalized_at)]));
    } else if (tab === 'Management Summary') {
      const s = await Api.get('/reports/management-summary');
      reportContent.innerHTML = `
        <div class="card card-pad">
          <p class="muted" style="margin-bottom:16px">Last 30 days: ${fmtDate(s.from)} — ${fmtDate(s.to)}</p>
          <div class="grid grid-4">
            <div class="stat-card accent-teal"><div class="stat-label">Admissions</div><div class="stat-value">${s.admissions}</div></div>
            <div class="stat-card accent-green"><div class="stat-label">Discharges</div><div class="stat-value">${s.discharges}</div></div>
            <div class="stat-card accent-blue"><div class="stat-label">OPD Volume</div><div class="stat-value">${s.opd}</div></div>
            <div class="stat-card accent-amber"><div class="stat-label">Surgeries</div><div class="stat-value">${s.surgeries}</div></div>
          </div>
          <div style="margin-top:18px">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px"><span>Bed Utilization</span><span>${s.occupancyRate}%</span></div>
            <div class="progress-bar"><div style="width:${s.occupancyRate}%"></div></div>
          </div>
        </div>`;
    }
  }
  qsa('.tab-btn', qs('#report-tabs')).forEach(btn => {
    btn.onclick = () => { qsa('.tab-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); loadReport(btn.dataset.tab); };
  });
  loadReport('Daily OPD');
});
