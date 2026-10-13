const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const access = require('../services/access');
const metrics = require('../services/metrics');
const approvals = require('../services/approvals');
const { notify } = require('../services/notify');
const { audit, security } = require('../services/audit');
const attendance = require('../services/attendance');
const { requirePerm } = require('../middleware');
const { today, addDays, nowTime, sqlNow, toNum, pick } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();
const roleRank = (role) => access.ROLES[role]?.level || 0;

// ── Staff directory ──
r.get('/users', requirePerm('users.manage'), (req, res) => {
  const { where, params, f } = filters(req.query, {
    q: F.search('u.name', 'u.email', 'u.staff_no', 'u.username', 'u.phone'),
    role: F.eq('u.role'),
    status: (v) => ["COALESCE(u.status, CASE WHEN u.active = 1 THEN 'active' ELSE 'inactive' END) = ?", v],
    site: (v) => ['EXISTS (SELECT 1 FROM user_sites x WHERE x.user_id = u.id AND x.site_id = ?)', v],
    cleared: (v) => ['u.cleared_to_work_alone = ?', v === 'yes' ? 1 : 0],
  });
  const p = paginate(req, `SELECT u.*, (SELECT group_concat(s.code, ', ') FROM user_sites us JOIN sites s ON s.id = us.site_id WHERE us.user_id = u.id) AS sites,
      (SELECT COUNT(*) FROM training_records tr WHERE tr.user_id = u.id AND tr.quiz_passed = 1) AS passed
    FROM users u WHERE ${where} ORDER BY u.active DESC, u.name`, params);
  res.page('users', 'Staff', { p, users: p.rows, f, sites: db.all('SELECT id, name FROM sites ORDER BY name'), modules: db.val('SELECT COUNT(*) FROM training_modules WHERE active = 1') });
});

r.get('/users/new', requirePerm('users.manage'), (req, res) => res.page('user-form', 'Add staff member', { u: { role: 'sales_rep' }, userSites: [], sites: db.all('SELECT * FROM sites ORDER BY name') }));

r.post('/users', requirePerm('users.manage'), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (roleRank(req.body.role) >= roleRank(req.user.role) && req.user.role !== 'owner') { req.flash('error', 'You cannot create a user with a role equal to or above your own.'); return res.back(); }
  if (db.get('SELECT 1 FROM users WHERE lower(email) = ?', email)) { req.flash('error', 'That email already has an account.'); return res.back(); }
  const temp = crypto.randomBytes(6).toString('base64url') + '7a';
  const count = db.val('SELECT COUNT(*) FROM users') + 1;
  const id = db.insert('users', {
    staff_no: req.body.staff_no || `SWG-${String(count).padStart(3, '0')}`,
    name: req.body.name, email, phone: req.body.phone || null, role: req.body.role,
    password_hash: bcrypt.hashSync(temp, 11), must_change_password: 1, hired_on: req.body.hired_on || today(),
    username: String(req.body.username || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9._-]/g, '') || null,
    status: 'active',
  });
  for (const s of [].concat(req.body.sites || [])) db.insert('user_sites', { user_id: id, site_id: Number(s) });
  audit(req, 'user.created', 'users', id, { email, role: req.body.role });
  res.page('user-created', 'Staff member added', { name: req.body.name, email, temp });
});

r.get('/users/:id', (req, res) => {
  const self = Number(req.params.id) === req.user.id;
  if (!self && !access.can(req.user, 'users.manage') && !access.can(req.user, 'training.assess')) return res.redirect('/account');
  const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) return res.redirect('/users');
  const { from, to } = metrics.range(30);
  res.page('user', u.name, {
    u,
    userSites: db.all('SELECT site_id FROM user_sites WHERE user_id = ?', u.id).map((x) => x.site_id),
    sites: db.all('SELECT * FROM sites ORDER BY name'),
    score: metrics.staffScorecard(db.all('SELECT id FROM sites').map((x) => x.id), from, to).find((x) => x.id === u.id),
    training: db.all('SELECT m.title, m.code, tr.* FROM training_modules m LEFT JOIN training_records tr ON tr.module_id = m.id AND tr.user_id = ? WHERE m.active = 1 ORDER BY m.position', u.id),
    attendance: db.all('SELECT a.*, s.name AS site_name FROM attendance a LEFT JOIN sites s ON s.id = a.site_id WHERE a.user_id = ? ORDER BY a.clock_in DESC LIMIT 10', u.id),
    acks: db.all('SELECT * FROM acknowledgements WHERE user_id = ?', u.id),
    month: attendance.summary(u.id, today().slice(0, 8) + '01', today()),
    overrides: Object.fromEntries(db.all('SELECT perm, effect FROM user_permissions WHERE user_id = ?', u.id).map((x) => [x.perm, x.effect])),
    CATALOG: access.CATALOG,
    roleHas: (perm) => !!db.get('SELECT 1 FROM role_permissions WHERE role = ? AND perm = ?', u.role, perm),
    canComp: access.can(req.user, 'users.compensation'),
  });
});

