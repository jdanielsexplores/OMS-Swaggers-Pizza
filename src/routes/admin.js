// Admin: settings, audit log, menu & prices, vendors, system health.
const express = require('express');
const fs = require('node:fs');
const db = require('../db');
const config = require('../config');
const approvals = require('../services/approvals');
const { audit } = require('../services/audit');
const { requirePerm } = require('../middleware');
const { toNum, pick } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();

const SETTINGS = [
  ['Company & branding', [
    ['business_name', 'Business name', 'text'],
    ['brand_tagline', 'Portal subtitle', 'text'],
    ['brand_color', 'Brand colour', 'color'],
    ['support_phone', 'Customer support phone', 'text'],
    ['currency', 'Currency code', 'text', 'Shown on money values (e.g. GHS).'],
    ['machine_portal_url', 'Supplier machine portal link', 'url', 'Opened from Sales & Cash-up and each machine page.'],
  ]],
  ['Attendance & geofence', [
    ['geofence_mode', 'Geofence', 'select:enforce|warn|off', 'Enforce = staff must be inside the site radius to clock in/out (checked on the server).'],
    ['geofence_default_radius_m', 'Default site radius (metres)', 'number'],
    ['geofence_max_accuracy_m', 'Reject GPS fixes less accurate than (metres)', 'number'],
    ['attendance_start_date', 'Attendance tracking started on', 'date', 'Days before this never count as absent.'],
    ['clockin_earliest_minutes', 'Earliest clock-in before shift (minutes)', 'number'],
    ['late_grace_minutes', 'Lateness grace (minutes)', 'number'],
    ['clockin_cutoff_hours', 'Clock-in cut-off after start (hours)', 'number', 'After this the day counts as absent unless a manager corrects it.'],
    ['standard_work_hours', 'Standard working day (hours)', 'number'],
    ['overtime_grace_hours', 'Overtime grace after the standard day (hours)', 'number', 'Overtime counts in whole hours after standard + grace.'],
  ]],
  ['Payroll rates', [
    ['payroll_working_days', 'Working days per month (for daily rate)', 'number'],
    ['overtime_multiplier', 'Overtime pay multiplier', 'number'],
    ['late_free_minutes_month', 'Free lateness minutes per month', 'number'],
    ['late_deduction_per_minute', 'Lateness deduction per minute after that (GHS)', 'number'],
    ['ssnit_employee_pct', 'SSNIT employee contribution (%)', 'number'],
    ['deduct_absences', 'Deduct unexplained absences from monthly pay (1 = yes, 0 = no)', 'text'],
  ]],
  ['Operations rules', [
    ['temp_min', 'Approved storage temperature — minimum °C', 'number', 'Until the supplier confirms the exact range (SOP-11).'],
    ['temp_max', 'Approved storage temperature — maximum °C', 'number'],
    ['refund_manager_limit', 'Refunds the Ops Manager may approve up to (GHS)', 'number', 'Above this the Owner approves.'],
    ['expense_manager_limit', 'Expenses recorded without approval up to (GHS)', 'number'],
    ['expense_owner_limit', 'Expenses the Ops Manager may approve up to (GHS)', 'number', 'Above this the Owner approves.'],
    ['variance_tolerance_amount', 'Cash-up variance tolerance (GHS)', 'number'],
    ['variance_tolerance_pct', 'Cash-up variance tolerance (%)', 'number'],
    ['waste_alert_pct', 'Waste alert threshold (% of units sold)', 'number'],
    ['digest_time', 'Daily summary time (HH:MM)', 'time'],
    ['playbook_version', 'Current playbook version (staff re-sign when changed)', 'text'],
    ['ai_enabled', 'Ask Swaggers AI assistant (1 = on, 0 = off)', 'text'],
    ['demo_mode', 'Show demo accounts on the sign-in page (1 = on, 0 = off)', 'text', 'Turn OFF before going live.'],
  ]],
];
const SETTING_KEYS = SETTINGS.flatMap(([, list]) => list.map(([k]) => k));

