-- ===================== AIVENTRA HMS SaaS — MULTI-TENANT SCHEMA =====================
-- Design notes (documented decisions for this phase — see docs/tenant-isolation.md):
--   1. Every hospital-owned table below carries an `organization_id` column. The backend
--      NEVER trusts an organization_id supplied by the client — it is always derived from
--      the authenticated session (see server/middleware/auth.js + server/middleware/tenant.js)
--      and injected into every SQL statement server-side.
--   2. Business identifiers (patient_id "PAT-000001", opd_number, admission_number,
--      bed_number, account_number, invoice_number) remain GLOBALLY unique across the whole
--      platform in this phase, rather than unique-per-organization. This is a deliberate,
--      documented simplification: it is strictly SAFER (not weaker) than per-org uniqueness,
--      since no two hospitals can ever collide on an identifier. The trade-off is cosmetic
--      only (hospital B's first patient will not necessarily be PAT-000001) and is listed as
--      a "remaining task" if per-org numbering is a hard business requirement later.
--   3. `users.username` also remains globally unique — each staff account belongs to exactly
--      ONE organization. This keeps login simple (username + password, no org/subdomain
--      selection step) for this phase. Platform staff (AIVENTRA_SUPER_ADMIN) have
--      organization_id = NULL.

PRAGMA foreign_keys = ON;

-- ===================== PLATFORM / SAAS TABLES =====================

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                      -- legal / display name
  slug TEXT UNIQUE NOT NULL,               -- url-safe identifier, e.g. 'citycare'
  org_type TEXT DEFAULT 'Hospital' CHECK(org_type IN ('Hospital','Clinic','Nursing Home')),
  status TEXT NOT NULL DEFAULT 'trial' CHECK(status IN ('trial','active','payment_due','grace_period','suspended','cancelled','expired')),
  city TEXT,
  state TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  gstin TEXT,
  registration_number TEXT,
  bed_count INTEGER,
  expected_monthly_opd INTEGER,
  invoice_prefix TEXT DEFAULT 'INV',
  patient_id_prefix TEXT DEFAULT 'PAT',
  logo_path TEXT,
  onboarding_step TEXT DEFAULT 'signup',
  onboarding_completed INTEGER DEFAULT 0,
  trial_ends_at TEXT,                       -- set at signup; the lifecycle sweep expires trial orgs that never subscribe
  internal_notes TEXT,                      -- Aiventra-admin-only notes, never exposed to the org
  suspended_at TEXT,
  suspended_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);

CREATE TABLE IF NOT EXISTS organization_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  value TEXT,
  UNIQUE(organization_id, key)
);

