const express = require('express');
const db = require('../db');
const access = require('../services/access');
const stock = require('../services/stock');
const metrics = require('../services/metrics');
const incidents = require('../services/incidents');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { requirePerm } = require('../middleware');
const { today, addDays, toNum, sqlNow } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();
const pizzas = () => db.all("SELECT * FROM products WHERE active = 1 AND category = 'pizza' ORDER BY name");
const myLocations = (user) => stock.locationsFor(access.siteIds(user));
const guardLoc = (user, locId) => {
  const loc = db.get('SELECT * FROM stock_locations WHERE id = ?', locId);
  if (!loc || (loc.site_id && !access.canSite(user, loc.site_id))) { const e = new Error('Not your stock location'); e.status = 403; throw e; }
  return loc;
};

r.get('/stock', (req, res) => {
  const ids = access.siteIds(req.user);
  const locs = myLocations(req.user);
  const bal = stock.balances().filter((b) => locs.some((l) => l.id === b.location_id));
  const { from, to } = metrics.range(7);
  res.page('stock', 'Stock & Food Safety', {
    locs, bal, products: pizzas(),
    low: metrics.lowStock(ids),
    expiring: metrics.expiring(72),
    waste: metrics.wasteByReason(ids, from, to),
    soldWeek: metrics.sales(ids, from, to).units,
    held: db.all("SELECT b.*, p.name AS product_name FROM batches b JOIN products p ON p.id = b.product_id WHERE b.status IN ('on_hold','recalled')"),
    temps: db.all(`SELECT t.*, s.name AS site_name, u.name AS user_name FROM temperature_logs t LEFT JOIN sites s ON s.id = t.site_id LEFT JOIN users u ON u.id = t.user_id WHERE ${access.siteFilter(req.user, 't.site_id')} ORDER BY t.recorded_at DESC LIMIT 8`),
    restock: db.val(`SELECT COUNT(*) FROM restock_requests WHERE status IN ('requested','approved','dispatched') AND ${access.siteFilter(req.user, 'site_id')}`),
  });
});

// ── Receive ──
r.get('/stock/receive', requirePerm('stock.manage'), (req, res) => {
  res.page('stock-receive', 'Receive stock', { products: pizzas(), suppliers: db.all("SELECT * FROM vendors WHERE category IN ('food_supplier','packaging','logistics') ORDER BY name"), locs: myLocations(req.user).filter((l) => l.kind !== 'machine'), range: { min: db.setting('temp_min'), max: db.setting('temp_max') } });
});
r.post('/stock/receive', requirePerm('stock.manage'), (req, res) => {
  const b = req.body;
  const loc = guardLoc(req.user, b.location_id);
  const temp = toNum(b.delivery_temp);
  const tmin = Number(db.setting('temp_min', '-18')); const tmax = Number(db.setting('temp_max', '5'));
  const tempBad = temp != null && (temp < tmin || temp > tmax);
  let received = 0; let rejected = 0;
  db.tx(() => {
    for (const p of pizzas()) {
      const qty = toNum(b[`qty_${p.id}`]) || 0; const rej = toNum(b[`rej_${p.id}`]) || 0;
      if (!qty && !rej) continue;
      const batchNo = (b[`batch_${p.id}`] || `${today().replace(/-/g, '')}-${p.sku}`).trim();
      let batch = db.get('SELECT * FROM batches WHERE product_id = ? AND batch_no = ?', p.id, batchNo);
      if (!batch) {
        const id = db.insert('batches', { product_id: p.id, batch_no: batchNo, supplier_id: toNum(b.supplier_id), expires_at: b[`exp_${p.id}`] ? `${b[`exp_${p.id}`]} 23:59:00` : null, status: tempBad ? 'on_hold' : 'released', hold_reason: tempBad ? `Delivery temperature ${temp}°C out of range` : null });
        batch = { id };
      }
      if (qty) stock.move({ product_id: p.id, batch_id: batch.id, to: loc.id, qty, kind: 'receive', reason: b.notes || null, reference: b.reference || null, user_id: req.user.id });
      if (rej) db.insert('stock_movements', { product_id: p.id, batch_id: batch.id, qty: rej, kind: 'reject', reason: b.reject_reason || 'Rejected at delivery', reference: b.reference, user_id: req.user.id });
      received += qty; rejected += rej;
    }
  });
  if (temp != null) db.insert('temperature_logs', { site_id: loc.site_id, location_label: 'Delivery cooler', reading: temp, min_allowed: tmin, max_allowed: tmax, in_range: tempBad ? 0 : 1, user_id: req.user.id, action_taken: tempBad ? 'Batches placed on hold at receipt' : null });
  if (tempBad) incidents.create({ site_id: loc.site_id, type: 'food_safety', severity: 'critical', title: `Delivery received at ${temp}°C — stock on hold`, description: `Ref ${b.reference || '—'}. Batches placed on hold automatically. Manager must decide release or rejection (SOP-11).`, source: 'system' }, req.user);
  audit(req, 'stock.received', 'stock_locations', loc.id, { received, rejected, reference: b.reference });
  req.flash(tempBad ? 'warning' : 'success', `${received} units received${rejected ? `, ${rejected} rejected` : ''}.${tempBad ? ' Temperature out of range — stock placed ON HOLD and a food-safety incident raised.' : ''}`);
  res.redirect('/stock');
});

