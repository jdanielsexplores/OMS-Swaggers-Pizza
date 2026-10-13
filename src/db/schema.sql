-- Swaggers Pizza Operations Management System — database schema
PRAGMA foreign_keys = ON;

-- ───────────── Organisation ─────────────
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',          -- airport | mall | office | school | other
  address TEXT,
  city TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  emergency_contact TEXT,
  opening_time TEXT DEFAULT '07:00',
  closing_time TEXT DEFAULT '21:00',
  status TEXT NOT NULL DEFAULT 'active',        -- planning | active | paused | closed
  latitude REAL, longitude REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,                    -- e.g. SWG-ACC-01
  site_id INTEGER REFERENCES sites(id),
  model TEXT,
  serial_no TEXT,
  capacity INTEGER DEFAULT 60,                  -- pizzas held in machine
  status TEXT NOT NULL DEFAULT 'online',        -- online | degraded | offline | maintenance | decommissioned
  status_reason TEXT,
  status_changed_at TEXT DEFAULT (datetime('now')),
  installed_on TEXT,
  warranty_until TEXT,
  last_service_on TEXT,
  service_interval_days INTEGER DEFAULT 30,
  api_key TEXT UNIQUE,                          -- for machine telemetry integration
  last_heartbeat TEXT,
  payment_qr_ref TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS machine_status_log (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  status TEXT NOT NULL,
  reason TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  user_id INTEGER REFERENCES users(id)
);

-- ───────────── People & access ─────────────
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  staff_no TEXT UNIQUE,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  role TEXT NOT NULL,                           -- owner | ops_manager | supervisor | sales_rep | stock_staff | technician | accounts
  password_hash TEXT NOT NULL,
  must_change_password INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  cleared_to_work_alone INTEGER DEFAULT 0,
  hired_on TEXT,
  emergency_contact TEXT,
  failed_logins INTEGER DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_sites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  ip TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────────── Roster & attendance ─────────────
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  machine_id INTEGER REFERENCES machines(id),
  shift_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  shift_type TEXT DEFAULT 'day',                -- opening | day | closing | restock | full
  duties TEXT,                                  -- comma list: opening,cleaning,refill,closing,customer
  status TEXT DEFAULT 'scheduled',              -- scheduled | in_progress | completed | missed | cancelled
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id),
  site_id INTEGER REFERENCES sites(id),
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  in_lat REAL, in_lng REAL, out_lat REAL, out_lng REAL,
  late_minutes INTEGER DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS handovers (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id),
  stock_summary TEXT,
  open_issues TEXT,
  cash_payment_notes TEXT,
  notes TEXT,
  acknowledged_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  leave_type TEXT DEFAULT 'annual',
  reason TEXT,
  status TEXT DEFAULT 'pending',
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────────── Checklists ─────────────
CREATE TABLE IF NOT EXISTS checklist_templates (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,                       -- opening | during | refill | cleaning | closing | weekly | food_safety | site
  description TEXT,
  frequency TEXT DEFAULT 'daily',               -- per_shift | daily | weekly | monthly | ad_hoc
  due_time TEXT,                                -- HH:MM local, for missed-task detection
  roles TEXT,                                   -- which roles may complete
  site_type TEXT,                               -- null = all sites
  sop_code TEXT,
  active INTEGER DEFAULT 1,
  version INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  guidance TEXT,
  response_type TEXT DEFAULT 'yesno',           -- yesno | number | text | temperature
  critical INTEGER DEFAULT 0,                   -- a "No" auto-raises an incident
  requires_photo INTEGER DEFAULT 0,
  min_value REAL, max_value REAL
);

