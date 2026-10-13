const express = require('express');
const db = require('../db');
const access = require('../services/access');
const metrics = require('../services/metrics');
const stock = require('../services/stock');
const { requirePerm } = require('../middleware');
const { today, addDays, nowTime } = require('../lib/util');
const attendance = require('../services/attendance');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();

function announcementsFor(user) {
  const sites = access.siteIds(user);
  return db.all(`SELECT a.*, u.name AS author, (SELECT 1 FROM announcement_acks k WHERE k.announcement_id = a.id AND k.user_id = ?) AS acked
    FROM announcements a LEFT JOIN users u ON u.id = a.created_by
    WHERE (a.expires_on IS NULL OR a.expires_on >= ?) AND (a.audience = 'all' OR a.audience = ? ${sites.length ? `OR a.audience IN (${sites.map((s) => `'site:${Number(s)}'`).join(',')})` : ''})
    ORDER BY a.pinned DESC, a.created_at DESC LIMIT 6`, user.id, today(), `role:${user.role}`);
}

function machineCards(user) {
  const ms = access.machinesFor(user);
  const bal = stock.balances();
  return ms.map((m) => ({
    ...m,
    stock: bal.filter((b) => b.machine_id === m.id),
    openIncidents: db.val("SELECT COUNT(*) FROM incidents WHERE machine_id = ? AND status NOT IN ('resolved','closed')", m.id),
  }));
}

function checklistsToday(user) {
  const d = today();
  const sites = access.sitesFor(user).filter((s) => s.status === 'active');
  const tpls = db.all("SELECT * FROM checklist_templates WHERE active = 1 AND frequency IN ('daily') ORDER BY CASE category WHEN 'opening' THEN 1 WHEN 'cleaning' THEN 2 WHEN 'closing' THEN 4 ELSE 3 END");
  const out = [];
  for (const s of sites) {
    for (const t of tpls) {
      if (t.site_type && t.site_type !== s.type) continue;
      const run = db.get('SELECT * FROM checklist_runs WHERE template_id = ? AND site_id = ? AND run_date = ? ORDER BY id DESC LIMIT 1', t.id, s.id, d);
      const overdue = !run?.submitted_at && t.due_time && nowTime() > t.due_time;
      out.push({ site: s, tpl: t, run, overdue });
    }
  }
  return out;
}

// ── Staff Home ──
r.get('/', (req, res) => {
  const u = req.user;
  const d = today();
  const shifts = db.all(`SELECT sh.*, s.name AS site_name, m.code AS machine_code FROM shifts sh JOIN sites s ON s.id = sh.site_id LEFT JOIN machines m ON m.id = sh.machine_id
    WHERE sh.user_id = ? AND sh.shift_date BETWEEN ? AND ? AND sh.status != 'cancelled' ORDER BY sh.shift_date, sh.start_time`, u.id, d, addDays(d, 6));
  const tasks = db.all(`SELECT t.*, s.name AS site_name FROM tasks t LEFT JOIN sites s ON s.id = t.site_id WHERE t.assigned_to = ? AND t.status IN ('open','in_progress') ORDER BY t.due_at IS NULL, t.due_at LIMIT 8`, u.id);
  const incidents = db.all(`SELECT i.*, s.name AS site_name FROM incidents i LEFT JOIN sites s ON s.id = i.site_id WHERE i.status NOT IN ('resolved','closed') AND (${access.siteFilter(u, 'i.site_id')} OR i.assigned_to = ?) ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, i.created_at DESC LIMIT 6`, u.id);
  const training = db.all(`SELECT m.*, tr.quiz_passed, tr.practical_passed FROM training_modules m LEFT JOIN training_records tr ON tr.module_id = m.id AND tr.user_id = ?
    WHERE m.active = 1 AND (m.roles = '' OR m.roles IS NULL OR (',' || m.roles || ',') LIKE ?) ORDER BY m.position`, u.id, `%,${u.role},%`);
  const ackDone = db.get("SELECT 1 FROM acknowledgements WHERE user_id = ? AND document = 'playbook' AND version = ?", u.id, db.setting('playbook_version', '2.0'));
  const handover = db.get(`SELECT h.*, f.name AS from_name, s.name AS site_name FROM handovers h JOIN users f ON f.id = h.from_user_id JOIN sites s ON s.id = h.site_id
    WHERE h.acknowledged_at IS NULL AND h.from_user_id != ? AND ${access.siteFilter(u, 'h.site_id')} AND h.created_at >= datetime('now','-1 day') ORDER BY h.id DESC LIMIT 1`, u.id);
  res.page('home', 'Staff Home', {
    shifts, tasks, incidents, training, ackDone, handover,
    announcements: announcementsFor(u),
    machines: machineCards(u),
    checklists: checklistsToday(u),
    sites: access.sitesFor(u),
    myMonth: attendance.summary(u.id, today().slice(0, 8) + '01', today()),
    todaySched: attendance.scheduleFor(u.id, today()),
    award: db.get("SELECT a.*, us.name, us.role FROM employee_awards a JOIN users us ON us.id = a.user_id ORDER BY a.month DESC LIMIT 1"),
    rules: attendance.rules(),
    payslip: db.get("SELECT i.id, i.net, r.month FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id WHERE i.user_id = ? AND r.status = 'finalized' ORDER BY r.month DESC LIMIT 1", u.id),
  });
});

