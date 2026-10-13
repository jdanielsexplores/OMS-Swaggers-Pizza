const express = require('express');
const db = require('../db');
const access = require('../services/access');
const approvals = require('../services/approvals');
const incidents = require('../services/incidents');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { requirePerm } = require('../middleware');
const { makeRef, toNum, sqlNow } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();
const CATS = ['payment', 'quality', 'food_safety', 'service', 'machine', 'suggestion', 'praise', 'other'];

r.get('/customers', (req, res) => {
  const status = req.query.status || 'open';
  const fl = filters(req.query, {
    category: F.eq('c.category'), channel: F.eq('c.channel'), site: F.eq('c.site_id'), rating: (v) => ['c.rating <= ?', Number(v)],
    from: F.dateFrom('c.created_at'), to: F.dateTo('c.created_at'), q: F.search('c.description', 'c.ref', 'c.outcome', 'c.payment_ref'),
  }, [`(c.site_id IS NULL OR ${access.siteFilter(req.user, 'c.site_id')})`, status === 'open' ? "c.status NOT IN ('resolved','closed')" : status === 'all' ? '1=1' : `c.status = '${['investigating', 'awaiting_refund', 'resolved', 'closed'].includes(status) ? status : 'open'}'`]);
  const p = paginate(req, `SELECT c.*, s.name AS site_name, p.name AS product_name, a.name AS assignee FROM customer_cases c LEFT JOIN sites s ON s.id = c.site_id LEFT JOIN products p ON p.id = c.product_id LEFT JOIN users a ON a.id = c.assigned_to
    WHERE ${fl.where} ORDER BY c.created_at DESC`, fl.params);
  const rows = p.rows;
  const stats = db.get(`SELECT ROUND(AVG(rating),1) avg_rating, COUNT(rating) ratings, SUM(category='praise') praise, SUM(status NOT IN ('resolved','closed')) open,
    AVG(CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at)-julianday(created_at))*24 END) avg_hours FROM customer_cases WHERE created_at >= datetime('now','-30 days') AND (site_id IS NULL OR ${access.siteFilter(req.user, 'site_id')})`);
  res.page('customers', 'Customers', { p, rows, status, stats, CATS, f: fl.f, q: req.query, sites: access.sitesFor(req.user) });
});

r.get('/customers/new', (req, res) => {
  res.page('customer-form', 'New customer case', { sites: access.sitesFor(req.user), machines: access.machinesFor(req.user), products: db.all("SELECT * FROM products WHERE category = 'pizza' AND active = 1"), CATS });
});

r.post('/customers', (req, res) => {
  const b = req.body;
  const m = b.machine_id ? db.get('SELECT * FROM machines WHERE id = ?', b.machine_id) : null;
  const siteId = m?.site_id || toNum(b.site_id);
  if (siteId && !access.canSite(req.user, siteId)) return res.back();
  const id = db.insert('customer_cases', {
    ref: makeRef('CS'), site_id: siteId, machine_id: m?.id, category: b.category, channel: b.channel || 'in_person',
    customer_name: b.customer_name || null, customer_contact: b.customer_contact || null, product_id: toNum(b.product_id),
    order_ref: b.order_ref || null, payment_ref: b.payment_ref || null, description: b.description, rating: toNum(b.rating),
    status: ['praise', 'suggestion'].includes(b.category) ? 'closed' : 'open', created_by: req.user.id,
  });
  if (b.category === 'food_safety') {
    incidents.create({ site_id: siteId, machine_id: m?.id, type: 'food_safety', severity: 'critical', title: `Customer food-safety report`, description: b.description, source: 'customer', source_id: id }, req.user);
  }
  if (!['praise', 'suggestion'].includes(b.category)) {
    notify({ roles: ['supervisor', 'ops_manager', ...(b.category === 'payment' ? ['accounts'] : [])], siteId, except: req.user.id }, { level: b.category === 'food_safety' ? 'critical' : 'info', title: `Customer case: ${b.category.replace('_', ' ')}`, body: b.description.slice(0, 140), link: `/customers/${id}` });
  }
  audit(req, 'case.created', 'customer_cases', id);
  req.flash('success', 'Case recorded. Tell the customer: "I\'ve recorded it and the right person will contact you." Do not promise a refund unless authorised.');
  res.redirect(`/customers/${id}`);
});

