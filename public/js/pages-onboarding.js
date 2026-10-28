registerRoute('/onboarding', async (params, content) => {
  const status = await Api.get('/onboarding/status');
  const org = status.organization;

  function stepCard(done, title, description, cta) {
    return `<div class="card" style="padding:20px;margin-bottom:14px;display:flex;gap:16px;align-items:flex-start">
      <div style="width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;
        background:${done ? 'var(--teal-600)' : 'var(--line-soft)'};color:${done ? '#fff' : 'var(--ink-faint)'};font-weight:700;font-size:14px">${done ? '\u2713' : ''}</div>
      <div style="flex:1">
        <h3 style="margin:0 0 4px">${title}</h3>
        <p class="hint" style="margin-bottom:10px">${description}</p>
        ${cta || ''}
      </div>
    </div>`;
  }

  content.innerHTML = `
    <div class="page-header"><div><h1>Get Your Hospital Set Up</h1><p class="sub">A few steps to get ${esc(org.name)} fully ready</p></div></div>

    ${status.trialEndsAt ? `<div class="card" style="padding:14px 18px;margin-bottom:20px;background:var(--soft-blue,#EAF2FF)"><strong>Trial ends ${fmtDate(status.trialEndsAt)}.</strong> Choose a plan any time before then to keep uninterrupted access.</div>` : ''}

    ${stepCard(status.checklist.hospitalProfile, '1. Complete Your Hospital Profile',
      'Bed count and expected monthly OPD volume help us recommend the right plan.',
      `<button class="btn btn-primary btn-sm" id="edit-profile-btn">Edit Profile</button>`)}

    ${stepCard(status.checklist.planSelected, '2. Choose a Subscription Plan',
      'Pick the plan that matches your hospital size. All plans include a free trial.',
      `<a href="#/subscription" class="btn btn-primary btn-sm">Choose a Plan</a>`)}

    ${stepCard(status.checklist.structureSetUp, '3. Set Up Your Hospital Structure',
      'Add floors, rooms and beds so admissions and bed allocation work correctly.',
      `<a href="#/administration" class="btn btn-primary btn-sm">Set Up Structure</a>`)}

    ${stepCard(status.checklist.staffInvited, '4. Invite Your Staff',
      'Add accounts for your doctors, receptionists, nurses and other staff.',
      `<a href="#/administration" class="btn btn-primary btn-sm">Invite Staff</a>`)}

    <div class="card" style="padding:20px;margin-top:20px;text-align:center">
      <p class="hint" style="margin-bottom:12px">${Object.values(status.checklist).every(Boolean)
        ? "Everything's set up! You're ready to mark onboarding complete."
        : 'You can finish setup later, but completing every step above gets your hospital fully operational faster.'}</p>
      <button class="btn ${Object.values(status.checklist).every(Boolean) ? 'btn-primary' : 'btn-secondary'}" id="finish-onboarding-btn">
        ${status.onboardingCompleted ? 'Onboarding Complete \u2713' : 'Mark Onboarding Complete'}
      </button>
    </div>
  `;

  qs('#edit-profile-btn').onclick = () => {
    openModal({
      title: 'Hospital Profile',
      bodyHtml: `
        <div class="form-group"><label>Bed Count</label><input type="number" id="p-beds" value="${org.bed_count || ''}"></div>
        <div class="form-group"><label>Expected Monthly OPD</label><input type="number" id="p-opd" value="${org.expected_monthly_opd || ''}"></div>
        <div class="form-group"><label>GSTIN</label><input type="text" id="p-gstin" value="${org.gstin || ''}"></div>
        <div class="form-group"><label>Registration Number</label><input type="text" id="p-reg" value="${org.registration_number || ''}"></div>
        <div class="form-group"><label>Invoice Prefix</label><input type="text" id="p-inv-prefix" value="${org.invoice_prefix || 'INV'}"></div>
        <div class="form-group"><label>Patient ID Prefix</label><input type="text" id="p-pat-prefix" value="${org.patient_id_prefix || 'PAT'}"></div>
        <button class="btn btn-primary btn-block" id="save-profile-btn">Save Profile</button>
      `,
      onMount: (overlay, close) => {
        qs('#save-profile-btn', overlay).onclick = async () => {
          try {
            await Api.put('/onboarding/profile', {
              bed_count: qs('#p-beds', overlay).value ? Number(qs('#p-beds', overlay).value) : null,
              expected_monthly_opd: qs('#p-opd', overlay).value ? Number(qs('#p-opd', overlay).value) : null,
              gstin: qs('#p-gstin', overlay).value,
              registration_number: qs('#p-reg', overlay).value,
              invoice_prefix: qs('#p-inv-prefix', overlay).value,
              patient_id_prefix: qs('#p-pat-prefix', overlay).value
            });
            toastSuccess('Hospital profile saved');
            close();
            router();
          } catch (e) { toastError(e); }
        };
      }
    });
  };

  qs('#finish-onboarding-btn').onclick = async () => {
    try {
      await Api.put('/onboarding/step', { step: 'completed' });
      toastSuccess('Onboarding marked complete');
      router();
    } catch (e) { toastError(e); }
  };
});
