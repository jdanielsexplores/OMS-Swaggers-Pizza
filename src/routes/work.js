// Tasks & corrective actions, approvals, announcements.
const express = require('express');
const db = require('../db');
const access = require('../services/access');
const approvals = require('../services/approvals');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { requirePerm } = require('../middleware');
const { toNum, sqlNow } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();
const assignable = (user) => db.all(`SELECT DISTINCT u.id, u.name, u.role FROM users u LEFT JOIN user_sites us ON us.user_id = u.id WHERE u.active = 1 AND (${access.siteFilter(user, 'us.site_id')} OR u.role IN ('ops_manager','accounts','technician','owner')) ORDER BY u.name`);

// ── Tasks ──
r.get('/tasks', (req, res) => {
  const view = req.query.view || (access.can(req.user, 'tasks.assign') ? 'all' : 'mine');
  const scope = view === 'mine' ? `t.assigned_to = ${Number(req.user.id)}` : view === 'created' ? `t.created_by = ${Number(req.user.id)}` : `(t.site_id IS NULL OR ${access.siteFilter(req.user, 't.site_id')} OR t.assigned_to = ${Number(req.user.id)})`;
  const { where, params, f } = filters(req.query, {
    status: (v) => (v === 'open' ? ["t.status IN ('open','in_progress')"] : v === 'done' ? ["t.status IN ('done','verified','cancelled')"] : ['t.status = ?', v]),
    priority: F.eq('t.priority'), kind: F.eq('t.kind'), site: F.eq('t.site_id'), assignee: F.eq('t.assigned_to'),
    overdue: (v) => (v === '1' ? ["t.due_at < datetime('now') AND t.status IN ('open','in_progress')"] : null),
    from: F.dateFrom('t.created_at'), to: F.dateTo('t.created_at'), q: F.search('t.title', 't.description'),
  }, [scope]);
  if (!req.query.status && req.query.done !== '1') { f.status = 'open'; }
  const statusClause = req.query.status ? '' : req.query.done === '1' ? " AND t.status IN ('done','verified','cancelled')" : " AND t.status IN ('open','in_progress')";
  const p = paginate(req, `SELECT t.*, a.name AS assignee, c.name AS creator, s.name AS site_name, i.ref AS incident_ref FROM tasks t LEFT JOIN users a ON a.id = t.assigned_to LEFT JOIN users c ON c.id = t.created_by LEFT JOIN sites s ON s.id = t.site_id LEFT JOIN incidents i ON i.id = t.incident_id
    WHERE ${where}${statusClause} ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_at IS NULL, t.due_at, t.created_at DESC`, params);
  res.page('tasks', 'Tasks', { p, rows: p.rows, view, f, done: req.query.done === '1', sites: access.sitesFor(req.user), people: access.can(req.user, 'tasks.assign') ? assignable(req.user) : [] });
});

r.get('/tasks/new', requirePerm('tasks.assign'), (req, res) => res.page('task-form', 'Assign a task', { users: assignable(req.user), sites: access.sitesFor(req.user), machines: access.machinesFor(req.user) }));

r.post('/tasks', requirePerm('tasks.assign'), (req, res) => {
  const b = req.body;
  if (b.site_id && !access.canSite(req.user, b.site_id)) return res.back();
  const id = db.insert('tasks', { title: b.title, description: b.description || null, kind: b.kind || 'task', site_id: toNum(b.site_id), machine_id: toNum(b.machine_id), assigned_to: toNum(b.assigned_to), created_by: req.user.id, priority: b.priority || 'normal', due_at: b.due_at ? b.due_at.replace('T', ' ') + ':00' : null });
  if (b.assigned_to) notify({ users: [Number(b.assigned_to)] }, { level: b.priority === 'urgent' ? 'critical' : 'warning', title: `New task: ${b.title}`, body: b.description?.slice(0, 140), link: `/tasks/${id}` });
  audit(req, 'task.created', 'tasks', id, b);
  req.flash('success', 'Task assigned.');
  res.redirect('/tasks');
});

r.get('/tasks/:id', (req, res) => {
  const t = db.get('SELECT t.*, a.name AS assignee, c.name AS creator, s.name AS site_name, m.code AS machine_code, i.ref AS incident_ref FROM tasks t LEFT JOIN users a ON a.id = t.assigned_to LEFT JOIN users c ON c.id = t.created_by LEFT JOIN sites s ON s.id = t.site_id LEFT JOIN machines m ON m.id = t.machine_id LEFT JOIN incidents i ON i.id = t.incident_id WHERE t.id = ?', req.params.id);
  if (!t) return res.redirect('/tasks');
  if (t.assigned_to !== req.user.id && t.created_by !== req.user.id && t.site_id && !access.canSite(req.user, t.site_id)) return res.redirect('/tasks');
  res.page('task', t.title, { t, users: access.can(req.user, 'tasks.assign') ? assignable(req.user) : [] });
});

r.post('/tasks/:id', (req, res) => {
  const t = db.get('SELECT * FROM tasks WHERE id = ?', req.params.id);
  const mine = t.assigned_to === req.user.id;
  const manager = access.can(req.user, 'tasks.assign');
  if (!mine && !manager) return res.back();
  const status = req.body.status;
  if (status === 'verified' && (!manager || t.assigned_to === req.user.id)) { req.flash('error', 'Another person must verify the work.'); return res.back(); }
  const patch = { status };
  if (status === 'done') { patch.completed_at = sqlNow(); patch.completion_notes = req.body.completion_notes || null; }
  if (manager && req.body.assigned_to) patch.assigned_to = toNum(req.body.assigned_to);
  db.update('tasks', t.id, patch);
  if (status === 'done' && t.created_by && t.created_by !== req.user.id) notify({ users: [t.created_by] }, { level: 'success', title: `Task done: ${t.title}`, body: req.body.completion_notes || '', link: `/tasks/${t.id}` });
  if (patch.assigned_to && patch.assigned_to !== t.assigned_to) notify({ users: [patch.assigned_to] }, { level: 'warning', title: `Task reassigned to you: ${t.title}`, link: `/tasks/${t.id}` });
  audit(req, `task.${status}`, 'tasks', t.id, req.body);
  res.redirect(`/tasks/${t.id}`);
});

