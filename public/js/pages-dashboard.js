registerRoute('/dashboard', async (params, content) => {
  const d = await Api.get('/dashboard');

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Good day, ${esc(Api.user.name.split(' ')[0])}</h1><p class="sub">Here's what's happening at the hospital today.</p></div>
    </div>

    <div class="grid grid-4" style="margin-bottom:20px">
      <div class="stat-card accent-teal"><div class="stat-label">Total Beds</div><div class="stat-value">${d.beds.total}</div><div class="stat-foot">${d.beds.occupancyRate}% occupancy</div></div>
      <div class="stat-card accent-red"><div class="stat-label">Occupied</div><div class="stat-value">${d.beds.Occupied}</div><div class="stat-foot">${d.beds.Available} available</div></div>
      <div class="stat-card accent-blue"><div class="stat-label">Today's OPD</div><div class="stat-value">${d.todayOPD}</div><div class="stat-foot">${d.opdStatus.waiting} waiting</div></div>
      <div class="stat-card accent-green"><div class="stat-label">Today's Admissions</div><div class="stat-value">${d.todayAdmissions}</div><div class="stat-foot">${d.todayDischarges} discharged today</div></div>
    </div>

    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <div class="card-header"><h3>Bed Occupancy</h3></div>
        <div class="card-pad">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--ink-faint);margin-bottom:8px">
            <span>${d.beds.Occupied} of ${d.beds.total} occupied</span><span>${d.beds.occupancyRate}%</span>
          </div>
          <div class="progress-bar"><div style="width:${d.beds.occupancyRate}%"></div></div>
          <div class="grid grid-4" style="margin-top:18px;gap:10px">
            ${['Available','Occupied','Cleaning','Maintenance'].map(s => `
              <div style="text-align:center">
                <div style="font-size:20px;font-weight:750">${d.beds[s]}</div>
                <div style="font-size:11px;color:var(--ink-faint)">${s}</div>
              </div>`).join('')}
          </div>
          <button class="btn btn-ghost btn-sm" style="margin-top:14px" onclick="location.hash='#/beds'">View bed map ${Icon.chevronRight}</button>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3>Today's OPD</h3></div>
        <div class="card-pad">
          <div class="grid grid-3">
            <div style="text-align:center"><div style="font-size:20px;font-weight:750;color:var(--amber)">${d.opdStatus.waiting}</div><div style="font-size:11px;color:var(--ink-faint)">Waiting</div></div>
            <div style="text-align:center"><div style="font-size:20px;font-weight:750;color:var(--blue)">${d.opdStatus.inConsultation}</div><div style="font-size:11px;color:var(--ink-faint)">In Consultation</div></div>
            <div style="text-align:center"><div style="font-size:20px;font-weight:750;color:var(--green)">${d.opdStatus.completed}</div><div style="font-size:11px;color:var(--ink-faint)">Completed</div></div>
          </div>
          <button class="btn btn-ghost btn-sm" style="margin-top:14px" onclick="location.hash='#/opd'">Open OPD queue ${Icon.chevronRight}</button>
        </div>
      </div>
    </div>

    <div class="grid grid-2" style="align-items:start;margin-top:16px">
      <div class="card">
        <div class="card-header"><h3>Current Admissions</h3><span class="muted" style="font-size:12px">${d.currentAdmissions.length} active</span></div>
        <div class="table-wrap">
          ${d.currentAdmissions.length ? `<table><thead><tr><th>Patient</th><th>Bed</th><th>Doctor</th><th>Diagnosis</th></tr></thead><tbody>
            ${d.currentAdmissions.map(a => `<tr>
              <td class="table-link" onclick="location.hash='#/patients/${a.patient_id}'">${esc(a.full_name)}</td>
              <td>${esc(a.bed_number || '-')}</td><td>${esc(a.doctor_name || '-')}</td><td>${esc(a.diagnosis || '-')}</td>
            </tr>`).join('')}
          </tbody></table>` : `<div class="empty-state"><p>No patients currently admitted.</p></div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3>Pending Lab</h3><span class="muted" style="font-size:12px">${d.pendingLab.length} pending</span></div>
        <div class="table-wrap">
          ${d.pendingLab.length ? `<table><thead><tr><th>Patient</th><th>Test</th><th>Status</th></tr></thead><tbody>
            ${d.pendingLab.map(l => `<tr><td class="table-link" onclick="location.hash='#/patients/${l.patient_id}'">${esc(l.full_name)}</td><td>${esc(l.test_name)}</td><td><span class="badge badge-amber">${esc(l.status)}</span></td></tr>`).join('')}
          </tbody></table>` : `<div class="empty-state"><p>No pending lab tests.</p></div>`}
        </div>
      </div>
    </div>

    <div class="grid grid-2" style="align-items:start;margin-top:16px">
      <div class="card">
        <div class="card-header"><h3>Today's Surgeries</h3></div>
        <div class="table-wrap">
          ${d.todaySurgeries.length ? `<table><thead><tr><th>Patient</th><th>Procedure</th><th>Doctor</th><th>Time</th></tr></thead><tbody>
            ${d.todaySurgeries.map(s => `<tr><td class="table-link" onclick="location.hash='#/patients/${s.patient_id}'">${esc(s.full_name)}</td><td>${esc(s.procedure_name)}</td><td>${esc(s.surgeon || '-')}</td><td>${esc(s.surgery_time || '-')}</td></tr>`).join('')}
          </tbody></table>` : `<div class="empty-state"><p>No surgeries scheduled today.</p></div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3>Recent Activity</h3></div>
        <div class="card-pad" style="max-height:340px;overflow-y:auto">
          ${d.recentActivity.length ? d.recentActivity.map(a => `
            <div style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--line-soft)">
              <div style="width:7px;height:7px;border-radius:50%;background:var(--teal-500);margin-top:6px;flex-shrink:0"></div>
              <div>
                <div style="font-size:12.5px;font-weight:600">${esc(a.event)} <span class="muted" style="font-weight:500">— ${esc(a.patient_id)}</span></div>
                <div style="font-size:11.5px;color:var(--ink-faint)">${esc(a.detail || '')} · ${fmtTimeAgo(a.event_date)}</div>
              </div>
            </div>`).join('') : `<div class="empty-state"><p>No recent activity.</p></div>`}
        </div>
      </div>
    </div>
  `;
});
