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


-- ===================== PLATFORM / SAAS TABLES =====================

CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);

CREATE TABLE IF NOT EXISTS organization_settings (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  UNIQUE(organization_id, key)
);

-- Platform-wide audit trail for actions taken BY Aiventra staff (separate from each
-- hospital's own clinical audit_log, which stays organization_id scoped below).
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id SERIAL PRIMARY KEY,
  admin_user_id INTEGER,
  admin_name TEXT,
  organization_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);

-- Support tickets raised by a hospital (visible to that hospital and to Aiventra admins).
CREATE TABLE IF NOT EXISTS support_tickets (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  raised_by INTEGER,
  subject TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
  resolution_notes TEXT,
  resolved_by INTEGER,
  resolved_at TEXT,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_org ON support_tickets(organization_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);

-- Support access must be explicitly approved by the hospital and expires automatically.
CREATE TABLE IF NOT EXISTS support_access_requests (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  requested_by INTEGER,           -- Aiventra admin user id
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','expired','revoked')),
  reason TEXT,
  approved_by INTEGER,            -- hospital user id who approved
  approved_at TEXT,
  expires_at TEXT,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);

-- ===================== USERS / ROLES (org-scoped, platform staff have organization_id = NULL) =====================
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER, -- NULL only for aiventra_super_admin
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
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

-- ---------- HOSPITAL STRUCTURE ----------
CREATE TABLE IF NOT EXISTS floors (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  floor_number INTEGER NOT NULL,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_floors_org ON floors(organization_id);

CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  floor_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  room_type TEXT NOT NULL CHECK(room_type IN ('Ward','Common Room','Deluxe Room')),
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_rooms_org ON rooms(organization_id);

CREATE TABLE IF NOT EXISTS beds (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  bed_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Available' CHECK(status IN ('Available','Occupied','Reserved','Cleaning','Maintenance')),
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_beds_org ON beds(organization_id);

-- ---------- PATIENTS ----------
CREATE TABLE IF NOT EXISTS patients (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
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
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_patients_org ON patients(organization_id);
CREATE INDEX IF NOT EXISTS idx_patients_mobile ON patients(organization_id, mobile);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(organization_id, full_name);

CREATE TABLE IF NOT EXISTS patient_documents (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('Aadhaar','PAN','Other')),
  doc_number TEXT,
  file_path TEXT,
  verification_status TEXT DEFAULT 'Pending' CHECK(verification_status IN ('Pending','Verified','Rejected')),
  uploaded_by INTEGER,
  uploaded_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_patient_documents_org ON patient_documents(organization_id);

-- ---------- DOCTORS / DEPARTMENTS ----------
CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  UNIQUE(organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(organization_id);

CREATE TABLE IF NOT EXISTS doctors (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  user_id INTEGER,
  name TEXT NOT NULL,
  department_id INTEGER,
  qualification TEXT,
  active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_doctors_org ON doctors(organization_id);

-- ---------- OPD ----------
CREATE TABLE IF NOT EXISTS opd_visits (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  opd_number TEXT UNIQUE NOT NULL,
  patient_id TEXT NOT NULL,
  department_id INTEGER,
  doctor_id INTEGER,
  token_number INTEGER,
  status TEXT DEFAULT 'Waiting' CHECK(status IN ('Waiting','In Consultation','Completed','Cancelled')),
  source TEXT DEFAULT 'staff' CHECK(source IN ('staff','qr_self')),
  visit_date TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD')),
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_opd_visits_org ON opd_visits(organization_id);

-- ---------- CONSULTATIONS ----------
CREATE TABLE IF NOT EXISTS consultations (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  opd_visit_id INTEGER,
  patient_id TEXT NOT NULL,
  doctor_id INTEGER,
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
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_consultations_org ON consultations(organization_id);

-- ---------- ADMISSIONS ----------
CREATE TABLE IF NOT EXISTS admissions (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  admission_number TEXT UNIQUE NOT NULL,
  patient_id TEXT NOT NULL,
  referring_doctor_id INTEGER,
  attending_doctor_id INTEGER,
  department_id INTEGER,
  reason TEXT,
  diagnosis TEXT,
  proposed_treatment TEXT,
  admission_type TEXT DEFAULT 'Normal' CHECK(admission_type IN ('Normal','Emergency')),
  bed_id INTEGER,
  status TEXT DEFAULT 'Active' CHECK(status IN ('Active','Discharged')),
  admitted_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
  discharged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admissions_org ON admissions(organization_id);

CREATE TABLE IF NOT EXISTS bed_allocations (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  bed_id INTEGER NOT NULL,
  admission_id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  allocated_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bed_allocations_org ON bed_allocations(organization_id);

-- ---------- CLINICAL ----------
CREATE TABLE IF NOT EXISTS clinical_notes (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  admission_id INTEGER,
  note_type TEXT CHECK(note_type IN ('Doctor Note','Nursing Note','Progress Note')),
  content TEXT NOT NULL,
  user_id INTEGER,
  role TEXT,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_clinical_notes_org ON clinical_notes(organization_id);

CREATE TABLE IF NOT EXISTS vitals (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  admission_id INTEGER,
  temperature TEXT, pulse TEXT, bp TEXT, spo2 TEXT, resp_rate TEXT,
  recorded_by INTEGER,
  recorded_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_vitals_org ON vitals(organization_id);

-- ---------- MEDICATION ----------
CREATE TABLE IF NOT EXISTS prescriptions (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  admission_id INTEGER,
  medicine TEXT NOT NULL,
  dose TEXT,
  route TEXT,
  frequency TEXT,
  start_date TEXT,
  end_date TEXT,
  prescribed_by INTEGER,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_org ON prescriptions(organization_id);

CREATE TABLE IF NOT EXISTS medication_administration (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  prescription_id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  administered_by INTEGER,
  administered_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_medication_administration_org ON medication_administration(organization_id);

-- ---------- LAB ----------
CREATE TABLE IF NOT EXISTS lab_orders (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  admission_id INTEGER,
  test_name TEXT NOT NULL,
  ordered_by INTEGER,
  status TEXT DEFAULT 'Ordered' CHECK(status IN ('Ordered','Sample Collected','Processing','Result Entered','Report Generated')),
  ordered_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
  sample_collected_at TEXT,
  result TEXT,
  report_file TEXT,
  finalized_by INTEGER,
  finalized_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lab_orders_org ON lab_orders(organization_id);

-- ---------- SURGERY ----------
CREATE TABLE IF NOT EXISTS surgeries (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  admission_id INTEGER,
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
  created_by INTEGER,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_surgeries_org ON surgeries(organization_id);

CREATE TABLE IF NOT EXISTS surgical_items (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  surgery_id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  item_category TEXT,
  quantity INTEGER,
  batch_number TEXT,
  usage_date TEXT,
  recorded_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_surgical_items_org ON surgical_items(organization_id);

-- ---------- DISCHARGE ----------
CREATE TABLE IF NOT EXISTS discharge_summaries (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  admission_id INTEGER UNIQUE NOT NULL,
  patient_id TEXT NOT NULL,
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
  finalized_by INTEGER,
  finalized_at TEXT,
  pdf_path TEXT,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_discharge_summaries_org ON discharge_summaries(organization_id);

-- ---------- TIMELINE / NOTIFICATIONS / LOGS ----------
CREATE TABLE IF NOT EXISTS patient_timeline (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  event_date TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_patient_timeline_org ON patient_timeline(organization_id);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  target_role TEXT,
  read_status INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_org ON notifications(organization_id);

CREATE TABLE IF NOT EXISTS sms_log (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  patient_id TEXT,
  phone TEXT,
  event_type TEXT,
  message TEXT,
  status TEXT DEFAULT 'Sent (Simulated)',
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_sms_log_org ON sms_log(organization_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  role TEXT,
  action TEXT NOT NULL,
  patient_id TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log(organization_id);

CREATE TABLE IF NOT EXISTS ai_query_log (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  user_id INTEGER,
  role TEXT,
  question TEXT,
  answer TEXT,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_ai_query_log_org ON ai_query_log(organization_id);

-- ===================== BILLING & ADVANCE DEPOSIT (hospital patient billing — kept separate from SaaS subscription billing) =====================

CREATE TABLE IF NOT EXISTS billing_accounts (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  account_number TEXT UNIQUE NOT NULL, -- BILL-000001
  patient_id TEXT NOT NULL,
  admission_id INTEGER UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','Closed')),
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_billing_accounts_org ON billing_accounts(organization_id);

CREATE TABLE IF NOT EXISTS billing_transactions (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
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
  created_by INTEGER,
  created_by_name TEXT,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_billing_transactions_org ON billing_transactions(organization_id);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  invoice_number TEXT UNIQUE NOT NULL, -- INV-2026-00001
  type TEXT NOT NULL CHECK(type IN ('Interim','Final')),
  total_charges REAL NOT NULL,
  deposit_amount REAL NOT NULL,
  additional_payments REAL NOT NULL,
  refunds REAL NOT NULL,
  balance_amount REAL NOT NULL,
  balance_type TEXT NOT NULL CHECK(balance_type IN ('CREDIT','DUE','SETTLED')),
  pdf_path TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(organization_id);

CREATE TABLE IF NOT EXISTS billing_rates (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  rate REAL,
  unit TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_billing_rates_org ON billing_rates(organization_id);

-- hospital_settings kept as a per-organization key/value table (was global, now scoped)
CREATE TABLE IF NOT EXISTS hospital_settings (
  organization_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (organization_id, key)
);

-- ===================== SAAS SUBSCRIPTION BILLING (Aiventra <-> Hospital, NOT hospital <-> patient) =====================
-- Kept entirely separate from the billing_* tables above, which are the hospital's own
-- patient billing. A hospital's subscription to Aiventra has nothing to do with what it
-- charges its own patients.

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
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
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  subscription_id INTEGER NOT NULL,
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
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_org ON subscription_payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_order ON subscription_payments(razorpay_order_id);

-- Every subscription lifecycle change (create/upgrade/downgrade/cancel/reactivate/webhook
-- event) is recorded here, independent of the hospital's own clinical audit_log.
CREATE TABLE IF NOT EXISTS subscription_events (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER, -- NULL for pre-auth events e.g. an invalid webhook signature from an unidentified sender
  subscription_id INTEGER,
  event_type TEXT NOT NULL,                 -- created, upgraded, downgraded, payment_verified, payment_failed, cancelled, reactivated, webhook_received, webhook_signature_invalid
  detail TEXT,
  actor TEXT,                               -- 'user:<id>' | 'webhook' | 'system'
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_subscription_events_org ON subscription_events(organization_id);

-- ===================== MARKETING SITE LEADS (public website, not tied to any organization) =====================
CREATE TABLE IF NOT EXISTS marketing_leads (
  id SERIAL PRIMARY KEY,
  lead_type TEXT NOT NULL CHECK(lead_type IN ('demo_request','contact')),
  name TEXT NOT NULL,
  hospital_name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  city TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','converted','closed')),
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_type ON marketing_leads(lead_type);

-- ===================== PASSWORD RESET =====================
-- Only the SHA-256 hash of the token is ever stored - the raw token exists only in the
-- (simulated, see docs/security.md) email sent to the user and in the URL they click,
-- exactly like a password_hash never stores the plaintext password.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  requested_ip TEXT,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);

-- ===================== STAFF INVITATIONS =====================
CREATE TABLE IF NOT EXISTS invitations (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK(role IN (
    'organization_owner','hospital_admin','doctor','receptionist',
    'accountant','pharmacy_staff','lab_staff','nurse','report_viewer'
  )),
  token_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked','expired')),
  invited_by INTEGER,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_user_id INTEGER,
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(organization_id);

-- ===================== EMAIL LOG (mirrors sms_log's simulated-provider pattern) =====================
-- No real email provider is configured out of the box (same honest stance as SMS - see
-- docs/security.md). Every email this app would send is recorded here with its full content
-- so nothing is silently lost, and a real provider (SendGrid/SES/etc) can be wired in by
-- replacing the one function in server/utils/email.js without touching any caller.
CREATE TABLE IF NOT EXISTS email_log (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER, -- NULL for platform-level emails (e.g. super admin's own password reset)
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  event_type TEXT,
  status TEXT DEFAULT 'Sent (Simulated)',
  created_at TEXT DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_org ON email_log(organization_id);


-- ===================== FOREIGN KEYS (added after all tables exist; SQLite tolerated
-- forward references inline, Postgres does not) =====================
DO $$ BEGIN
  ALTER TABLE organization_settings ADD CONSTRAINT fk_organization_settings_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE platform_audit_log ADD CONSTRAINT fk_platform_audit_log_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE support_tickets ADD CONSTRAINT fk_support_tickets_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE support_tickets ADD CONSTRAINT fk_support_tickets_raised_by FOREIGN KEY (raised_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE support_access_requests ADD CONSTRAINT fk_support_access_requests_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT fk_users_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE floors ADD CONSTRAINT fk_floors_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE rooms ADD CONSTRAINT fk_rooms_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE rooms ADD CONSTRAINT fk_rooms_floor_id FOREIGN KEY (floor_id) REFERENCES floors(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE beds ADD CONSTRAINT fk_beds_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE beds ADD CONSTRAINT fk_beds_room_id FOREIGN KEY (room_id) REFERENCES rooms(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE patients ADD CONSTRAINT fk_patients_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE patient_documents ADD CONSTRAINT fk_patient_documents_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE patient_documents ADD CONSTRAINT fk_patient_documents_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE patient_documents ADD CONSTRAINT fk_patient_documents_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE departments ADD CONSTRAINT fk_departments_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE doctors ADD CONSTRAINT fk_doctors_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE doctors ADD CONSTRAINT fk_doctors_user_id FOREIGN KEY (user_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE doctors ADD CONSTRAINT fk_doctors_department_id FOREIGN KEY (department_id) REFERENCES departments(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE opd_visits ADD CONSTRAINT fk_opd_visits_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE opd_visits ADD CONSTRAINT fk_opd_visits_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE opd_visits ADD CONSTRAINT fk_opd_visits_department_id FOREIGN KEY (department_id) REFERENCES departments(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE opd_visits ADD CONSTRAINT fk_opd_visits_doctor_id FOREIGN KEY (doctor_id) REFERENCES doctors(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE consultations ADD CONSTRAINT fk_consultations_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE consultations ADD CONSTRAINT fk_consultations_opd_visit_id FOREIGN KEY (opd_visit_id) REFERENCES opd_visits(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE consultations ADD CONSTRAINT fk_consultations_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE consultations ADD CONSTRAINT fk_consultations_doctor_id FOREIGN KEY (doctor_id) REFERENCES doctors(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE admissions ADD CONSTRAINT fk_admissions_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE admissions ADD CONSTRAINT fk_admissions_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE admissions ADD CONSTRAINT fk_admissions_referring_doctor_id FOREIGN KEY (referring_doctor_id) REFERENCES doctors(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE admissions ADD CONSTRAINT fk_admissions_attending_doctor_id FOREIGN KEY (attending_doctor_id) REFERENCES doctors(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE admissions ADD CONSTRAINT fk_admissions_department_id FOREIGN KEY (department_id) REFERENCES departments(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE admissions ADD CONSTRAINT fk_admissions_bed_id FOREIGN KEY (bed_id) REFERENCES beds(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE bed_allocations ADD CONSTRAINT fk_bed_allocations_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE bed_allocations ADD CONSTRAINT fk_bed_allocations_bed_id FOREIGN KEY (bed_id) REFERENCES beds(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE bed_allocations ADD CONSTRAINT fk_bed_allocations_admission_id FOREIGN KEY (admission_id) REFERENCES admissions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE bed_allocations ADD CONSTRAINT fk_bed_allocations_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE clinical_notes ADD CONSTRAINT fk_clinical_notes_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE clinical_notes ADD CONSTRAINT fk_clinical_notes_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE clinical_notes ADD CONSTRAINT fk_clinical_notes_admission_id FOREIGN KEY (admission_id) REFERENCES admissions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE clinical_notes ADD CONSTRAINT fk_clinical_notes_user_id FOREIGN KEY (user_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE vitals ADD CONSTRAINT fk_vitals_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE vitals ADD CONSTRAINT fk_vitals_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE vitals ADD CONSTRAINT fk_vitals_admission_id FOREIGN KEY (admission_id) REFERENCES admissions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE vitals ADD CONSTRAINT fk_vitals_recorded_by FOREIGN KEY (recorded_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE prescriptions ADD CONSTRAINT fk_prescriptions_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE prescriptions ADD CONSTRAINT fk_prescriptions_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE prescriptions ADD CONSTRAINT fk_prescriptions_admission_id FOREIGN KEY (admission_id) REFERENCES admissions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE prescriptions ADD CONSTRAINT fk_prescriptions_prescribed_by FOREIGN KEY (prescribed_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE medication_administration ADD CONSTRAINT fk_medication_administration_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE medication_administration ADD CONSTRAINT fk_medication_administration_prescription_id FOREIGN KEY (prescription_id) REFERENCES prescriptions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE medication_administration ADD CONSTRAINT fk_medication_administration_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE medication_administration ADD CONSTRAINT fk_medication_administration_administered_by FOREIGN KEY (administered_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE lab_orders ADD CONSTRAINT fk_lab_orders_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE lab_orders ADD CONSTRAINT fk_lab_orders_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE lab_orders ADD CONSTRAINT fk_lab_orders_admission_id FOREIGN KEY (admission_id) REFERENCES admissions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE lab_orders ADD CONSTRAINT fk_lab_orders_ordered_by FOREIGN KEY (ordered_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE lab_orders ADD CONSTRAINT fk_lab_orders_finalized_by FOREIGN KEY (finalized_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE surgeries ADD CONSTRAINT fk_surgeries_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE surgeries ADD CONSTRAINT fk_surgeries_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE surgeries ADD CONSTRAINT fk_surgeries_admission_id FOREIGN KEY (admission_id) REFERENCES admissions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE surgeries ADD CONSTRAINT fk_surgeries_created_by FOREIGN KEY (created_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE surgical_items ADD CONSTRAINT fk_surgical_items_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE surgical_items ADD CONSTRAINT fk_surgical_items_surgery_id FOREIGN KEY (surgery_id) REFERENCES surgeries(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE surgical_items ADD CONSTRAINT fk_surgical_items_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE surgical_items ADD CONSTRAINT fk_surgical_items_recorded_by FOREIGN KEY (recorded_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE discharge_summaries ADD CONSTRAINT fk_discharge_summaries_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE discharge_summaries ADD CONSTRAINT fk_discharge_summaries_admission_id FOREIGN KEY (admission_id) REFERENCES admissions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE discharge_summaries ADD CONSTRAINT fk_discharge_summaries_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE discharge_summaries ADD CONSTRAINT fk_discharge_summaries_finalized_by FOREIGN KEY (finalized_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE patient_timeline ADD CONSTRAINT fk_patient_timeline_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE patient_timeline ADD CONSTRAINT fk_patient_timeline_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE notifications ADD CONSTRAINT fk_notifications_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE sms_log ADD CONSTRAINT fk_sms_log_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE sms_log ADD CONSTRAINT fk_sms_log_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE audit_log ADD CONSTRAINT fk_audit_log_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE audit_log ADD CONSTRAINT fk_audit_log_user_id FOREIGN KEY (user_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE ai_query_log ADD CONSTRAINT fk_ai_query_log_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE ai_query_log ADD CONSTRAINT fk_ai_query_log_user_id FOREIGN KEY (user_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE billing_accounts ADD CONSTRAINT fk_billing_accounts_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE billing_accounts ADD CONSTRAINT fk_billing_accounts_patient_id FOREIGN KEY (patient_id) REFERENCES patients(patient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE billing_accounts ADD CONSTRAINT fk_billing_accounts_admission_id FOREIGN KEY (admission_id) REFERENCES admissions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE billing_transactions ADD CONSTRAINT fk_billing_transactions_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE billing_transactions ADD CONSTRAINT fk_billing_transactions_account_id FOREIGN KEY (account_id) REFERENCES billing_accounts(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE billing_transactions ADD CONSTRAINT fk_billing_transactions_created_by FOREIGN KEY (created_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT fk_invoices_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT fk_invoices_account_id FOREIGN KEY (account_id) REFERENCES billing_accounts(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT fk_invoices_created_by FOREIGN KEY (created_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE billing_rates ADD CONSTRAINT fk_billing_rates_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE hospital_settings ADD CONSTRAINT fk_hospital_settings_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE subscriptions ADD CONSTRAINT fk_subscriptions_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE subscriptions ADD CONSTRAINT fk_subscriptions_plan_id FOREIGN KEY (plan_id) REFERENCES plans(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE subscription_payments ADD CONSTRAINT fk_subscription_payments_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE subscription_payments ADD CONSTRAINT fk_subscription_payments_subscription_id FOREIGN KEY (subscription_id) REFERENCES subscriptions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE subscription_events ADD CONSTRAINT fk_subscription_events_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE subscription_events ADD CONSTRAINT fk_subscription_events_subscription_id FOREIGN KEY (subscription_id) REFERENCES subscriptions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE password_reset_tokens ADD CONSTRAINT fk_password_reset_tokens_user_id FOREIGN KEY (user_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE invitations ADD CONSTRAINT fk_invitations_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE invitations ADD CONSTRAINT fk_invitations_invited_by FOREIGN KEY (invited_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE invitations ADD CONSTRAINT fk_invitations_accepted_user_id FOREIGN KEY (accepted_user_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE email_log ADD CONSTRAINT fk_email_log_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
