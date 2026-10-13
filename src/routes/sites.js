const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const access = require('../services/access');
const metrics = require('../services/metrics');
const stock = require('../services/stock');
const incidents = require('../services/incidents');
const approvals = require('../services/approvals');
const { audit } = require('../services/audit');
const { requirePerm } = require('../middleware');
const { READINESS, SITE_RULES } = require('../content/reference');
const { pick, today, addDays, toNum, sqlNow } = require('../lib/util');
const { paginate } = require('../lib/paging');
const config = require('../config');

const r = express.Router();
const SITE_FIELDS = ['code', 'name', 'type', 'address', 'city', 'contact_name', 'contact_phone', 'emergency_contact', 'opening_time', 'closing_time', 'status', 'notes', 'latitude', 'longitude', 'geofence_radius_m'];
const MACHINE_FIELDS = ['code', 'supplier_device_no', 'site_id', 'model', 'serial_no', 'capacity', 'installed_on', 'warranty_until', 'last_service_on', 'service_interval_days', 'payment_qr_ref', 'notes'];

const guardSite = (req, id) => { if (!access.canSite(req.user, id)) { const e = new Error('This site is not assigned to you.'); e.status = 403; throw e; } };

// ── Sites ──
r.get('/sites', (req, res) => {
  const ids = access.siteIds(req.user);
  const { from, to } = metrics.range(30);
  const perf = metrics.salesBySite(ids, from, to);
  const sites = db.all(`SELECT s.*, (SELECT COUNT(*) FROM machines m WHERE m.site_id = s.id AND m.status != 'decommissioned') AS machines,
      (SELECT COUNT(*) FROM readiness_items ri WHERE ri.site_id = s.id) AS ready_total,
      (SELECT COUNT(*) FROM readiness_items ri WHERE ri.site_id = s.id AND ri.status IN ('confirmed','not_applicable')) AS ready_done,
      (SELECT COUNT(*) FROM user_sites us JOIN users u ON u.id = us.user_id WHERE us.site_id = s.id AND u.active = 1) AS staff
    FROM sites s WHERE ${access.siteFilter(req.user, 's.id')} ORDER BY s.status = 'active' DESC, s.name`)
    .map((s) => ({ ...s, perf: perf.find((p) => p.id === s.id) }));
  res.page('sites', 'Sites & Expansion', { sites });
});

r.get('/sites/new', requirePerm('sites.manage'), (req, res) => res.page('site-form', 'New site', { site: { type: 'other', status: 'planning', opening_time: '07:00', closing_time: '21:00' } }));

r.post('/sites', requirePerm('sites.manage'), (req, res) => {
  const data = pick(req.body, SITE_FIELDS);
  data.code = String(data.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!data.code || db.get('SELECT 1 FROM sites WHERE code = ?', data.code)) { req.flash('error', 'Site code is missing or already used.'); return res.back('/sites/new'); }
  const id = db.insert('sites', data);
  READINESS.forEach(([item, owner], i) => db.insert('readiness_items', { site_id: id, item, owner_source: owner, position: i }));
  db.insert('stock_locations', { name: `${data.name} store`, kind: 'site_store', site_id: id });
  if (req.body.request_approval) approvals.request({ kind: 'new_site', title: `Approve new site: ${data.name}`, details: req.body.business_case || '', entity: 'sites', entity_id: id, required_role: 'owner', amount: toNum(req.body.investment) }, req.user);
  audit(req, 'site.created', 'sites', id, data);
  req.flash('success', 'Site created. A launch readiness checklist was generated (SOP-22).');
  res.redirect(`/sites/${id}`);
});