-- Platform-wide audit trail for actions taken BY Aiventra staff (separate from each
-- hospital's own clinical audit_log, which stays organization_id scoped below).
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER,
  admin_name TEXT,
  organization_id INTEGER REFERENCES organizations(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Support tickets raised by a hospital (visible to that hospital and to Aiventra admins).
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  raised_by INTEGER REFERENCES users(id),
  subject TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
  resolution_notes TEXT,
  resolved_by INTEGER,
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_org ON support_tickets(organization_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);

-- Support access must be explicitly approved by the hospital and expires automatically.
CREATE TABLE IF NOT EXISTS support_access_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  requested_by INTEGER,           -- Aiventra admin user id
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','expired','revoked')),
  reason TEXT,
  approved_by INTEGER,            -- hospital user id who approved
  approved_at TEXT,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== USERS / ROLES (org-scoped, platform staff have organization_id = NULL) =====================
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(id), -- NULL only for aiventra_super_admin
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN (
    'aiventra_super_admin','organization_owner','hospital_admin','doctor',
    'receptionist','accountant','pharmacy_staff','lab_staff','nurse','report_viewer'
  )),
  phone TEXT,
  department TEXT,
  active INTEGER DEFAULT 1,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,                        -- brute-force lockout: NULL or a future timestamp
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

-- ---------- HOSPITAL STRUCTURE ----------
CREATE TABLE IF NOT EXISTS floors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  floor_number INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_floors_org ON floors(organization_id);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  name TEXT NOT NULL,
  room_type TEXT NOT NULL CHECK(room_type IN ('Ward','Common Room','Deluxe Room')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rooms_org ON rooms(organization_id);

CREATE TABLE IF NOT EXISTS beds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  bed_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Available' CHECK(status IN ('Available','Occupied','Reserved','Cleaning','Maintenance')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_beds_org ON beds(organization_id);

-- ---------- PATIENTS ----------
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  patient_id TEXT UNIQUE NOT NULL, -- PAT-000001
  full_name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  gender TEXT,
  dob TEXT,
  age INTEGER,
  address TEXT,
  aadhaar_number TEXT, -- stored, masked on display
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_org ON patients(organization_id);
CREATE INDEX IF NOT EXISTS idx_patients_mobile ON patients(organization_id, mobile);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(organization_id, full_name);

CREATE TABLE IF NOT EXISTS patient_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  doc_type TEXT NOT NULL CHECK(doc_type IN ('Aadhaar','PAN','Other')),
  doc_number TEXT,
  file_path TEXT,
  verification_status TEXT DEFAULT 'Pending' CHECK(verification_status IN ('Pending','Verified','Rejected')),
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patient_documents_org ON patient_documents(organization_id);

-- ---------- DOCTORS / DEPARTMENTS ----------
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  UNIQUE(organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(organization_id);

CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  qualification TEXT,
  active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_doctors_org ON doctors(organization_id);

-- ---------- OPD ----------
CREATE TABLE IF NOT EXISTS opd_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  opd_number TEXT UNIQUE NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  department_id INTEGER REFERENCES departments(id),
  doctor_id INTEGER REFERENCES doctors(id),
  token_number INTEGER,
  status TEXT DEFAULT 'Waiting' CHECK(status IN ('Waiting','In Consultation','Completed','Cancelled')),
  source TEXT DEFAULT 'staff' CHECK(source IN ('staff','qr_self')),
  visit_date TEXT DEFAULT (date('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_opd_visits_org ON opd_visits(organization_id);

-- ---------- CONSULTATIONS ----------
CREATE TABLE IF NOT EXISTS consultations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  opd_visit_id INTEGER REFERENCES opd_visits(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  doctor_id INTEGER REFERENCES doctors(id),
  chief_complaint TEXT,
  symptoms TEXT,
  diagnosis TEXT,
  vitals TEXT, -- JSON
  clinical_notes TEXT,
  treatment TEXT,
  medicines TEXT,
  lab_investigations TEXT,
  advice TEXT,
  follow_up_date TEXT,
  decision TEXT CHECK(decision IN ('OPD Treatment','Recommend Admission')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consultations_org ON consultations(organization_id);

-- ---------- ADMISSIONS ----------
CREATE TABLE IF NOT EXISTS admissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  admission_number TEXT UNIQUE NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  referring_doctor_id INTEGER REFERENCES doctors(id),
  attending_doctor_id INTEGER REFERENCES doctors(id),
  department_id INTEGER REFERENCES departments(id),
  reason TEXT,
  diagnosis TEXT,
  proposed_treatment TEXT,
  admission_type TEXT DEFAULT 'Normal' CHECK(admission_type IN ('Normal','Emergency')),
  bed_id INTEGER REFERENCES beds(id),
  status TEXT DEFAULT 'Active' CHECK(status IN ('Active','Discharged')),
  admitted_at TEXT DEFAULT (datetime('now')),
  discharged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admissions_org ON admissions(organization_id);

CREATE TABLE IF NOT EXISTS bed_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  bed_id INTEGER NOT NULL REFERENCES beds(id),
  admission_id INTEGER NOT NULL REFERENCES admissions(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  allocated_at TEXT DEFAULT (datetime('now')),
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bed_allocations_org ON bed_allocations(organization_id);

-- ---------- CLINICAL ----------
CREATE TABLE IF NOT EXISTS clinical_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  admission_id INTEGER REFERENCES admissions(id),
  note_type TEXT CHECK(note_type IN ('Doctor Note','Nursing Note','Progress Note')),
  content TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  role TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clinical_notes_org ON clinical_notes(organization_id);

CREATE TABLE IF NOT EXISTS vitals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  admission_id INTEGER REFERENCES admissions(id),
  temperature TEXT, pulse TEXT, bp TEXT, spo2 TEXT, resp_rate TEXT,
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vitals_org ON vitals(organization_id);

-- ---------- MEDICATION ----------
CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  admission_id INTEGER REFERENCES admissions(id),
  medicine TEXT NOT NULL,
  dose TEXT,
  route TEXT,
  frequency TEXT,
  start_date TEXT,
  end_date TEXT,
  prescribed_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_org ON prescriptions(organization_id);

CREATE TABLE IF NOT EXISTS medication_administration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  administered_by INTEGER REFERENCES users(id),
  administered_at TEXT DEFAULT (datetime('now')),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_medication_administration_org ON medication_administration(organization_id);

-- ---------- LAB ----------
CREATE TABLE IF NOT EXISTS lab_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  admission_id INTEGER REFERENCES admissions(id),
  test_name TEXT NOT NULL,
  ordered_by INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'Ordered' CHECK(status IN ('Ordered','Sample Collected','Processing','Result Entered','Report Generated')),
  ordered_at TEXT DEFAULT (datetime('now')),
  sample_collected_at TEXT,
  result TEXT,
  report_file TEXT,
  finalized_by INTEGER REFERENCES users(id),
  finalized_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lab_orders_org ON lab_orders(organization_id);

-- ---------- SURGERY ----------
CREATE TABLE IF NOT EXISTS surgeries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  admission_id INTEGER REFERENCES admissions(id),
  procedure_name TEXT NOT NULL,
  surgery_date TEXT,
  surgery_time TEXT,
  surgeon TEXT,
  assistant TEXT,
  anaesthetist TEXT,
  diagnosis TEXT,
  procedure_notes TEXT,
  post_op_notes TEXT,
  document_file TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_surgeries_org ON surgeries(organization_id);

CREATE TABLE IF NOT EXISTS surgical_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  surgery_id INTEGER NOT NULL REFERENCES surgeries(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  item_name TEXT NOT NULL,
  item_category TEXT,
  quantity INTEGER,
  batch_number TEXT,
  usage_date TEXT,
  recorded_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_surgical_items_org ON surgical_items(organization_id);

-- ---------- DISCHARGE ----------
CREATE TABLE IF NOT EXISTS discharge_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  admission_id INTEGER UNIQUE NOT NULL REFERENCES admissions(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  diagnosis TEXT,
  reason_for_admission TEXT,
  clinical_summary TEXT,
  investigations TEXT,
  treatment_given TEXT,
  procedures TEXT,
  medications TEXT,
  condition_at_discharge TEXT,
  advice TEXT,
  follow_up TEXT,
  emergency_instructions TEXT,
  doctor_name TEXT,
  status TEXT DEFAULT 'Draft' CHECK(status IN ('Draft','Finalized')),
  finalized_by INTEGER REFERENCES users(id),
  finalized_at TEXT,
  pdf_path TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discharge_summaries_org ON discharge_summaries(organization_id);

-- ---------- TIMELINE / NOTIFICATIONS / LOGS ----------
CREATE TABLE IF NOT EXISTS patient_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  event TEXT NOT NULL,
  detail TEXT,
  event_date TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patient_timeline_org ON patient_timeline(organization_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  message TEXT,
  target_role TEXT,
  read_status INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_org ON notifications(organization_id);

CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  patient_id TEXT REFERENCES patients(patient_id),
  phone TEXT,
  event_type TEXT,
  message TEXT,
  status TEXT DEFAULT 'Sent (Simulated)',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_log_org ON sms_log(organization_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER REFERENCES users(id),
  user_name TEXT,
  role TEXT,
  action TEXT NOT NULL,
  patient_id TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log(organization_id);

CREATE TABLE IF NOT EXISTS ai_query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER REFERENCES users(id),
  role TEXT,
  question TEXT,
  answer TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_query_log_org ON ai_query_log(organization_id);

-- ===================== BILLING & ADVANCE DEPOSIT (hospital patient billing — kept separate from SaaS subscription billing) =====================

CREATE TABLE IF NOT EXISTS billing_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  account_number TEXT UNIQUE NOT NULL, -- BILL-000001
  patient_id TEXT NOT NULL REFERENCES patients(patient_id),
  admission_id INTEGER UNIQUE NOT NULL REFERENCES admissions(id),
  status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','Closed')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_billing_accounts_org ON billing_accounts(organization_id);

CREATE TABLE IF NOT EXISTS billing_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  account_id INTEGER NOT NULL REFERENCES billing_accounts(id),
  type TEXT NOT NULL CHECK(type IN ('DEPOSIT','CHARGE','PAYMENT','REFUND')),
  category TEXT,
  description TEXT NOT NULL,
  quantity REAL DEFAULT 1,
  unit_price REAL,
  amount REAL NOT NULL,
  payment_method TEXT,
  reference TEXT,
  notes TEXT,
  receipt_path TEXT,
  created_by INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_billing_transactions_org ON billing_transactions(organization_id);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  account_id INTEGER NOT NULL REFERENCES billing_accounts(id),
  invoice_number TEXT UNIQUE NOT NULL, -- INV-2026-00001
  type TEXT NOT NULL CHECK(type IN ('Interim','Final')),
  total_charges REAL NOT NULL,
  deposit_amount REAL NOT NULL,
  additional_payments REAL NOT NULL,
  refunds REAL NOT NULL,
  balance_amount REAL NOT NULL,
  balance_type TEXT NOT NULL CHECK(balance_type IN ('CREDIT','DUE','SETTLED')),
  pdf_path TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(organization_id);

CREATE TABLE IF NOT EXISTS billing_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  rate REAL,
  unit TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_billing_rates_org ON billing_rates(organization_id);

-- hospital_settings kept as a per-organization key/value table (was global, now scoped)
CREATE TABLE IF NOT EXISTS hospital_settings (
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (organization_id, key)
);

-- ===================== SAAS SUBSCRIPTION BILLING (Aiventra <-> Hospital, NOT hospital <-> patient) =====================
-- Kept entirely separate from the billing_* tables above, which are the hospital's own
-- patient billing. A hospital's subscription to Aiventra has nothing to do with what it
-- charges its own patients.

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,               -- 'clinic' | 'small_hospital' | 'hospital' | 'enterprise'
  name TEXT NOT NULL,                      -- 'Aiventra Clinic', etc.
  monthly_price REAL NOT NULL,             -- in INR, GST-exclusive
  annual_price REAL NOT NULL,              -- in INR, GST-exclusive (should reflect an annual discount)
  installation_fee REAL NOT NULL DEFAULT 0,
  gst_percent REAL NOT NULL DEFAULT 18,
  bed_limit INTEGER,                       -- NULL = unlimited
  opd_limit INTEGER,                       -- monthly OPD registrations, NULL = unlimited
  user_limit INTEGER,
  doctor_limit INTEGER,
  branch_limit INTEGER DEFAULT 1,
  storage_limit_gb INTEGER,
  enabled_modules TEXT,                    -- JSON array, e.g. ["opd","ipd","billing","lab","pharmacy"]
  trial_days INTEGER NOT NULL DEFAULT 14,
  active INTEGER NOT NULL DEFAULT 1,       -- inactive plans are hidden from new signups but kept for existing subscribers
  display_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  billing_cycle TEXT NOT NULL CHECK(billing_cycle IN ('monthly','annual')),
  status TEXT NOT NULL DEFAULT 'trial' CHECK(status IN ('trial','pending_payment','active','payment_due','grace_period','suspended','cancelled','expired')),
  additional_users INTEGER NOT NULL DEFAULT 0,
  additional_doctors INTEGER NOT NULL DEFAULT 0,
  additional_branches INTEGER NOT NULL DEFAULT 0,
  addon_modules TEXT,                       -- JSON array of add-on module codes
  base_amount REAL,                         -- snapshot of plan price at time of (re)subscription, GST-exclusive
  gst_amount REAL,
  total_amount REAL,                        -- what was actually charged, GST-inclusive
  razorpay_order_id TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  trial_ends_at TEXT,
  grace_period_ends_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  razorpay_order_id TEXT NOT NULL,
  razorpay_payment_id TEXT UNIQUE,          -- UNIQUE = the idempotency guard against duplicate webhook delivery
  razorpay_signature TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','verified','captured','failed','refunded')),
  method TEXT,                              -- card / upi / netbanking / etc, from Razorpay once known
  failure_reason TEXT,
  verified_at TEXT,
  raw_webhook_event TEXT,                   -- last raw webhook payload received for this payment, for audit/debugging
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_org ON subscription_payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_order ON subscription_payments(razorpay_order_id);

-- Every subscription lifecycle change (create/upgrade/downgrade/cancel/reactivate/webhook
-- event) is recorded here, independent of the hospital's own clinical audit_log.
CREATE TABLE IF NOT EXISTS subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(id), -- NULL for pre-auth events e.g. an invalid webhook signature from an unidentified sender
  subscription_id INTEGER REFERENCES subscriptions(id),
  event_type TEXT NOT NULL,                 -- created, upgraded, downgraded, payment_verified, payment_failed, cancelled, reactivated, webhook_received, webhook_signature_invalid
  detail TEXT,
  actor TEXT,                               -- 'user:<id>' | 'webhook' | 'system'
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscription_events_org ON subscription_events(organization_id);

-- ===================== MARKETING SITE LEADS (public website, not tied to any organization) =====================
CREATE TABLE IF NOT EXISTS marketing_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_type TEXT NOT NULL CHECK(lead_type IN ('demo_request','contact')),
  name TEXT NOT NULL,
  hospital_name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  city TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','converted','closed')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_type ON marketing_leads(lead_type);

-- ===================== PASSWORD RESET =====================
-- Only the SHA-256 hash of the token is ever stored - the raw token exists only in the
-- (simulated, see docs/security.md) email sent to the user and in the URL they click,
-- exactly like a password_hash never stores the plaintext password.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  requested_ip TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);

-- ===================== STAFF INVITATIONS =====================
CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK(role IN (
    'organization_owner','hospital_admin','doctor','receptionist',
    'accountant','pharmacy_staff','lab_staff','nurse','report_viewer'
  )),
  token_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked','expired')),
  invited_by INTEGER REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_user_id INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(organization_id);

-- ===================== EMAIL LOG (mirrors sms_log's simulated-provider pattern) =====================
-- No real email provider is configured out of the box (same honest stance as SMS - see
-- docs/security.md). Every email this app would send is recorded here with its full content
-- so nothing is silently lost, and a real provider (SendGrid/SES/etc) can be wired in by
-- replacing the one function in server/utils/email.js without touching any caller.
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(id), -- NULL for platform-level emails (e.g. super admin's own password reset)
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  event_type TEXT,
  status TEXT DEFAULT 'Sent (Simulated)',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_org ON email_log(organization_id);