r.get('/admin', requirePerm('audit.view'), (req, res) => {
  const dbSize = fs.existsSync(config.dbPath) ? fs.statSync(config.dbPath).size : 0;
  const backups = fs.existsSync(config.backupDir) ? fs.readdirSync(config.backupDir).sort().reverse().slice(0, 5) : [];
  res.page('admin', 'Admin & Settings', {
    SETTINGS, values: Object.fromEntries(SETTING_KEYS.map((k) => [k, db.setting(k, '')])),
    stats: db.get('SELECT (SELECT COUNT(*) FROM users WHERE active=1) users, (SELECT COUNT(*) FROM sites) sites, (SELECT COUNT(*) FROM machines) machines, (SELECT COUNT(*) FROM sales) sales, (SELECT COUNT(*) FROM checklist_runs) runs, (SELECT COUNT(*) FROM audit_log) audits'),
    dbSize, backups, lastBackup: db.setting('last_backup_at'),
    integrations: { email: !!config.smtp, sms: !!config.smsWebhook, ai: !!config.anthropicKey, https: config.baseUrl.startsWith('https') },
  });
});

r.post('/admin/settings', requirePerm('settings.manage'), (req, res) => {
  const changed = {};
  for (const k of SETTING_KEYS) if (req.body[k] !== undefined && req.body[k] !== db.setting(k)) { db.setSetting(k, req.body[k]); changed[k] = req.body[k]; }
  const logo = require('../middleware').fileFor(req, 'brand_logo_file');
  if (logo) {
    // Copy into the public folder so the logo also shows on the sign-in page.
    const dest = require('node:path').join(config.root, 'public', 'img', `brand-${logo}`);
    fs.copyFileSync(require('node:path').join(config.uploadDir, logo), dest);
    db.setSetting('brand_logo', `/img/brand-${logo}`); changed.brand_logo = logo;
  }
  audit(req, 'settings.updated', 'settings', null, changed);
  req.flash('success', 'Settings saved.');
  res.redirect('/admin');
});

r.post('/admin/backup', requirePerm('settings.manage'), (req, res) => {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const file = `${config.backupDir}/swaggers-manual-${Date.now()}.db`;
  db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  db.setSetting('last_backup_at', new Date().toISOString().slice(0, 19).replace('T', ' '));
  audit(req, 'backup.created', null, null, file);
  req.flash('success', `Backup created: ${file.split('/').pop()}`);
  res.redirect('/admin');
});

r.post('/admin/run-jobs', requirePerm('settings.manage'), (req, res) => {
  require('../services/scheduler').runAll();
  req.flash('success', 'Automation checks run now (escalations, missed tasks, stock, maintenance).');
  res.redirect('/admin');
});

r.get('/admin/security', requirePerm('audit.view'), (req, res) => {
  const { where, params, f } = filters(req.query, {
    event: (v) => ['l.event LIKE ?', `${v}%`], user: F.eq('l.user_id'), from: F.dateFrom('l.created_at'), to: F.dateTo('l.created_at'),
    q: F.search('l.identifier', 'l.details', 'l.ip'),
  });
  const p = paginate(req, `SELECT l.*, u.name FROM security_log l LEFT JOIN users u ON u.id = l.user_id WHERE ${where} ORDER BY l.id DESC`, params, { perPage: 25 });
  const stats = db.get("SELECT SUM(event = 'login.success') ok, SUM(event = 'login.failed') failed, SUM(event = 'lockout') lockouts, SUM(event = 'geofence.rejected') geo, SUM(event = 'access.denied') denied FROM security_log WHERE created_at >= datetime('now','-7 days')");
  res.page('security-log', 'Security log', { p, rows: p.rows, stats, q: f, f, users: db.all('SELECT id, name FROM users ORDER BY name') });
});

r.get('/admin/audit', requirePerm('audit.view'), (req, res) => {
  const { where, params, f } = filters(req.query, {
    user: F.eq('a.user_id'), action: (v) => ['a.action LIKE ?', `%${v}%`], entity: F.eq('a.entity'),
    from: F.dateFrom('a.created_at'), to: F.dateTo('a.created_at'), q: F.search('a.details'),
  });
  const p = paginate(req, `SELECT a.*, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.id DESC`, params, { perPage: 25 });
  res.page('audit', 'Audit log', { p, rows: p.rows, f, q: f, users: db.all('SELECT id, name FROM users ORDER BY name'), entities: db.all('SELECT DISTINCT entity FROM audit_log WHERE entity IS NOT NULL ORDER BY entity').map((x) => x.entity) });
});