r.get('/sites/:id', (req, res) => {
  const site = db.get('SELECT * FROM sites WHERE id = ?', req.params.id);
  if (!site) return res.redirect('/sites');
  guardSite(req, site.id);
  const { from, to } = metrics.range(30);
  const bal = stock.balances();
  const machines = db.all("SELECT m.*, ? AS site_name FROM machines m WHERE m.site_id = ? AND m.status != 'decommissioned'", site.name, site.id)
    .map((m) => ({ ...m, stock: bal.filter((b) => b.machine_id === m.id) }));
  res.page('site', site.name, {
    site, machines,
    rules: SITE_RULES[site.type],
    sales: metrics.sales([site.id], from, to),
    trend: metrics.salesByDay([site.id], from, to),
    staff: db.all('SELECT u.* FROM users u JOIN user_sites us ON us.user_id = u.id WHERE us.site_id = ? AND u.active = 1 ORDER BY u.role, u.name', site.id),
    readiness: db.all('SELECT ri.*, u.name AS confirmed_name FROM readiness_items ri LEFT JOIN users u ON u.id = ri.confirmed_by WHERE ri.site_id = ? ORDER BY ri.position', site.id),
    incidents: db.all('SELECT * FROM incidents WHERE site_id = ? ORDER BY created_at DESC LIMIT 8', site.id),
  });
});

r.get('/sites/:id/edit', requirePerm('sites.manage'), (req, res) => {
  const site = db.get('SELECT * FROM sites WHERE id = ?', req.params.id);
  res.page('site-form', `Edit ${site.name}`, { site });
});
r.post('/sites/:id', requirePerm('sites.manage'), (req, res) => {
  const data = pick(req.body, SITE_FIELDS); delete data.code;
  db.update('sites', req.params.id, data);
  audit(req, 'site.updated', 'sites', req.params.id, data);
  req.flash('success', 'Site saved.');
  res.redirect(`/sites/${req.params.id}`);
});

// ── Launch readiness (business-wide + per site) ──
r.get('/readiness', requirePerm('readiness.manage'), (req, res) => {
  const f = { site: req.query.site || '', status: req.query.status || '' };
  const where = ['1=1']; const params = [];
  if (f.site === 'business') where.push('ri.site_id IS NULL');
  else if (f.site) { where.push('ri.site_id = ?'); params.push(Number(f.site)); }
  if (f.status === 'outstanding') where.push("ri.status IN ('open','in_progress')");
  else if (f.status) { where.push('ri.status = ?'); params.push(f.status); }
  if (req.query.q) { where.push('ri.item LIKE ?'); params.push(`%${req.query.q}%`); f.q = req.query.q; }
  const p = paginate(req, `SELECT ri.*, s.name AS site_name, u.name AS confirmed_name FROM readiness_items ri LEFT JOIN sites s ON s.id = ri.site_id LEFT JOIN users u ON u.id = ri.confirmed_by WHERE ${where.join(' AND ')} ORDER BY ri.site_id IS NOT NULL, s.name, ri.position`, params, { perPage: 20 });
  const items = p.rows;
  const bySite = db.all(`SELECT s.id, s.name, s.status, (SELECT COUNT(*) FROM readiness_items r WHERE r.site_id = s.id) total,
      (SELECT COUNT(*) FROM readiness_items r WHERE r.site_id = s.id AND r.status IN ('confirmed','not_applicable')) done,
      (SELECT GROUP_CONCAT(m.code, ', ') FROM machines m WHERE m.site_id = s.id) machines FROM sites s ORDER BY s.status = 'planning' DESC, s.name`);
  const biz = db.get("SELECT COUNT(*) total, SUM(status IN ('confirmed','not_applicable')) done FROM readiness_items WHERE site_id IS NULL");
  res.page('readiness', 'Launch Readiness', { p, items, f, bySite, biz, sites: db.all('SELECT id, name FROM sites ORDER BY name') });
});
r.post('/readiness/:id', requirePerm('readiness.manage'), (req, res) => {
  const status = req.body.status;
  db.update('readiness_items', req.params.id, { status, evidence: req.body.evidence || null, confirmed_by: status === 'confirmed' ? req.user.id : null, confirmed_at: status === 'confirmed' ? sqlNow() : null });
  audit(req, 'readiness.updated', 'readiness_items', req.params.id, { status, evidence: req.body.evidence });
  res.back('/readiness');
});
r.post('/readiness', requirePerm('readiness.manage'), (req, res) => {
  db.insert('readiness_items', { site_id: toNum(req.body.site_id), item: req.body.item, owner_source: req.body.owner_source, position: 99 });
  res.back('/readiness');
});

