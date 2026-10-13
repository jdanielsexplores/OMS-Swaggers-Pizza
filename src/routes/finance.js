const express = require('express');
const db = require('../db');
const metrics = require('../services/metrics');
const approvals = require('../services/approvals');
const { audit } = require('../services/audit');
const { requirePerm, fileFor } = require('../middleware');
const { today, toNum, addDays } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();
r.use('/finance', requirePerm('finance.view'));

const monthBounds = (m) => { const [y, mo] = m.split('-').map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` }; };

r.get('/finance', (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  const { from, to } = req.query.from ? { from: req.query.from, to: req.query.to || today() } : monthBounds(month);
  const all = db.all('SELECT id FROM sites').map((s) => s.id);
  const fin = metrics.finance(all, from, to);
  const byCategory = db.all(`SELECT c.id, c.name, c.parent, c.kind, COALESCE(SUM(t.amount),0) AS actual,
      (SELECT COALESCE(SUM(b.amount),0) FROM budgets b WHERE b.category_id = c.id AND b.month = ?) AS budget
    FROM finance_categories c LEFT JOIN transactions t ON t.category_id = c.id AND t.status = 'approved' AND t.txn_date BETWEEN ? AND ?
    GROUP BY c.id HAVING actual > 0 OR budget > 0 ORDER BY c.kind, c.parent, actual DESC`, month, from, to);
  // Site profitability: sales − COGS − expenses tagged to that site (unallocated overheads shown separately).
  const sites = metrics.salesBySite(all, from, to).map((s) => {
    const cogs = db.val("SELECT COALESCE(SUM(x.qty * p.unit_cost),0) FROM sales x JOIN products p ON p.id = x.product_id WHERE x.site_id = ? AND date(x.sold_at) BETWEEN ? AND ? AND x.payment_status='confirmed'", s.id, from, to);
    const exp = db.val("SELECT COALESCE(SUM(amount),0) FROM transactions WHERE kind='expense' AND status='approved' AND site_id = ? AND txn_date BETWEEN ? AND ?", s.id, from, to);
    const waste = metrics.waste([s.id], from, to).filter((w) => w.site_id === s.id).reduce((a, w) => a + w.cost, 0);
    return { ...s, cogs, exp, waste, contribution: s.revenue - cogs - exp };
  });
  const overheads = db.val("SELECT COALESCE(SUM(amount),0) FROM transactions WHERE kind='expense' AND status='approved' AND site_id IS NULL AND txn_date BETWEEN ? AND ?", from, to);
  const tf = filters(req.query, { kind: F.eq('t.kind'), category: F.eq('t.category_id'), tsite: (v) => (v === 'none' ? ['t.site_id IS NULL'] : ['t.site_id = ?', v]), tstatus: F.eq('t.status'), q: F.search('t.description', 't.reference') }, ['t.txn_date BETWEEN ? AND ?']);
  const tp = paginate(req, `SELECT t.*, c.name AS category, s.name AS site_name, u.name AS user_name FROM transactions t LEFT JOIN finance_categories c ON c.id = t.category_id LEFT JOIN sites s ON s.id = t.site_id LEFT JOIN users u ON u.id = t.recorded_by WHERE ${tf.where} ORDER BY t.txn_date DESC, t.id DESC`, [from, to, ...tf.params], { param: 'tpage', perPage: 15 });
  const recent = tp.rows;
  const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(`${month}-15T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - (5 - i)); return d.toISOString().slice(0, 7); });
  const trend = months.map((m) => { const b = monthBounds(m); const f = metrics.finance(all, b.from, b.to); return { m, rev: f.salesRev + f.otherIncome, cost: f.cogs + f.expenses + f.refunds, net: f.net }; });
  res.page('finance', 'Finance', { month, from, to, fin, byCategory, sites, overheads, recent, tp, tf: tf.f, trend, categories: db.all('SELECT * FROM finance_categories ORDER BY kind, parent, name'), siteList: db.all('SELECT id, name FROM sites ORDER BY name'), vendors: db.all('SELECT id, name FROM vendors ORDER BY name'), limits: { mgr: Number(db.setting('expense_manager_limit', '500')), owner: Number(db.setting('expense_owner_limit', '2000')) } });
});

r.post('/finance/transactions', requirePerm('finance.record'), (req, res) => {
  const b = req.body;
  const amount = toNum(b.amount);
  if (!(amount > 0)) { req.flash('error', 'Enter an amount.'); return res.back(); }
  const mgr = Number(db.setting('expense_manager_limit', '500'));
  const owner = Number(db.setting('expense_owner_limit', '2000'));
  const needs = b.kind === 'expense' && req.user.role !== 'owner' && amount > mgr ? (amount > owner ? 'owner' : 'ops_manager') : null;
  const id = db.insert('transactions', { kind: b.kind, category_id: toNum(b.category_id), site_id: toNum(b.site_id), vendor_id: toNum(b.vendor_id), amount, description: b.description, reference: b.reference || null, receipt: fileFor(req, 'receipt'), txn_date: b.txn_date || today(), status: needs ? 'pending' : 'approved', recorded_by: req.user.id });
  if (needs) {
    const cat = db.val('SELECT name FROM finance_categories WHERE id = ?', b.category_id);
    const aid = approvals.request({ kind: 'expense', title: `Expense GH₵${amount.toFixed(2)} — ${cat}: ${b.description || ''}`.slice(0, 140), amount, entity: 'transactions', entity_id: id, required_role: needs }, req.user);
    db.update('transactions', id, { approval_id: aid });
  }
  audit(req, 'transaction.recorded', 'transactions', id, { kind: b.kind, amount, needs });
  req.flash('success', needs ? `Recorded and sent to the ${needs === 'owner' ? 'Owner' : 'Ops Manager'} for approval (above GH₵${needs === 'owner' ? owner : mgr}).` : 'Recorded.');
  res.redirect('/finance');
});

r.post('/finance/budgets', requirePerm('finance.record'), (req, res) => {
  const month = req.body.month;
  for (const [k, v] of Object.entries(req.body)) {
    if (!k.startsWith('b_')) continue;
    const cat = Number(k.slice(2)); const amt = toNum(v);
    if (amt == null) continue;
    db.run('INSERT INTO budgets(month, category_id, site_id, amount) VALUES (?, ?, NULL, ?) ON CONFLICT(month, category_id, site_id) DO UPDATE SET amount = excluded.amount', month, cat, amt);
    db.run('DELETE FROM budgets WHERE month = ? AND category_id = ? AND site_id IS NULL AND rowid NOT IN (SELECT MAX(rowid) FROM budgets WHERE month = ? AND category_id = ? AND site_id IS NULL)', month, cat, month, cat);
  }
  audit(req, 'budget.saved', 'budgets', null, month);
  req.flash('success', 'Budget saved.');
  res.redirect(`/finance?month=${month}`);
});

r.get('/finance/budget', requirePerm('finance.record'), (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  const prev = monthBounds(addDays(`${month}-01`, -1).slice(0, 7));
  const cats = db.all(`SELECT c.*, (SELECT amount FROM budgets b WHERE b.category_id = c.id AND b.month = ? AND b.site_id IS NULL ORDER BY rowid DESC LIMIT 1) AS budget,
    (SELECT COALESCE(SUM(amount),0) FROM transactions t WHERE t.category_id = c.id AND t.status='approved' AND t.txn_date BETWEEN ? AND ?) AS last_month FROM finance_categories c WHERE c.kind = 'expense' ORDER BY c.parent, c.name`, month, prev.from, prev.to);
  res.page('budget', 'Budget', { month, cats });
});

module.exports = r;