// ── Load machine / transfer (FEFO) ──
r.get('/stock/load', (req, res) => {
  const locs = myLocations(req.user);
  const machines = access.machinesFor(req.user);
  const machineId = toNum(req.query.machine) || machines[0]?.id;
  const to = machineId ? stock.machineLocation(machineId) : null;
  const fromLocs = locs.filter((l) => l.kind !== 'machine');
  const fromId = toNum(req.query.from) || fromLocs.find((l) => l.site_id && l.site_id === to?.site_id)?.id || fromLocs[0]?.id;
  const products = pizzas().map((p) => ({ ...p, inMachine: to ? stock.balance(to.id, p.id) : 0, available: fromId ? stock.balance(fromId, p.id) : 0, fefo: fromId ? stock.fefo(fromId, p.id).filter((x) => x.status === 'released').slice(0, 2) : [] }));
  res.page('stock-load', 'Load machine', { machines, machineId, fromLocs, fromId, to, products, allLocs: locs });
});

function transfer({ fromId, toId, productId, qty, kind, user, reference }) {
  let left = qty;
  for (const b of stock.fefo(fromId, productId)) {
    if (left <= 0) break;
    if (b.status && b.status !== 'released') continue; // never move held / recalled / expired stock
    const take = Math.min(left, b.qty);
    stock.move({ product_id: productId, batch_id: b.id, from: fromId, to: toId, qty: take, kind, user_id: user.id, reference });
    left -= take;
  }
  if (left > 0) stock.move({ product_id: productId, from: fromId, to: toId, qty: left, kind, reason: 'No released batch on record — check stock records', user_id: user.id, reference });
}

r.post('/stock/load', (req, res) => {
  const from = guardLoc(req.user, req.body.from_id);
  const to = req.body.machine_id ? stock.machineLocation(Number(req.body.machine_id)) : guardLoc(req.user, req.body.to_id);
  if (to.site_id && !access.canSite(req.user, to.site_id)) return res.back();
  let total = 0;
  db.tx(() => {
    for (const p of pizzas()) {
      const qty = toNum(req.body[`qty_${p.id}`]) || 0;
      if (qty <= 0) continue;
      transfer({ fromId: from.id, toId: to.id, productId: p.id, qty, kind: to.kind === 'machine' ? 'load' : 'transfer', user: req.user, reference: req.body.reference });
      total += qty;
    }
  });
  audit(req, 'stock.loaded', 'stock_locations', to.id, { from: from.id, total });
  req.flash('success', `${total} units moved to ${to.name}.${to.kind === 'machine' ? ' Now complete the Refill checklist.' : ''}`);
  if (to.kind === 'machine' && total) {
    const tpl = db.val("SELECT id FROM checklist_templates WHERE code = 'REFILL'");
    return res.redirect(`/checklists/start/${tpl}?site=${to.site_id}&machine=${to.machine_id}`);
  }
  res.redirect('/stock');
});