// ── Operations dashboard ──
r.get('/dashboard', requirePerm('dashboard.ops'), (req, res) => {
  const u = req.user;
  const ids = access.siteIds(u);
  const d = today();
  const from14 = addDays(d, -13);
  const machines = machineCards(u);
  const attention = [];
  const crit = db.all(`SELECT i.*, s.name AS site_name FROM incidents i LEFT JOIN sites s ON s.id = i.site_id WHERE i.status NOT IN ('resolved','closed') AND (i.severity = 'critical' OR i.due_at < datetime('now') OR i.sales_paused = 1) AND ${access.siteFilter(u, 'i.site_id')} ORDER BY i.created_at DESC`);
  for (const i of crit) attention.push({ level: 'bad', text: `${i.ref} ${i.title}`, sub: `${i.site_name || ''} · ${i.severity}${i.sales_paused ? ' · sales paused' : ''}`, link: `/incidents/${i.id}` });
  for (const b of metrics.lowStock(ids)) attention.push({ level: b.qty <= 0 ? 'bad' : 'warn', text: `${b.qty <= 0 ? 'Out of stock' : 'Low stock'}: ${b.product_name}`, sub: `${b.location_name} · ${b.qty} left`, link: '/stock/restock' });
  for (const c of checklistsToday(u).filter((x) => x.overdue)) attention.push({ level: 'warn', text: `Overdue: ${c.tpl.name}`, sub: c.site.name, link: `/checklists?site=${c.site.id}` });
  const pe = db.val(`SELECT COUNT(*) FROM payment_exceptions WHERE status IN ('open','investigating') AND ${access.siteFilter(u, 'site_id')}`);
  if (pe) attention.push({ level: 'warn', text: `${pe} open payment exception(s)`, sub: 'Customer money needs reconciling', link: '/payments' });
  const notIn = db.all(`SELECT sh.*, us.name, s.name AS site_name FROM shifts sh JOIN users us ON us.id = sh.user_id JOIN sites s ON s.id = sh.site_id
    WHERE sh.shift_date = ? AND sh.start_time <= ? AND sh.status = 'scheduled' AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.shift_id = sh.id) AND ${access.siteFilter(u, 'sh.site_id')}`, d, nowTime());
  for (const s of notIn) attention.push({ level: 'warn', text: `${s.name} not clocked in`, sub: `${s.site_name} · due ${s.start_time}`, link: '/attendance' });
  const reviewQ = db.val(`SELECT COUNT(*) FROM checklist_runs WHERE status = 'submitted' AND failed_count > 0 AND ${access.siteFilter(u, 'site_id')}`);
  if (reviewQ) attention.push({ level: 'info', text: `${reviewQ} checklist(s) with failed items to review`, sub: 'Confirm corrective action', link: '/checklists/review' });
  for (const m of db.all("SELECT * FROM machines WHERE status != 'decommissioned' AND last_service_on IS NOT NULL AND date(last_service_on, '+' || service_interval_days || ' days') <= date('now')")) {
    if (ids.includes(m.site_id)) attention.push({ level: 'info', text: `Service due: ${m.code}`, sub: `Last serviced ${m.last_service_on}`, link: `/machines/${m.id}` });
  }
  const restock = db.all(`SELECT r.*, s.name AS site_name FROM restock_requests r JOIN sites s ON s.id = r.site_id WHERE r.status IN ('requested','approved','dispatched') AND ${access.siteFilter(u, 'r.site_id')} ORDER BY r.created_at DESC LIMIT 5`);
  res.page('dashboard', 'Operations', {
    todaySales: metrics.sales(ids, d, d),
    yesterday: metrics.sales(ids, addDays(d, -1), addDays(d, -1)),
    trend: metrics.salesByDay(ids, from14, d),
    hourly: metrics.salesByHour(ids, addDays(d, -6), d),
    inc: metrics.incidentsSummary(ids),
    compliance: metrics.checklistCompliance(ids, d, d),
    machines, attention, restock,
    wasteToday: metrics.waste(ids, d, d).reduce((a, x) => a + x.units, 0),
    approvals: access.can(u, 'approvals.decide') ? db.all("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5") : [],
  });
});

