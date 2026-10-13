// Public customer feedback page reached by scanning the QR sticker on a machine: /f/SWG-KIA-01
const express = require('express');
const db = require('../db');
const incidents = require('../services/incidents');
const { notify } = require('../services/notify');
const { makeRef, toNum } = require('../lib/util');

const r = express.Router();

r.get('/:code', (req, res) => {
  const m = db.get('SELECT m.*, s.name AS site_name FROM machines m LEFT JOIN sites s ON s.id = m.site_id WHERE m.code = ?', req.params.code);
  if (!m) return res.status(404).send('Unknown machine');
  res.render('feedback', { m, products: db.all("SELECT id, name FROM products WHERE category = 'pizza' AND active = 1"), done: false, csrfToken: res.locals.csrfToken });
});

r.post('/:code', (req, res) => {
  const m = db.get('SELECT * FROM machines WHERE code = ?', req.params.code);
  if (!m) return res.status(404).send('Unknown machine');
  if (req.body.website) return res.render('feedback', { m, done: true }); // honeypot
  const category = ['payment', 'quality', 'machine', 'service', 'suggestion', 'praise', 'food_safety'].includes(req.body.category) ? req.body.category : 'other';
  const description = String(req.body.description || '').slice(0, 2000).trim() || '(no comment)';
  const contact = String(req.body.contact || '').slice(0, 80) || null;
  const id = db.insert('customer_cases', {
    ref: makeRef('CS'), site_id: m.site_id, machine_id: m.id, category, channel: 'qr_feedback', customer_name: String(req.body.name || '').slice(0, 80) || null,
    customer_contact: contact, product_id: toNum(req.body.product_id), payment_ref: String(req.body.payment_ref || '').slice(0, 40) || null,
    description, rating: Math.min(5, Math.max(1, toNum(req.body.rating) || 0)) || null, status: ['praise', 'suggestion'].includes(category) ? 'closed' : 'open',
  });
  if (category === 'food_safety') incidents.create({ site_id: m.site_id, machine_id: m.id, type: 'food_safety', severity: 'critical', title: 'Customer reported a food-safety concern (QR feedback)', description, source: 'customer', source_id: id }, null);
  else if (category === 'machine') incidents.create({ site_id: m.site_id, machine_id: m.id, type: 'machine', severity: 'minor', title: `Customer reported a machine problem on ${m.code}`, description, source: 'customer', source_id: id }, null);
  if (!['praise', 'suggestion'].includes(category)) {
    notify({ roles: ['supervisor', 'ops_manager', ...(category === 'payment' ? ['accounts'] : [])], siteId: m.site_id }, { level: category === 'food_safety' ? 'critical' : 'info', title: `QR feedback (${category}) — ${m.code}`, body: description.slice(0, 140), link: `/customers/${id}` });
  }
  res.render('feedback', { m, done: true, ref: db.val('SELECT ref FROM customer_cases WHERE id = ?', id) });
});

module.exports = r;