r.get('/customers/refunds', (req, res) => {
  const { where, params, f } = filters(req.query, { status: F.eq('rf.status'), from: F.dateFrom('rf.created_at'), to: F.dateTo('rf.created_at'), q: F.search('c.ref', 'rf.reason', 'rf.paid_ref') }, [`(c.site_id IS NULL OR ${access.siteFilter(req.user, 'c.site_id')})`]);
  const p = paginate(req, `SELECT rf.*, c.ref AS case_ref, c.site_id, s.name AS site_name, rq.name AS requester, ap.name AS approver FROM refunds rf LEFT JOIN customer_cases c ON c.id = rf.case_id LEFT JOIN sites s ON s.id = c.site_id LEFT JOIN users rq ON rq.id = rf.requested_by LEFT JOIN users ap ON ap.id = rf.approved_by
    WHERE ${where} ORDER BY CASE rf.status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, rf.created_at DESC`, params);
  res.page('refunds', 'Refunds', { p, rows: p.rows, f });
});
r.post('/customers/refunds/:id/pay', requirePerm('refunds.pay'), (req, res) => {
  const rf = db.get('SELECT * FROM refunds WHERE id = ?', req.params.id);
  if (rf.status !== 'approved') { req.flash('error', 'Only approved refunds can be paid.'); return res.back(); }
  if (!req.body.paid_ref) { req.flash('error', 'Enter the provider reversal / transfer reference.'); return res.back(); }
  db.update('refunds', rf.id, { status: 'paid', paid_ref: req.body.paid_ref, paid_at: sqlNow() });
  if (rf.case_id) db.update('customer_cases', rf.case_id, { status: 'resolved', outcome: `Refund GH₵${rf.amount} paid (ref ${req.body.paid_ref})`, resolved_at: sqlNow() });
  if (rf.payment_exception_id) db.update('payment_exceptions', rf.payment_exception_id, { status: 'refunded', resolved_by: req.user.id, resolved_at: sqlNow(), resolution: `Refunded ref ${req.body.paid_ref}` });
  db.run("UPDATE sales SET payment_status = 'refunded' WHERE payment_ref = (SELECT payment_ref FROM customer_cases WHERE id = ?) AND payment_ref IS NOT NULL", rf.case_id);
  audit(req, 'refund.paid', 'refunds', rf.id, req.body.paid_ref);
  req.flash('success', 'Refund marked as paid and the case resolved.');
  res.redirect('/customers/refunds');
});

r.get('/customers/:id', (req, res) => {
  const c = db.get('SELECT c.*, s.name AS site_name, m.code AS machine_code, p.name AS product_name, cb.name AS created_name, a.name AS assignee FROM customer_cases c LEFT JOIN sites s ON s.id = c.site_id LEFT JOIN machines m ON m.id = c.machine_id LEFT JOIN products p ON p.id = c.product_id LEFT JOIN users cb ON cb.id = c.created_by LEFT JOIN users a ON a.id = c.assigned_to WHERE c.id = ?', req.params.id);
  if (!c || (c.site_id && !access.canSite(req.user, c.site_id))) return res.redirect('/customers');
  const canSeeContact = access.can(req.user, 'cases.manage') || c.created_by === req.user.id;
  res.page('customer-case', c.ref, {
    c, canSeeContact,
    refunds: db.all('SELECT rf.*, u.name AS approver FROM refunds rf LEFT JOIN users u ON u.id = rf.approved_by WHERE rf.case_id = ?', c.id),
    staff: db.all("SELECT id, name, role FROM users WHERE active = 1 AND role IN ('supervisor','ops_manager','accounts') ORDER BY name"),
    limit: Number(db.setting('refund_manager_limit', '100')),
  });
});

r.post('/customers/:id', requirePerm('cases.manage'), (req, res) => {
  const c = db.get('SELECT * FROM customer_cases WHERE id = ?', req.params.id);
  const status = req.body.status;
  db.update('customer_cases', c.id, { status, outcome: req.body.outcome || c.outcome, assigned_to: toNum(req.body.assigned_to) || c.assigned_to, resolved_at: ['resolved', 'closed'].includes(status) ? (c.resolved_at || sqlNow()) : null });
  if (req.body.assigned_to && Number(req.body.assigned_to) !== c.assigned_to) notify({ users: [Number(req.body.assigned_to)] }, { title: `Customer case assigned: ${c.ref}`, link: `/customers/${c.id}` });
  audit(req, 'case.updated', 'customer_cases', c.id, req.body);
  res.redirect(`/customers/${c.id}`);
});

r.post('/customers/:id/refund', requirePerm('cases.manage'), (req, res) => {
  const c = db.get('SELECT * FROM customer_cases WHERE id = ?', req.params.id);
  const amount = toNum(req.body.amount);
  if (!(amount > 0)) { req.flash('error', 'Enter an amount.'); return res.back(); }
  const rf = db.insert('refunds', { case_id: c.id, amount, method: req.body.method || 'momo_reversal', reason: req.body.reason, requested_by: req.user.id });
  const limit = Number(db.setting('refund_manager_limit', '100'));
  approvals.request({ kind: 'refund', title: `Refund GH₵${amount} — ${c.ref}`, details: req.body.reason, amount, entity: 'refunds', entity_id: rf, required_role: amount > limit ? 'owner' : 'ops_manager' }, req.user);
  db.update('customer_cases', c.id, { status: 'awaiting_refund' });
  req.flash('success', `Refund request sent to the ${amount > limit ? 'Owner' : 'Operations Manager'} for approval.`);
  res.redirect(`/customers/${c.id}`);
});

module.exports = r;
