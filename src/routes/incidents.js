const express = require('express');
const db = require('../db');
const access = require('../services/access');
const incidents = require('../services/incidents');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { requirePerm, fileFor } = require('../middleware');
const { toNum, sqlNow } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();

r.get('/report', (req, res) => {
  res.page('report', 'Report a problem', {
    sites: access.sitesFor(req.user),
    machines: access.machinesFor(req.user),
    pre: { machine: toNum(req.query.machine), type: req.query.type, site: toNum(req.query.site) || res.locals.clockedIn?.site_id },
    SLA: incidents.SLA,
  });
});

r.post('/report', (req, res) => {
  const b = req.body;
  const machine = b.machine_id ? db.get('SELECT * FROM machines WHERE id = ?', b.machine_id) : null;
  const siteId = machine?.site_id || toNum(b.site_id);
  if (!siteId || !access.canSite(req.user, siteId)) { req.flash('error', 'Choose one of your sites.'); return res.back('/report'); }
  if (!b.title) { req.flash('error', 'Say briefly what happened.'); return res.back('/report'); }
  const inc = incidents.create({
    site_id: siteId, machine_id: machine?.id, type: b.type, severity: b.severity, title: b.title,
    description: b.description, action_taken: b.action_taken, error_message: b.error_message,
    order_ref: b.order_ref, payment_ref: b.payment_ref, sales_paused: b.sales_paused === '1',
  }, req.user);
  const photo = fileFor(req, 'photo');
  if (photo) db.insert('incident_updates', { incident_id: inc.id, user_id: req.user.id, kind: 'comment', body: 'Photo evidence attached at report time.', attachment: photo });
  if (b.type === 'payment' && (b.amount || b.payment_ref)) {
    db.insert('payment_exceptions', { site_id: siteId, machine_id: machine?.id, kind: b.payment_kind || 'unmatched', amount: toNum(b.amount), payment_ref: b.payment_ref, order_ref: b.order_ref, customer_phone_last4: String(b.phone_last4 || '').replace(/\D/g, '').slice(-4) || null, occurred_at: sqlNow(), reported_by: req.user.id });
  }
  audit(req, 'incident.reported', 'incidents', inc.id, { severity: b.severity, type: b.type });
  req.flash('success', `Reported as ${inc.ref}. ${b.severity === 'critical' ? 'The Manager and Owner have been alerted. Keep people safe and do not touch the machine.' : 'The right people have been notified.'}`);
  res.redirect(`/incidents/${inc.id}`);
});

r.get('/incidents', (req, res) => {
  const q = { status: 'open', ...req.query };
  const { where, params, f } = filters(q, {
    status: (v) => (v === 'open' ? ["i.status NOT IN ('resolved','closed')"] : v === 'all' ? null : ['i.status = ?', v]),
    severity: F.eq('i.severity'), type: F.eq('i.type'), site: F.eq('i.site_id'), machine: F.eq('i.machine_id'),
    assignee: (v) => (v === 'me' ? ['i.assigned_to = ?', req.user.id] : ['i.assigned_to = ?', v]),
    from: F.dateFrom('i.created_at'), to: F.dateTo('i.created_at'),
    q: F.search('i.title', 'i.ref', 'i.description', 'i.error_message'),
  }, [access.siteFilter(req.user, 'i.site_id')]);
  if (req.query.mine) { f.assignee = 'me'; }
  const p = paginate(req, `SELECT i.*, s.name AS site_name, m.code AS machine_code, a.name AS assignee, v.name AS vendor_name
    FROM incidents i LEFT JOIN sites s ON s.id = i.site_id LEFT JOIN machines m ON m.id = i.machine_id LEFT JOIN users a ON a.id = i.assigned_to LEFT JOIN vendors v ON v.id = i.vendor_id
    WHERE ${where}${req.query.mine ? ` AND i.assigned_to = ${Number(req.user.id)}` : ''} ORDER BY CASE WHEN i.status IN ('resolved','closed') THEN 1 ELSE 0 END, CASE i.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, i.created_at DESC`, params);
  res.page('incidents', 'Incidents', { p, rows: p.rows, f: { ...f, status: q.status }, sites: access.sitesFor(req.user), machines: access.machinesFor(req.user), staff: db.all("SELECT id, name FROM users WHERE active = 1 AND role IN ('technician','ops_manager','supervisor','accounts','stock_staff') ORDER BY name"), TYPES: incidents.TYPES });
});

function loadIncident(req) {
  const inc = db.get(`SELECT i.*, s.name AS site_name, m.code AS machine_code, m.status AS machine_status, rp.name AS reporter, a.name AS assignee, v.name AS vendor_name, v.phone AS vendor_phone
    FROM incidents i LEFT JOIN sites s ON s.id = i.site_id LEFT JOIN machines m ON m.id = i.machine_id LEFT JOIN users rp ON rp.id = i.reported_by LEFT JOIN users a ON a.id = i.assigned_to LEFT JOIN vendors v ON v.id = i.vendor_id WHERE i.id = ?`, req.params.id);
  if (!inc) return null;
  if (inc.site_id && !access.canSite(req.user, inc.site_id) && inc.assigned_to !== req.user.id) { const e = new Error('Not your site'); e.status = 403; throw e; }
  return inc;
}

