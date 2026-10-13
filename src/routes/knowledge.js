// Handbook (SOPs), playbook acknowledgement and training.
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const db = require('../db');
const config = require('../config');
const access = require('../services/access');
const approvals = require('../services/approvals');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { requirePerm } = require('../middleware');
const { SITE_RULES, ROLES } = require('../content/reference');
const { sqlNow, addDays, today } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();
const CATEGORY_LABELS = { operations: 'Daily operations', customer: 'Customers', payments: 'Payments', food_safety: 'Food safety', stock: 'Stock', cleaning: 'Cleaning', safety: 'Safety & machines', people: 'People & portal', management: 'Management', site: 'Sites' };
const PLAYBOOK_FILE = path.join(config.root, 'docs', 'Swaggers_Pizza_Operations_Playbook_v2.docx');

r.get('/handbook', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let sops = db.all(`SELECT s.*, (SELECT 1 FROM sop_reads r WHERE r.sop_id = s.id AND r.user_id = ? AND r.version = s.version) AS read FROM sops s WHERE s.status != 'retired' ${access.can(req.user, 'sops.manage') ? '' : "AND s.status = 'approved'"} ORDER BY s.code`, req.user.id);
  if (q) sops = sops.filter((s) => `${s.code} ${s.title} ${s.purpose} ${s.body}`.toLowerCase().includes(q));
  const ackDone = db.get("SELECT signed_at FROM acknowledgements WHERE user_id = ? AND document = 'playbook' AND version = ?", req.user.id, db.setting('playbook_version', '2.0'));
  res.page('handbook', 'Handbook & SOPs', { sops, q, CATEGORY_LABELS, ackDone, siteRules: SITE_RULES, hasDocx: fs.existsSync(PLAYBOOK_FILE) });
});

r.get('/handbook/playbook.docx', (req, res) => {
  if (!fs.existsSync(PLAYBOOK_FILE)) return res.redirect('/handbook');
  res.download(PLAYBOOK_FILE);
});

r.get('/handbook/acknowledge', (req, res) => {
  const version = db.setting('playbook_version', '2.0');
  res.page('acknowledge', 'Playbook acknowledgement', { version, done: db.get("SELECT * FROM acknowledgements WHERE user_id = ? AND document = 'playbook' AND version = ?", req.user.id, version) });
});
r.post('/handbook/acknowledge', (req, res) => {
  const version = db.setting('playbook_version', '2.0');
  const sig = String(req.body.signature || '').trim();
  if (sig.toLowerCase() !== req.user.name.toLowerCase() || !req.body.agree) { req.flash('error', 'Tick the box and type your full name exactly as shown to sign.'); return res.back(); }
  db.run('INSERT OR IGNORE INTO acknowledgements(user_id, document, version, signature, ip) VALUES (?,?,?,?,?)', req.user.id, 'playbook', version, sig, req.ip);
  audit(req, 'playbook.acknowledged', 'users', req.user.id, version);
  req.flash('success', 'Thank you — your acknowledgement is recorded.');
  res.redirect('/');
});

r.get('/handbook/compliance', requirePerm('training.assess'), (req, res) => {
  const fl = filters(req.query, { q: F.search('name'), role: F.eq('role') }, ['active = 1']);
  const p = paginate(req, `SELECT id, name, role FROM users WHERE ${fl.where} ORDER BY role, name`, fl.params, { perPage: 15 });
  const users = p.rows;
  const sops = db.all("SELECT id, code, title, version, roles FROM sops WHERE status = 'approved' ORDER BY code");
  const reads = new Set(db.all('SELECT r.sop_id, r.user_id FROM sop_reads r JOIN sops s ON s.id = r.sop_id AND s.version = r.version').map((x) => `${x.sop_id}:${x.user_id}`));
  const acks = new Set(db.all("SELECT user_id FROM acknowledgements WHERE document = 'playbook' AND version = ?", db.setting('playbook_version', '2.0')).map((x) => x.user_id));
  res.page('sop-compliance', 'SOP read tracking', { p, f: fl.f, users, sops, reads, acks });
});

r.get('/handbook/new', requirePerm('sops.manage'), (req, res) => {
  const n = db.all("SELECT code FROM sops WHERE code LIKE 'SOP-%'").map((s) => Number(s.code.slice(4))).filter(Boolean);
  res.page('sop-edit', 'New SOP', { sop: { code: `SOP-${String(Math.max(0, ...n) + 1).padStart(2, '0')}`, version: '0.1', category: 'operations', roles: 'all', body: '## Steps\n1. ' }, CATEGORY_LABELS, isNew: true });
});

