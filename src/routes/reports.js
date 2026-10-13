const express = require('express');
const db = require('../db');
const access = require('../services/access');
const metrics = require('../services/metrics');
const { audit } = require('../services/audit');
const { requirePerm } = require('../middleware');
const { today, addDays } = require('../lib/util');

const r = express.Router();
r.use('/reports', requirePerm('reports.view'));

r.get('/reports', (req, res) => {
  const ids = access.siteIds(req.user);
  const from = req.query.from || addDays(today(), -29);
  const to = req.query.to || today();
  res.page('reports', 'Reports', {
    from, to,
    sales: metrics.sales(ids, from, to),
    bySite: metrics.salesBySite(ids, from, to),
    byProduct: metrics.salesByProduct(ids, from, to),
    byHour: metrics.salesByHour(ids, from, to),
    byDow: db.all(`SELECT CAST(strftime('%w', sold_at) AS INTEGER) dow, SUM(qty) units FROM sales WHERE site_id IN (${ids.map(Number).join(',') || 0}) AND date(sold_at) BETWEEN ? AND ? AND payment_status='confirmed' GROUP BY dow ORDER BY dow`, from, to),
    waste: metrics.waste(ids, from, to),
    wasteReasons: metrics.wasteByReason(ids, from, to),
    compliance: metrics.checklistCompliance(ids, from, to),
    uptime: metrics.uptime(ids, Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1)),
    incidentsByType: db.all(`SELECT type, severity, COUNT(*) n, AVG(CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at)-julianday(created_at))*1440 END) avg_mins FROM incidents WHERE (site_id IS NULL OR site_id IN (${ids.map(Number).join(',') || 0})) AND date(created_at) BETWEEN ? AND ? GROUP BY type, severity ORDER BY n DESC`, from, to),
    repeatFaults: db.all(`SELECT m.code, m.id, COUNT(*) n, GROUP_CONCAT(i.title, ' | ') titles FROM incidents i JOIN machines m ON m.id = i.machine_id WHERE i.type = 'machine' AND date(i.created_at) BETWEEN ? AND ? AND m.site_id IN (${ids.map(Number).join(',') || 0}) GROUP BY m.id HAVING n >= 2 ORDER BY n DESC`, from, to),
    temps: db.get(`SELECT COUNT(*) n, SUM(in_range = 0) bad FROM temperature_logs WHERE site_id IN (${ids.map(Number).join(',') || 0}) AND date(recorded_at) BETWEEN ? AND ?`, from, to),
    cases: db.all(`SELECT category, COUNT(*) n, ROUND(AVG(rating),1) rating FROM customer_cases WHERE (site_id IS NULL OR site_id IN (${ids.map(Number).join(',') || 0})) AND date(created_at) BETWEEN ? AND ? GROUP BY category ORDER BY n DESC`, from, to),
    training: db.get("SELECT SUM(cleared_to_work_alone) cleared, COUNT(*) n FROM users WHERE active = 1 AND role NOT IN ('owner')"),
    scorecard: metrics.staffScorecard(ids, from, to),
  });
});