r.get('/incidents/:id', (req, res) => {
  const inc = loadIncident(req);
  if (!inc) return res.redirect('/incidents');
  res.page('incident', `${inc.ref}`, {
    inc,
    sla: incidents.SLA[inc.severity],
    updates: db.all('SELECT u.*, us.name FROM incident_updates u LEFT JOIN users us ON us.id = u.user_id WHERE u.incident_id = ? ORDER BY u.created_at, u.id', inc.id),
    staff: db.all("SELECT id, name, role FROM users WHERE active = 1 AND role IN ('technician','ops_manager','supervisor','accounts','stock_staff') ORDER BY role, name"),
    vendors: db.all('SELECT * FROM vendors WHERE approved = 1 ORDER BY category, name'),
    tasks: db.all('SELECT t.*, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.incident_id = ?', inc.id),
    related: inc.machine_id ? db.all("SELECT id, ref, title, created_at, status FROM incidents WHERE machine_id = ? AND id != ? AND created_at >= datetime('now','-30 days') ORDER BY created_at DESC", inc.machine_id, inc.id) : [],
    canManage: access.can(req.user, 'incidents.manage'),
    canClose: access.can(req.user, 'incidents.close'),
  });
});

r.post('/incidents/:id/comment', (req, res) => {
  const inc = loadIncident(req);
  const photo = fileFor(req, 'photo');
  if (!req.body.body && !photo) return res.back();
  db.insert('incident_updates', { incident_id: inc.id, user_id: req.user.id, kind: 'comment', body: req.body.body || 'Photo added', attachment: photo });
  db.run("UPDATE incidents SET updated_at = datetime('now') WHERE id = ?", inc.id);
  const watchers = [inc.reported_by, inc.assigned_to].filter((x) => x && x !== req.user.id);
  notify({ users: watchers }, { title: `Update on ${inc.ref}`, body: (req.body.body || '').slice(0, 140), link: `/incidents/${inc.id}` });
  res.redirect(`/incidents/${inc.id}`);
});

r.post('/incidents/:id/ack', requirePerm('incidents.manage'), (req, res) => {
  const inc = loadIncident(req);
  if (inc.status === 'open') incidents.changeStatus(inc.id, 'acknowledged', req.user, 'Seen and being handled');
  res.redirect(`/incidents/${inc.id}`);
});

r.post('/incidents/:id/assign', requirePerm('incidents.manage'), (req, res) => {
  const inc = loadIncident(req);
  incidents.assign(inc.id, toNum(req.body.assigned_to), req.user, toNum(req.body.vendor_id));
  if (req.body.severity && req.body.severity !== inc.severity) {
    db.update('incidents', inc.id, { severity: req.body.severity });
    incidents.timeline(inc.id, req.user.id, 'status', `Severity changed ${inc.severity} → ${req.body.severity}`);
  }
  audit(req, 'incident.assigned', 'incidents', inc.id, req.body);
  res.redirect(`/incidents/${inc.id}`);
});

r.post('/incidents/:id/status', (req, res) => {
  const inc = loadIncident(req);
  const status = req.body.status;
  const isAssignee = inc.assigned_to === req.user.id;
  const manage = access.can(req.user, 'incidents.manage');
  if (['closed'].includes(status) && !access.can(req.user, 'incidents.close')) { req.flash('error', 'Only a Supervisor or Manager can close an incident after verifying the fix.'); return res.back(); }
  if (!manage && !isAssignee) { req.flash('error', 'Not allowed.'); return res.back(); }
  if (status === 'resolved') {
    if (inc.machine_id && inc.type === 'machine' && !req.body.return_to_service_checked) { req.flash('error', 'Confirm the return-to-service safety/function checks passed (SOP-07).'); return res.back(); }
    db.update('incidents', inc.id, { root_cause: req.body.root_cause || null, resolution: req.body.resolution || null, cost: toNum(req.body.cost) || 0, return_to_service_checked: req.body.return_to_service_checked ? 1 : 0 });
    if (toNum(req.body.cost) > 0) {
      const cat = db.val("SELECT id FROM finance_categories WHERE name = 'Repairs & Breakdowns'");
      db.insert('transactions', { kind: 'expense', category_id: cat, site_id: inc.site_id, machine_id: inc.machine_id, vendor_id: inc.vendor_id, amount: toNum(req.body.cost), description: `Repair ${inc.ref}: ${inc.title}`, txn_date: sqlNow().slice(0, 10), recorded_by: req.user.id });
    }
    if (inc.machine_id && inc.type === 'machine') db.insert('maintenance_logs', { machine_id: inc.machine_id, incident_id: inc.id, kind: 'corrective', performed_by: req.user.id, vendor_id: inc.vendor_id, performed_on: sqlNow().slice(0, 10), findings: req.body.root_cause, work_done: req.body.resolution, cost: toNum(req.body.cost) || 0, tests_passed: req.body.return_to_service_checked ? 1 : 0 });
  }
  incidents.changeStatus(inc.id, status, req.user, req.body.note);
  if (status === 'resolved') notify({ roles: ['supervisor', 'ops_manager'], siteId: inc.site_id, except: req.user.id }, { level: 'success', title: `${inc.ref} resolved — please verify and close`, body: inc.title, link: `/incidents/${inc.id}` });
  audit(req, `incident.${status}`, 'incidents', inc.id, req.body);
  res.redirect(`/incidents/${inc.id}`);
});

r.post('/incidents/:id/task', requirePerm('tasks.assign'), (req, res) => {
  const inc = loadIncident(req);
  const id = db.insert('tasks', { title: req.body.title, kind: 'corrective_action', site_id: inc.site_id, machine_id: inc.machine_id, incident_id: inc.id, assigned_to: toNum(req.body.assigned_to), created_by: req.user.id, priority: req.body.priority || 'normal', due_at: req.body.due_at ? req.body.due_at.replace('T', ' ') + ':00' : null });
  if (req.body.assigned_to) notify({ users: [Number(req.body.assigned_to)] }, { level: 'warning', title: `Corrective action: ${req.body.title}`, link: `/tasks/${id}` });
  incidents.timeline(inc.id, req.user.id, 'system', `Corrective action created: ${req.body.title}`);
  res.redirect(`/incidents/${inc.id}`);
});

module.exports = r;