r.get('/handbook/:code', (req, res) => {
  const sop = db.get('SELECT s.*, u.name AS approver FROM sops s LEFT JOIN users u ON u.id = s.approved_by WHERE s.code = ?', req.params.code);
  if (!sop) return res.redirect('/handbook');
  const read = db.get('SELECT read_at FROM sop_reads WHERE sop_id = ? AND user_id = ? AND version = ?', sop.id, req.user.id, sop.version);
  const readers = access.can(req.user, 'training.assess') ? db.val('SELECT COUNT(*) FROM sop_reads WHERE sop_id = ? AND version = ?', sop.id, sop.version) : null;
  const all = db.all("SELECT code, title FROM sops WHERE status != 'retired' ORDER BY code");
  const i = all.findIndex((s) => s.code === sop.code);
  res.page('sop', `${sop.code} ${sop.title}`, { sop, read, readers, staffCount: db.val('SELECT COUNT(*) FROM users WHERE active = 1'), prev: all[i - 1], next: all[i + 1], ROLES, CATEGORY_LABELS });
});

r.post('/handbook/:code/read', (req, res) => {
  const sop = db.get('SELECT * FROM sops WHERE code = ?', req.params.code);
  db.run('INSERT OR IGNORE INTO sop_reads(sop_id, user_id, version) VALUES (?,?,?)', sop.id, req.user.id, sop.version);
  res.redirect(`/handbook/${sop.code}`);
});

r.get('/handbook/:code/edit', requirePerm('sops.manage'), (req, res) => {
  const sop = db.get('SELECT * FROM sops WHERE code = ?', req.params.code);
  res.page('sop-edit', `Edit ${sop.code}`, { sop, CATEGORY_LABELS, isNew: false });
});

// Edits create a new version as a draft that must be approved by the Owner (playbook: changes approved in writing).
r.post('/handbook/save', requirePerm('sops.manage'), (req, res) => {
  const b = req.body;
  const existing = db.get('SELECT * FROM sops WHERE code = ?', b.code);
  const bump = (v) => { const [maj, min] = String(v || '1.0').split('.').map(Number); return `${maj}.${(min || 0) + 1}`; };
  const fields = { title: b.title, category: b.category, purpose: b.purpose, roles: b.roles || 'all', body: b.body, updated_at: sqlNow(), review_due: addDays(today(), 180) };
  let id;
  const direct = req.user.role === 'owner';
  if (existing) {
    id = existing.id;
    if (direct) db.update('sops', id, { ...fields, version: bump(existing.version), status: 'approved', approved_by: req.user.id, approved_at: sqlNow(), draft: null });
    else db.update('sops', id, { draft: JSON.stringify(fields) }); // live text unchanged until approved
  } else {
    id = direct
      ? db.insert('sops', { code: b.code, ...fields, version: '1.0', status: 'approved', approved_by: req.user.id, approved_at: sqlNow() })
      : db.insert('sops', { code: b.code, ...fields, version: '0.1', status: 'draft', draft: JSON.stringify(fields) });
  }
  if (!direct) approvals.request({ kind: 'sop_change', title: `${existing ? 'SOP change' : 'New SOP'}: ${b.code} ${b.title}`, details: b.change_note || '', entity: 'sops', entity_id: id, required_role: 'owner' }, req.user);
  else notify({ roles: Object.keys(ROLES), except: req.user.id }, { title: `Procedure updated: ${b.code} ${b.title}`, body: b.change_note || 'Please read the new version.', link: `/handbook/${b.code}` });
  audit(req, 'sop.saved', 'sops', id, { code: b.code, note: b.change_note });
  req.flash('success', direct ? 'Saved and published. Staff have been asked to read the new version.' : 'Saved as a draft and sent to the Owner for approval. Staff still see the previous text until it is approved.');
  res.redirect(`/handbook/${b.code}`);
});

// ── Training ──
const modulesFor = (user) => db.all(`SELECT m.*, tr.quiz_score, tr.quiz_passed, tr.attempts, tr.practical_passed, tr.practical_at, (SELECT COUNT(*) FROM quiz_questions q WHERE q.module_id = m.id) AS questions
  FROM training_modules m LEFT JOIN training_records tr ON tr.module_id = m.id AND tr.user_id = ? WHERE m.active = 1 ORDER BY m.position`, user.id)
  .map((m) => ({ ...m, required: !m.roles || (`,${m.roles},`).includes(`,${user.role},`) }));

r.get('/training', (req, res) => {
  const modules = modulesFor(req.user);
  res.page('training', 'Training', { modules });
});

r.get('/training/matrix', requirePerm('training.assess'), (req, res) => {
  const ids = access.siteIds(req.user);
  const fl = filters(req.query, { q: F.search('u.name'), role: F.eq('u.role'), cleared: (v) => ['u.cleared_to_work_alone = ?', v === 'yes' ? 1 : 0] });
  const p = paginate(req, `SELECT DISTINCT u.* FROM users u LEFT JOIN user_sites us ON us.user_id = u.id WHERE u.active = 1 AND u.role != 'owner' AND (us.site_id IN (${ids.map(Number).join(',') || 0}) OR u.role IN ('ops_manager','accounts') OR ${access.seesAllSites(req.user) ? 1 : 0}) AND ${fl.where} ORDER BY u.name`, fl.params, { perPage: 15 });
  const users = p.rows;
  const modules = db.all('SELECT * FROM training_modules WHERE active = 1 ORDER BY position');
  const recs = Object.fromEntries(db.all('SELECT * FROM training_records').map((x) => [`${x.user_id}:${x.module_id}`, x]));
  res.page('training-matrix', 'Training matrix', { p, f: fl.f, users, modules, recs });
});