r.get('/reports/daily', (req, res) => {
  const ids = access.siteIds(req.user);
  const d = req.query.date || today();
  res.page('report-daily', `Daily report ${d}`, {
    d,
    sales: metrics.sales(ids, d, d),
    bySite: metrics.salesBySite(ids, d, d),
    byProduct: metrics.salesByProduct(ids, d, d),
    compliance: metrics.checklistCompliance(ids, d, d),
    waste: metrics.waste(ids, d, d),
    incidents: db.all(`SELECT i.*, s.name AS site_name FROM incidents i LEFT JOIN sites s ON s.id = i.site_id WHERE (date(i.created_at) = ? OR i.status NOT IN ('resolved','closed')) AND (i.site_id IS NULL OR ${access.siteFilter(req.user, 'i.site_id')}) ORDER BY i.created_at DESC`, d),
    cases: db.all(`SELECT * FROM customer_cases WHERE date(created_at) = ? AND (site_id IS NULL OR ${access.siteFilter(req.user, 'site_id')})`, d),
    attendance: db.all(`SELECT a.*, u.name, s.name AS site_name FROM attendance a JOIN users u ON u.id = a.user_id LEFT JOIN sites s ON s.id = a.site_id WHERE date(a.clock_in) = ? AND ${access.siteFilter(req.user, 'a.site_id')}`, d),
    missed: db.all(`SELECT sh.*, u.name, s.name AS site_name FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN sites s ON s.id = sh.site_id WHERE sh.shift_date = ? AND sh.status = 'missed' AND ${access.siteFilter(req.user, 'sh.site_id')}`, d),
    temps: db.all(`SELECT t.*, s.name AS site_name FROM temperature_logs t LEFT JOIN sites s ON s.id = t.site_id WHERE date(t.recorded_at) = ? AND t.in_range = 0 AND ${access.siteFilter(req.user, 't.site_id')}`, d),
    closeouts: db.all(`SELECT c.*, m.code FROM daily_closeouts c JOIN machines m ON m.id = c.machine_id WHERE c.business_date = ? AND ${access.siteFilter(req.user, 'c.site_id')}`, d),
  });
});

