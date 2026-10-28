const bcrypt = require('bcryptjs');
const db = require('./db');
const { nextPatientId, nextOpdNumber, nextAdmissionNumber, logTimeline, sendSMS } = require('./utils/helpers');

const hash = (pw) => bcrypt.hashSync(pw, 10);

async function seedOrganization({ slug, name, city, state, usernameSuffix, ownerPassword }) {
  const orgInfo = await db.prepare(`
    INSERT INTO organizations (name, slug, org_type, status, city, state, contact_email, contact_phone, onboarding_completed)
    VALUES (?, ?, 'Hospital', 'active', ?, ?, ?, ?, 1)
  `).run(name, slug, city, state, `admin@${slug}.example`, '+91 90000 00000');
  const orgId = orgInfo.lastInsertRowid;

  const users = [
    ['System Administrator', `owner.${usernameSuffix}`, hash(ownerPassword), 'organization_owner', '9800000001', 'Administration'],
    ['Priya Nair (Manager)', `manager.${usernameSuffix}`, hash('manager123'), 'hospital_admin', '9800000002', 'Administration'],
    ['Rekha Menon (Reception)', `reception.${usernameSuffix}`, hash('reception123'), 'receptionist', '9800000003', 'Front Desk'],
    ['Dr. Arjun Sharma', `dr.sharma.${usernameSuffix}`, hash('doctor123'), 'doctor', '9800000004', 'General Medicine'],
    ['Dr. Kavita Iyer', `dr.iyer.${usernameSuffix}`, hash('doctor123'), 'doctor', '9800000005', 'Orthopedics'],
    ['Dr. Rohan Mehta', `dr.mehta.${usernameSuffix}`, hash('doctor123'), 'doctor', '9800000006', 'Pediatrics'],
    ['Dr. Sneha Kulkarni', `dr.kulkarni.${usernameSuffix}`, hash('doctor123'), 'doctor', '9800000007', 'Gynecology'],
    ['Dr. Vikram Rao', `dr.rao.${usernameSuffix}`, hash('doctor123'), 'doctor', '9800000008', 'General Surgery'],
    ['Anita Joseph (Nurse)', `nurse.anita.${usernameSuffix}`, hash('nurse123'), 'nurse', '9800000009', 'Nursing'],
    ['Sunil Verma (Nurse)', `nurse.sunil.${usernameSuffix}`, hash('nurse123'), 'nurse', '9800000010', 'Nursing'],
    ['Deepa Krishnan (Lab)', `lab.deepa.${usernameSuffix}`, hash('lab123'), 'lab_staff', '9800000011', 'Laboratory'],
    ['Manoj Pillai (Pharmacy)', `pharmacy.manoj.${usernameSuffix}`, hash('pharmacy123'), 'pharmacy_staff', '9800000012', 'Pharmacy']
  ];
  const insUser = db.prepare(`INSERT INTO users (organization_id, name, username, password_hash, role, phone, department) VALUES (?,?,?,?,?,?,?)`);
  const userIds = {};
  for (const u of users) { const info = await insUser.run(orgId, ...u); userIds[u[1].split('.').slice(0, -1).join('.')] = info.lastInsertRowid; }

  const settings = {
    hospital_name: name,
    hospital_address: `MG Road, ${city}, ${state}, India`,
    hospital_phone: '+91 484 000 1234',
    sms_provider: 'not_configured',
    sms_api_key: ''
  };
  const insSetting = db.prepare(`INSERT INTO hospital_settings (organization_id, key, value) VALUES (?,?,?)`);
  for (const [k, v] of Object.entries(settings)) await insSetting.run(orgId, k, v);

  const insFloor = db.prepare(`INSERT INTO floors (organization_id, name, floor_number) VALUES (?,?,?)`);
  const insRoom = db.prepare(`INSERT INTO rooms (organization_id, floor_id, name, room_type) VALUES (?,?,?,?)`);
  const insBed = db.prepare(`INSERT INTO beds (organization_id, room_id, bed_number, status) VALUES (?,?,?,?)`);

  const f1 = (await insFloor.run(orgId, 'Floor 1', 1)).lastInsertRowid;
  const f2 = (await insFloor.run(orgId, 'Floor 2', 2)).lastInsertRowid;

  const wardA = (await insRoom.run(orgId, f1, 'Ward A', 'Ward')).lastInsertRowid;
  const commonF1 = (await insRoom.run(orgId, f1, 'Common Room', 'Common Room')).lastInsertRowid;
  const deluxeF1 = (await insRoom.run(orgId, f1, 'Deluxe Room', 'Deluxe Room')).lastInsertRowid;
  const wardB = (await insRoom.run(orgId, f2, 'Ward B', 'Ward')).lastInsertRowid;
  const commonF2 = (await insRoom.run(orgId, f2, 'Common Room', 'Common Room')).lastInsertRowid;
  const deluxeF2 = (await insRoom.run(orgId, f2, 'Deluxe Room', 'Deluxe Room')).lastInsertRowid;

  const bedPlan = [
    [wardA, ['101', '102', '103', '104', '105']],
    [commonF1, ['106', '107', '108']],
    [deluxeF1, ['109', '110']],
    [wardB, ['201', '202', '203', '204', '205', '206']],
    [commonF2, ['207', '208', '209']],
    [deluxeF2, ['210']]
  ];
  const bedIds = {};
  for (const [roomId, numbers] of bedPlan) {
    for (const n of numbers) {
      const bedNumber = `${usernameSuffix.toUpperCase()}-${n}`;
      const info = await insBed.run(orgId, roomId, bedNumber, 'Available');
      bedIds[n] = { id: info.lastInsertRowid, label: bedNumber };
    }
  }

  const depts = ['General Medicine', 'Orthopedics', 'Pediatrics', 'Gynecology', 'General Surgery', 'ENT', 'Cardiology'];
  const insDept = db.prepare(`INSERT INTO departments (organization_id, name) VALUES (?,?)`);
  const deptIds = {};
  for (const d of depts) { deptIds[d] = (await insDept.run(orgId, d)).lastInsertRowid; }

  const insDoctor = db.prepare(`INSERT INTO doctors (organization_id, user_id, name, department_id, qualification) VALUES (?,?,?,?,?)`);
  const doctorIds = {};
  doctorIds['sharma'] = (await insDoctor.run(orgId, userIds['dr.sharma'], 'Dr. Arjun Sharma', deptIds['General Medicine'], 'MBBS, MD (Medicine)')).lastInsertRowid;
  doctorIds['iyer'] = (await insDoctor.run(orgId, userIds['dr.iyer'], 'Dr. Kavita Iyer', deptIds['Orthopedics'], 'MBBS, MS (Ortho)')).lastInsertRowid;
  doctorIds['mehta'] = (await insDoctor.run(orgId, userIds['dr.mehta'], 'Dr. Rohan Mehta', deptIds['Pediatrics'], 'MBBS, MD (Pediatrics)')).lastInsertRowid;
  doctorIds['kulkarni'] = (await insDoctor.run(orgId, userIds['dr.kulkarni'], 'Dr. Sneha Kulkarni', deptIds['Gynecology'], 'MBBS, MS (OBG)')).lastInsertRowid;
  doctorIds['rao'] = (await insDoctor.run(orgId, userIds['dr.rao'], 'Dr. Vikram Rao', deptIds['General Surgery'], 'MBBS, MS (Surgery)')).lastInsertRowid;

  const patientsData = [
    ['Ahmed Khan', '9812345601', 'Male', '1984-03-12', 'Palarivattom'],
    ['Lakshmi Pillai', '9812345602', 'Female', '1990-07-25', 'Kadavanthra'],
    ['Ravi Menon', '9812345603', 'Male', '1975-11-02', 'Edappally'],
    ['Fathima Beevi', '9812345604', 'Female', '1968-01-15', 'Vyttila'],
    ['Suresh Kumar', '9812345605', 'Male', '1995-05-30', 'Kakkanad'],
    ['Anjali Nair', '9812345606', 'Female', '1988-09-18', 'Panampilly Nagar'],
    ['George Mathew', '9812345607', 'Male', '1960-12-05', 'Fort Kochi'],
    ['Divya Krishnan', '9812345608', 'Female', '2001-02-20', 'Thrikkakara'],
    ['Mohammed Yusuf', '9812345609', 'Male', '1979-04-14', 'Aluva'],
    ['Meera Suresh', '9812345610', 'Female', '1993-08-09', 'Tripunithura'],
    ['Baby Girl Roshan', '9812345611', 'Female', '2020-06-01', 'Kaloor'],
    ['Thomas Jacob', '9812345612', 'Male', '1955-10-22', 'Vytilla']
  ].map(([n, m, g, d, a]) => [n, `${usernameSuffix === 'hospitala' ? '1' : '2'}${m.slice(1)}`, g, d, a]);

  const insPatient = db.prepare(`INSERT INTO patients (organization_id, patient_id, full_name, mobile, gender, dob, age, address) VALUES (?,?,?,?,?,?,?,?)`);
  const patients = [];
  for (const [name, mobile, gender, dob, address] of patientsData) {
    const pid = await nextPatientId();
    const age = new Date().getFullYear() - new Date(dob).getFullYear();
    await insPatient.run(orgId, pid, name, mobile, gender, dob, age, address);
    await logTimeline(orgId, pid, 'Patient registered', 'Demo data');
    patients.push({ patient_id: pid, full_name: name, mobile, gender, age });
  }

  const insOpd = db.prepare(`INSERT INTO opd_visits (organization_id, opd_number, patient_id, department_id, doctor_id, token_number, status, source, visit_date) VALUES (?,?,?,?,?,?,?,?,date('now'))`);
  const insConsult = db.prepare(`INSERT INTO consultations
    (organization_id, opd_visit_id, patient_id, doctor_id, chief_complaint, symptoms, diagnosis, clinical_notes, treatment, advice, decision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  const doctorList = [doctorIds.sharma, doctorIds.iyer, doctorIds.mehta, doctorIds.kulkarni, doctorIds.rao];
  const complaints = [
    ['Fever and body ache', 'High grade fever, chills', 'Viral fever', 'Rest and hydration advised', 'OPD Treatment'],
    ['Fracture in left leg', 'Severe pain, swelling', 'Tibial fracture', 'Cast applied, admission recommended for surgery', 'Recommend Admission'],
    ['Persistent cough', 'Cough with mild fever', 'Upper respiratory infection', 'Antibiotics prescribed', 'OPD Treatment'],
    ['Abdominal pain', 'Severe lower abdominal pain', 'Suspected appendicitis', 'Admission recommended for surgical evaluation', 'Recommend Admission'],
    ['Routine checkup', 'None', 'Healthy - routine visit', 'General advice given', 'OPD Treatment'],
    ['Chest pain', 'Tightness in chest, breathlessness', 'Suspected cardiac event - needs monitoring', 'Admission recommended for observation', 'Recommend Admission'],
    ['Diabetes follow-up', 'Fatigue', 'Type 2 Diabetes - uncontrolled', 'Medication adjusted', 'OPD Treatment'],
    ['Pregnancy checkup', 'None', 'Normal pregnancy - 32 weeks', 'Routine prenatal care', 'OPD Treatment'],
    ['Severe burns on hand', 'Second degree burns', 'Thermal burn injury', 'Admission recommended for wound management', 'Recommend Admission'],
    ['Post-delivery care', 'Mild fatigue', 'Normal post-partum recovery', 'Rest advised', 'OPD Treatment'],
    ['Newborn checkup', 'None', 'Healthy newborn', 'Vaccination schedule given', 'OPD Treatment'],
    ['Difficulty breathing', 'Shortness of breath, low oxygen', 'COPD exacerbation', 'Admission recommended for oxygen therapy', 'Recommend Admission']
  ];

  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    const doctorId = doctorList[i % doctorList.length];
    const opdNum = await nextOpdNumber();
    const status = complaints[i][4] === 'Recommend Admission' ? 'Completed' : (i % 4 === 0 ? 'Waiting' : 'Completed');
    const info = await insOpd.run(orgId, opdNum, p.patient_id, deptIds['General Medicine'], doctorId, i + 1, status, 'staff');
    await insConsult.run(orgId, info.lastInsertRowid, p.patient_id, doctorId, complaints[i][0], complaints[i][1], complaints[i][2],
      'Patient examined. Findings documented.', complaints[i][3], complaints[i][3], complaints[i][4]);
    await logTimeline(orgId, p.patient_id, 'OPD consultation', complaints[i][2]);
    if (complaints[i][4] === 'Recommend Admission') await logTimeline(orgId, p.patient_id, 'Admission recommended', complaints[i][2]);
  }

  const insAdm = db.prepare(`INSERT INTO admissions
    (organization_id, admission_number, patient_id, attending_doctor_id, department_id, reason, diagnosis, proposed_treatment, admission_type, bed_id, status, admitted_at, discharged_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now', ?),?)`);
  const insBedAlloc = db.prepare(`INSERT INTO bed_allocations (organization_id, bed_id, admission_id, patient_id, allocated_at, released_at) VALUES (?,?,?,?,datetime('now', ?),?)`);

  const admissionPlans = [
    { patient: patients[1], doctor: doctorIds.iyer, bed: '102', reason: 'Tibial fracture surgery', diagnosis: 'Tibial fracture', treatment: 'Surgical fixation', daysAgo: '-3 days', active: true },
    { patient: patients[3], doctor: doctorIds.rao, bed: '103', reason: 'Suspected appendicitis', diagnosis: 'Acute appendicitis', treatment: 'Appendectomy', daysAgo: '-2 days', active: true },
    { patient: patients[5], doctor: doctorIds.sharma, bed: '106', reason: 'Cardiac observation', diagnosis: 'Unstable angina', treatment: 'Monitoring and medication', daysAgo: '-1 days', active: true },
    { patient: patients[8], doctor: doctorIds.rao, bed: '109', reason: 'Burn wound management', diagnosis: 'Second degree burns - hand', treatment: 'Wound dressing and antibiotics', daysAgo: '-4 days', active: true },
    { patient: patients[11], doctor: doctorIds.sharma, bed: '201', reason: 'COPD exacerbation', diagnosis: 'COPD exacerbation', treatment: 'Oxygen therapy, bronchodilators', daysAgo: '-2 days', active: true },
    { patient: patients[9], doctor: doctorIds.kulkarni, bed: '202', reason: 'Post-delivery observation', diagnosis: 'Normal post-partum recovery', treatment: 'Rest and monitoring', daysAgo: '-8 days', active: false },
    { patient: patients[10], doctor: doctorIds.mehta, bed: '203', reason: 'Newborn observation', diagnosis: 'Healthy newborn - observation', treatment: 'Routine care', daysAgo: '-7 days', active: false }
  ];

  for (const plan of admissionPlans) {
    const admNum = await nextAdmissionNumber();
    const bed = bedIds[plan.bed];
    const info = await insAdm.run(orgId, admNum, plan.patient.patient_id, plan.doctor, deptIds['General Medicine'], plan.reason,
      plan.diagnosis, plan.treatment, 'Normal', bed.id, plan.active ? 'Active' : 'Discharged', plan.daysAgo,
      plan.active ? null : new Date(Date.now() - 86400000).toISOString());

    const admissionId = info.lastInsertRowid;
    await insBedAlloc.run(orgId, bed.id, admissionId, plan.patient.patient_id, plan.daysAgo, plan.active ? null : new Date(Date.now() - 86400000).toISOString());
    await db.prepare(`UPDATE beds SET status = ? WHERE id = ? AND organization_id = ?`).run(plan.active ? 'Occupied' : 'Available', bed.id, orgId);

    await logTimeline(orgId, plan.patient.patient_id, 'Patient admitted', `Admission ${admNum}`);
    await logTimeline(orgId, plan.patient.patient_id, 'Bed assigned', `Bed ${bed.label}`);
    await sendSMS(orgId, plan.patient.patient_id, plan.patient.mobile, 'Admission',
      `Dear ${plan.patient.full_name}, you have been admitted to ${name}. Admission No: ${admNum}. Your assigned bed is ${bed.label}. We wish you a smooth recovery.`);

    await db.prepare(`INSERT INTO clinical_notes (organization_id, patient_id, admission_id, note_type, content, user_id, role) VALUES (?,?,?,?,?,?,?)`)
      .run(orgId, plan.patient.patient_id, admissionId, 'Doctor Note', `Patient stable. Continuing treatment plan: ${plan.treatment}.`, userIds['dr.sharma'], 'doctor');
    await db.prepare(`INSERT INTO vitals (organization_id, patient_id, admission_id, temperature, pulse, bp, spo2, resp_rate, recorded_by) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(orgId, plan.patient.patient_id, admissionId, '98.6 F', '78 bpm', '120/80', '98%', '16/min', userIds['nurse.anita']);

    await db.prepare(`INSERT INTO prescriptions (organization_id, patient_id, admission_id, medicine, dose, route, frequency, start_date, prescribed_by) VALUES (?,?,?,?,?,?,?,date('now'),?)`)
      .run(orgId, plan.patient.patient_id, admissionId, 'Paracetamol', '500mg', 'Oral', 'Twice daily', userIds['dr.sharma']);
    await logTimeline(orgId, plan.patient.patient_id, 'Medicine prescribed', 'Paracetamol 500mg');

    const labStatus = plan.active ? (Math.random() > 0.5 ? 'Report Generated' : 'Processing') : 'Report Generated';
    await db.prepare(`INSERT INTO lab_orders (organization_id, patient_id, admission_id, test_name, ordered_by, status, result, finalized_by, finalized_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(orgId, plan.patient.patient_id, admissionId, 'Complete Blood Count (CBC)', userIds['dr.sharma'], labStatus,
        labStatus === 'Report Generated' ? 'Hemoglobin: 13.2 g/dL, WBC: 7,200/uL - within normal limits' : null,
        labStatus === 'Report Generated' ? userIds['lab.deepa'] : null,
        labStatus === 'Report Generated' ? new Date().toISOString() : null);
    await logTimeline(orgId, plan.patient.patient_id, 'Blood test ordered', 'Complete Blood Count (CBC)');
    if (labStatus === 'Report Generated') await logTimeline(orgId, plan.patient.patient_id, 'Lab report uploaded', 'Complete Blood Count (CBC)');

    if (!plan.active) {
      await db.prepare(`INSERT INTO discharge_summaries
        (organization_id, admission_id, patient_id, diagnosis, reason_for_admission, clinical_summary, investigations, treatment_given,
         procedures, medications, condition_at_discharge, advice, follow_up, emergency_instructions, doctor_name, status, finalized_by, finalized_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(orgId, admissionId, plan.patient.patient_id, plan.diagnosis, plan.reason,
          'Patient responded well to treatment. Vitals stable throughout stay.',
          'CBC: within normal limits', plan.treatment, 'None', 'Paracetamol 500mg twice daily',
          'Stable and improving', 'Adequate rest, follow hospital advice', 'Follow-up after 7 days if needed',
          'In case of emergency, contact the hospital immediately.', 'Dr. Arjun Sharma', 'Finalized',
          userIds['dr.sharma'], new Date(Date.now() - 86400000).toISOString());
      await logTimeline(orgId, plan.patient.patient_id, 'Patient discharged', 'Discharge summary finalized');
      await logTimeline(orgId, plan.patient.patient_id, 'Bed released for cleaning', '');
      await sendSMS(orgId, plan.patient.patient_id, plan.patient.mobile, 'Discharge',
        `Dear ${plan.patient.full_name}, your discharge from ${name} has been completed successfully. We wish you good health and a speedy recovery.`);
    }
  }

  const surgeryPlans = [
    { patient: patients[1], name: 'Open Reduction Internal Fixation (Tibia)', surgeon: 'Dr. Kavita Iyer', anaesthetist: 'Dr. Neha Bhat', date: new Date(Date.now() - 86400000).toISOString().slice(0, 10) },
    { patient: patients[3], name: 'Laparoscopic Appendectomy', surgeon: 'Dr. Vikram Rao', anaesthetist: 'Dr. Neha Bhat', date: new Date().toISOString().slice(0, 10) }
  ];
  for (const sp of surgeryPlans) {
    const admission = await db.prepare(`SELECT * FROM admissions WHERE patient_id = ? AND organization_id = ? AND status='Active' ORDER BY id DESC LIMIT 1`).get(sp.patient.patient_id, orgId);
    const info = await db.prepare(`INSERT INTO surgeries
      (organization_id, patient_id, admission_id, procedure_name, surgery_date, surgery_time, surgeon, assistant, anaesthetist, diagnosis, procedure_notes, post_op_notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orgId, sp.patient.patient_id, admission ? admission.id : null, sp.name, sp.date, '10:30 AM', sp.surgeon,
        'Dr. Sunil Verma', sp.anaesthetist, admission ? admission.diagnosis : '', 'Procedure completed without complications.',
        'Patient recovering well in post-op ward.', userIds['dr.rao']);
    const surgeryId = info.lastInsertRowid;
    await db.prepare(`INSERT INTO surgical_items (organization_id, surgery_id, patient_id, item_name, item_category, quantity, batch_number, usage_date, recorded_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(orgId, surgeryId, sp.patient.patient_id, 'Surgical Gloves', 'Consumable', 4, 'BN-2026-114', sp.date, userIds['nurse.sunil']);
    await db.prepare(`INSERT INTO surgical_items (organization_id, surgery_id, patient_id, item_name, item_category, quantity, batch_number, usage_date, recorded_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(orgId, surgeryId, sp.patient.patient_id, 'Suture Kit', 'Consumable', 2, 'BN-2026-089', sp.date, userIds['nurse.sunil']);
    await logTimeline(orgId, sp.patient.patient_id, 'Surgery performed', sp.name);
  }

  return { orgId, slug, userIds };
}

async function run() {
  await db.init();
  const orgCount = (await db.prepare(`SELECT COUNT(*) c FROM organizations`).get()).c;
  if (orgCount > 0) {
    console.log('Database already contains organizations. Skipping seed. Delete/reset the aiventra Postgres database to reseed.');
    return;
  }

  console.log('Seeding TWO demo hospitals (Hospital A and Hospital B) for isolation testing...\n');

  await seedOrganization({
    slug: 'citycare', name: 'City Care Hospital', city: 'Kochi', state: 'Kerala',
    usernameSuffix: 'hospitala', ownerPassword: 'admin123'
  });
  await seedOrganization({
    slug: 'sunrise', name: 'Sunrise Multispecialty Hospital', city: 'Ahmedabad', state: 'Gujarat',
    usernameSuffix: 'hospitalb', ownerPassword: 'admin123'
  });

  console.log('Demo data seeded successfully for both organizations.\n');
  console.log('Login credentials - HOSPITAL A (City Care Hospital, slug: citycare):');
  console.log('  Owner        -> owner.hospitala / admin123');
  console.log('  Manager      -> manager.hospitala / manager123');
  console.log('  Reception    -> reception.hospitala / reception123');
  console.log('  Doctor       -> dr.sharma.hospitala / doctor123');
  console.log('  Nurse        -> nurse.anita.hospitala / nurse123');
  console.log('  Lab Staff    -> lab.deepa.hospitala / lab123');
  console.log('  Pharmacy     -> pharmacy.manoj.hospitala / pharmacy123\n');
  console.log('Login credentials - HOSPITAL B (Sunrise Multispecialty, slug: sunrise):');
  console.log('  Owner        -> owner.hospitalb / admin123');
  console.log('  Manager      -> manager.hospitalb / manager123');
  console.log('  Reception    -> reception.hospitalb / reception123');
  console.log('  Doctor       -> dr.sharma.hospitalb / doctor123');
  console.log('  Nurse        -> nurse.anita.hospitalb / nurse123');
  console.log('  Lab Staff    -> lab.deepa.hospitalb / lab123');
  console.log('  Pharmacy     -> pharmacy.manoj.hospitalb / pharmacy123\n');
}

if (require.main === module) {
  run().then(() => db.pool.end()).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run, seedOrganization };