r.get('/training/:code', (req, res) => {
  const m = db.get('SELECT * FROM training_modules WHERE code = ?', req.params.code);
  if (!m) return res.redirect('/training');
  const qs = db.all('SELECT * FROM quiz_questions WHERE module_id = ? ORDER BY id', m.id).map((q) => ({ ...q, options: JSON.parse(q.options) }));
  const rec = db.get('SELECT * FROM training_records WHERE user_id = ? AND module_id = ?', req.user.id, m.id);
  const sops = (m.sop_codes || '').split(',').filter(Boolean).map((c) => db.get('SELECT code, title FROM sops WHERE code = ?', c.trim())).filter(Boolean);
  const trainees = access.can(req.user, 'training.assess') && m.practical_required ? db.all(`SELECT u.id, u.name, tr.quiz_passed, tr.practical_passed FROM users u LEFT JOIN training_records tr ON tr.user_id = u.id AND tr.module_id = ? WHERE u.active = 1 AND u.role != 'owner' ORDER BY tr.practical_passed IS NOT NULL, u.name`, m.id) : [];
  res.page('training-module', m.title, { m, qs, rec, sops, trainees, result: req.session.quizResult?.module === m.id ? req.session.quizResult : null });
  delete req.session.quizResult;
});

r.post('/training/:code/quiz', (req, res) => {
  const m = db.get('SELECT * FROM training_modules WHERE code = ?', req.params.code);
  const qs = db.all('SELECT * FROM quiz_questions WHERE module_id = ? ORDER BY id', m.id);
  const answers = qs.map((q) => ({ id: q.id, given: req.body[`q_${q.id}`] == null ? null : Number(req.body[`q_${q.id}`]), correct: q.correct_index, explanation: q.explanation }));
  const right = answers.filter((a) => a.given === a.correct).length;
  const score = qs.length ? Math.round((right / qs.length) * 100) : 100;
  const passed = score >= m.pass_mark ? 1 : 0;
  db.run(`INSERT INTO training_records(user_id, module_id, quiz_score, quiz_passed, attempts, quiz_completed_at) VALUES (?,?,?,?,1,?)
    ON CONFLICT(user_id, module_id) DO UPDATE SET quiz_score = excluded.quiz_score, quiz_passed = MAX(quiz_passed, excluded.quiz_passed), attempts = attempts + 1, quiz_completed_at = excluded.quiz_completed_at`, req.user.id, m.id, score, passed, sqlNow());
  audit(req, 'training.quiz', 'training_modules', m.id, { score, passed });
  req.session.quizResult = { module: m.id, score, passed, answers };
  res.redirect(`/training/${m.code}#result`);
});

r.post('/training/:code/practical', requirePerm('training.assess'), (req, res) => {
  const m = db.get('SELECT * FROM training_modules WHERE code = ?', req.params.code);
  const uid = Number(req.body.user_id);
  if (uid === req.user.id) { req.flash('error', 'You cannot assess yourself.'); return res.back(); }
  const passed = req.body.result === 'pass' ? 1 : 0;
  db.run(`INSERT INTO training_records(user_id, module_id, practical_passed, practical_assessor, practical_notes, practical_at, retrain_due) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id, module_id) DO UPDATE SET practical_passed = excluded.practical_passed, practical_assessor = excluded.practical_assessor, practical_notes = excluded.practical_notes, practical_at = excluded.practical_at, retrain_due = excluded.retrain_due`,
  uid, m.id, passed, req.user.id, req.body.notes || null, sqlNow(), passed ? null : req.body.retrain_due || addDays(today(), 7));
  // Cleared to work alone once every required module has quiz + practical passed.
  const u = db.get('SELECT * FROM users WHERE id = ?', uid);
  const required = db.all("SELECT * FROM training_modules WHERE active = 1 AND (roles = '' OR roles IS NULL OR (',' || roles || ',') LIKE ?)", `%,${u.role},%`);
  const ok = required.every((rm) => { const rec = db.get('SELECT * FROM training_records WHERE user_id = ? AND module_id = ?', uid, rm.id); return rec?.quiz_passed && (!rm.practical_required || rec.practical_passed); });
  if (ok && !u.cleared_to_work_alone) { db.update('users', uid, { cleared_to_work_alone: 1 }); notify({ users: [uid] }, { level: 'success', title: 'You are cleared to work alone 🎉', body: 'All required training and practical tests passed.' }); }
  notify({ users: [uid] }, { level: passed ? 'success' : 'warning', title: `Practical ${passed ? 'passed' : 'not yet passed'}: ${m.title}`, body: req.body.notes || '', link: `/training/${m.code}` });
  audit(req, 'training.practical', 'training_modules', m.id, { user: uid, passed });
  req.flash('success', `Practical result recorded${ok ? ' — staff member is now cleared to work alone' : ''}.`);
  res.redirect(`/training/${m.code}`);
});

module.exports = r;
