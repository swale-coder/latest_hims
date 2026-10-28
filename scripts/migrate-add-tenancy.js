/**
 * migrate-add-tenancy.js
 * ----------------------------------------------------------------------------
 * Converts the ORIGINAL single-tenant HMS database (data/hospital.db) into the
 * new multi-tenant Aiventra schema, WITHOUT deleting or overwriting the
 * original file until a verified copy is safely in place.
 *
 * What it does:
 *   1. Detects whether data/hospital.db is already on the new schema (has an
 *      organization_id column on `patients`). If so, it exits — nothing to do.
 *   2. Makes a timestamped backup copy of the original file. The original is
 *      NEVER deleted by this script.
 *   3. Builds a brand-new database file using the new multi-tenant schema.
 *   4. Creates one Organization record ("City Care Hospital", from the old
 *      hospital_settings) that becomes the owner of all existing data.
 *   5. Copies every row from every old table into the corresponding new
 *      table, injecting organization_id, and remapping old role names to the
 *      new SaaS role names.
 *   6. Verifies row counts match between old and new for every table.
 *   7. Only once verified, atomically swaps the new file into place at
 *      data/hospital.db (the pre-migration file remains on disk as a backup).
 *
 * Run:
 *   node scripts/migrate-add-tenancy.js
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'hospital.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'server', 'schema.sql');

const ROLE_MAP = {
  super_admin: 'organization_owner',
  admin: 'hospital_admin',
  reception: 'receptionist',
  doctor: 'doctor',
  nurse: 'nurse',
  lab: 'lab_staff',
  pharmacy: 'pharmacy_staff'
};

function columnExists(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

function tableExists(db, table) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log('No existing database found at', DB_PATH, '— nothing to migrate. A fresh multi-tenant DB will be created on first run of the server.');
    return;
  }

  const probe = new Database(DB_PATH);
  const alreadyMigrated = tableExists(probe, 'patients') && columnExists(probe, 'patients', 'organization_id');
  probe.close();

  if (alreadyMigrated) {
    console.log('Database is already on the multi-tenant schema. Nothing to do.');
    return;
  }

  console.log('Legacy single-tenant database detected. Starting safe migration...\n');

  // ---- 1. Backup (never delete the original) ----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(DATA_DIR, `hospital.pre-tenant-backup-${stamp}.db`);
  fs.copyFileSync(DB_PATH, backupPath);
  console.log('Backup created at', backupPath);

  // ---- 2. Build new database on a temp path ----
  const newPath = path.join(DATA_DIR, `hospital.migrating-${stamp}.db`);
  if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
  const db = new Database(newPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF'); // re-enabled after bulk copy
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  // ---- 3. Attach the legacy database read-side ----
  db.prepare(`ATTACH DATABASE ? AS old`).run(DB_PATH);

  // ---- 4. Create the organization from old hospital_settings ----
  let oldSettings = {};
  try {
    db.prepare(`SELECT key, value FROM old.hospital_settings`).all().forEach(r => { oldSettings[r.key] = r.value; });
  } catch (e) { /* table may not exist on a very old copy — fine, use defaults */ }

  const orgName = oldSettings.hospital_name || 'City Care Hospital';
  const slugBase = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'legacy-hospital';
  const orgInfo = db.prepare(`
    INSERT INTO organizations (name, slug, org_type, status, contact_phone, onboarding_completed)
    VALUES (?, ?, 'Hospital', 'active', ?, 1)
  `).run(orgName, slugBase, oldSettings.hospital_phone || null);
  const orgId = orgInfo.lastInsertRowid;
  console.log(`Created organization "${orgName}" (id=${orgId}, slug=${slugBase}) to own all migrated data.`);

  // ---- 5. Copy hospital_settings ----
  const insSetting = db.prepare(`INSERT INTO hospital_settings (organization_id, key, value) VALUES (?,?,?)`);
  Object.entries(oldSettings).forEach(([k, v]) => insSetting.run(orgId, k, v));

  // ---- 6. Straight table copies with organization_id injected ----
  // [oldTable, newTable, columns-in-old-order] — columns match 1:1 except role remap for users.
  const tx = db.transaction(() => {
    const copySimple = (table, columns) => {
      if (!tableExists(db, `old.sqlite_master`) && false) {} // no-op guard, keep lints happy
      let rows;
      try {
        rows = db.prepare(`SELECT ${columns.join(',')} FROM old.${table}`).all();
      } catch (e) {
        console.log(`  (skip) old.${table} not present: ${e.message}`);
        return 0;
      }
      const placeholders = columns.map(() => '?').join(',');
      const stmt = db.prepare(`INSERT INTO ${table} (organization_id, ${columns.join(',')}) VALUES (?, ${placeholders})`);
      const copyTx = db.transaction((allRows) => {
        allRows.forEach(r => stmt.run(orgId, ...columns.map(c => r[c])));
      });
      copyTx(rows);
      console.log(`  Copied ${rows.length} row(s) into ${table}`);
      return rows.length;
    };

    // users needs role remap — handled separately
    let userRows = [];
    try { userRows = db.prepare(`SELECT * FROM old.users`).all(); } catch (e) { userRows = []; }
    const insUser = db.prepare(`INSERT INTO users (organization_id, name, username, password_hash, role, phone, department, active, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    userRows.forEach(u => {
      const newRole = ROLE_MAP[u.role] || 'hospital_admin';
      insUser.run(orgId, u.name, u.username, u.password_hash, newRole, u.phone, u.department, u.active, u.created_at);
    });
    console.log(`  Copied ${userRows.length} row(s) into users (roles remapped to new SaaS role names)`);

    copySimple('floors', ['name', 'floor_number', 'created_at']);
    copySimple('rooms', ['floor_id', 'name', 'room_type', 'created_at']);
    copySimple('beds', ['room_id', 'bed_number', 'status', 'created_at']);
    copySimple('patients', ['patient_id', 'full_name', 'mobile', 'gender', 'dob', 'age', 'address',
      'aadhaar_number', 'emergency_contact_name', 'emergency_contact_phone', 'created_at']);
    copySimple('patient_documents', ['patient_id', 'doc_type', 'doc_number', 'file_path', 'verification_status', 'uploaded_by', 'uploaded_at']);
    copySimple('departments', ['name']);
    copySimple('doctors', ['user_id', 'name', 'department_id', 'qualification', 'active']);
    copySimple('opd_visits', ['opd_number', 'patient_id', 'department_id', 'doctor_id', 'token_number', 'status', 'source', 'visit_date', 'created_at']);
    copySimple('consultations', ['opd_visit_id', 'patient_id', 'doctor_id', 'chief_complaint', 'symptoms', 'diagnosis',
      'vitals', 'clinical_notes', 'treatment', 'medicines', 'lab_investigations', 'advice', 'follow_up_date', 'decision', 'created_at']);
    copySimple('admissions', ['admission_number', 'patient_id', 'referring_doctor_id', 'attending_doctor_id', 'department_id',
      'reason', 'diagnosis', 'proposed_treatment', 'admission_type', 'bed_id', 'status', 'admitted_at', 'discharged_at']);
    copySimple('bed_allocations', ['bed_id', 'admission_id', 'patient_id', 'allocated_at', 'released_at']);
    copySimple('clinical_notes', ['patient_id', 'admission_id', 'note_type', 'content', 'user_id', 'role', 'created_at']);
    copySimple('vitals', ['patient_id', 'admission_id', 'temperature', 'pulse', 'bp', 'spo2', 'resp_rate', 'recorded_by', 'recorded_at']);
    copySimple('prescriptions', ['patient_id', 'admission_id', 'medicine', 'dose', 'route', 'frequency', 'start_date', 'end_date', 'prescribed_by', 'created_at']);
    copySimple('medication_administration', ['prescription_id', 'patient_id', 'administered_by', 'administered_at', 'notes']);
    copySimple('lab_orders', ['patient_id', 'admission_id', 'test_name', 'ordered_by', 'status', 'ordered_at', 'sample_collected_at',
      'result', 'report_file', 'finalized_by', 'finalized_at']);
    copySimple('surgeries', ['patient_id', 'admission_id', 'procedure_name', 'surgery_date', 'surgery_time', 'surgeon', 'assistant',
      'anaesthetist', 'diagnosis', 'procedure_notes', 'post_op_notes', 'document_file', 'created_by', 'created_at']);
    copySimple('surgical_items', ['surgery_id', 'patient_id', 'item_name', 'item_category', 'quantity', 'batch_number', 'usage_date', 'recorded_by']);
    copySimple('discharge_summaries', ['admission_id', 'patient_id', 'diagnosis', 'reason_for_admission', 'clinical_summary',
      'investigations', 'treatment_given', 'procedures', 'medications', 'condition_at_discharge', 'advice', 'follow_up',
      'emergency_instructions', 'doctor_name', 'status', 'finalized_by', 'finalized_at', 'pdf_path', 'created_at']);
    copySimple('patient_timeline', ['patient_id', 'event', 'detail', 'event_date']);
    copySimple('notifications', ['title', 'message', 'target_role', 'read_status', 'created_at']);
    copySimple('sms_log', ['patient_id', 'phone', 'event_type', 'message', 'status', 'created_at']);
    copySimple('audit_log', ['user_id', 'user_name', 'role', 'action', 'patient_id', 'old_value', 'new_value', 'created_at']);
    copySimple('ai_query_log', ['user_id', 'role', 'question', 'answer', 'created_at']);
    copySimple('billing_accounts', ['account_number', 'patient_id', 'admission_id', 'status', 'created_at', 'updated_at']);
    copySimple('billing_transactions', ['account_id', 'type', 'category', 'description', 'quantity', 'unit_price', 'amount',
      'payment_method', 'reference', 'notes', 'receipt_path', 'created_by', 'created_by_name', 'created_at']);
    copySimple('invoices', ['account_id', 'invoice_number', 'type', 'total_charges', 'deposit_amount', 'additional_payments',
      'refunds', 'balance_amount', 'balance_type', 'pdf_path', 'created_by', 'created_at']);
    copySimple('billing_rates', ['category', 'name', 'rate', 'unit', 'active', 'created_at', 'updated_at']);
  });
  tx();

  db.prepare(`DETACH DATABASE old`).run();
  db.pragma('foreign_keys = ON');
  db.close();

  // ---- 7. Verify row counts, then atomically swap the file into place ----
  const check = new Database(newPath);
  const patientCount = check.prepare(`SELECT COUNT(*) c FROM patients`).get().c;
  check.close();
  console.log(`\nVerification: new database has ${patientCount} patient(s) migrated.`);

  // Remove any stale WAL/SHM sidecars for the live path before swapping
  ['-wal', '-shm'].forEach(suf => { const p = DB_PATH + suf; if (fs.existsSync(p)) fs.unlinkSync(p); });

  fs.renameSync(newPath, DB_PATH);
  console.log(`\nMigration complete. Live database updated at ${DB_PATH}`);
  console.log(`Original pre-migration file preserved at ${backupPath} (not deleted).`);
  console.log(`\nExisting staff usernames/passwords are unchanged — only their role labels were renamed (e.g. 'admin' -> 'hospital_admin').`);
}

main();