// ── Approvals ──
r.get('/approvals', (req, res) => {
  const status = req.query.status || 'pending';
  const mineOnly = !access.can(req.user, 'approvals.decide');
  const { where, params, f } = filters(req.query, {
    kind: F.eq('a.kind'), from: F.dateFrom('a.created_at'), to: F.dateTo('a.created_at'), q: F.search('a.title', 'a.details'),
  }, [status === 'all' ? '1=1' : 'a.status = ?', ...(mineOnly ? [`a.requested_by = ${Number(req.user.id)}`] : [])]);
  const p = paginate(req, `SELECT a.*, u.name AS requester, d.name AS decider FROM approvals a LEFT JOIN users u ON u.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by WHERE ${where} ORDER BY a.created_at DESC`, status === 'all' ? params : [status, ...params]);
  res.page('approvals', 'Approvals', { p, rows: p.rows, status, f, canDecide: (a) => approvals.canDecide(req.user, a) });
});
r.get('/approvals/:id', (req, res) => {
  const a = db.get('SELECT a.*, u.name AS requester, d.name AS decider FROM approvals a LEFT JOIN users u ON u.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by WHERE a.id = ?', req.params.id);
  if (!a || (!access.can(req.user, 'approvals.decide') && a.requested_by !== req.user.id)) return res.redirect('/approvals');
  let context = null;
  if (a.kind === 'price_change' && a.payload) { const p = JSON.parse(a.payload); context = db.get('SELECT name, price, unit_cost FROM products WHERE id = ?', p.product_id); if (context) context.new_price = p.new_price; }
  if (a.kind === 'refund' && a.entity_id) context = db.get('SELECT rf.*, c.ref, c.description FROM refunds rf LEFT JOIN customer_cases c ON c.id = rf.case_id WHERE rf.id = ?', a.entity_id);
  if (a.kind === 'expense' && a.entity_id) context = db.get('SELECT t.*, c.name AS category FROM transactions t LEFT JOIN finance_categories c ON c.id = t.category_id WHERE t.id = ?', a.entity_id);
  res.page('approval', a.title, { a, context, canDecide: approvals.canDecide(req.user, a) && a.status === 'pending' });
});
r.post('/approvals/:id', requirePerm('approvals.decide'), (req, res) => {
  try {
    approvals.decide(Number(req.params.id), req.body.decision === 'approve', req.user, req.body.notes);
    audit(req, `approval.${req.body.decision}`, 'approvals', req.params.id, req.body.notes);
    req.flash('success', `Decision recorded: ${req.body.decision === 'approve' ? 'approved' : 'rejected'}.`);
  } catch (e) { req.flash('error', e.message); }
  res.redirect('/approvals');
});
r.post('/approvals', (req, res) => {
  const b = req.body;
  const id = approvals.request({ kind: b.kind || 'other', title: b.title, details: b.details, amount: toNum(b.amount), required_role: b.required_role === 'owner' ? 'owner' : 'ops_manager' }, req.user);
  audit(req, 'approval.requested', 'approvals', id, b);
  req.flash('success', 'Request sent.');
  res.redirect('/approvals');
});

// ── Announcements ──
r.get('/announcements', (req, res) => {
  const { where, params, f } = filters(req.query, { q: F.search('a.title', 'a.body'), from: F.dateFrom('a.created_at'), to: F.dateTo('a.created_at') });
  const p = paginate(req, `SELECT a.*, u.name AS author, (SELECT COUNT(*) FROM announcement_acks k WHERE k.announcement_id = a.id) AS acks FROM announcements a LEFT JOIN users u ON u.id = a.created_by WHERE ${where} ORDER BY a.pinned DESC, a.created_at DESC`, params, { perPage: 10 });
  res.page('announcements', 'Notice board', { p, f, rows: p.rows, sites: access.sitesFor(req.user), staffCount: db.val('SELECT COUNT(*) FROM users WHERE active = 1') });
});
r.post('/announcements', requirePerm('announcements.post'), (req, res) => {
  const b = req.body;
  const id = db.insert('announcements', { title: b.title, body: b.body, audience: b.audience || 'all', pinned: b.pinned ? 1 : 0, requires_ack: b.requires_ack ? 1 : 0, expires_on: b.expires_on || null, created_by: req.user.id });
  const target = b.audience?.startsWith('site:') ? { roles: ['sales_rep', 'supervisor', 'stock_staff', 'technician'], siteId: Number(b.audience.slice(5)) } : b.audience?.startsWith('role:') ? { roles: [b.audience.slice(5)] } : { roles: Object.keys(access.ROLES) };
  notify({ ...target, except: req.user.id }, { title: `📣 ${b.title}`, body: b.body.slice(0, 140), link: '/' });
  audit(req, 'announcement.posted', 'announcements', id);
  req.flash('success', 'Announcement posted.');
  res.redirect('/announcements');
});
r.post('/announcements/:id/delete', requirePerm('announcements.post'), (req, res) => {
  db.run('DELETE FROM announcements WHERE id = ?', req.params.id);
  audit(req, 'announcement.deleted', 'announcements', req.params.id);
  res.redirect('/announcements');
});

module.exports = r;
