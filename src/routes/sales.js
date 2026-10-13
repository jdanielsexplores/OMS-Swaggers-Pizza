const express = require('express');
const fs = require('node:fs');
const db = require('../db');
const access = require('../services/access');
const stock = require('../services/stock');
const metrics = require('../services/metrics');
const approvals = require('../services/approvals');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { requirePerm, fileFor } = require('../middleware');
const { today, addDays, toNum, sqlNow, makeRef } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();
const pizzas = () => db.all("SELECT * FROM products WHERE active = 1 AND category = 'pizza' ORDER BY name");

// Records a sale and removes the units from the machine's stock (FEFO).
function recordSale(s, userId) {
  const id = db.insert('sales', { ...s, recorded_by: userId });
  if (s.product_id && s.payment_status === 'confirmed' && s.dispense_status !== 'failed') {
    const loc = stock.machineLocation(s.machine_id);
    stock.consume({ location_id: loc.id, product_id: s.product_id, qty: s.qty || 1, kind: 'sale', reference: s.order_ref || `SALE-${id}`, user_id: userId, occurred_at: s.sold_at });
  }
  return id;
}

// The supplier's machine portal is the live source of sales. This module records each machine's daily figures
// from that portal (with a screenshot as evidence), reconciles them with Mobile Money settlements, and feeds
// the dashboards, finance and stock.
const cashupSql = (user) => `SELECT c.*, m.code AS machine_code, m.supplier_device_no, s.name AS site_name, sb.name AS submitted_name, vb.name AS verified_name
  FROM daily_closeouts c JOIN machines m ON m.id = c.machine_id JOIN sites s ON s.id = c.site_id LEFT JOIN users sb ON sb.id = c.submitted_by LEFT JOIN users vb ON vb.id = c.verified_by
  WHERE ${access.siteFilter(user, 'c.site_id')}`;
const tol = () => ({ amt: Number(db.setting('variance_tolerance_amount', '20')), pct: Number(db.setting('variance_tolerance_pct', '2')) });
const isBig = (c) => { const t = tol(); return c.variance != null && Math.abs(c.variance) > t.amt && Math.abs(c.variance) > ((c.machine_reported_amount || 0) * t.pct) / 100; };

r.get('/sales', requirePerm('sales.view'), (req, res) => {
  const ids = access.siteIds(req.user);
  const from = req.query.from || addDays(today(), -13);
  const to = req.query.to || today();
  const site = toNum(req.query.site);
  const scope = site && ids.includes(site) ? [site] : ids;
  const inScope = `c.site_id IN (${scope.map(Number).join(',') || 0})`;
  const cf = filters(req.query, {
    machine: F.eq('c.machine_id'),
    verified: (v) => (v === 'yes' ? ['c.verified_at IS NOT NULL'] : v === 'no' ? ['c.verified_at IS NULL'] : null),
    variance: (v) => (v === 'big' ? [`ABS(COALESCE(c.variance,0)) > ${Number(db.setting('variance_tolerance_amount', '20'))}`] : null),
    status: F.eq('c.machine_status'),
  });
  const cp = paginate(req, `${cashupSql(req.user)} AND ${inScope} AND c.business_date BETWEEN ? AND ? AND ${cf.where} ORDER BY c.business_date DESC, s.name`, [from, to, ...cf.params], { perPage: 15 });
  const rows = cp.rows;
  const totals = db.get(`SELECT COALESCE(SUM(machine_reported_amount),0) income, COALESCE(SUM(machine_reported_orders),0) orders, COALESCE(SUM(provider_settled_amount),0) settled,
      COALESCE(SUM(CASE WHEN provider_settled_amount IS NOT NULL THEN variance END),0) variance, SUM(verified_at IS NULL) unverified, COUNT(*) n FROM daily_closeouts c WHERE ${inScope} AND business_date BETWEEN ? AND ?`, from, to);
  const machines = access.machinesFor(req.user).filter((m) => scope.includes(m.site_id) && m.status !== 'maintenance');
  const yesterday = addDays(today(), -1);
  const missing = machines.filter((m) => !db.get('SELECT 1 FROM daily_closeouts WHERE machine_id = ? AND business_date = ?', m.id, yesterday));
  res.page('sales', 'Sales & Cash-up', {
    rows, cp, cf: cf.f, machines: access.machinesFor(req.user), from, to, site, sites: access.sitesFor(req.user), totals, missing, yesterday,
    trend: db.all(`SELECT business_date day, SUM(machine_reported_amount) revenue, SUM(machine_reported_orders) orders FROM daily_closeouts c WHERE ${inScope} AND business_date BETWEEN ? AND ? GROUP BY day ORDER BY day`, from, to),
    byMachine: db.all(`SELECT m.code, m.id, s.name site_name, COALESCE(SUM(c.machine_reported_amount),0) revenue, COALESCE(SUM(c.machine_reported_orders),0) orders FROM machines m JOIN sites s ON s.id = m.site_id LEFT JOIN daily_closeouts c ON c.machine_id = m.id AND c.business_date BETWEEN ? AND ? WHERE m.site_id IN (${scope.map(Number).join(',') || 0}) AND m.status != 'decommissioned' GROUP BY m.id ORDER BY revenue DESC`, from, to),
    byProduct: metrics.salesByProduct(scope, from, to),
    openPE: db.val(`SELECT COUNT(*) FROM payment_exceptions WHERE status IN ('open','investigating') AND ${access.siteFilter(req.user, 'site_id')}`),
    isBig, tol: tol(),
  });
});

