// HR: admin attendance tools, payroll, leaderboard & Employee of the Month, access & roles.
const express = require('express');
const db = require('../db');
const access = require('../services/access');
const attendance = require('../services/attendance');
const payroll = require('../services/payroll');
const metrics = require('../services/metrics');
const { notify } = require('../services/notify');
const { audit, security } = require('../services/audit');
const { requirePerm } = require('../middleware');
const { today, toNum, addDays } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();

// ── Admin attendance tools (PRD 6.5) ──
r.post('/hr/attendance', requirePerm('attendance.manage'), (req, res) => {
  const b = req.body;
  if (!b.reason) { req.flash('error', 'A reason is required for manual attendance changes.'); return res.back('/attendance'); }
  const date = b.date; const userId = Number(b.user_id);
  const dup = db.get("SELECT id FROM attendance WHERE user_id = ? AND COALESCE(work_date, date(clock_in)) = ?", userId, date);
  if (dup && !b.override_duplicate) { req.flash('error', 'This person already has an attendance record for that day. Tick "allow a second record" to override.'); return res.back('/attendance'); }
  const id = db.insert('attendance', { user_id: userId, site_id: toNum(b.site_id), clock_in: `${date} ${b.clock_in}:00`, clock_out: b.clock_out ? `${date} ${b.clock_out}:00` : null, work_date: date, source: 'admin', notes: b.reason });
  attendance.recalc(id);
  audit(req, 'attendance.inserted', 'attendance', id, b);
  notify({ users: [userId] }, { title: 'Your attendance was updated by a manager', body: `${date}: ${b.reason}`, link: '/attendance' });
  req.flash('success', 'Attendance record added.');
  res.redirect(`/attendance?date=${date}`);
});

r.post('/hr/attendance/:id', requirePerm('attendance.manage'), (req, res) => {
  const a = db.get('SELECT * FROM attendance WHERE id = ?', req.params.id);
  const b = req.body;
  if (!b.reason) { req.flash('error', 'A reason is required.'); return res.back('/attendance'); }
  const date = a.work_date || a.clock_in.slice(0, 10);
  if (b.action === 'delete') {
    db.run('DELETE FROM attendance WHERE id = ?', a.id);
    audit(req, 'attendance.deleted', 'attendance', a.id, { before: a, reason: b.reason });
    req.flash('success', 'Record deleted (kept in the audit log).');
    return res.redirect(`/attendance?date=${date}`);
  }
  const patch = { notes: b.reason };
  if (b.clock_in) patch.clock_in = `${date} ${b.clock_in}:00`;
  if (b.clock_out) patch.clock_out = `${date} ${b.clock_out}:00`;
  if (b.overtime_override !== undefined && b.overtime_override !== '') { patch.overtime_override = Number(b.overtime_override); patch.override_reason = b.reason; }
  if (b.overtime_override === '') patch.overtime_override = null;
  db.update('attendance', a.id, patch);
  const after = attendance.recalc(a.id);
  audit(req, 'attendance.edited', 'attendance', a.id, { before: { in: a.clock_in, out: a.clock_out, ot: a.overtime_hours }, after: { in: after.clock_in, out: after.clock_out, ot: after.overtime_hours }, reason: b.reason });
  req.flash('success', 'Attendance updated and recalculated.');
  res.redirect(`/attendance?date=${date}`);
});

// ── Payroll (PRD 6.8) ──
r.get('/payroll/my', (req, res) => {
  const p = paginate(req, "SELECT i.*, r.month FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id WHERE i.user_id = ? AND r.status = 'finalized' ORDER BY r.month DESC", [req.user.id], { perPage: 12 });
  res.page('payroll-my', 'My payslips', { p, items: p.rows });
});