// ── Machines ──
r.get('/machines', (req, res) => {
  const bal = stock.balances();
  const machines = access.machinesFor(req.user).map((m) => ({ ...m, stock: bal.filter((b) => b.machine_id === m.id), openIncidents: db.val("SELECT COUNT(*) FROM incidents WHERE machine_id = ? AND status NOT IN ('resolved','closed')", m.id) }));
  const uptime = metrics.uptime(access.siteIds(req.user), 7);
  res.page('machines', 'Machines', { machines, uptime });
});

r.get('/machines/new', requirePerm('sites.manage'), (req, res) => res.page('machine-form', 'Register machine', { m: { capacity: 60, service_interval_days: 30, site_id: req.query.site }, sites: access.sitesFor(req.user) }));
r.post('/machines', requirePerm('sites.manage'), (req, res) => {
  const data = pick(req.body, MACHINE_FIELDS);
  data.code = String(data.code || '').toUpperCase().trim();
  if (!data.code || db.get('SELECT 1 FROM machines WHERE code = ?', data.code)) { req.flash('error', 'Machine code is missing or already used.'); return res.back('/machines/new'); }
  data.api_key = `swg_${crypto.randomBytes(16).toString('hex')}`;
  data.status = 'maintenance';
  const id = db.insert('machines', data);
  stock.machineLocation(id);
  db.insert('machine_status_log', { machine_id: id, status: 'maintenance', reason: 'Registered — awaiting commissioning', user_id: req.user.id });
  audit(req, 'machine.created', 'machines', id, data);
  req.flash('success', 'Machine registered. Set it Online after commissioning tests pass.');
  res.redirect(`/machines/${id}`);
});

r.get('/machines/:id', (req, res) => {
  const m = db.get('SELECT m.*, s.name AS site_name, s.type AS site_type FROM machines m LEFT JOIN sites s ON s.id = m.site_id WHERE m.id = ?', req.params.id);
  if (!m) return res.redirect('/machines');
  guardSite(req, m.site_id);
  const loc = stock.machineLocation(m.id);
  const { from, to } = metrics.range(30);
  res.page('machine', m.code, {
    m, loc,
    stock: stock.balances(loc.id),
    byDay: db.all("SELECT date(sold_at) day, SUM(amount) revenue, SUM(qty) units FROM sales WHERE machine_id = ? AND date(sold_at) BETWEEN ? AND ? AND payment_status='confirmed' GROUP BY day ORDER BY day", m.id, from, to),
    statusLog: db.all('SELECT l.*, u.name AS user_name FROM machine_status_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.machine_id = ? ORDER BY l.started_at DESC LIMIT 6', m.id),
    incidents: db.all('SELECT * FROM incidents WHERE machine_id = ? ORDER BY created_at DESC LIMIT 6', m.id),
    incidentCount: db.val('SELECT COUNT(*) FROM incidents WHERE machine_id = ?', m.id),
    mp: paginate(req, 'SELECT ml.*, u.name AS by_name, v.name AS vendor_name FROM maintenance_logs ml LEFT JOIN users u ON u.id = ml.performed_by LEFT JOIN vendors v ON v.id = ml.vendor_id WHERE ml.machine_id = ? ORDER BY ml.performed_on DESC', [m.id], { param: 'mpage', perPage: 8 }),
    uptime: metrics.uptime([m.site_id], 30).find((x) => x.id === m.id),
    temps: db.all('SELECT * FROM temperature_logs WHERE machine_id = ? ORDER BY recorded_at DESC LIMIT 12', m.id),
    vendors: db.all("SELECT * FROM vendors WHERE category = 'technician'"),
    nextService: m.last_service_on ? addDays(m.last_service_on, m.service_interval_days || 30) : null,
    feedbackUrl: `${config.baseUrl}/f/${m.code}`,
    sites: access.sitesFor(req.user),
  });
});