r.get('/sales/cashup', requirePerm('sales.record'), (req, res) => {
  const machines = access.machinesFor(req.user);
  const machineId = toNum(req.query.machine) || machines[0]?.id;
  const date = req.query.date || today();
  const m = machines.find((x) => x.id === machineId);
  const existing = m ? db.get('SELECT * FROM daily_closeouts WHERE machine_id = ? AND business_date = ?', m.id, date) : null;
  res.page('cashup', 'Daily cash-up', { machines, m, date, existing, counts: existing?.flavour_counts ? JSON.parse(existing.flavour_counts) : {}, products: pizzas(), canSettle: access.can(req.user, 'payments.manage') });
});

r.post('/sales/cashup', requirePerm('sales.record'), (req, res) => {
  const b = req.body;
  const m = db.get('SELECT * FROM machines WHERE id = ?', b.machine_id);
  if (!m || !access.canSite(req.user, m.site_id)) return res.back('/sales');
  const date = b.business_date || today();
  if (date > today()) { req.flash('error', 'You cannot cash up a future date.'); return res.back('/sales/cashup'); }
  const income = toNum(b.machine_reported_amount);
  if (income == null) { req.flash('error', "Enter the machine's income from the supplier portal."); return res.back('/sales/cashup'); }
  const existing = db.get('SELECT * FROM daily_closeouts WHERE machine_id = ? AND business_date = ?', m.id, date);
  if (existing?.verified_at && !access.can(req.user, 'payments.manage')) { req.flash('error', 'This cash-up is already verified by Accounts.'); return res.back('/sales'); }
  const counts = {};
  for (const p of pizzas()) { const q = toNum(b[`qty_${p.id}`]); if (q > 0) counts[p.id] = q; }
  const settled = access.can(req.user, 'payments.manage') ? toNum(b.provider_settled_amount) : existing?.provider_settled_amount ?? null;
  const evidence = fileFor(req, 'evidence') || existing?.evidence || null;
  const data = {
    site_id: m.site_id, machine_id: m.id, business_date: date,
    machine_reported_orders: toNum(b.machine_reported_orders), machine_reported_amount: income,
    provider_settled_amount: settled, system_orders: toNum(b.machine_reported_orders), system_amount: income,
    variance: settled == null ? null : settled - income, notes: b.notes || existing?.notes || null,
    evidence, machine_status: b.machine_status || null, flavour_counts: Object.keys(counts).length ? JSON.stringify(counts) : null,
  };
  db.tx(() => {
    if (existing) db.update('daily_closeouts', existing.id, { ...data, verified_by: null, verified_at: null });
    else db.insert('daily_closeouts', { ...data, submitted_by: req.user.id });
    // Rebuild this day's sales rows for the machine so dashboards, finance and flavour reports stay in step.
    const ref = `CASHUP-${m.id}-${date}`;
    db.run("DELETE FROM sales WHERE machine_id = ? AND date(sold_at) = ? AND source = 'supplier_portal'", m.id, date);
    db.run("DELETE FROM stock_movements WHERE reference = ? AND kind = 'sale'", ref);
    const loc = stock.machineLocation(m.id);
    let counted = 0;
    for (const p of pizzas()) {
      const q = counts[p.id]; if (!q) continue;
      const amt = Math.round(q * p.price * 100) / 100; counted += amt;
      db.insert('sales', { machine_id: m.id, site_id: m.site_id, product_id: p.id, qty: q, unit_price: p.price, amount: amt, payment_method: 'momo', payment_status: 'confirmed', dispense_status: 'dispensed', source: 'supplier_portal', sold_at: `${date} 21:00:00`, order_ref: ref, recorded_by: req.user.id });
      stock.consume({ location_id: loc.id, product_id: p.id, qty: q, kind: 'sale', reference: ref, user_id: req.user.id, occurred_at: `${date} 21:00:00` });
    }
    const rest = Math.round((income - counted) * 100) / 100;
    if (rest > 0.009 || !Object.keys(counts).length) db.insert('sales', { machine_id: m.id, site_id: m.site_id, product_id: null, qty: Object.keys(counts).length ? 0 : (toNum(b.machine_reported_orders) || 0), amount: Math.max(0, rest), payment_method: 'momo', payment_status: 'confirmed', dispense_status: 'dispensed', source: 'supplier_portal', sold_at: `${date} 21:00:00`, order_ref: ref, recorded_by: req.user.id });
  });
  if (b.machine_status === 'offline' && m.status === 'online') notify({ roles: ['ops_manager', 'technician'], siteId: m.site_id }, { level: 'warning', title: `${m.code} shows OFFLINE in the machine portal`, body: 'Reported during cash-up. Check the machine or raise a fault.', link: `/machines/${m.id}` });
  const saved = db.get('SELECT * FROM daily_closeouts WHERE machine_id = ? AND business_date = ?', m.id, date);
  if (isBig(saved)) notify({ roles: ['accounts', 'ops_manager'] }, { level: 'warning', title: `Cash-up variance GH₵${saved.variance.toFixed(2)} on ${m.code} (${date})`, link: '/sales' });
  audit(req, 'cashup.saved', 'machines', m.id, { date, income, settled, counts });
  req.flash('success', `Cash-up saved for ${m.code} on ${date}: GH₵${income.toFixed(2)}${settled != null ? `, settled GH₵${settled.toFixed(2)}` : ''}.`);
  res.redirect('/sales');
});