r.get('/payroll', requirePerm('payroll.manage'), (req, res) => {
  const fl = filters(req.query, { status: F.eq('r.status'), year: (v) => ['substr(r.month,1,4) = ?', v] });
  const p = paginate(req, `SELECT r.*, g.name AS generated_name, f.name AS finalized_name FROM payroll_runs r LEFT JOIN users g ON g.id = r.generated_by LEFT JOIN users f ON f.id = r.finalized_by WHERE ${fl.where} ORDER BY r.month DESC`, fl.params, { perPage: 12 });
  const runs = p.rows;
  const missingPay = db.all("SELECT id, name, role FROM users WHERE active = 1 AND role != 'owner' AND COALESCE(base_salary,0) = 0");
  res.page('payroll', 'Payroll', { p, f: fl.f, years: db.all('SELECT DISTINCT substr(month,1,4) y FROM payroll_runs ORDER BY y DESC').map((x) => x.y), runs, missingPay, thisMonth: today().slice(0, 7), rates: payroll.rates() });
});
r.post('/payroll/generate', requirePerm('payroll.manage'), (req, res) => {
  try {
    const id = payroll.generate(req.body.month, req.user.id);
    audit(req, 'payroll.generated', 'payroll_runs', id, req.body.month);
    req.flash('success', `Payroll for ${req.body.month} generated from attendance, leave and pay records. Review it, then finalise.`);
    res.redirect(`/payroll/${id}`);
  } catch (e) { req.flash('error', e.message); res.redirect('/payroll'); }
});
r.get('/payroll/:id', requirePerm('payroll.manage'), (req, res) => {
  const run = db.get('SELECT * FROM payroll_runs WHERE id = ?', req.params.id);
  if (!run) return res.redirect('/payroll');
  const fl = filters(req.query, { q: F.search('u.name', 'u.staff_no'), role: F.eq('u.role'), absent: (v) => (v === '1' ? ['i.absent_days > 0'] : null) }, ['i.run_id = ?']);
  const p = paginate(req, `SELECT i.*, u.name, u.role, u.staff_no FROM payroll_items i JOIN users u ON u.id = i.user_id WHERE ${fl.where} ORDER BY u.name`, [run.id, ...fl.params], { perPage: 20 });
  res.page('payroll-run', `Payroll ${run.month}`, { run, p, items: p.rows, f: fl.f });
});
r.post('/payroll/:id/finalize', requirePerm('payroll.manage'), (req, res) => {
  try {
    payroll.finalize(Number(req.params.id), req.user.id);
    const run = db.get('SELECT * FROM payroll_runs WHERE id = ?', req.params.id);
    for (const i of db.all('SELECT user_id FROM payroll_items WHERE run_id = ?', run.id)) notify({ users: [i.user_id] }, { level: 'success', title: `Your payslip for ${run.month} is ready`, link: '/payroll/my', email: true });
    audit(req, 'payroll.finalized', 'payroll_runs', run.id, run.month);
    req.flash('success', 'Payroll finalised, staff notified and the salary expense posted to Finance.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect(`/payroll/${req.params.id}`);
});
r.get('/payroll/slip/:itemId', (req, res) => {
  const i = db.get('SELECT i.*, r.month, r.status, u.name, u.staff_no, u.role, u.bank_details FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id JOIN users u ON u.id = i.user_id WHERE i.id = ?', req.params.itemId);
  if (!i || (i.user_id !== req.user.id && !access.can(req.user, 'payroll.manage')) || (i.user_id === req.user.id && i.status !== 'finalized' && !access.can(req.user, 'payroll.manage'))) return res.redirect('/payroll/my');
  res.page('payslip', `Payslip ${i.month}`, { i, d: JSON.parse(i.details || '{}') });
});

// ── Leaderboard & Employee of the Month (PRD 6.7) ──
r.get('/leaderboard', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const { from, to } = payroll.monthBounds(month);
  const all = db.all('SELECT id FROM sites').map((s) => s.id);
  const board = metrics.staffScorecard(all, from, to > today() ? today() : to)
    .filter((s) => !['owner'].includes(s.role))
    .map((s) => {
      // Ranking uses the attendance rules engine (schedules, leave, absences) rather than roster shifts only.
      const a = attendance.summary(s.id, from, to > today() ? today() : to);
      const att = a.scheduled ? Math.min(100, (a.worked / a.scheduled) * 100) : null;
      const punctuality = a.worked ? Math.max(0, 100 - Math.min(100, (a.late / a.worked) * 3)) : null;
      const quality = s.avg_score ?? 90;
      const reliability = Math.max(0, Math.min(100, 70 + s.reports * 5 + s.tasks_done * 5 - s.tasks_overdue * 10 - s.rejected * 10));
      const score = att == null ? null : att * 0.4 + (punctuality ?? 100) * 0.2 + quality * 0.25 + reliability * 0.15;
      return { ...s, attendance: att, late_mins: a.late, absent: a.absent, punctuality, score };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const award = db.get('SELECT a.*, u.name, u.role FROM employee_awards a JOIN users u ON u.id = a.user_id WHERE a.month = ?', month);
  const history = db.all('SELECT a.*, u.name FROM employee_awards a JOIN users u ON u.id = a.user_id ORDER BY a.month DESC LIMIT 12');
  res.page('leaderboard', 'Leaderboard', { month, board, award, history, prev: addDays(`${month}-01`, -1).slice(0, 7), next: addDays(`${month}-28`, 7).slice(0, 7) });
});
r.post('/leaderboard/award', requirePerm('awards.manage'), (req, res) => {
  const { month, user_id: uid, citation, score } = req.body;
  db.run('INSERT INTO employee_awards(month, user_id, score, citation, awarded_by) VALUES (?,?,?,?,?) ON CONFLICT(month) DO UPDATE SET user_id = excluded.user_id, score = excluded.score, citation = excluded.citation, awarded_by = excluded.awarded_by', month, uid, toNum(score), citation || null, req.user.id);
  const u = db.get('SELECT name FROM users WHERE id = ?', uid);
  notify({ roles: Object.keys(access.ROLES) }, { level: 'success', title: `🏆 Employee of the Month (${month}): ${u.name}`, body: citation || '', link: `/leaderboard?month=${month}` });
  audit(req, 'award.given', 'employee_awards', null, { month, uid });
  req.flash('success', `${u.name} is Employee of the Month. Everyone has been notified.`);
  res.redirect(`/leaderboard?month=${month}`);
});

// ── Access & roles ──
r.get('/access', requirePerm('access.manage'), (req, res) => {
  const roles = Object.keys(access.ROLES);
  const matrix = {};
  for (const x of db.all('SELECT role, perm FROM role_permissions')) (matrix[x.role] ||= {})[x.perm] = true;
  const overrides = db.all('SELECT p.*, u.name, u.role FROM user_permissions p JOIN users u ON u.id = p.user_id ORDER BY u.name');
  res.page('access', 'Access & roles', { roles, matrix, CATALOG: access.CATALOG, overrides });
});
r.post('/access', requirePerm('access.manage'), (req, res) => {
  const roles = Object.keys(access.ROLES).filter((x) => x !== 'owner');
  const before = db.all("SELECT role, perm FROM role_permissions WHERE role != 'owner'").map((x) => `${x.role}:${x.perm}`);
  const after = [];
  db.tx(() => {
    db.run("DELETE FROM role_permissions WHERE role != 'owner'");
    for (const role of roles) for (const perm of access.PERM_LIST) if (req.body[`${role}:${perm}`]) { db.run('INSERT INTO role_permissions(role, perm) VALUES (?, ?)', role, perm); after.push(`${role}:${perm}`); }
  });
  access.invalidate();
  const added = after.filter((x) => !before.includes(x)); const removed = before.filter((x) => !after.includes(x));
  security(req, 'permission.changed', { details: { added, removed } });
  audit(req, 'access.roles_updated', 'role_permissions', null, { added, removed });
  req.flash('success', `Role permissions saved (${added.length} added, ${removed.length} removed).`);
  res.redirect('/access');
});
r.post('/access/reset', requirePerm('access.manage'), (req, res) => {
  db.tx(() => {
    db.run("DELETE FROM role_permissions WHERE role != 'owner'");
    for (const [perm, rs] of Object.entries(access.DEFAULTS)) for (const role of rs) db.run('INSERT OR IGNORE INTO role_permissions(role, perm) VALUES (?, ?)', role, perm);
  });
  access.invalidate();
  security(req, 'permission.changed', { details: 'reset to defaults' });
  req.flash('success', 'All roles reset to the recommended defaults.');
  res.redirect('/access');
});
r.post('/users/:id/permissions', requirePerm('access.manage'), (req, res) => {
  const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (u.role === 'owner') { req.flash('error', 'The Owner always has full access.'); return res.back(); }
  const changes = {};
  db.tx(() => {
    db.run('DELETE FROM user_permissions WHERE user_id = ?', u.id);
    for (const perm of access.PERM_LIST) {
      const v = req.body[`perm:${perm}`];
      if (v === 'grant' || v === 'deny') { db.run('INSERT INTO user_permissions(user_id, perm, effect) VALUES (?,?,?)', u.id, perm, v); changes[perm] = v; }
    }
  });
  access.invalidate();
  security(req, 'permission.changed', { identifier: u.email, details: changes });
  audit(req, 'access.user_overrides', 'users', u.id, changes);
  req.flash('success', `Access for ${u.name} saved.`);
  res.redirect(`/users/${u.id}#access`);
});

module.exports = r;
