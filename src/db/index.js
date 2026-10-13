// Thin wrapper over Node's built-in SQLite (no native build step needed).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const raw = new DatabaseSync(config.dbPath);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
raw.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Lightweight forward migrations for databases created by older versions.
const hasCol = (t, c) => raw.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
const addCol = (t, c, def) => { if (!hasCol(t, c)) raw.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('sops', 'draft', 'TEXT');
// v1.1 — access, HR, geofence, supplier portal
addCol('users', 'username', 'TEXT');
addCol('users', 'status', "TEXT DEFAULT 'active'");             // active | inactive | suspended
addCol('users', 'pay_type', "TEXT DEFAULT 'monthly'");          // monthly | daily | hourly
addCol('users', 'base_salary', 'REAL DEFAULT 0');               // monthly salary, or daily / hourly rate
addCol('users', 'allowances', 'REAL DEFAULT 0');                // fixed monthly allowances
addCol('users', 'other_deductions', 'REAL DEFAULT 0');
addCol('users', 'ssnit_applies', 'INTEGER DEFAULT 1');
addCol('users', 'bank_details', 'TEXT');                        // MoMo / bank account for salary
addCol('users', 'work_days', "TEXT DEFAULT '1,2,3,4,5,6'");     // 0=Sun … 6=Sat
addCol('users', 'work_start', "TEXT DEFAULT '07:00'");
addCol('users', 'work_end', "TEXT DEFAULT '15:00'");
addCol('users', 'geofence_mode', "TEXT DEFAULT 'site'");        // site | custom | exempt
addCol('users', 'geo_lat', 'REAL');
addCol('users', 'geo_lng', 'REAL');
addCol('users', 'geo_radius_m', 'INTEGER');
addCol('users', 'avatar_color', 'TEXT');
addCol('sites', 'geofence_radius_m', 'INTEGER DEFAULT 150');
addCol('machines', 'supplier_device_no', 'TEXT');
addCol('attendance', 'in_distance_m', 'REAL');
addCol('attendance', 'out_distance_m', 'REAL');
addCol('attendance', 'in_accuracy_m', 'REAL');
addCol('attendance', 'work_date', 'TEXT');
addCol('attendance', 'scheduled_start', 'TEXT');
addCol('attendance', 'effective_start', 'TEXT');
addCol('attendance', 'worked_minutes', 'INTEGER');
addCol('attendance', 'overtime_hours', 'INTEGER DEFAULT 0');
addCol('attendance', 'overtime_override', 'INTEGER');
addCol('attendance', 'override_reason', 'TEXT');
addCol('attendance', 'source', "TEXT DEFAULT 'self'");          // self | admin | auto_clockout
addCol('attendance', 'flags', 'TEXT');
addCol('leave_requests', 'until_time', 'TEXT');                 // late permission: allowed to arrive by
addCol('daily_closeouts', 'evidence', 'TEXT');                  // screenshot from the supplier portal
addCol('daily_closeouts', 'machine_status', 'TEXT');            // online/offline as shown in supplier portal
addCol('daily_closeouts', 'flavour_counts', 'TEXT');           // JSON {product_id: qty}
addCol('products', 'image', 'TEXT');
raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
  return s;
}
// node:sqlite rejects `undefined`; normalise params.
const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
const plain = (row) => (row ? { ...row } : row);

const db = {
  raw,
  all: (sql, ...params) => stmt(sql).all(...clean(params)).map(plain),
  get: (sql, ...params) => plain(stmt(sql).get(...clean(params))),
  run: (sql, ...params) => {
    const r = stmt(sql).run(...clean(params));
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  },
  val: (sql, ...params) => {
    const row = stmt(sql).get(...clean(params));
    return row ? Object.values(row)[0] : undefined;
  },
  exec: (sql) => raw.exec(sql),
  tx(fn) {
    raw.exec('BEGIN');
    try { const out = fn(); raw.exec('COMMIT'); return out; }
    catch (e) { raw.exec('ROLLBACK'); throw e; }
  },
  // Insert helper: db.insert('table', {col: val})
  insert(table, obj) {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    return db.run(sql, ...keys.map((k) => obj[k])).id;
  },
  update(table, id, obj) {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    if (!keys.length) return 0;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
    return db.run(sql, ...keys.map((k) => obj[k]), id).changes;
  },
  setting(key, fallback = null) {
    const v = db.val('SELECT value FROM settings WHERE key = ?', key);
    return v === undefined || v === null ? fallback : v;
  },
  setSetting(key, value) {
    db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  },
};

module.exports = db;