// ── Owner's view ──
r.get('/owner', requirePerm('dashboard.owner'), (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const ids = db.all('SELECT id FROM sites').map((x) => x.id);
  const { from, to } = metrics.range(days);
  const prev = { from: addDays(from, -days), to: addDays(from, -1) };
  const bySite = metrics.salesBySite(ids, from, to);
  const waste = metrics.waste(ids, from, to);
  const uptime = metrics.uptime(ids, days);
  const comp = metrics.checklistCompliance(ids, from, to);
  const league = bySite.map((s) => {
    const w = waste.find((x) => x.site_id === s.id);
    const ms = uptime.filter((m) => m.site_name === s.name);
    const c = comp.find((x) => x.id === s.id);
    return { ...s, wasteUnits: w?.units || 0, wastePct: s.units ? ((w?.units || 0) / s.units) * 100 : null, uptime: ms.length ? ms.reduce((a, m) => a + m.uptime, 0) / ms.length : null, compliance: c?.compliance, faults: ms.reduce((a, m) => a + m.faults_30d, 0) };
  });
  res.page('owner', "Owner's View", {
    days, from, to,
    fin: metrics.finance(ids, from, to),
    finPrev: metrics.finance(ids, prev.from, prev.to),
    sales: metrics.sales(ids, from, to),
    trend: metrics.salesByDay(ids, from, to),
    byProduct: metrics.salesByProduct(ids, from, to),
    byMachine: metrics.salesByMachine(ids, from, to),
    league, uptime,
    inc: metrics.incidentsSummary(ids),
    scorecard: metrics.staffScorecard(ids, from, to).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 8),
    approvals: db.all("SELECT a.*, u.name AS requester FROM approvals a LEFT JOIN users u ON u.id = a.requested_by WHERE a.status = 'pending' ORDER BY a.required_role = 'owner' DESC, a.created_at DESC"),
    sitesCount: db.get("SELECT SUM(status='active') active, SUM(status='planning') planning, COUNT(*) total FROM sites"),
    openCases: db.val("SELECT COUNT(*) FROM customer_cases WHERE status NOT IN ('resolved','closed')"),
    avgRating: db.val("SELECT ROUND(AVG(rating),1) FROM customer_cases WHERE rating IS NOT NULL AND created_at >= datetime('now', ?)", `-${days} days`),
    unverified: db.val('SELECT COUNT(*) FROM daily_closeouts WHERE verified_at IS NULL AND business_date <= ?', addDays(today(), -2)),
    closeVariance: db.val('SELECT COALESCE(SUM(variance),0) FROM daily_closeouts WHERE business_date BETWEEN ? AND ?', from, to),
    aiOn: require('../services/ai').enabled(),
  });
});