// ── Waste ──
r.get('/stock/waste', (req, res) => {
  res.page('stock-waste', 'Record waste', { locs: myLocations(req.user), locId: toNum(req.query.location), products: pizzas(), recent: db.all(`SELECT m.*, p.name AS product_name, l.name AS loc_name, u.name AS user_name FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN stock_locations l ON l.id = m.from_location_id LEFT JOIN users u ON u.id = m.user_id WHERE m.kind = 'waste' AND (l.site_id IS NULL OR ${access.siteFilter(req.user, 'l.site_id')}) ORDER BY m.occurred_at DESC LIMIT 8`) });
});
r.post('/stock/waste', (req, res) => {
  const loc = guardLoc(req.user, req.body.location_id);
  const qty = toNum(req.body.qty);
  if (!(qty > 0)) { req.flash('error', 'Enter a quantity.'); return res.back(); }
  const reason = req.body.reason + (req.body.notes ? `: ${req.body.notes}` : '');
  stock.consume({ location_id: loc.id, product_id: Number(req.body.product_id), qty, kind: 'waste', reason: req.body.reason, reference: req.body.notes || null, user_id: req.user.id });
  if (qty >= 5) notify({ roles: ['supervisor', 'ops_manager'], siteId: loc.site_id, except: req.user.id }, { level: 'warning', title: `High waste: ${qty} units at ${loc.name}`, body: reason, link: '/stock/movements?kind=waste' });
  audit(req, 'stock.waste', 'stock_locations', loc.id, { product: req.body.product_id, qty, reason });
  req.flash('success', `${qty} unit(s) recorded as waste. Dispose of them using the approved route — never give them away.`);
  res.redirect('/stock/waste');
});

// ── Count ──
r.get('/stock/count', (req, res) => {
  const locs = myLocations(req.user);
  const locId = toNum(req.query.location) || locs.find((l) => l.kind === 'machine')?.id;
  res.page('stock-count', 'Stock count', { locs, locId, products: pizzas().map((p) => ({ ...p, expected: locId ? stock.balance(locId, p.id) : 0 })), recent: db.all(`SELECT c.*, p.name AS product_name, l.name AS loc_name, u.name AS user_name FROM stock_counts c JOIN products p ON p.id = c.product_id JOIN stock_locations l ON l.id = c.location_id LEFT JOIN users u ON u.id = c.user_id WHERE l.site_id IS NULL OR ${access.siteFilter(req.user, 'l.site_id')} ORDER BY c.counted_at DESC LIMIT 8`) });
});
r.post('/stock/count', (req, res) => {
  const loc = guardLoc(req.user, req.body.location_id);
  const diffs = [];
  db.tx(() => {
    for (const p of pizzas()) {
      const v = req.body[`count_${p.id}`];
      if (v === '' || v == null) continue;
      const out = stock.count({ location_id: loc.id, product_id: p.id, counted: Number(v), user_id: req.user.id, explanation: req.body[`why_${p.id}`] || req.body.explanation || null });
      if (out.variance) diffs.push({ p, ...out });
    }
  });
  const big = diffs.filter((d) => Math.abs(d.variance) >= 3 && d.variance < 0);
  if (big.length) {
    incidents.create({ site_id: loc.site_id, type: 'stock', severity: 'major', title: `Unexplained stock shortage at ${loc.name}`, description: big.map((d) => `${d.p.name}: expected ${d.expected}, counted ${d.counted} (${d.variance})`).join('\n'), source: 'system' }, req.user);
  }
  audit(req, 'stock.counted', 'stock_locations', loc.id, diffs.map((d) => ({ p: d.p.name, v: d.variance })));
  req.flash(diffs.length ? 'warning' : 'success', diffs.length ? `Count saved. ${diffs.length} difference(s) adjusted${big.length ? ' — shortage incident raised for the Manager' : ''}.` : 'Count saved — matches records exactly. 👍');
  res.redirect('/stock');
});