r.post('/sales/closeouts/:id/verify', requirePerm('payments.manage'), (req, res) => {
  const c = db.get('SELECT * FROM daily_closeouts WHERE id = ?', req.params.id);
  if (c.provider_settled_amount == null && toNum(req.body.provider_settled_amount) == null) { req.flash('error', 'Enter the Mobile Money settled amount before verifying.'); return res.back('/sales'); }
  const settled = toNum(req.body.provider_settled_amount) ?? c.provider_settled_amount;
  const next = { ...c, provider_settled_amount: settled, variance: settled - (c.machine_reported_amount || 0) };
  if (isBig(next) && !req.body.notes && !c.notes) { req.flash('error', 'Explain the variance (and link payment exceptions) before verifying.'); return res.back('/sales'); }
  db.update('daily_closeouts', c.id, { provider_settled_amount: settled, variance: next.variance, verified_by: req.user.id, verified_at: sqlNow(), notes: req.body.notes || c.notes });
  audit(req, 'cashup.verified', 'daily_closeouts', c.id);
  req.flash('success', 'Cash-up verified.');
  res.back('/sales');
});

// Old URLs → new cash-up screen.
r.get(['/sales/entry', '/sales/closeouts'], (req, res) => res.redirect('/sales/cashup'));

// Optional: import an order export (CSV) downloaded from the supplier portal's Order Management.
r.get('/sales/import', requirePerm('sales.record'), (req, res) => res.page('sales-import', 'Import supplier orders'));
r.post('/sales/import', requirePerm('sales.record'), (req, res) => {
  const file = req.files?.find((f) => f.fieldname === 'file');
  if (!file) { req.flash('error', 'Choose a CSV file.'); return res.back(); }
  const text = fs.readFileSync(file.path, 'utf8'); fs.unlinkSync(file.path);
  const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
  const head = lines.shift().split(',').map((h) => h.trim().toLowerCase());
  const col = (row, k) => row[head.indexOf(k)]?.trim();
  const machines = Object.fromEntries(db.all('SELECT * FROM machines').flatMap((m) => [[m.code, m], ...(m.supplier_device_no ? [[m.supplier_device_no, m]] : [])]));
  const products = Object.fromEntries(db.all('SELECT * FROM products').flatMap((p) => [[p.sku, p], [p.name.toLowerCase(), p]]));
  let ok = 0; const errors = [];
  db.tx(() => {
    lines.forEach((line, i) => {
      const row = line.split(',');
      const m = machines[col(row, 'machine_code') || col(row, 'device')]; const p = products[col(row, 'sku')] || products[(col(row, 'product') || '').toLowerCase()];
      if (!m || !access.canSite(req.user, m.site_id)) { errors.push(`Row ${i + 2}: unknown machine`); return; }
      const ref = col(row, 'order_ref') || col(row, 'payment_ref');
      if (ref && db.get('SELECT 1 FROM sales WHERE machine_id = ? AND (order_ref = ? OR payment_ref = ?)', m.id, ref, ref)) { errors.push(`Row ${i + 2}: duplicate ${ref} skipped`); return; }
      const qty = toNum(col(row, 'qty')) || 1;
      recordSale({ machine_id: m.id, site_id: m.site_id, product_id: p?.id, qty, unit_price: p?.price, amount: toNum(col(row, 'amount')) ?? qty * (p?.price || 0), payment_method: 'momo', payment_ref: col(row, 'payment_ref'), payment_status: col(row, 'payment_status') || 'confirmed', dispense_status: col(row, 'dispense_status') || 'dispensed', source: 'import', sold_at: (col(row, 'sold_at') || sqlNow()).replace('T', ' ').slice(0, 19), order_ref: col(row, 'order_ref') }, req.user.id);
      ok++;
    });
  });
  audit(req, 'sales.imported', 'sales', null, { ok, errors: errors.length });
  req.flash(errors.length ? 'warning' : 'success', `Imported ${ok} order(s).${errors.length ? ` ${errors.length} skipped: ${errors.slice(0, 5).join('; ')}` : ''}`);
  res.redirect('/sales');
});

