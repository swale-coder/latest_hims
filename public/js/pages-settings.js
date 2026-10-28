registerRoute('/settings', async (params, content) => {
  const settings = await Api.get('/hospital/settings');
  content.innerHTML = `
    <div class="page-header"><div><h1>Settings</h1><p class="sub">Hospital information and SMS notification configuration</p></div></div>
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <div class="card-header"><h3>Hospital Information</h3></div>
        <div class="card-pad">
          <div class="form-group"><label>Hospital Name</label><input type="text" id="s-name" value="${esc(settings.hospital_name || '')}"></div>
          <div class="form-group"><label>Address</label><textarea id="s-address" rows="2">${esc(settings.hospital_address || '')}</textarea></div>
          <div class="form-group"><label>Phone</label><input type="text" id="s-phone" value="${esc(settings.hospital_phone || '')}"></div>
          <button class="btn btn-primary" id="s-save-hospital">Save</button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>SMS Provider Configuration</h3></div>
        <div class="card-pad">
          <p class="hint" style="margin-bottom:14px">Configure a SMS gateway to send real notifications. Without a configured provider, SMS events are recorded in the SMS log for demonstration purposes.</p>
          <div class="form-group"><label>Provider</label>
            <select id="s-sms-provider">
              <option value="not_configured" ${settings.sms_provider==='not_configured'?'selected':''}>Not configured (simulated)</option>
              <option value="twilio" ${settings.sms_provider==='twilio'?'selected':''}>Twilio</option>
              <option value="msg91" ${settings.sms_provider==='msg91'?'selected':''}>MSG91</option>
              <option value="textlocal" ${settings.sms_provider==='textlocal'?'selected':''}>Textlocal</option>
            </select>
          </div>
          <div class="form-group"><label>API Key</label><input type="text" id="s-sms-key" value="${esc(settings.sms_api_key || '')}" placeholder="Enter provider API key"></div>
          <button class="btn btn-primary" id="s-save-sms">Save SMS Settings</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-header"><h3>Recent SMS Log</h3></div>
      <div class="table-wrap" id="sms-log-table"><div class="loading-spin"><div class="spinner"></div></div></div>
    </div>
  `;

  qs('#s-save-hospital').onclick = async () => {
    try {
      await Api.put('/hospital/settings', { hospital_name: qs('#s-name').value, hospital_address: qs('#s-address').value, hospital_phone: qs('#s-phone').value });
      toastSuccess('Hospital settings saved');
    } catch (e) { toastError(e); }
  };
  qs('#s-save-sms').onclick = async () => {
    try {
      await Api.put('/hospital/settings', { sms_provider: qs('#s-sms-provider').value, sms_api_key: qs('#s-sms-key').value });
      toastSuccess('SMS settings saved');
    } catch (e) { toastError(e); }
  };

  const smsLogs = await Api.get('/notifications/sms-log');
  qs('#sms-log-table').innerHTML = smsLogs.length ? `<table><thead><tr><th>Patient</th><th>Event</th><th>Message</th><th>Status</th><th>Sent</th></tr></thead>
    <tbody>${smsLogs.map(s => `<tr><td class="mono">${esc(s.patient_id || '-')}</td><td>${esc(s.event_type)}</td>
      <td style="max-width:320px;white-space:normal">${esc(s.message)}</td><td><span class="badge badge-green">${esc(s.status)}</span></td><td>${fmtDateTime(s.created_at)}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty-state"><p>No SMS sent yet.</p></div>`;
});