// ── Batches, hold & recall (SOP-25) ──
r.get('/stock/batches', (req, res) => {
  const { where, params, f } = filters(req.query, {
    q: F.search('b.batch_no'), product: F.eq('b.product_id'), status: F.eq('b.status'),
    stock: (v) => (v === 'in' ? ['on_hand > 0'] : v === 'empty' ? ['on_hand <= 0'] : null),
    expiring: (v) => (v === '7' ? ["b.expires_at <= datetime('now','+7 days')"] : null),
  });
  const p = paginate(req, `SELECT * FROM (SELECT b.*, p.name AS product_name, v.name AS supplier,
      (SELECT COALESCE(SUM(CASE WHEN to_location_id IS NOT NULL THEN qty ELSE 0 END),0) - COALESCE(SUM(CASE WHEN from_location_id IS NOT NULL THEN qty ELSE 0 END),0) FROM stock_movements WHERE batch_id = b.id) AS on_hand
    FROM batches b JOIN products p ON p.id = b.product_id LEFT JOIN vendors v ON v.id = b.supplier_id) b WHERE ${where} ORDER BY b.status != 'released' DESC, b.on_hand > 0 DESC, b.expires_at`, params);
  res.page('stock-batches', 'Batches & traceability', { p, rows: p.rows, f, products: pizzas() });
});
r.get('/stock/batches/:id', (req, res) => {
  const b = db.get('SELECT b.*, p.name AS product_name, v.name AS supplier FROM batches b JOIN products p ON p.id = b.product_id LEFT JOIN vendors v ON v.id = b.supplier_id WHERE b.id = ?', req.params.id);
  const where = db.all(`WITH mv AS (SELECT to_location_id loc, qty FROM stock_movements WHERE batch_id = ? AND to_location_id IS NOT NULL UNION ALL SELECT from_location_id, -qty FROM stock_movements WHERE batch_id = ? AND from_location_id IS NOT NULL)
    SELECT l.name, l.site_id, SUM(mv.qty) qty FROM mv JOIN stock_locations l ON l.id = mv.loc GROUP BY l.id HAVING SUM(mv.qty) != 0`, b.id, b.id);
  const mvp = paginate(req, 'SELECT m.*, fl.name AS from_name, tl.name AS to_name, u.name AS user_name FROM stock_movements m LEFT JOIN stock_locations fl ON fl.id = m.from_location_id LEFT JOIN stock_locations tl ON tl.id = m.to_location_id LEFT JOIN users u ON u.id = m.user_id WHERE m.batch_id = ? ORDER BY m.occurred_at DESC', [b.id]);
  const moves = mvp.rows;
  const sold = db.val("SELECT COALESCE(SUM(qty),0) FROM stock_movements WHERE batch_id = ? AND kind = 'sale'", b.id);
  res.page('stock-batch', `Batch ${b.batch_no}`, { b, where, moves, mvp, sold });
});
r.post('/stock/batches/:id/status', requirePerm('stock.batches'), (req, res) => {
  const b = db.get('SELECT b.*, p.name AS product_name FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = ?', req.params.id);
  const status = req.body.status;
  if (status === 'released' && !['owner', 'ops_manager'].includes(req.user.role)) { req.flash('error', 'Only the Ops Manager or Owner can release held stock.'); return res.back(); }
  db.update('batches', b.id, { status, hold_reason: req.body.reason || null });
  if (status !== 'released') {
    const sites = db.all(`WITH mv AS (SELECT to_location_id loc, qty FROM stock_movements WHERE batch_id = ? AND to_location_id IS NOT NULL UNION ALL SELECT from_location_id, -qty FROM stock_movements WHERE batch_id = ? AND from_location_id IS NOT NULL)
      SELECT DISTINCT l.site_id FROM mv JOIN stock_locations l ON l.id = mv.loc WHERE l.site_id IS NOT NULL GROUP BY l.id HAVING SUM(mv.qty) > 0`, b.id, b.id).map((x) => x.site_id);
    for (const s of sites) notify({ roles: ['supervisor', 'sales_rep', 'stock_staff'], siteId: s }, { level: 'critical', title: `${status === 'recalled' ? 'RECALL' : 'HOLD'}: ${b.product_name} batch ${b.batch_no}`, body: `Remove these units from sale immediately and record them. Reason: ${req.body.reason || '—'}`, link: `/stock/batches/${b.id}` });
    notify({ roles: ['owner', 'ops_manager'] }, { level: 'critical', title: `Batch ${b.batch_no} set to ${status}`, body: req.body.reason, link: `/stock/batches/${b.id}` });
  }
  audit(req, `batch.${status}`, 'batches', b.id, req.body.reason);
  req.flash('success', `Batch ${b.batch_no} is now ${status}.`);
  res.redirect(`/stock/batches/${b.id}`);
});