// ── Payment exceptions (SOP-03) ──
r.get('/payments', (req, res) => {
  const status = req.query.status || 'open';
  const { where, params, f } = filters(req.query, {
    kind: F.eq('pe.kind'), machine: F.eq('pe.machine_id'), from: F.dateFrom('pe.created_at'), to: F.dateTo('pe.created_at'),
    q: F.search('pe.payment_ref', 'pe.order_ref', 'pe.customer_phone_last4', 'pe.resolution'),
  }, [access.siteFilter(req.user, 'pe.site_id'), status === 'open' ? "pe.status IN ('open','investigating')" : status === 'all' ? '1=1' : `pe.status = '${['matched', 'refunded', 'rejected', 'closed', 'investigating'].includes(status) ? status : 'open'}'`]);
  const p = paginate(req, `SELECT pe.*, s.name AS site_name, m.code AS machine_code, u.name AS reporter, c.ref AS case_ref FROM payment_exceptions pe LEFT JOIN sites s ON s.id = pe.site_id LEFT JOIN machines m ON m.id = pe.machine_id LEFT JOIN users u ON u.id = pe.reported_by LEFT JOIN customer_cases c ON c.id = pe.case_id
    WHERE ${where} ORDER BY pe.created_at DESC`, params, { perPage: 15 });
  res.page('payments', 'Payment exceptions', { p, rows: p.rows, status, f, machines: access.machinesFor(req.user) });
});
r.post('/payments', (req, res) => {
  const m = db.get('SELECT * FROM machines WHERE id = ?', req.body.machine_id);
  if (!m || !access.canSite(req.user, m.site_id)) return res.back();
  const id = db.insert('payment_exceptions', { site_id: m.site_id, machine_id: m.id, kind: req.body.kind, amount: toNum(req.body.amount), payment_ref: req.body.payment_ref || null, order_ref: req.body.order_ref || null, customer_phone_last4: String(req.body.phone_last4 || '').replace(/\D/g, '').slice(-4) || null, occurred_at: (req.body.occurred_at || sqlNow()).replace('T', ' '), reported_by: req.user.id });
  notify({ roles: ['accounts', 'supervisor'], siteId: m.site_id, except: req.user.id }, { level: 'warning', title: `Payment exception: ${req.body.kind.replace(/_/g, ' ')} ${req.body.amount ? 'GH₵' + req.body.amount : ''}`, body: `${m.code} · ref ${req.body.payment_ref || '—'}`, link: '/payments' });
  audit(req, 'payment_exception.created', 'payment_exceptions', id);
  req.flash('success', 'Recorded. Accounts will reconcile within 1 business day. Tell the customer they will get an update within 48 hours — do not ask them to pay again.');
  res.redirect('/payments');
});
r.post('/payments/:id', requirePerm('payments.manage'), (req, res) => {
  const pe = db.get('SELECT * FROM payment_exceptions WHERE id = ?', req.params.id);
  const status = req.body.status;
  db.update('payment_exceptions', pe.id, { status, resolution: req.body.resolution || pe.resolution, resolved_by: ['matched', 'refunded', 'rejected', 'closed'].includes(status) ? req.user.id : null, resolved_at: ['matched', 'refunded', 'rejected', 'closed'].includes(status) ? sqlNow() : null });
  if (req.body.request_refund && pe.amount) {
    let caseId = pe.case_id;
    if (!caseId) {
      caseId = db.insert('customer_cases', { ref: makeRef('CS'), site_id: pe.site_id, machine_id: pe.machine_id, category: 'payment', channel: 'in_person', customer_name: pe.customer_phone_last4 ? `Customer (ends ${pe.customer_phone_last4})` : null, payment_ref: pe.payment_ref, description: `Payment exception: ${pe.kind.replace(/_/g, ' ')}`, status: 'awaiting_refund', created_by: req.user.id });
      db.update('payment_exceptions', pe.id, { case_id: caseId });
    }
    const rf = db.insert('refunds', { case_id: caseId, payment_exception_id: pe.id, amount: pe.amount, reason: req.body.resolution || pe.kind, requested_by: req.user.id });
    const limit = Number(db.setting('refund_manager_limit', '100'));
    approvals.request({ kind: 'refund', title: `Refund GH₵${pe.amount} — ${pe.kind.replace(/_/g, ' ')} (ref ${pe.payment_ref || '—'})`, amount: pe.amount, entity: 'refunds', entity_id: rf, required_role: pe.amount > limit ? 'owner' : 'ops_manager' }, req.user);
    req.flash('success', 'Refund request sent for approval.');
  }
  audit(req, 'payment_exception.updated', 'payment_exceptions', pe.id, req.body);
  res.redirect('/payments');
});

module.exports = r;
