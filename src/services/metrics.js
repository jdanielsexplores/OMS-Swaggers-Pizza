// KPI queries for dashboards and reports.
const db = require('../db');
const { addDays, today } = require('../lib/util');
const { OPEN_STATUSES } = require('./incidents');

const inList = (ids) => (ids && ids.length ? `IN (${ids.map(Number).join(',')})` : 'IN (0)');
const OPEN = `(${OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`;

function sales(siteIds, from, to) {
  return db.get(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(qty),0) AS units, COALESCE(SUM(amount),0) AS revenue,
           COALESCE(SUM(CASE WHEN payment_status='confirmed' AND dispense_status!='dispensed' THEN 1 ELSE 0 END),0) AS paid_not_dispensed,
           COALESCE(SUM(CASE WHEN payment_status IN ('failed','pending') THEN 1 ELSE 0 END),0) AS payment_failures
    FROM sales WHERE site_id ${inList(siteIds)} AND date(sold_at) BETWEEN ? AND ? AND payment_status != 'refunded'`, from, to);
}

function salesByDay(siteIds, from, to) {
  return db.all(`SELECT date(sold_at) AS day, COALESCE(SUM(amount),0) AS revenue, COALESCE(SUM(qty),0) AS units
    FROM sales WHERE site_id ${inList(siteIds)} AND date(sold_at) BETWEEN ? AND ? AND payment_status = 'confirmed'
    GROUP BY day ORDER BY day`, from, to);
}
function salesBySite(siteIds, from, to) {
  return db.all(`SELECT s.id, s.name, s.type, COALESCE(SUM(x.amount),0) AS revenue, COALESCE(SUM(x.qty),0) AS units, COUNT(x.id) AS orders
    FROM sites s LEFT JOIN sales x ON x.site_id = s.id AND date(x.sold_at) BETWEEN ? AND ? AND x.payment_status = 'confirmed'
    WHERE s.id ${inList(siteIds)} GROUP BY s.id ORDER BY revenue DESC`, from, to);
}
function salesByProduct(siteIds, from, to) {
  return db.all(`SELECT p.id, p.name, p.colour, p.image, COALESCE(SUM(x.qty),0) AS units, COALESCE(SUM(x.amount),0) AS revenue,
      COALESCE(SUM(x.qty * p.unit_cost),0) AS cogs
    FROM products p LEFT JOIN sales x ON x.product_id = p.id AND x.site_id ${inList(siteIds)} AND date(x.sold_at) BETWEEN ? AND ? AND x.payment_status = 'confirmed'
    WHERE p.category = 'pizza' AND p.active = 1 GROUP BY p.id ORDER BY units DESC`, from, to);
}
function salesByMachine(siteIds, from, to) {
  return db.all(`SELECT m.id, m.code, s.name AS site_name, m.status, COALESCE(SUM(x.amount),0) AS revenue, COALESCE(SUM(x.qty),0) AS units
    FROM machines m JOIN sites s ON s.id = m.site_id
    LEFT JOIN sales x ON x.machine_id = m.id AND date(x.sold_at) BETWEEN ? AND ? AND x.payment_status = 'confirmed'
    WHERE m.site_id ${inList(siteIds)} AND m.status != 'decommissioned' GROUP BY m.id ORDER BY revenue DESC`, from, to);
}
function salesByHour(siteIds, from, to) {
  return db.all(`SELECT CAST(strftime('%H', sold_at) AS INTEGER) AS hour, COALESCE(SUM(qty),0) AS units
    FROM sales WHERE site_id ${inList(siteIds)} AND date(sold_at) BETWEEN ? AND ? AND payment_status='confirmed' GROUP BY hour ORDER BY hour`, from, to);
}

function waste(siteIds, from, to) {
  return db.all(`SELECT COALESCE(l.site_id, 0) AS site_id, COALESCE(s.name, 'Central store') AS site_name,
      COALESCE(SUM(m.qty),0) AS units, COALESCE(SUM(m.qty * COALESCE(m.unit_cost,0)),0) AS cost
    FROM stock_movements m LEFT JOIN stock_locations l ON l.id = m.from_location_id LEFT JOIN sites s ON s.id = l.site_id
    WHERE m.kind = 'waste' AND date(m.occurred_at) BETWEEN ? AND ? AND (l.site_id IS NULL OR l.site_id ${inList(siteIds)})
    GROUP BY l.site_id ORDER BY units DESC`, from, to);
}
function wasteByReason(siteIds, from, to) {
  return db.all(`SELECT COALESCE(m.reason,'other') AS reason, SUM(m.qty) AS units, SUM(m.qty*COALESCE(m.unit_cost,0)) AS cost
    FROM stock_movements m LEFT JOIN stock_locations l ON l.id = m.from_location_id
    WHERE m.kind='waste' AND date(m.occurred_at) BETWEEN ? AND ? AND (l.site_id IS NULL OR l.site_id ${inList(siteIds)})
    GROUP BY reason ORDER BY units DESC`, from, to);
}

function checklistCompliance(siteIds, from, to) {
  // Expected = daily templates × active sites × days; done = submitted runs.
  const rows = db.all(`SELECT s.id, s.name,
      (SELECT COUNT(*) FROM checklist_runs r WHERE r.site_id = s.id AND r.run_date BETWEEN ? AND ? AND r.status IN ('submitted','reviewed')) AS done,
      (SELECT COUNT(*) FROM checklist_templates t WHERE t.active = 1 AND t.frequency = 'daily' AND (t.site_type IS NULL OR t.site_type = s.type)) AS per_day,
      (SELECT ROUND(AVG(score),1) FROM checklist_runs r WHERE r.site_id = s.id AND r.run_date BETWEEN ? AND ? AND r.status IN ('submitted','reviewed')) AS avg_score
    FROM sites s WHERE s.id ${inList(siteIds)} AND s.status = 'active' ORDER BY s.name`, from, to, from, to);
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  return rows.map((r) => {
    const expectedDaily = r.per_day * days;
    const doneDaily = db.val(`SELECT COUNT(*) FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id
      WHERE r.site_id = ? AND t.frequency = 'daily' AND r.run_date BETWEEN ? AND ? AND r.status IN ('submitted','reviewed')`, r.id, from, to);
    return { ...r, expected: expectedDaily, compliance: expectedDaily ? Math.min(100, (doneDaily / expectedDaily) * 100) : null };
  });
}

function incidentsSummary(siteIds) {
  return db.get(`SELECT
      SUM(CASE WHEN status IN ${OPEN} THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status IN ${OPEN} AND severity='critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN status IN ${OPEN} AND due_at < datetime('now') THEN 1 ELSE 0 END) AS overdue,
      AVG(CASE WHEN resolved_at IS NOT NULL AND created_at >= datetime('now','-30 days') THEN (julianday(resolved_at)-julianday(created_at))*1440 END) AS avg_resolve_mins,
      AVG(CASE WHEN acknowledged_at IS NOT NULL AND created_at >= datetime('now','-30 days') THEN (julianday(acknowledged_at)-julianday(created_at))*1440 END) AS avg_ack_mins
    FROM incidents WHERE (site_id IS NULL OR site_id ${inList(siteIds)})`);
}

// Uptime % per machine over N days, computed from the status log.
function uptime(siteIds, days = 7) {
  const since = `datetime('now','-${Number(days)} days')`;
  return db.all(`SELECT m.id, m.code, s.name AS site_name, m.status,
      COALESCE((SELECT SUM((julianday(COALESCE(l.ended_at, datetime('now'))) - julianday(MAX(l.started_at, ${since})))*1440)
        FROM machine_status_log l WHERE l.machine_id = m.id AND l.status IN ('offline','maintenance')
        AND COALESCE(l.ended_at, datetime('now')) > ${since}), 0) AS down_mins,
      (SELECT COUNT(*) FROM incidents i WHERE i.machine_id = m.id AND i.type='machine' AND i.created_at >= datetime('now','-30 days')) AS faults_30d
    FROM machines m JOIN sites s ON s.id = m.site_id WHERE m.site_id ${inList(siteIds)} AND m.status != 'decommissioned' ORDER BY s.name, m.code`)
    .map((r) => ({ ...r, uptime: Math.max(0, 100 - (r.down_mins / (days * 1440)) * 100) }));
}

function lowStock(siteIds) {
  const stock = require('./stock');
  return stock.balances().filter((b) => b.kind === 'machine' && siteIds.includes(b.site_id) && b.qty <= b.reorder_level);
}

function expiring(hours = 24) {
  return db.all(`SELECT b.*, p.name AS product_name FROM batches b JOIN products p ON p.id = b.product_id
    WHERE b.status = 'released' AND b.expires_at IS NOT NULL AND b.expires_at <= datetime('now', '+${Number(hours)} hours')
    AND (SELECT COALESCE(SUM(CASE WHEN to_location_id IS NOT NULL THEN qty ELSE 0 END) - SUM(CASE WHEN from_location_id IS NOT NULL THEN qty ELSE 0 END),0)
         FROM stock_movements WHERE batch_id = b.id) > 0
    ORDER BY b.expires_at`);
}

function finance(siteIds, from, to) {
  const salesRev = db.val(`SELECT COALESCE(SUM(amount),0) FROM sales WHERE site_id ${inList(siteIds)} AND date(sold_at) BETWEEN ? AND ? AND payment_status='confirmed'`, from, to);
  const cogs = db.val(`SELECT COALESCE(SUM(x.qty * p.unit_cost),0) FROM sales x JOIN products p ON p.id = x.product_id WHERE x.site_id ${inList(siteIds)} AND date(x.sold_at) BETWEEN ? AND ? AND x.payment_status='confirmed'`, from, to);
  const otherIncome = db.val(`SELECT COALESCE(SUM(amount),0) FROM transactions WHERE kind='income' AND status='approved' AND txn_date BETWEEN ? AND ? AND (site_id IS NULL OR site_id ${inList(siteIds)})`, from, to);
  // Stock purchases (Ingredients / Packaging) are inventory: they reach the P&L as cost of goods when sold,
  // so they are excluded here to avoid counting them twice.
  const expFilter = `kind='expense' AND status='approved' AND txn_date BETWEEN ? AND ? AND (site_id IS NULL OR site_id ${inList(siteIds)})`;
  const INVENTORY = "(SELECT id FROM finance_categories WHERE name IN ('Ingredients','Packaging'))";
  const expenses = db.val(`SELECT COALESCE(SUM(amount),0) FROM transactions WHERE ${expFilter} AND (category_id IS NULL OR category_id NOT IN ${INVENTORY})`, from, to);
  const stockPurchases = db.val(`SELECT COALESCE(SUM(amount),0) FROM transactions WHERE ${expFilter} AND category_id IN ${INVENTORY}`, from, to);
  const wasteCost = waste(siteIds, from, to).reduce((a, r) => a + r.cost, 0);
  const refunds = db.val(`SELECT COALESCE(SUM(amount),0) FROM refunds WHERE status='paid' AND date(paid_at) BETWEEN ? AND ?`, from, to);
  const gross = salesRev - cogs;
  const net = salesRev + otherIncome - cogs - expenses - refunds;
  return { salesRev, cogs, otherIncome, expenses, stockPurchases, wasteCost, refunds, gross, net, margin: salesRev ? (net / salesRev) * 100 : null };
}

function staffScorecard(siteIds, from, to) {
  return db.all(`SELECT u.id, u.name, u.role,
      (SELECT COUNT(*) FROM shifts s WHERE s.user_id = u.id AND s.shift_date BETWEEN ? AND ? AND s.status != 'cancelled') AS shifts,
      (SELECT COUNT(*) FROM attendance a WHERE a.user_id = u.id AND date(a.clock_in) BETWEEN ? AND ?) AS attended,
      (SELECT COALESCE(SUM(late_minutes),0) FROM attendance a WHERE a.user_id = u.id AND date(a.clock_in) BETWEEN ? AND ?) AS late_mins,
      (SELECT COUNT(*) FROM checklist_runs r WHERE r.user_id = u.id AND r.run_date BETWEEN ? AND ? AND r.status IN ('submitted','reviewed')) AS checklists,
      (SELECT ROUND(AVG(score),0) FROM checklist_runs r WHERE r.user_id = u.id AND r.run_date BETWEEN ? AND ? AND r.status IN ('submitted','reviewed')) AS avg_score,
      (SELECT COUNT(*) FROM checklist_runs r WHERE r.user_id = u.id AND r.status = 'rejected' AND r.run_date BETWEEN ? AND ?) AS rejected,
      (SELECT COUNT(*) FROM incidents i WHERE i.reported_by = u.id AND date(i.created_at) BETWEEN ? AND ?) AS reports,
      (SELECT COUNT(*) FROM tasks t WHERE t.assigned_to = u.id AND t.status IN ('done','verified') AND date(t.completed_at) BETWEEN ? AND ?) AS tasks_done,
      (SELECT COUNT(*) FROM tasks t WHERE t.assigned_to = u.id AND t.status IN ('open','in_progress') AND t.due_at < datetime('now')) AS tasks_overdue,
      (SELECT COUNT(*) FROM training_records tr WHERE tr.user_id = u.id AND tr.quiz_passed = 1) AS modules_passed
    FROM users u WHERE u.active = 1 AND u.role NOT IN ('owner')
      AND (u.role IN ('ops_manager','accounts') OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id ${inList(siteIds)}))
    ORDER BY u.name`, ...Array(8).fill([from, to]).flat())
    .map((r) => {
      const attendance = r.shifts ? Math.min(100, (r.attended / r.shifts) * 100) : null;
      const parts = [attendance, r.avg_score].filter((x) => x != null);
      let score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
      if (score != null) score = Math.max(0, score - r.tasks_overdue * 5 - r.rejected * 5 - Math.min(20, r.late_mins / 15));
      return { ...r, attendance, score };
    });
}

const range = (days) => ({ from: addDays(today(), -(days - 1)), to: today() });

module.exports = { sales, salesByDay, salesBySite, salesByProduct, salesByMachine, salesByHour, waste, wasteByReason, checklistCompliance, incidentsSummary, uptime, lowStock, expiring, finance, staffScorecard, range };