// ── Movements ledger ──
r.get('/stock/movements', (req, res) => {
  const { where, params, f } = filters(req.query, {
    kind: F.eq('m.kind'), product: F.eq('m.product_id'),
    location: (v) => ['(m.from_location_id = ? OR m.to_location_id = ?)', v, v],
    reason: F.eq('m.reason'), staff: F.eq('m.user_id'),
    from: F.dateFrom('m.occurred_at'), to: F.dateTo('m.occurred_at'), q: F.search('b.batch_no', 'm.reference', 'm.reason'),
  }, ['(fl.site_id IS NULL OR ' + access.siteFilter(req.user, 'fl.site_id') + ')', '(tl.site_id IS NULL OR ' + access.siteFilter(req.user, 'tl.site_id') + ')']);
  const p = paginate(req, `SELECT m.*, p.name AS product_name, b.batch_no, fl.name AS from_name, tl.name AS to_name, u.name AS user_name FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN batches b ON b.id = m.batch_id
    LEFT JOIN stock_locations fl ON fl.id = m.from_location_id LEFT JOIN stock_locations tl ON tl.id = m.to_location_id LEFT JOIN users u ON u.id = m.user_id WHERE ${where} ORDER BY m.occurred_at DESC, m.id DESC`, params, { perPage: 25 });
  res.page('stock-movements', 'Stock ledger', { p, rows: p.rows, f, q: f, locs: myLocations(req.user), products: pizzas(), people: db.all('SELECT DISTINCT u.id, u.name FROM users u JOIN stock_movements m ON m.user_id = u.id ORDER BY u.name') });
});

// ── Restock requests ──
r.get('/stock/restock', (req, res) => {
  const fl = filters(req.query, { status: (v) => (v === 'open' ? ["r.status IN ('requested','approved','dispatched')"] : ['r.status = ?', v]), site: F.eq('r.site_id'), priority: F.eq('r.priority'), from: F.dateFrom('r.created_at'), to: F.dateTo('r.created_at') }, [access.siteFilter(req.user, 'r.site_id')]);
  const p = paginate(req, `SELECT r.*, s.name AS site_name, m.code AS machine_code, u.name AS requester, h.name AS handler FROM restock_requests r JOIN sites s ON s.id = r.site_id LEFT JOIN machines m ON m.id = r.machine_id LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users h ON h.id = r.handled_by
    WHERE ${fl.where} ORDER BY CASE r.status WHEN 'requested' THEN 0 WHEN 'approved' THEN 1 WHEN 'dispatched' THEN 2 ELSE 3 END, r.created_at DESC`, fl.params, { perPage: 10 });
  const rows = p.rows;
  const ids = access.siteIds(req.user);
  res.page('stock-restock', 'Restock requests', { p, f: fl.f, sites: access.sitesFor(req.user), rows, products: pizzas(), machines: access.machinesFor(req.user), low: metrics.lowStock(ids), pmap: Object.fromEntries(pizzas().map((p) => [p.id, p.name])) });
});
r.post('/stock/restock', (req, res) => {
  const m = db.get('SELECT * FROM machines WHERE id = ?', req.body.machine_id);
  if (!m || !access.canSite(req.user, m.site_id)) return res.back();
  const items = pizzas().map((p) => ({ product_id: p.id, qty: toNum(req.body[`qty_${p.id}`]) || 0 })).filter((i) => i.qty > 0);
  if (!items.length) { req.flash('error', 'Add at least one quantity.'); return res.back(); }
  const id = db.insert('restock_requests', { site_id: m.site_id, machine_id: m.id, requested_by: req.user.id, items: JSON.stringify(items), priority: req.body.priority, notes: req.body.notes, needed_by: req.body.needed_by || null });
  notify({ roles: ['stock_staff', 'ops_manager'], siteId: m.site_id, except: req.user.id }, { level: req.body.priority === 'urgent' ? 'critical' : 'warning', title: `Restock ${req.body.priority === 'urgent' ? 'URGENT ' : ''}requested: ${m.code}`, body: `${items.reduce((a, i) => a + i.qty, 0)} units`, link: '/stock/restock' });
  audit(req, 'restock.requested', 'restock_requests', id, items);
  req.flash('success', 'Restock request sent.');
  res.redirect('/stock/restock');
});
r.post('/stock/restock/:id', requirePerm('stock.manage'), (req, res) => {
  const rr = db.get('SELECT * FROM restock_requests WHERE id = ?', req.params.id);
  db.update('restock_requests', rr.id, { status: req.body.status, handled_by: req.user.id, updated_at: sqlNow() });
  if (req.body.status === 'delivered' && req.body.post_stock) {
    const central = stock.centralLocation();
    const to = stock.machineLocation(rr.machine_id);
    db.tx(() => { for (const it of JSON.parse(rr.items)) transfer({ fromId: central.id, toId: to.id, productId: it.product_id, qty: it.qty, kind: 'load', user: req.user, reference: `RR-${rr.id}` }); });
  }
  notify({ users: [rr.requested_by] }, { title: `Restock ${req.body.status}`, link: '/stock/restock' });
  audit(req, `restock.${req.body.status}`, 'restock_requests', rr.id);
  res.redirect('/stock/restock');
});