r.post('/machines/:id/status', requirePerm('machines.manage', 'incidents.manage'), (req, res) => {
  const m = db.get('SELECT * FROM machines WHERE id = ?', req.params.id);
  guardSite(req, m.site_id);
  if (req.body.status === 'online' && !req.body.tests_passed) { req.flash('error', 'Confirm that the return-to-service checks passed before setting the machine Online (SOP-07).'); return res.back(); }
  incidents.setMachineStatus(m.id, req.body.status, req.body.reason || null, req.user.id);
  audit(req, 'machine.status', 'machines', m.id, req.body);
  req.flash('success', `Machine set to ${req.body.status}.`);
  res.back();
});

r.post('/machines/:id/edit', requirePerm('sites.manage'), (req, res) => {
  const data = pick(req.body, MACHINE_FIELDS); delete data.code;
  db.update('machines', req.params.id, data);
  if (data.site_id) db.run('UPDATE stock_locations SET site_id = ? WHERE machine_id = ?', data.site_id, req.params.id);
  audit(req, 'machine.updated', 'machines', req.params.id, data);
  req.flash('success', 'Machine saved.');
  res.redirect(`/machines/${req.params.id}`);
});

r.post('/machines/:id/rotate-key', requirePerm('settings.manage'), (req, res) => {
  db.update('machines', req.params.id, { api_key: `swg_${crypto.randomBytes(16).toString('hex')}` });
  audit(req, 'machine.api_key_rotated', 'machines', req.params.id);
  req.flash('success', 'New API key generated. Update the machine/telemetry integration.');
  res.back();
});

r.post('/machines/:id/maintenance', requirePerm('machines.manage'), (req, res) => {
  const m = db.get('SELECT * FROM machines WHERE id = ?', req.params.id);
  const data = pick(req.body, ['kind', 'performed_on', 'findings', 'work_done', 'parts_used', 'cost', 'next_due_on', 'vendor_id']);
  data.tests_passed = req.body.tests_passed ? 1 : 0;
  data.machine_id = m.id; data.performed_by = req.user.id;
  data.cost = toNum(data.cost) || 0;
  data.performed_on = data.performed_on || today();
  const id = db.insert('maintenance_logs', data);
  if (['preventive', 'inspection'].includes(data.kind)) db.update('machines', m.id, { last_service_on: data.performed_on });
  if (data.cost > 0) {
    const cat = db.val('SELECT id FROM finance_categories WHERE name = ?', data.kind === 'preventive' ? 'Routine Servicing' : 'Repairs & Breakdowns');
    db.insert('transactions', { kind: 'expense', category_id: cat, site_id: m.site_id, machine_id: m.id, vendor_id: toNum(data.vendor_id), amount: data.cost, description: `Maintenance ${m.code}: ${data.work_done || data.kind}`, txn_date: data.performed_on, recorded_by: req.user.id });
  }
  audit(req, 'maintenance.logged', 'maintenance_logs', id, data);
  req.flash('success', 'Maintenance recorded.');
  res.redirect(`/machines/${m.id}`);
});

r.get('/machines/:id/poster', (req, res) => {
  const m = db.get('SELECT m.*, s.name AS site_name FROM machines m LEFT JOIN sites s ON s.id = m.site_id WHERE m.id = ?', req.params.id);
  res.render('poster', { m, url: `${config.baseUrl}/f/${m.code}` });
});

module.exports = r;