// ── Menu & prices (SOP-10) ──
r.get('/admin/products', requirePerm('products.manage'), (req, res) => {
  res.page('products', 'Menu & prices', { products: db.all('SELECT * FROM products ORDER BY active DESC, category, name'), pending: db.all("SELECT * FROM approvals WHERE kind IN ('price_change','menu_change') AND status = 'pending'") });
});
r.post('/admin/products', requirePerm('products.manage'), (req, res) => {
  const fields = pick(req.body, ['sku', 'name', 'category', 'unit', 'allergens', 'description', 'storage_note', 'colour']);
  const id = db.insert('products', { ...fields, price: toNum(req.body.price) || 0, unit_cost: toNum(req.body.unit_cost) || 0, reorder_level: toNum(req.body.reorder_level) || 12, shelf_life_hours: toNum(req.body.shelf_life_hours), approved: req.user.role === 'owner' ? 1 : 0, available: 0 });
  if (req.user.role !== 'owner') approvals.request({ kind: 'menu_change', title: `New menu item: ${fields.name} at GH₵${req.body.price}`, details: fields.description, entity: 'products', entity_id: id, payload: { product_id: id, available: 1 }, required_role: 'owner' }, req.user);
  audit(req, 'product.created', 'products', id, fields);
  req.flash('success', req.user.role === 'owner' ? 'Product added. Mark it available when ready.' : 'Product added and sent to the Owner for approval. It stays unavailable until approved.');
  res.redirect('/admin/products');
});
r.post('/admin/products/:id', requirePerm('products.manage'), (req, res) => {
  const p = db.get('SELECT * FROM products WHERE id = ?', req.params.id);
  const data = pick(req.body, ['name', 'allergens', 'description', 'storage_note', 'colour']);
  data.unit_cost = toNum(req.body.unit_cost) ?? p.unit_cost;
  data.reorder_level = toNum(req.body.reorder_level) ?? p.reorder_level;
  data.shelf_life_hours = toNum(req.body.shelf_life_hours);
  data.available = req.body.available ? 1 : 0;
  data.active = req.body.active ? 1 : 0;
  if (data.available && !p.approved) { req.flash('error', 'This product is not approved yet, so it cannot be made available.'); data.available = 0; }
  db.update('products', p.id, data);
  const newPrice = toNum(req.body.price);
  if (newPrice != null && newPrice !== p.price) {
    if (req.user.role === 'owner') { db.update('products', p.id, { price: newPrice }); req.flash('success', `Price changed to GH₵${newPrice}. Update the machine using the approved process and run a test order.`); }
    else { approvals.request({ kind: 'price_change', title: `Price change: ${p.name} GH₵${p.price} → GH₵${newPrice}`, details: req.body.reason || '', amount: newPrice, entity: 'products', entity_id: p.id, payload: { product_id: p.id, new_price: newPrice }, required_role: 'owner' }, req.user); req.flash('success', 'Price change sent to the Owner for approval.'); }
  }
  audit(req, 'product.updated', 'products', p.id, { ...data, newPrice });
  res.redirect('/admin/products');
});

// ── Vendors / suppliers / technicians ──
r.get('/admin/vendors', requirePerm('vendors.manage'), (req, res) => {
  const { where, params, f } = filters(req.query, { q: F.search('v.name', 'v.contact_name', 'v.phone', 'v.email'), category: F.eq('v.category'), approved: (v) => ['v.approved = ?', v === 'yes' ? 1 : 0] });
  const p = paginate(req, `SELECT v.*, (SELECT COUNT(*) FROM incidents i WHERE i.vendor_id = v.id) AS jobs, (SELECT COALESCE(SUM(amount),0) FROM transactions t WHERE t.vendor_id = v.id AND t.kind='expense') AS spend FROM vendors v WHERE ${where} ORDER BY v.category, v.name`, params, { perPage: 15 });
  res.page('vendors', 'Suppliers & technicians', { p, vendors: p.rows, f });
});
r.post('/admin/vendors', requirePerm('vendors.manage'), (req, res) => {
  const data = pick(req.body, ['name', 'category', 'contact_name', 'phone', 'email', 'notes']);
  data.sla_hours = toNum(req.body.sla_hours);
  data.approved = req.body.approved ? 1 : 0;
  if (req.body.id) db.update('vendors', Number(req.body.id), data); else db.insert('vendors', data);
  audit(req, 'vendor.saved', 'vendors', toNum(req.body.id), data);
  res.redirect('/admin/vendors');
});

module.exports = r;