// ── Temperatures (SOP-11) ──
r.get('/stock/temperature', (req, res) => {
  res.page('stock-temperature', 'Temperature log', {
    machines: access.machinesFor(req.user), sites: access.sitesFor(req.user),
    range: { min: Number(db.setting('temp_min', '-18')), max: Number(db.setting('temp_max', '5')) },
    ...(() => {
      const fl = filters(req.query, { site: F.eq('t.site_id'), machine: F.eq('t.machine_id'), result: (v) => (v === 'bad' ? ['t.in_range = 0'] : v === 'ok' ? ['t.in_range = 1'] : null), what: F.eq('t.location_label'), from: F.dateFrom('t.recorded_at'), to: F.dateTo('t.recorded_at') }, [access.siteFilter(req.user, 't.site_id')]);
      const p = paginate(req, `SELECT t.*, s.name AS site_name, m.code AS machine_code, u.name AS user_name FROM temperature_logs t LEFT JOIN sites s ON s.id = t.site_id LEFT JOIN machines m ON m.id = t.machine_id LEFT JOIN users u ON u.id = t.user_id WHERE ${fl.where} ORDER BY t.recorded_at DESC`, fl.params);
      return { p, rows: p.rows, f: fl.f };
    })(),
    todayCounts: db.all(`SELECT m.code, COUNT(t.id) n FROM machines m LEFT JOIN temperature_logs t ON t.machine_id = m.id AND date(t.recorded_at) = ? WHERE ${access.siteFilter(req.user, 'm.site_id')} AND m.status != 'decommissioned' GROUP BY m.id`, today()),
  });
});
r.post('/stock/temperature', (req, res) => {
  const m = req.body.machine_id ? db.get('SELECT * FROM machines WHERE id = ?', req.body.machine_id) : null;
  const siteId = m?.site_id || toNum(req.body.site_id);
  if (!access.canSite(req.user, siteId)) return res.back();
  const reading = Number(req.body.reading);
  const min = Number(db.setting('temp_min', '-18')); const max = Number(db.setting('temp_max', '5'));
  const ok = reading >= min && reading <= max;
  db.insert('temperature_logs', { site_id: siteId, machine_id: m?.id, location_label: req.body.location_label || 'Machine storage', reading, min_allowed: min, max_allowed: max, in_range: ok ? 1 : 0, action_taken: req.body.action_taken || null, user_id: req.user.id });
  if (!ok) {
    const recent = db.val("SELECT COUNT(*) FROM temperature_logs WHERE machine_id IS ? AND in_range = 0 AND recorded_at >= datetime('now','-30 minutes')", m?.id);
    if (recent >= 2) incidents.create({ site_id: siteId, machine_id: m?.id, type: 'food_safety', severity: 'critical', title: `Temperature still out of range on re-check: ${reading}°C`, description: `Approved range ${min} to ${max}°C. Stock must be held (SOP-11).`, sales_paused: 1, source: 'system' }, req.user);
    req.flash('error', `${reading}°C is OUTSIDE the approved range (${min} to ${max}°C). Do not sell. Re-check in 10 minutes${recent >= 2 ? ' — this was the re-check, so a CRITICAL incident has been raised and sales paused.' : ' and log it again.'}`);
  } else req.flash('success', `${reading}°C logged — within range.`);
  res.redirect('/stock/temperature');
});

module.exports = r;