r.post('/users/:id', requirePerm('users.manage'), (req, res) => {
  const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (u.role === 'owner' && req.user.role !== 'owner') { req.flash('error', 'Only the Owner can edit the Owner account.'); return res.back(); }
  if (req.body.role && roleRank(req.body.role) >= roleRank(req.user.role) && req.user.role !== 'owner') { req.flash('error', 'You cannot assign a role equal to or above your own.'); return res.back(); }
  const data = pick(req.body, ['name', 'phone', 'role', 'staff_no', 'emergency_contact', 'hired_on', 'username', 'work_start', 'work_end', 'geofence_mode']);
  if (data.username) data.username = String(data.username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') || null;
  if (data.username && db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', data.username, u.id)) { req.flash('error', 'That username is taken.'); return res.back(); }
  data.work_days = [].concat(req.body.work_days || []).join(',');
  data.status = ['active', 'inactive', 'suspended'].includes(req.body.status) ? req.body.status : 'active';
  data.active = data.status === 'inactive' ? 0 : 1;
  data.geo_lat = toNum(req.body.geo_lat); data.geo_lng = toNum(req.body.geo_lng); data.geo_radius_m = toNum(req.body.geo_radius_m);
  if (access.can(req.user, 'users.compensation')) {
    data.pay_type = ['monthly', 'daily', 'hourly'].includes(req.body.pay_type) ? req.body.pay_type : 'monthly';
    data.base_salary = toNum(req.body.base_salary) || 0;
    data.allowances = toNum(req.body.allowances) || 0;
    data.other_deductions = toNum(req.body.other_deductions) || 0;
    data.ssnit_applies = req.body.ssnit_applies ? 1 : 0;
    data.bank_details = req.body.bank_details || null;
  }
  data.cleared_to_work_alone = req.body.cleared_to_work_alone ? 1 : 0;
  if (u.id === req.user.id) { data.active = 1; data.status = 'active'; delete data.role; }
  if (data.status !== u.status) security(req, 'user.status_changed', { userId: req.user.id, identifier: u.email, details: { from: u.status, to: data.status } });
  db.update('users', u.id, data);
  db.run('DELETE FROM user_sites WHERE user_id = ?', u.id);
  for (const s of [].concat(req.body.sites || [])) db.insert('user_sites', { user_id: u.id, site_id: Number(s) });
  if (!data.active) db.run("DELETE FROM sessions WHERE sess LIKE ?", `%"userId":${u.id}%`);
  audit(req, 'user.updated', 'users', u.id, data);
  req.flash('success', 'Saved.');
  res.redirect(`/users/${u.id}`);
});

r.post('/users/:id/reset-password', requirePerm('users.manage'), (req, res) => {
  const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (u.role === 'owner' && req.user.role !== 'owner') { req.flash('error', 'Only the Owner can reset the Owner password.'); return res.back(); }
  const temp = crypto.randomBytes(6).toString('base64url') + '7a';
  db.update('users', u.id, { password_hash: bcrypt.hashSync(temp, 11), must_change_password: 1, failed_logins: 0, locked_until: null });
  db.run("DELETE FROM sessions WHERE sess LIKE ?", `%"userId":${u.id}%`);
  audit(req, 'user.password_reset', 'users', u.id);
  security(req, 'password.reset', { identifier: u.email });
  res.page('user-created', 'Password reset', { name: u.name, email: u.email, temp, reset: true });
});

// ── Roster ──
r.get('/roster', (req, res) => {
  const start = req.query.week || (() => { const d = new Date(today() + 'T12:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; return addDays(today(), -dow); })();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const sites = access.sitesFor(req.user).filter((s) => s.status !== 'closed');
  const shifts = db.all(`SELECT sh.*, u.name AS user_name, u.role, m.code AS machine_code,
      (SELECT a.clock_in FROM attendance a WHERE a.shift_id = sh.id LIMIT 1) AS clock_in
    FROM shifts sh JOIN users u ON u.id = sh.user_id LEFT JOIN machines m ON m.id = sh.machine_id
    WHERE sh.shift_date BETWEEN ? AND ? AND ${access.siteFilter(req.user, 'sh.site_id')} ORDER BY sh.start_time`, days[0], days[6]);
  const staff = access.can(req.user, 'roster.manage') ? db.all(`SELECT DISTINCT u.* FROM users u LEFT JOIN user_sites us ON us.user_id = u.id WHERE u.active = 1 AND u.role != 'owner' AND (${access.siteFilter(req.user, 'us.site_id')} OR u.role IN ('ops_manager','accounts')) ORDER BY u.name`) : [];
  const leave = db.all(`SELECT l.*, u.name FROM leave_requests l JOIN users u ON u.id = l.user_id WHERE l.status = 'approved' AND l.end_date >= ? AND l.start_date <= ?`, days[0], days[6]);
  res.page('roster', 'Roster', { start, days, sites, shifts, staff, leave, machines: access.machinesFor(req.user) });
});

r.post('/roster', requirePerm('roster.manage'), (req, res) => {
  const { user_id, site_id, shift_date, start_time, end_time, shift_type, repeat_days } = req.body;
  if (!access.canSite(req.user, site_id)) { req.flash('error', 'Not your site.'); return res.back(); }
  const n = Math.min(14, Math.max(1, Number(repeat_days) || 1));
  let created = 0;
  for (let i = 0; i < n; i++) {
    const d = addDays(shift_date, i);
    const onLeave = db.get("SELECT 1 FROM leave_requests WHERE user_id = ? AND status = 'approved' AND ? BETWEEN start_date AND end_date", user_id, d);
    const clash = db.get("SELECT 1 FROM shifts WHERE user_id = ? AND shift_date = ? AND status != 'cancelled' AND NOT (end_time <= ? OR start_time >= ?)", user_id, d, start_time, end_time);
    if (onLeave || clash) continue;
    db.insert('shifts', { user_id, site_id, machine_id: toNum(req.body.machine_id), shift_date: d, start_time, end_time, shift_type, duties: [].concat(req.body.duties || []).join(','), created_by: req.user.id });
    created++;
  }
  if (created) notify({ users: [Number(user_id)] }, { title: `New shift${created > 1 ? 's' : ''} rostered`, body: `${created} shift(s) from ${shift_date}, ${start_time}–${end_time}`, link: '/roster' });
  audit(req, 'roster.created', 'shifts', null, { ...req.body, created });
  req.flash(created ? 'success' : 'warning', created ? `${created} shift(s) added.` : 'No shifts added — clashes with leave or another shift.');
  res.redirect(`/roster?week=${req.body.week || ''}`);
});

r.post('/roster/:id/cancel', requirePerm('roster.manage'), (req, res) => {
  const sh = db.get('SELECT * FROM shifts WHERE id = ?', req.params.id);
  db.update('shifts', sh.id, { status: 'cancelled' });
  notify({ users: [sh.user_id] }, { level: 'warning', title: 'Shift cancelled', body: `${sh.shift_date} ${sh.start_time}–${sh.end_time}`, link: '/roster' });
  audit(req, 'roster.cancelled', 'shifts', sh.id);
  res.back('/roster');
});

// ── Attendance ──
r.get('/attendance', (req, res) => {
  const team = access.can(req.user, 'attendance.view');
  const date = req.query.date || today();
  // Team list for one day (or a range) with filters.
  let tp = null; let missing = []; let tf = {};
  if (team) {
    const t = filters(req.query, {
      site: F.eq('a.site_id'), staff: F.eq('a.user_id'),
      punctuality: (v) => (v === 'late' ? ['a.late_minutes > 0'] : v === 'ontime' ? ['COALESCE(a.late_minutes,0) = 0'] : null),
      state: (v) => (v === 'open' ? ['a.clock_out IS NULL'] : v === 'auto' ? ["a.source = 'auto_clockout'"] : v === 'manual' ? ["a.source = 'admin'"] : v === 'ot' ? ['a.overtime_hours > 0'] : null),
      q: F.search('u.name'),
    }, [access.siteFilter(req.user, 'a.site_id'), 'COALESCE(a.work_date, date(a.clock_in)) BETWEEN ? AND ?']);
    tf = t.f;
    const tFrom = req.query.date_from || date; const tTo = req.query.date_to || date;
    tf.date_from = req.query.date_from || ''; tf.date_to = req.query.date_to || '';
    tp = paginate(req, `SELECT a.*, u.name, u.role, s.name AS site_name FROM attendance a JOIN users u ON u.id = a.user_id LEFT JOIN sites s ON s.id = a.site_id WHERE ${t.where} ORDER BY COALESCE(a.work_date, date(a.clock_in)) DESC, a.clock_in`, [tFrom, tTo, ...t.params], { param: 'tpage', perPage: 20 });
    missing = db.all(`SELECT sh.*, u.name, s.name AS site_name FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN sites s ON s.id = sh.site_id
      WHERE sh.shift_date = ? AND sh.status IN ('scheduled','missed') AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = sh.user_id AND COALESCE(a.work_date, date(a.clock_in)) = sh.shift_date) AND ${access.siteFilter(req.user, 'sh.site_id')} ORDER BY sh.start_time`, date);
  }
  // My own history, paged.
  const m = filters({ mfrom: req.query.mfrom, mto: req.query.mto, mlate: req.query.mlate }, {
    mfrom: F.dateFrom('COALESCE(a.work_date, a.clock_in)'), mto: F.dateTo('COALESCE(a.work_date, a.clock_in)'),
    mlate: (v) => (v === '1' ? ['a.late_minutes > 0'] : null),
  }, ['a.user_id = ?']);
  const mp = paginate(req, `SELECT a.*, s.name AS site_name FROM attendance a LEFT JOIN sites s ON s.id = a.site_id WHERE ${m.where} ORDER BY a.clock_in DESC`, [req.user.id, ...m.params], { param: 'mpage', perPage: 10 });
  res.page('attendance', 'Attendance', {
    date, tp, rows: tp ? tp.rows : [], tf, missing, mp, mine: mp.rows, mf: m.f, team,
    myMonth: attendance.summary(req.user.id, today().slice(0, 8) + '01', today()), sites: access.sitesFor(req.user),
    staff: team ? db.all(`SELECT DISTINCT u.id, u.name FROM users u LEFT JOIN user_sites us ON us.user_id = u.id WHERE u.active = 1 AND u.role != 'owner' AND (${access.siteFilter(req.user, 'us.site_id')} OR u.role IN ('ops_manager','accounts')) ORDER BY u.name`) : [],
  });
});

r.post('/attendance/in', (req, res) => {
  const siteId = Number(req.body.site_id);
  const site = db.get('SELECT * FROM sites WHERE id = ?', siteId);
  if (!site || !access.canSite(req.user, siteId)) { req.flash('error', 'You are not assigned to that site.'); return res.back('/'); }
  try {
    const { record, warn } = attendance.clockIn(req.user, site, { lat: toNum(req.body.lat), lng: toNum(req.body.lng), accuracy: toNum(req.body.accuracy) });
    audit(req, 'clock.in', 'attendance', record.id, { siteId, late: record.late_minutes, distance: record.in_distance_m });
    if (record.late_minutes) notify({ roles: ['supervisor', 'ops_manager'], siteId, except: req.user.id }, { level: 'warning', title: `${req.user.name} clocked in ${record.late_minutes} min late`, body: site.name, link: '/attendance' });
    req.flash(warn ? 'warning' : 'success', `Clocked in at ${record.clock_in.slice(11, 16)} (server time)${record.late_minutes ? ` — ${record.late_minutes} min late` : ''}.${record.in_distance_m != null ? ` You are ${record.in_distance_m} m from site ✓.` : ''}${warn ? ` ${warn}` : ''}${req.user.cleared_to_work_alone ? '' : ' Reminder: work with a trained colleague until you are cleared.'}`);
  } catch (e) {
    if (e.geofence) security(req, 'geofence.rejected', { details: { action: 'clock_in', site: site.name, distance: e.distance && Math.round(e.distance) } });
    req.flash('error', e.message);
  }
  res.redirect('/');
});

r.post('/attendance/out', (req, res) => {
  try {
    const { record, warn } = attendance.clockOut(req.user, { lat: toNum(req.body.lat), lng: toNum(req.body.lng), accuracy: toNum(req.body.accuracy) });
    audit(req, 'clock.out', 'attendance', record.id, { worked: record.worked_minutes, ot: record.overtime_hours });
    req.flash(warn ? 'warning' : 'success', `Clocked out at ${record.clock_out.slice(11, 16)}. Worked ${Math.floor(record.worked_minutes / 60)}h ${record.worked_minutes % 60}m${record.overtime_hours ? `, ${record.overtime_hours}h overtime` : ''}. Thank you!${warn ? ` ${warn}` : ''}`);
  } catch (e) {
    if (e.geofence) security(req, 'geofence.rejected', { details: { action: 'clock_out', distance: e.distance && Math.round(e.distance) } });
    req.flash('error', e.message);
  }
  res.redirect('/');
});

// ── Shift handover ──
r.get('/handover/new', (req, res) => {
  const sites = access.sitesFor(req.user);
  const siteId = Number(req.query.site) || res.locals.clockedIn?.site_id || sites[0]?.id;
  const open = siteId ? {
    incidents: db.all("SELECT ref, title, severity FROM incidents WHERE site_id = ? AND status NOT IN ('resolved','closed')", siteId),
    cases: db.all("SELECT ref, description FROM customer_cases WHERE site_id = ? AND status NOT IN ('resolved','closed')", siteId),
    payments: db.all("SELECT kind, amount, payment_ref FROM payment_exceptions WHERE site_id = ? AND status IN ('open','investigating')", siteId),
  } : { incidents: [], cases: [], payments: [] };
  const stockLines = require('../services/stock').balances().filter((b) => b.site_id === siteId && b.kind === 'machine').map((b) => `${b.product_name}: ${b.qty}`).join(', ');
  res.page('handover-form', 'Shift handover', { sites, siteId, open, stockLines, colleagues: db.all(`SELECT DISTINCT u.id, u.name FROM users u JOIN user_sites us ON us.user_id = u.id WHERE us.site_id = ? AND u.id != ? AND u.active = 1`, siteId || 0, req.user.id) });
});

r.post('/handover', (req, res) => {
  const id = db.insert('handovers', { site_id: req.body.site_id, from_user_id: req.user.id, to_user_id: toNum(req.body.to_user_id), stock_summary: req.body.stock_summary, open_issues: req.body.open_issues, cash_payment_notes: req.body.cash_payment_notes, notes: req.body.notes });
  if (req.body.to_user_id) notify({ users: [Number(req.body.to_user_id)] }, { level: 'info', title: `Handover from ${req.user.name}`, body: (req.body.open_issues || '').slice(0, 140), link: `/handover/${id}` });
  notify({ roles: ['supervisor'], siteId: Number(req.body.site_id), except: req.user.id }, { title: `Shift handover submitted by ${req.user.name}`, link: `/handover/${id}` });
  audit(req, 'handover.created', 'handovers', id);
  req.flash('success', 'Handover submitted. Remember to clock out.');
  res.redirect('/');
});

r.get('/handover', (req, res) => {
  const { where, params, f } = filters(req.query, {
    site: F.eq('h.site_id'), from: F.dateFrom('h.created_at'), to: F.dateTo('h.created_at'),
    ack: (v) => (v === 'pending' ? ['h.acknowledged_at IS NULL'] : v === 'done' ? ['h.acknowledged_at IS NOT NULL'] : null),
    q: F.search('f.name', 't.name', 'h.open_issues', 'h.notes'),
  }, [access.siteFilter(req.user, 'h.site_id')]);
  const p = paginate(req, `SELECT h.*, f.name AS from_name, t.name AS to_name, s.name AS site_name FROM handovers h JOIN users f ON f.id = h.from_user_id LEFT JOIN users t ON t.id = h.to_user_id JOIN sites s ON s.id = h.site_id WHERE ${where} ORDER BY h.created_at DESC`, params);
  res.page('handovers', 'Shift handovers', { p, items: p.rows, f, sites: access.sitesFor(req.user) });
});

r.get('/handover/:id', (req, res) => {
  const h = db.get('SELECT h.*, f.name AS from_name, t.name AS to_name, s.name AS site_name FROM handovers h JOIN users f ON f.id = h.from_user_id LEFT JOIN users t ON t.id = h.to_user_id JOIN sites s ON s.id = h.site_id WHERE h.id = ?', req.params.id);
  if (!h || !access.canSite(req.user, h.site_id)) return res.redirect('/handover');
  res.page('handover', 'Shift handover', { h });
});
r.post('/handover/:id/ack', (req, res) => {
  db.run("UPDATE handovers SET acknowledged_at = datetime('now'), to_user_id = COALESCE(to_user_id, ?) WHERE id = ?", req.user.id, req.params.id);
  req.flash('success', 'Handover acknowledged.');
  res.redirect('/');
});

// ── Leave & late permission ──
r.get('/leave', (req, res) => {
  const mp = paginate(req, 'SELECT * FROM leave_requests WHERE user_id = ? ORDER BY start_date DESC', [req.user.id], { param: 'mpage', perPage: 8 });
  let tp = null; let tf = {};
  if (access.can(req.user, 'leave.decide') || access.can(req.user, 'roster.manage')) {
    const t = filters(req.query, {
      tstatus: F.eq('l.status'), ttype: F.eq('l.leave_type'), tstaff: F.eq('l.user_id'),
      tfrom: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? ['l.end_date >= ?', v] : null), tto: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? ['l.start_date <= ?', v] : null),
    });
    tf = t.f;
    tp = paginate(req, `SELECT l.*, u.name FROM leave_requests l JOIN users u ON u.id = l.user_id WHERE ${t.where} ORDER BY l.status = 'pending' DESC, l.start_date DESC`, t.params, { param: 'tpage', perPage: 15 });
  }
  res.page('leave', 'Leave & late permission', { mp, mine: mp.rows, tp, team: tp ? tp.rows : [], tf, people: db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name"), staff: access.can(req.user, 'leave.decide') ? db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name") : [] });
});
r.post('/leave', (req, res) => {
  const b = req.body;
  const isLate = b.leave_type === 'late_permission';
  const direct = b.user_id && access.can(req.user, 'leave.decide');   // PRD: admins can insert leave directly
  const userId = direct ? Number(b.user_id) : req.user.id;
  const start = b.start_date; const end = isLate ? b.start_date : (b.end_date || b.start_date);
  if (!start || end < start) { req.flash('error', 'Check the dates.'); return res.back('/leave'); }
  if (isLate && !b.until_time) { req.flash('error', 'Late permission needs an "arrive by" time.'); return res.back('/leave'); }
  if (db.get("SELECT 1 FROM leave_requests WHERE user_id = ? AND status IN ('pending','approved') AND leave_type = ? AND NOT (end_date < ? OR start_date > ?)", userId, b.leave_type, start, end)) { req.flash('error', 'There is already a request covering those dates.'); return res.back('/leave'); }
  const id = db.insert('leave_requests', { user_id: userId, start_date: start, end_date: end, leave_type: b.leave_type, until_time: isLate ? b.until_time : null, reason: b.reason, status: direct ? 'approved' : 'pending', decided_by: direct ? req.user.id : null, decided_at: direct ? sqlNow() : null });
  if (direct) {
    for (let d = start; d <= end; d = addDays(d, 1)) attendance.recalcUserDate(userId, d);
    notify({ users: [userId] }, { level: 'info', title: `${isLate ? 'Late permission' : 'Leave'} recorded for you`, body: `${start}${end !== start ? ' → ' + end : ''}${isLate ? ' until ' + b.until_time : ''}`, link: '/leave', email: true });
    audit(req, 'leave.inserted', 'leave_requests', id, b);
    req.flash('success', 'Recorded and approved.');
  } else {
    approvals.request({ kind: 'leave', title: `${isLate ? 'Late permission' : 'Leave'}: ${req.user.name} ${start}${end !== start ? ' → ' + end : ''}${isLate ? ' (arrive by ' + b.until_time + ')' : ''}`, details: `${b.leave_type}: ${b.reason || ''}`, entity: 'leave_requests', entity_id: id, required_role: 'ops_manager' }, req.user);
    req.flash('success', 'Request sent for approval.');
  }
  res.redirect('/leave');
});
r.post('/leave/:id/decide', requirePerm('leave.decide'), (req, res) => {
  const l = db.get('SELECT * FROM leave_requests WHERE id = ?', req.params.id);
  if (!l || l.status !== 'pending') return res.back('/leave');
  if (l.user_id === req.user.id && req.user.role !== 'owner') { req.flash('error', 'You cannot approve your own request.'); return res.back('/leave'); }
  const appr = db.get("SELECT id FROM approvals WHERE kind = 'leave' AND entity_id = ? AND status = 'pending'", l.id);
  if (appr) approvals.decide(appr.id, req.body.decision === 'approve', req.user, req.body.notes);
  else db.update('leave_requests', l.id, { status: req.body.decision === 'approve' ? 'approved' : 'rejected', decided_by: req.user.id, decided_at: sqlNow() });
  audit(req, `leave.${req.body.decision}`, 'leave_requests', l.id);
  req.flash('success', `Request ${req.body.decision === 'approve' ? 'approved' : 'rejected'}.`);
  res.redirect('/leave');
});

module.exports = r;