// ── CSV exports ──
const EXPORTS = {
  sales: { perm: 'sales.view', sql: (u) => `SELECT x.sold_at, m.code AS machine, s.name AS site, p.name AS product, x.qty, x.unit_price, x.amount, x.payment_method, x.payment_ref, x.payment_status, x.dispense_status, x.order_ref, x.source FROM sales x JOIN machines m ON m.id = x.machine_id JOIN sites s ON s.id = x.site_id LEFT JOIN products p ON p.id = x.product_id WHERE ${access.siteFilter(u, 'x.site_id')} AND date(x.sold_at) BETWEEN ? AND ? ORDER BY x.sold_at`, dated: true },
  incidents: { perm: 'reports.view', sql: (u) => `SELECT i.ref, i.created_at, s.name AS site, m.code AS machine, i.type, i.severity, i.title, i.status, i.acknowledged_at, i.resolved_at, i.downtime_minutes, i.root_cause, i.resolution, i.cost FROM incidents i LEFT JOIN sites s ON s.id = i.site_id LEFT JOIN machines m ON m.id = i.machine_id WHERE (i.site_id IS NULL OR ${access.siteFilter(u, 'i.site_id')}) AND date(i.created_at) BETWEEN ? AND ? ORDER BY i.created_at`, dated: true },
  checklists: { perm: 'reports.view', sql: (u) => `SELECT r.run_date, s.name AS site, t.name AS checklist, us.name AS staff, r.submitted_at, r.status, r.score, r.failed_count FROM checklist_runs r JOIN sites s ON s.id = r.site_id JOIN checklist_templates t ON t.id = r.template_id JOIN users us ON us.id = r.user_id WHERE ${access.siteFilter(u, 'r.site_id')} AND r.run_date BETWEEN ? AND ? ORDER BY r.run_date`, dated: true },
  stock_movements: { perm: 'reports.view', sql: () => 'SELECT m.occurred_at, m.kind, p.name AS product, b.batch_no, m.qty, fl.name AS from_location, tl.name AS to_location, m.reason, m.reference, u.name AS user FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN batches b ON b.id = m.batch_id LEFT JOIN stock_locations fl ON fl.id = m.from_location_id LEFT JOIN stock_locations tl ON tl.id = m.to_location_id LEFT JOIN users u ON u.id = m.user_id WHERE date(m.occurred_at) BETWEEN ? AND ? ORDER BY m.occurred_at', dated: true },
  temperature_logs: { perm: 'reports.view', sql: (u) => `SELECT t.recorded_at, s.name AS site, m.code AS machine, t.location_label, t.reading, t.min_allowed, t.max_allowed, t.in_range, t.action_taken, us.name AS staff FROM temperature_logs t LEFT JOIN sites s ON s.id = t.site_id LEFT JOIN machines m ON m.id = t.machine_id LEFT JOIN users us ON us.id = t.user_id WHERE ${access.siteFilter(u, 't.site_id')} AND date(t.recorded_at) BETWEEN ? AND ? ORDER BY t.recorded_at`, dated: true },
  attendance: { perm: 'attendance.view', sql: (u) => `SELECT u.name, s.name AS site, a.clock_in, a.clock_out, a.late_minutes FROM attendance a JOIN users u ON u.id = a.user_id LEFT JOIN sites s ON s.id = a.site_id WHERE ${access.siteFilter(u, 'a.site_id')} AND date(a.clock_in) BETWEEN ? AND ? ORDER BY a.clock_in`, dated: true },
  transactions: { perm: 'finance.view', sql: () => 'SELECT t.txn_date, t.kind, c.parent, c.name AS category, s.name AS site, v.name AS vendor, t.amount, t.description, t.reference, t.status FROM transactions t LEFT JOIN finance_categories c ON c.id = t.category_id LEFT JOIN sites s ON s.id = t.site_id LEFT JOIN vendors v ON v.id = t.vendor_id WHERE t.txn_date BETWEEN ? AND ? ORDER BY t.txn_date', dated: true },
  customer_cases: { perm: 'cases.manage', sql: (u) => `SELECT c.ref, c.created_at, s.name AS site, c.category, c.channel, c.rating, c.status, c.description, c.outcome FROM customer_cases c LEFT JOIN sites s ON s.id = c.site_id WHERE (c.site_id IS NULL OR ${access.siteFilter(u, 'c.site_id')}) AND date(c.created_at) BETWEEN ? AND ? ORDER BY c.created_at`, dated: true },
  payroll: { perm: 'payroll.manage', sql: () => "SELECT r.month, u.staff_no, u.name, i.pay_type, i.scheduled_days, i.worked_days, i.absent_days, i.leave_days, i.late_minutes, i.overtime_hours, i.base_pay, i.allowances, i.overtime_pay, i.absence_deduction, i.late_deduction, i.ssnit, i.other_deductions, i.gross, i.net, u.bank_details FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id JOIN users u ON u.id = i.user_id WHERE r.month BETWEEN substr(?,1,7) AND substr(?,1,7) ORDER BY r.month, u.name", dated: true },
  security_log: { perm: 'audit.view', sql: () => 'SELECT l.created_at, u.name AS user, l.event, l.identifier, l.details, l.ip FROM security_log l LEFT JOIN users u ON u.id = l.user_id WHERE date(l.created_at) BETWEEN ? AND ? ORDER BY l.created_at', dated: true },
  audit_log: { perm: 'audit.view', sql: () => 'SELECT a.created_at, u.name AS user, a.action, a.entity, a.entity_id, a.details, a.ip FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE date(a.created_at) BETWEEN ? AND ? ORDER BY a.created_at', dated: true },
};
const csvCell = (v) => { if (v == null) return ''; let s = String(v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

r.get('/reports/export/:type', (req, res, next) => {
  const ex = EXPORTS[req.params.type];
  if (!ex) return next();
  if (!access.can(req.user, ex.perm)) { const e = new Error('Not allowed'); e.status = 403; return next(e); }
  const from = req.query.from || addDays(today(), -90); const to = req.query.to || today();
  const rows = db.all(ex.sql(req.user), from, to);
  const cols = rows.length ? Object.keys(rows[0]) : ['no_data'];
  const csv = [cols.join(','), ...rows.map((r0) => cols.map((c) => csvCell(r0[c])).join(','))].join('\n');
  audit(req, 'export', req.params.type, null, { from, to, rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="swaggers-${req.params.type}-${from}-to-${to}.csv"`);
  res.send('﻿' + csv);
});

module.exports = r;
