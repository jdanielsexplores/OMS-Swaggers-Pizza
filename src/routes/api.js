// Machine / payment-provider integration API (Phase 2 — direct machine monitoring).
// Auth: header "Authorization: Bearer <machine api_key>" (see Machines → Integration).
const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const stock = require('../services/stock');
const incidents = require('../services/incidents');
const { sqlNow, toNum } = require('../lib/util');

const r = express.Router();

function machineAuth(req, res, next) {
  const key = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!key) return res.status(401).json({ error: 'Missing API key' });
  const m = db.all('SELECT * FROM machines WHERE api_key IS NOT NULL').find((x) => x.api_key.length === key.length && crypto.timingSafeEqual(Buffer.from(x.api_key), Buffer.from(key)));
  if (!m) return res.status(401).json({ error: 'Invalid API key' });
  req.machine = m;
  next();
}

r.get('/health', (req, res) => res.json({ ok: true }));

// POST /api/v1/machine/heartbeat  { status?: "ok"|"error", temperature?: number, stock?: {SKU: qty} }
r.post('/machine/heartbeat', machineAuth, (req, res) => {
  const m = req.machine;
  db.update('machines', m.id, { last_heartbeat: sqlNow() });
  const t = toNum(req.body.temperature);
  if (t != null) {
    const min = Number(db.setting('temp_min', '-18')); const max = Number(db.setting('temp_max', '5'));
    const last = db.get("SELECT recorded_at FROM temperature_logs WHERE machine_id = ? AND location_label = 'Machine sensor' ORDER BY id DESC LIMIT 1", m.id);
    if (!last || Date.now() - new Date(last.recorded_at.replace(' ', 'T') + 'Z').getTime() > 30 * 60000 || t < min || t > max) {
      db.insert('temperature_logs', { site_id: m.site_id, machine_id: m.id, location_label: 'Machine sensor', reading: t, min_allowed: min, max_allowed: max, in_range: t >= min && t <= max ? 1 : 0 });
    }
  }
  // Auto-recover machines that went offline only because of a missed heartbeat.
  if (m.status === 'offline' && /no heartbeat/.test(m.status_reason || '')) {
    const inc = db.get("SELECT id FROM incidents WHERE machine_id = ? AND source = 'system' AND title LIKE '%heartbeat%' AND status NOT IN ('resolved','closed') ORDER BY id DESC LIMIT 1", m.id);
    if (inc) incidents.changeStatus(inc.id, 'resolved', null, 'Machine reconnected (heartbeat received).');
  }
  res.json({ ok: true, status: db.val('SELECT status FROM machines WHERE id = ?', m.id) });
});

// POST /api/v1/machine/sale  { order_ref, sku, qty?, amount, payment_ref?, payment_status?, dispense_status?, sold_at? }
r.post('/machine/sale', machineAuth, (req, res) => {
  const m = req.machine; const b = req.body;
  if (b.order_ref && db.get('SELECT id FROM sales WHERE machine_id = ? AND order_ref = ?', m.id, b.order_ref)) return res.json({ ok: true, duplicate: true });
  const p = b.sku ? db.get('SELECT * FROM products WHERE sku = ?', b.sku) : null;
  const qty = toNum(b.qty) || 1;
  const payment_status = ['confirmed', 'pending', 'failed', 'refunded'].includes(b.payment_status) ? b.payment_status : 'confirmed';
  const dispense_status = ['dispensed', 'failed', 'pending'].includes(b.dispense_status) ? b.dispense_status : 'dispensed';
  const id = db.insert('sales', { machine_id: m.id, site_id: m.site_id, product_id: p?.id, order_ref: b.order_ref, qty, unit_price: p?.price, amount: toNum(b.amount) ?? qty * (p?.price || 0), payment_method: b.payment_method || 'momo', payment_ref: b.payment_ref, payment_status, dispense_status, source: 'machine_api', sold_at: (b.sold_at || sqlNow()).replace('T', ' ').slice(0, 19) });
  if (p && payment_status === 'confirmed' && dispense_status === 'dispensed') stock.consume({ location_id: stock.machineLocation(m.id).id, product_id: p.id, qty, kind: 'sale', reference: b.order_ref || `API-${id}` });
  if (payment_status === 'confirmed' && dispense_status === 'failed') {
    db.insert('payment_exceptions', { site_id: m.site_id, machine_id: m.id, kind: 'deducted_no_order', amount: toNum(b.amount), payment_ref: b.payment_ref, order_ref: b.order_ref, occurred_at: sqlNow() });
    const recentFails = db.val("SELECT COUNT(*) FROM sales WHERE machine_id = ? AND dispense_status = 'failed' AND sold_at >= datetime('now','-1 hour')", m.id);
    if (recentFails >= 3) incidents.create({ site_id: m.site_id, machine_id: m.id, type: 'machine', severity: 'major', title: `${m.code}: ${recentFails} paid orders failed to dispense in the last hour`, source: 'machine', sales_paused: 0 }, null);
  }
  db.update('machines', m.id, { last_heartbeat: sqlNow() });
  res.status(201).json({ ok: true, id });
});

// POST /api/v1/machine/fault  { code, message, severity?: "critical"|"major"|"minor" }
r.post('/machine/fault', machineAuth, (req, res) => {
  const m = req.machine; const b = req.body;
  const existing = db.get("SELECT id FROM incidents WHERE machine_id = ? AND error_message = ? AND status NOT IN ('resolved','closed')", m.id, b.code || b.message);
  if (existing) { incidents.timeline(existing.id, null, 'system', `Machine re-reported fault: ${b.message || b.code}`); return res.json({ ok: true, incident_id: existing.id, duplicate: true }); }
  const inc = incidents.create({ site_id: m.site_id, machine_id: m.id, type: 'machine', severity: ['critical', 'major', 'minor'].includes(b.severity) ? b.severity : 'major', title: `${m.code} reported: ${b.message || b.code || 'fault'}`, error_message: b.code || b.message, source: 'machine', sales_paused: b.severity === 'critical' ? 1 : 0 }, null);
  res.status(201).json({ ok: true, incident_id: inc.id, ref: inc.ref });
});

module.exports = r;