r.post('/owner/summary', requirePerm('dashboard.owner'), async (req, res, next) => {
  try {
    const summary = await require('../services/ai').dailySummary();
    req.flash('info', summary || 'AI summary is not available — add ANTHROPIC_API_KEY to enable it.');
    res.redirect('/owner');
  } catch (e) { next(e); }
});

// ── Notifications ──
r.get('/notifications', (req, res) => {
  const { where, params, f } = filters(req.query, {
    level: F.eq('level'), unread: (v) => (v === '1' ? ['read_at IS NULL'] : null),
    from: F.dateFrom('created_at'), to: F.dateTo('created_at'), q: F.search('title', 'body'),
  }, ['user_id = ?']);
  const p = paginate(req, `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC`, [req.user.id, ...params]);
  res.page('notifications', 'Notifications', { p, items: p.rows, f });
});
r.post('/notifications/read', (req, res) => {
  db.run("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL", req.user.id);
  res.redirect('/notifications');
});
r.get('/notifications/:id', (req, res) => {
  const n = db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!n) return res.redirect('/notifications');
  db.run("UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ?", n.id);
  res.redirect(n.link && n.link.startsWith('/') ? n.link : '/notifications');
});

r.post('/announcements/:id/ack', (req, res) => {
  db.run('INSERT OR IGNORE INTO announcement_acks(announcement_id, user_id) VALUES (?, ?)', req.params.id, req.user.id);
  res.back('/');
});

// ── Global search ──
r.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const out = { staff: [], machines: [], incidents: [], sops: [], sites: [] };
  if (q.length >= 2) {
    if (access.can(req.user, 'users.manage')) out.staff = db.all('SELECT id, name, role, staff_no FROM users WHERE name LIKE ? OR staff_no LIKE ? OR email LIKE ? OR username LIKE ? LIMIT 8', like, like, like, like);
    if (access.can(req.user, 'machines.view')) out.machines = db.all(`SELECT m.id, m.code, m.status, m.supplier_device_no, s.name AS site_name FROM machines m LEFT JOIN sites s ON s.id = m.site_id WHERE (m.code LIKE ? OR m.supplier_device_no LIKE ? OR s.name LIKE ?) AND ${access.siteFilter(req.user, 'm.site_id')} LIMIT 8`, like, like, like);
    if (access.can(req.user, 'incidents.view')) out.incidents = db.all(`SELECT id, ref, title, status, severity FROM incidents WHERE (title LIKE ? OR ref LIKE ? OR description LIKE ?) AND (site_id IS NULL OR ${access.siteFilter(req.user, 'site_id')}) ORDER BY created_at DESC LIMIT 8`, like, like, like);
    if (access.can(req.user, 'handbook.view')) out.sops = db.all("SELECT code, title, purpose FROM sops WHERE status = 'approved' AND (code LIKE ? OR title LIKE ? OR body LIKE ?) LIMIT 8", like, like, like);
    if (access.can(req.user, 'sites.view')) out.sites = db.all(`SELECT id, name, type FROM sites WHERE (name LIKE ? OR code LIKE ?) AND ${access.siteFilter(req.user, 'id')} LIMIT 6`, like, like);
  }
  res.page('search', 'Search', { q, out });
});

module.exports = r;