CREATE TABLE IF NOT EXISTS checklist_runs (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES checklist_templates(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  machine_id INTEGER REFERENCES machines(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id),
  run_date TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  submitted_at TEXT,
  status TEXT DEFAULT 'draft',                  -- draft | submitted | reviewed | rejected
  score REAL,                                   -- % items passed
  failed_count INTEGER DEFAULT 0,
  notes TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_notes TEXT
);

CREATE TABLE IF NOT EXISTS checklist_responses (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES checklist_runs(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES checklist_items(id),
  answer TEXT,                                  -- yes | no | na | value
  value REAL,
  notes TEXT,
  photo TEXT,
  answered_at TEXT DEFAULT (datetime('now')),
  UNIQUE(run_id, item_id)
);

CREATE TABLE IF NOT EXISTS checklist_corrections (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES checklist_runs(id),
  item_id INTEGER,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────────── Incidents & maintenance ─────────────
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  ref TEXT UNIQUE,
  site_id INTEGER REFERENCES sites(id),
  machine_id INTEGER REFERENCES machines(id),
  type TEXT NOT NULL,                           -- machine | payment | food_safety | stock | customer | site_safety | security | other
  severity TEXT NOT NULL DEFAULT 'minor',       -- critical | major | minor
  title TEXT NOT NULL,
  description TEXT,
  action_taken TEXT,
  error_message TEXT,
  order_ref TEXT,
  payment_ref TEXT,
  sales_paused INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',          -- open | acknowledged | assigned | in_progress | awaiting_verification | resolved | closed
  reported_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  vendor_id INTEGER REFERENCES vendors(id),
  source TEXT DEFAULT 'staff',                  -- staff | checklist | machine | customer | system
  source_id INTEGER,
  acknowledged_at TEXT,
  resolved_at TEXT,
  closed_at TEXT,
  due_at TEXT,
  escalation_level INTEGER DEFAULT 0,
  root_cause TEXT,
  resolution TEXT,
  return_to_service_checked INTEGER DEFAULT 0,
  downtime_minutes INTEGER,
  cost REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  kind TEXT DEFAULT 'comment',                  -- comment | status | assign | escalation | system
  body TEXT,
  attachment TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,                                -- technician | food_supplier | packaging | payment_provider | logistics | cleaning | other
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  sla_hours INTEGER,
  approved INTEGER DEFAULT 1,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  incident_id INTEGER REFERENCES incidents(id),
  kind TEXT DEFAULT 'preventive',               -- preventive | corrective | inspection | calibration
  performed_by INTEGER REFERENCES users(id),
  vendor_id INTEGER REFERENCES vendors(id),
  performed_on TEXT NOT NULL,
  findings TEXT,
  work_done TEXT,
  parts_used TEXT,
  cost REAL DEFAULT 0,
  tests_passed INTEGER DEFAULT 1,
  next_due_on TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────────── Products, stock & food safety ─────────────
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'pizza',                -- pizza | packaging | consumable | ingredient
  unit TEXT DEFAULT 'pcs',
  price REAL DEFAULT 0,                          -- selling price (GHS)
  unit_cost REAL DEFAULT 0,                      -- cost of goods
  allergens TEXT,
  description TEXT,
  shelf_life_hours INTEGER,
  storage_note TEXT,
  reorder_level INTEGER DEFAULT 20,
  approved INTEGER DEFAULT 0,
  available INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  colour TEXT
);

CREATE TABLE IF NOT EXISTS stock_locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'machine',         -- central | site_store | machine | vehicle
  site_id INTEGER REFERENCES sites(id),
  machine_id INTEGER REFERENCES machines(id) UNIQUE
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  batch_no TEXT NOT NULL,
  supplier_id INTEGER REFERENCES vendors(id),
  produced_on TEXT,
  expires_at TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'released',               -- released | on_hold | recalled | expired
  hold_reason TEXT,
  UNIQUE(product_id, batch_no)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  batch_id INTEGER REFERENCES batches(id),
  from_location_id INTEGER REFERENCES stock_locations(id),
  to_location_id INTEGER REFERENCES stock_locations(id),
  qty REAL NOT NULL,
  kind TEXT NOT NULL,                           -- receive | transfer | load | sale | waste | adjust | count | return | reject
  reason TEXT,
  reference TEXT,
  unit_cost REAL,
  user_id INTEGER REFERENCES users(id),
  occurred_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_counts (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES stock_locations(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  expected REAL NOT NULL,
  counted REAL NOT NULL,
  variance REAL NOT NULL,
  user_id INTEGER REFERENCES users(id),
  explanation TEXT,
  counted_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS restock_requests (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  machine_id INTEGER REFERENCES machines(id),
  requested_by INTEGER REFERENCES users(id),
  items TEXT NOT NULL,                          -- JSON [{product_id, qty}]
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'requested',              -- requested | approved | dispatched | delivered | cancelled
  notes TEXT,
  handled_by INTEGER REFERENCES users(id),
  needed_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS temperature_logs (
  id INTEGER PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id),
  machine_id INTEGER REFERENCES machines(id),
  location_label TEXT,                          -- machine chiller | site freezer | delivery cooler
  reading REAL NOT NULL,
  min_allowed REAL,
  max_allowed REAL,
  in_range INTEGER,
  action_taken TEXT,
  user_id INTEGER REFERENCES users(id),
  recorded_at TEXT DEFAULT (datetime('now'))
);

-- ───────────── Sales & payments ─────────────
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  product_id INTEGER REFERENCES products(id),
  order_ref TEXT,
  qty INTEGER DEFAULT 1,
  unit_price REAL,
  amount REAL NOT NULL,
  payment_method TEXT DEFAULT 'momo',           -- momo | qr | card | other
  payment_ref TEXT,
  payment_status TEXT DEFAULT 'confirmed',      -- confirmed | pending | failed | refunded
  dispense_status TEXT DEFAULT 'dispensed',     -- dispensed | failed | pending
  source TEXT DEFAULT 'manual',                 -- manual | import | machine_api
  sold_at TEXT NOT NULL,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sold_at);
CREATE INDEX IF NOT EXISTS idx_sales_machine ON sales(machine_id, sold_at);

CREATE TABLE IF NOT EXISTS payment_exceptions (
  id INTEGER PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id),
  machine_id INTEGER REFERENCES machines(id),
  kind TEXT NOT NULL,                           -- deducted_no_order | duplicate | wrong_amount | pending | provider_down | unmatched
  amount REAL,
  payment_ref TEXT,
  order_ref TEXT,
  customer_phone_last4 TEXT,
  occurred_at TEXT,
  status TEXT DEFAULT 'open',                   -- open | investigating | matched | refunded | rejected | closed
  resolution TEXT,
  case_id INTEGER REFERENCES customer_cases(id),
  reported_by INTEGER REFERENCES users(id),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_closeouts (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  business_date TEXT NOT NULL,
  machine_reported_orders INTEGER,
  machine_reported_amount REAL,
  provider_settled_amount REAL,
  system_orders INTEGER,
  system_amount REAL,
  variance REAL,
  notes TEXT,
  submitted_by INTEGER REFERENCES users(id),
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(machine_id, business_date)
);

-- ───────────── Customers ─────────────
CREATE TABLE IF NOT EXISTS customer_cases (
  id INTEGER PRIMARY KEY,
  ref TEXT UNIQUE,
  site_id INTEGER REFERENCES sites(id),
  machine_id INTEGER REFERENCES machines(id),
  category TEXT NOT NULL,                       -- payment | quality | food_safety | service | machine | suggestion | praise | other
  channel TEXT DEFAULT 'in_person',             -- in_person | qr_feedback | phone | social | email
  customer_name TEXT,
  customer_contact TEXT,
  product_id INTEGER REFERENCES products(id),
  order_ref TEXT,
  payment_ref TEXT,
  description TEXT NOT NULL,
  rating INTEGER,
  status TEXT DEFAULT 'open',                   -- open | investigating | awaiting_refund | resolved | closed
  outcome TEXT,
  assigned_to INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  case_id INTEGER REFERENCES customer_cases(id),
  payment_exception_id INTEGER REFERENCES payment_exceptions(id),
  amount REAL NOT NULL,
  method TEXT DEFAULT 'momo_reversal',
  reason TEXT,
  status TEXT DEFAULT 'pending',                -- pending | approved | rejected | paid
  requested_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  paid_ref TEXT,
  paid_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────────── Work management ─────────────
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT DEFAULT 'task',                     -- task | corrective_action | follow_up | project
  site_id INTEGER REFERENCES sites(id),
  machine_id INTEGER REFERENCES machines(id),
  incident_id INTEGER REFERENCES incidents(id),
  assigned_to INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  priority TEXT DEFAULT 'normal',               -- low | normal | high | urgent
  due_at TEXT,
  status TEXT DEFAULT 'open',                   -- open | in_progress | done | verified | cancelled
  completed_at TEXT,
  completion_notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                           -- expense | refund | price_change | menu_change | sop_change | purchase | new_site | other
  title TEXT NOT NULL,
  details TEXT,
  amount REAL,
  entity TEXT,
  entity_id INTEGER,
  payload TEXT,                                 -- JSON applied on approval
  required_role TEXT DEFAULT 'ops_manager',
  status TEXT DEFAULT 'pending',                -- pending | approved | rejected
  requested_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT DEFAULT 'info',                    -- info | warning | critical | success
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT DEFAULT 'all',                  -- all | role:<role> | site:<id>
  pinned INTEGER DEFAULT 0,
  requires_ack INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  expires_on TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcement_acks (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acked_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(announcement_id, user_id)
);

-- ───────────── Knowledge & training ─────────────
CREATE TABLE IF NOT EXISTS sops (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,                    -- SOP-01
  title TEXT NOT NULL,
  category TEXT,                                -- operations | customer | payments | food_safety | stock | cleaning | safety | people | management | site
  purpose TEXT,
  roles TEXT,
  body TEXT NOT NULL,                           -- markdown-ish
  version TEXT DEFAULT '2.0',
  status TEXT DEFAULT 'approved',               -- draft | approved | retired
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  review_due TEXT,
  draft TEXT,                                   -- JSON of proposed changes awaiting approval
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sop_reads (
  sop_id INTEGER NOT NULL REFERENCES sops(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  read_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(sop_id, user_id, version)
);

CREATE TABLE IF NOT EXISTS training_modules (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT,
  video_url TEXT,
  roles TEXT,                                   -- comma list; empty = everyone
  sop_codes TEXT,
  pass_mark INTEGER DEFAULT 80,
  practical_required INTEGER DEFAULT 1,
  position INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id INTEGER PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options TEXT NOT NULL,                        -- JSON array
  correct_index INTEGER NOT NULL,
  explanation TEXT
);

CREATE TABLE IF NOT EXISTS training_records (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  module_id INTEGER NOT NULL REFERENCES training_modules(id),
  quiz_score INTEGER,
  quiz_passed INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  quiz_completed_at TEXT,
  practical_passed INTEGER,
  practical_assessor INTEGER REFERENCES users(id),
  practical_notes TEXT,
  practical_at TEXT,
  retrain_due TEXT,
  UNIQUE(user_id, module_id)
);

CREATE TABLE IF NOT EXISTS acknowledgements (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  document TEXT NOT NULL,                       -- playbook | code_of_conduct | data_privacy
  version TEXT NOT NULL,
  signature TEXT NOT NULL,                      -- typed full name
  ip TEXT,
  signed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, document, version)
);

-- ───────────── Finance ─────────────
CREATE TABLE IF NOT EXISTS finance_categories (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                           -- income | expense
  name TEXT NOT NULL,
  parent TEXT,
  UNIQUE(kind, name)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                           -- income | expense
  category_id INTEGER REFERENCES finance_categories(id),
  site_id INTEGER REFERENCES sites(id),
  machine_id INTEGER REFERENCES machines(id),
  vendor_id INTEGER REFERENCES vendors(id),
  amount REAL NOT NULL,
  description TEXT,
  reference TEXT,
  receipt TEXT,
  txn_date TEXT NOT NULL,
  status TEXT DEFAULT 'approved',               -- pending | approved | rejected
  approval_id INTEGER REFERENCES approvals(id),
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,                          -- YYYY-MM
  category_id INTEGER REFERENCES finance_categories(id),
  site_id INTEGER REFERENCES sites(id),
  amount REAL NOT NULL,
  UNIQUE(month, category_id, site_id)
);

-- ───────────── Launch readiness & settings ─────────────
CREATE TABLE IF NOT EXISTS readiness_items (
  id INTEGER PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id),         -- null = business-wide
  item TEXT NOT NULL,
  owner_source TEXT,
  status TEXT DEFAULT 'open',                   -- open | in_progress | confirmed | not_applicable
  evidence TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  position INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ai_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  question TEXT,
  answer TEXT,
  helpful INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts_sent (
  key TEXT PRIMARY KEY,
  sent_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS public_feedback_throttle (
  ip TEXT, created_at TEXT DEFAULT (datetime('now'))
);

-- ───────────── v1.1: access control, HR & payroll ─────────────
CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  perm TEXT NOT NULL,
  PRIMARY KEY (role, perm)
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perm TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('grant','deny')),
  PRIMARY KEY (user_id, perm)
);

CREATE TABLE IF NOT EXISTS security_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  event TEXT NOT NULL,              -- login.success | login.failed | lockout | logout | timeout | password.changed | password.reset | permission.changed | geofence.rejected | access.denied
  identifier TEXT,
  details TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Audit and security logs are append-only.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS security_log_no_update BEFORE UPDATE ON security_log BEGIN SELECT RAISE(ABORT, 'security log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS security_log_no_delete BEFORE DELETE ON security_log BEGIN SELECT RAISE(ABORT, 'security log is append-only'); END;

CREATE TABLE IF NOT EXISTS employee_awards (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL UNIQUE,       -- YYYY-MM
  user_id INTEGER NOT NULL REFERENCES users(id),
  score REAL,
  citation TEXT,
  awarded_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL UNIQUE,       -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | finalized
  employees INTEGER, gross REAL, deductions REAL, net REAL,
  generated_by INTEGER REFERENCES users(id),
  generated_at TEXT DEFAULT (datetime('now')),
  finalized_by INTEGER REFERENCES users(id),
  finalized_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pay_type TEXT,
  base_pay REAL, allowances REAL,
  scheduled_days INTEGER, worked_days INTEGER, absent_days INTEGER, leave_days INTEGER,
  late_minutes INTEGER, overtime_hours INTEGER,
  overtime_pay REAL, absence_deduction REAL, late_deduction REAL, ssnit REAL, other_deductions REAL,
  gross REAL, net REAL,
  details TEXT
);
