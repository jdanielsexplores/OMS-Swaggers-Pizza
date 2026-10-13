// Inventory ledger. Every unit is a movement between locations (null = outside the business).
const db = require('../db');

const BAL_SQL = `
  SELECT COALESCE(SUM(CASE WHEN to_location_id = :loc THEN qty ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN from_location_id = :loc THEN qty ELSE 0 END), 0) AS bal
  FROM stock_movements WHERE (to_location_id = :loc OR from_location_id = :loc)`;

function balance(locationId, productId, batchId) {
  let sql = BAL_SQL.replaceAll(':loc', '?') + ' AND product_id = ?';
  const params = [locationId, locationId, locationId, locationId, productId];
  if (batchId !== undefined) { sql += ' AND batch_id IS ?'; params.push(batchId); }
  return Number(db.val(sql, ...params) || 0);
}

// Per-product balances at one location (or every location when null).
function balances(locationId = null) {
  return db.all(`
    WITH moves AS (
      SELECT to_location_id AS loc, product_id, qty FROM stock_movements WHERE to_location_id IS NOT NULL
      UNION ALL
      SELECT from_location_id, product_id, -qty FROM stock_movements WHERE from_location_id IS NOT NULL
    )
    SELECT l.id AS location_id, l.name AS location_name, l.kind, l.site_id, l.machine_id,
           p.id AS product_id, p.name AS product_name, p.sku, p.reorder_level, p.colour, p.unit_cost,
           COALESCE(SUM(m.qty), 0) AS qty
    FROM stock_locations l
    CROSS JOIN products p
    LEFT JOIN moves m ON m.loc = l.id AND m.product_id = p.id
    WHERE p.active = 1 AND p.category = 'pizza' ${locationId ? 'AND l.id = ?' : ''}
    GROUP BY l.id, p.id
    ORDER BY l.kind, l.name, p.name`, ...(locationId ? [locationId] : []));
}

// Batches available at a location, earliest expiry first (FEFO).
function fefo(locationId, productId) {
  return db.all(`
    WITH moves AS (
      SELECT batch_id, qty FROM stock_movements WHERE to_location_id = ? AND product_id = ?
      UNION ALL
      SELECT batch_id, -qty FROM stock_movements WHERE from_location_id = ? AND product_id = ?
    )
    SELECT b.id, b.batch_no, b.expires_at, b.status, SUM(m.qty) AS qty
    FROM moves m LEFT JOIN batches b ON b.id = m.batch_id
    GROUP BY m.batch_id HAVING SUM(m.qty) > 0
    ORDER BY CASE WHEN b.expires_at IS NULL THEN 1 ELSE 0 END, b.expires_at`, locationId, productId, locationId, productId);
}

function move({ product_id, batch_id = null, from = null, to = null, qty, kind, reason = null, reference = null, user_id = null, occurred_at }) {
  if (!(qty > 0)) throw new Error('Quantity must be greater than zero');
  const unit_cost = db.val('SELECT unit_cost FROM products WHERE id = ?', product_id);
  return db.insert('stock_movements', {
    product_id, batch_id, from_location_id: from, to_location_id: to, qty, kind, reason, reference, unit_cost, user_id,
    occurred_at,
  });
}

// Remove qty from a location, consuming batches FEFO. Used for sales and waste.
function consume({ location_id, product_id, qty, kind, reason, reference, user_id, occurred_at, batch_id }) {
  if (batch_id) return [move({ product_id, batch_id, from: location_id, qty, kind, reason, reference, user_id, occurred_at })];
  const ids = [];
  let left = qty;
  for (const b of fefo(location_id, product_id)) {
    if (left <= 0) break;
    const take = Math.min(left, b.qty);
    ids.push(move({ product_id, batch_id: b.id, from: location_id, qty: take, kind, reason, reference, user_id, occurred_at }));
    left -= take;
  }
  if (left > 0) ids.push(move({ product_id, from: location_id, qty: left, kind, reason: reason || 'no batch on record', reference, user_id, occurred_at }));
  return ids;
}

function machineLocation(machineId) {
  let loc = db.get('SELECT * FROM stock_locations WHERE machine_id = ?', machineId);
  if (!loc) {
    const m = db.get('SELECT * FROM machines WHERE id = ?', machineId);
    const id = db.insert('stock_locations', { name: `Machine ${m.code}`, kind: 'machine', site_id: m.site_id, machine_id: m.id });
    loc = db.get('SELECT * FROM stock_locations WHERE id = ?', id);
  }
  return loc;
}
const centralLocation = () => db.get("SELECT * FROM stock_locations WHERE kind = 'central' ORDER BY id LIMIT 1");
const locationsFor = (siteIds) => db.all(`SELECT * FROM stock_locations WHERE kind = 'central' OR site_id IN (${siteIds.map(Number).join(',') || 0}) ORDER BY kind, name`);

// Stock-count: record and auto-adjust the ledger to match the physical count.
function count({ location_id, product_id, counted, user_id, explanation }) {
  const expected = balance(location_id, product_id);
  const variance = counted - expected;
  db.insert('stock_counts', { location_id, product_id, expected, counted, variance, user_id, explanation });
  if (variance > 0) move({ product_id, to: location_id, qty: variance, kind: 'count', reason: explanation || 'count surplus', user_id });
  if (variance < 0) consume({ location_id, product_id, qty: -variance, kind: 'count', reason: explanation || 'count shortage', user_id });
  return { expected, counted, variance };
}

module.exports = { balance, balances, fefo, move, consume, machineLocation, centralLocation, locationsFor, count };
