const express = require('express');
const db = require('../db');
const access = require('../services/access');
const incidents = require('../services/incidents');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { requirePerm, fileFor } = require('../middleware');
const { today, sqlNow, toNum, addDays } = require('../lib/util');
const { paginate, filters, F } = require('../lib/paging');

const r = express.Router();
const tempRange = () => ({ min: Number(db.setting('temp_min', '-18')), max: Number(db.setting('temp_max', '5')) });

function loadRun(id) {
  const run = db.get(`SELECT r.*, t.name AS tpl_name, t.code AS tpl_code, t.sop_code, t.category, t.description AS tpl_desc, s.name AS site_name, m.code AS machine_code, u.name AS user_name, rv.name AS reviewer_name
    FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id JOIN sites s ON s.id = r.site_id LEFT JOIN machines m ON m.id = r.machine_id JOIN users u ON u.id = r.user_id LEFT JOIN users rv ON rv.id = r.reviewed_by WHERE r.id = ?`, id);
  if (!run) return null;
  const items = db.all('SELECT i.*, x.answer, x.value, x.notes AS resp_notes, x.photo FROM checklist_items i LEFT JOIN checklist_responses x ON x.item_id = i.id AND x.run_id = ? WHERE i.template_id = ? ORDER BY i.position', id, run.template_id);
  return { run, items };
}

r.get('/checklists', (req, res) => {
  const sites = access.sitesFor(req.user);
  const siteId = Number(req.query.site) || res.locals.clockedIn?.site_id || sites[0]?.id;
  const site = sites.find((s) => s.id === siteId);
  const date = req.query.date || today();
  const templates = db.all('SELECT * FROM checklist_templates WHERE active = 1 AND (site_type IS NULL OR site_type = ?) ORDER BY CASE frequency WHEN \'daily\' THEN 0 WHEN \'per_shift\' THEN 1 WHEN \'ad_hoc\' THEN 2 ELSE 3 END, due_time', site?.type || '')
    .map((t) => ({ ...t, runs: db.all('SELECT r.*, u.name AS user_name FROM checklist_runs r JOIN users u ON u.id = r.user_id WHERE r.template_id = ? AND r.site_id = ? AND r.run_date = ? ORDER BY r.started_at', t.id, siteId || 0, date) }));
  const h = filters(req.query, {
    htpl: F.eq('r.template_id'), hstatus: F.eq('r.status'), hsite: F.eq('r.site_id'), hstaff: F.eq('r.user_id'),
    hfrom: F.dateFrom('r.run_date'), hto: F.dateTo('r.run_date'),
    hfailed: (v) => (v === '1' ? ['r.failed_count > 0'] : null),
  }, [access.siteFilter(req.user, 'r.site_id')]);
  const hp = paginate(req, `SELECT r.*, t.name AS tpl_name, u.name AS user_name, s.name AS site_name FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id JOIN users u ON u.id = r.user_id JOIN sites s ON s.id = r.site_id
    WHERE ${h.where} ORDER BY r.started_at DESC`, h.params, { param: 'hpage', perPage: 15 });
  const history = hp.rows;
  res.page('checklists', 'Checklists', { sites, site, siteId, date, templates, history, hp, hf: h.f, allTemplates: db.all('SELECT id, name FROM checklist_templates ORDER BY name'), people: db.all(`SELECT DISTINCT u.id, u.name FROM users u JOIN checklist_runs r ON r.user_id = u.id WHERE ${access.siteFilter(req.user, 'r.site_id')} ORDER BY u.name`), reviewCount: access.can(req.user, 'checklists.review') ? db.val(`SELECT COUNT(*) FROM checklist_runs WHERE status = 'submitted' AND ${access.siteFilter(req.user, 'site_id')}`) : 0 });
});

r.get('/checklists/start/:tplId', (req, res) => {
  const tpl = db.get('SELECT * FROM checklist_templates WHERE id = ? AND active = 1', req.params.tplId);
  const siteId = Number(req.query.site) || res.locals.clockedIn?.site_id || access.siteIds(req.user)[0];
  if (!tpl || !siteId || !access.canSite(req.user, siteId)) { req.flash('error', 'Choose one of your sites first.'); return res.redirect('/checklists'); }
  const machineId = Number(req.query.machine) || db.val("SELECT id FROM machines WHERE site_id = ? AND status != 'decommissioned' ORDER BY id LIMIT 1", siteId) || null;
  const existing = tpl.frequency !== 'ad_hoc' && tpl.frequency !== 'per_shift'
    ? db.get("SELECT id FROM checklist_runs WHERE template_id = ? AND site_id = ? AND run_date = ? AND (machine_id IS ? ) AND status = 'draft'", tpl.id, siteId, today(), machineId)
    : db.get("SELECT id FROM checklist_runs WHERE template_id = ? AND site_id = ? AND user_id = ? AND run_date = ? AND status = 'draft'", tpl.id, siteId, req.user.id, today());
  if (existing) return res.redirect(`/checklists/run/${existing.id}`);
  const shift = db.get("SELECT id FROM shifts WHERE user_id = ? AND site_id = ? AND shift_date = ? AND status != 'cancelled' LIMIT 1", req.user.id, siteId, today());
  const id = db.insert('checklist_runs', { template_id: tpl.id, site_id: siteId, machine_id: machineId, user_id: req.user.id, shift_id: shift?.id, run_date: today() });
  res.redirect(`/checklists/run/${id}`);
});

r.get('/checklists/run/:id', (req, res) => {
  const data = loadRun(req.params.id);
  if (!data || !access.canSite(req.user, data.run.site_id)) return res.redirect('/checklists');
  const editable = data.run.status === 'draft' && data.run.user_id === req.user.id;
  res.page('checklist-run', data.run.tpl_name, {
    ...data, editable, range: tempRange(),
    corrections: db.all('SELECT c.*, u.name, i.text FROM checklist_corrections c JOIN users u ON u.id = c.user_id LEFT JOIN checklist_items i ON i.id = c.item_id WHERE c.run_id = ? ORDER BY c.created_at', data.run.id),
    machines: db.all("SELECT id, code FROM machines WHERE site_id = ? AND status != 'decommissioned'", data.run.site_id),
  });
});

r.post('/checklists/run/:id', (req, res) => {
  const data = loadRun(req.params.id);
  if (!data || data.run.status !== 'draft' || data.run.user_id !== req.user.id) { req.flash('error', 'This checklist can no longer be edited.'); return res.redirect(`/checklists/run/${req.params.id}`); }
  const { run, items } = data;
  const range = tempRange();
  const submit = req.body.action === 'submit';
  const missing = []; const failed = [];
  db.tx(() => {
    if (req.body.machine_id) db.update('checklist_runs', run.id, { machine_id: toNum(req.body.machine_id) });
    for (const it of items) {
      const key = `item_${it.id}`;
      let answer = req.body[key] || null; let value = null;
      if (it.response_type === 'temperature' || it.response_type === 'number') {
        value = toNum(req.body[key]);
        answer = value == null ? null : 'value';
      }
      const photo = fileFor(req, `photo_${it.id}`) || it.photo || null;
      const notes = req.body[`notes_${it.id}`] || null;
      if (answer || notes || photo) {
        db.run(`INSERT INTO checklist_responses(run_id, item_id, answer, value, notes, photo) VALUES (?,?,?,?,?,?)
          ON CONFLICT(run_id, item_id) DO UPDATE SET answer = excluded.answer, value = excluded.value, notes = excluded.notes, photo = excluded.photo, answered_at = datetime('now')`, run.id, it.id, answer, value, notes, photo);
      }
      if (!answer) missing.push(it.text);
      if (it.requires_photo && answer === 'yes' && !photo && submit) missing.push(`Photo: ${it.text}`);
      const outOfRange = it.response_type === 'temperature' && value != null && (value < (it.min_value ?? range.min) || value > (it.max_value ?? range.max));
      if (answer === 'no' || outOfRange) failed.push({ it, value, notes, outOfRange });
      if (submit && it.response_type === 'temperature' && value != null) {
        db.insert('temperature_logs', { site_id: run.site_id, machine_id: toNum(req.body.machine_id) || run.machine_id, location_label: it.text, reading: value, min_allowed: it.min_value ?? range.min, max_allowed: it.max_value ?? range.max, in_range: outOfRange ? 0 : 1, user_id: req.user.id, action_taken: outOfRange ? notes : null });
      }
    }
  });
  if (!submit) { req.flash('success', 'Progress saved.'); return res.redirect(`/checklists/run/${run.id}`); }
  if (missing.length) { req.flash('error', `Answer every item before submitting (${missing.length} missing). Use N/A where an item does not apply.`); return res.redirect(`/checklists/run/${run.id}`); }

  const answered = items.filter((i) => db.get("SELECT answer FROM checklist_responses WHERE run_id = ? AND item_id = ? AND answer != 'na'", run.id, i.id)).length;
  const score = answered ? Math.round(((answered - failed.length) / answered) * 100) : 100;
  db.update('checklist_runs', run.id, { status: 'submitted', submitted_at: sqlNow(), score, failed_count: failed.length, notes: req.body.run_notes || null });
  audit(req, 'checklist.submitted', 'checklist_runs', run.id, { score, failed: failed.length });

  // Failed critical items raise incidents automatically; others notify the supervisor.
  const machineId = toNum(req.body.machine_id) || run.machine_id;
  let raised = 0;
  for (const f of failed) {
    if (!f.it.critical) continue;
    const isFood = f.outOfRange || /temperature|expiry|food|stock checked|quality/i.test(f.it.text);
    const isSafety = /safe|walkway|wiring|power|seal|tamper|shut-down/i.test(f.it.text);
    incidents.create({
      site_id: run.site_id, machine_id: machineId,
      type: f.outOfRange || isFood ? 'food_safety' : /payment|qr/i.test(f.it.text) ? 'payment' : isSafety ? 'site_safety' : 'machine',
      severity: f.outOfRange || isFood || isSafety ? 'critical' : 'major',
      title: f.outOfRange ? `Temperature out of range: ${f.value}°C (${run.tpl_name})` : `Failed check: ${f.it.text}`,
      description: `Raised automatically from ${run.tpl_name} at ${run.site_name}.${f.notes ? ` Staff note: ${f.notes}` : ''}`,
      source: 'checklist', source_id: run.id,
      sales_paused: f.outOfRange ? 1 : 0,
    }, req.user);
    raised++;
  }
  if (failed.length) {
    notify({ roles: ['supervisor', 'ops_manager'], siteId: run.site_id, except: req.user.id }, { level: 'warning', title: `${run.tpl_name}: ${failed.length} failed item(s) at ${run.site_name}`, body: failed.map((f) => f.it.text).join('; ').slice(0, 250), link: `/checklists/run/${run.id}` });
  }
  req.flash(failed.length ? 'warning' : 'success', failed.length
    ? `Submitted with ${failed.length} failed item(s). ${raised ? `${raised} incident(s) raised and the Manager alerted. Follow the SOP — do not sell if safety is in doubt.` : 'Your Supervisor has been notified.'}`
    : `Submitted — ${score}%. Great work!`);
  res.redirect(failed.length && raised ? '/incidents' : '/');
});

// Corrections after submission are allowed but always audited (Playbook: keep an audit trail).
r.post('/checklists/run/:id/correct', (req, res) => {
  const { run } = loadRun(req.params.id);
  if (run.user_id !== req.user.id && !access.can(req.user, 'checklists.review')) return res.back();
  if (!req.body.reason) { req.flash('error', 'A reason is required for corrections.'); return res.back(); }
  const old = db.get('SELECT * FROM checklist_responses WHERE run_id = ? AND item_id = ?', run.id, req.body.item_id);
  db.insert('checklist_corrections', { run_id: run.id, item_id: toNum(req.body.item_id), old_value: old ? `${old.answer}${old.value != null ? ` ${old.value}` : ''}` : null, new_value: req.body.new_value, reason: req.body.reason, user_id: req.user.id });
  const isNum = req.body.new_value !== '' && !Number.isNaN(Number(req.body.new_value));
  db.run('UPDATE checklist_responses SET answer = ?, value = ? WHERE run_id = ? AND item_id = ?', isNum ? 'value' : req.body.new_value, isNum ? Number(req.body.new_value) : null, run.id, req.body.item_id);
  audit(req, 'checklist.corrected', 'checklist_runs', run.id, req.body);
  req.flash('success', 'Correction recorded in the audit trail.');
  res.back();
});

r.get('/checklists/review', requirePerm('checklists.review'), (req, res) => {
  const { where, params, f } = filters(req.query, { site: F.eq('r.site_id'), failed: (v) => (v === '1' ? ['r.failed_count > 0'] : null), from: F.dateFrom('r.run_date'), to: F.dateTo('r.run_date') }, ["r.status = 'submitted'", access.siteFilter(req.user, 'r.site_id')]);
  const p = paginate(req, `SELECT r.*, t.name AS tpl_name, u.name AS user_name, s.name AS site_name FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id JOIN users u ON u.id = r.user_id JOIN sites s ON s.id = r.site_id
    WHERE ${where} ORDER BY r.failed_count DESC, r.submitted_at DESC`, params);
  res.page('checklist-review', 'Review checklists', { p, runs: p.rows, f, sites: access.sitesFor(req.user) });
});

r.post('/checklists/run/:id/review', requirePerm('checklists.review'), (req, res) => {
  const { run } = loadRun(req.params.id);
  if (run.user_id === req.user.id && req.user.role !== 'owner') { req.flash('error', 'You cannot review your own checklist.'); return res.back(); }
  const reject = req.body.decision === 'reject';
  db.update('checklist_runs', run.id, { status: reject ? 'rejected' : 'reviewed', reviewed_by: req.user.id, reviewed_at: sqlNow(), review_notes: req.body.review_notes || null });
  if (reject) {
    notify({ users: [run.user_id] }, { level: 'warning', title: `Checklist returned: ${run.tpl_name}`, body: req.body.review_notes || 'Please redo this checklist.', link: `/checklists/run/${run.id}` });
    if (req.body.create_task) db.insert('tasks', { title: `Redo ${run.tpl_name} (${run.site_name})`, description: req.body.review_notes, kind: 'corrective_action', site_id: run.site_id, assigned_to: run.user_id, created_by: req.user.id, priority: 'high', due_at: `${today()} 23:59:00` });
  }
  audit(req, reject ? 'checklist.rejected' : 'checklist.reviewed', 'checklist_runs', run.id, req.body);
  req.flash('success', reject ? 'Checklist returned to staff.' : 'Checklist signed off.');
  res.redirect(req.body.next === 'queue' ? '/checklists/review' : `/checklists/run/${run.id}`);
});

// ── Templates ──
r.get('/checklists/templates', requirePerm('checklists.templates'), (req, res) => {
  const templates = db.all('SELECT t.*, (SELECT COUNT(*) FROM checklist_items i WHERE i.template_id = t.id) AS items FROM checklist_templates t ORDER BY t.active DESC, t.category, t.name');
  res.page('checklist-templates', 'Checklist templates', { templates });
});
r.get('/checklists/templates/:id', requirePerm('checklists.templates'), (req, res) => {
  const t = req.params.id === 'new' ? { id: null, frequency: 'daily', category: 'site', roles: 'supervisor,sales_rep' } : db.get('SELECT * FROM checklist_templates WHERE id = ?', req.params.id);
  const items = t.id ? db.all('SELECT * FROM checklist_items WHERE template_id = ? ORDER BY position', t.id) : [];
  res.page('checklist-template', t.name || 'New template', { t, items, sops: db.all('SELECT code, title FROM sops ORDER BY code') });
});
r.post('/checklists/templates', requirePerm('checklists.templates'), (req, res) => {
  const fields = ['name', 'category', 'description', 'frequency', 'due_time', 'roles', 'site_type', 'sop_code'];
  const data = Object.fromEntries(fields.map((f) => [f, req.body[f] || null]));
  let id = toNum(req.body.id);
  if (id) { data.active = req.body.active ? 1 : 0; db.update('checklist_templates', id, data); db.run('UPDATE checklist_templates SET version = version + 1 WHERE id = ?', id); }
  else id = db.insert('checklist_templates', { ...data, code: `CUST-${Date.now().toString(36).toUpperCase()}` });
  audit(req, 'checklist_template.saved', 'checklist_templates', id, data);
  res.redirect(`/checklists/templates/${id}`);
});
r.post('/checklists/templates/:id/items', requirePerm('checklists.templates'), (req, res) => {
  const pos = (db.val('SELECT MAX(position) FROM checklist_items WHERE template_id = ?', req.params.id) || 0) + 1;
  db.insert('checklist_items', { template_id: req.params.id, position: pos, text: req.body.text, guidance: req.body.guidance || null, response_type: req.body.response_type || 'yesno', critical: req.body.critical ? 1 : 0, requires_photo: req.body.requires_photo ? 1 : 0 });
  db.run('UPDATE checklist_templates SET version = version + 1 WHERE id = ?', req.params.id);
  audit(req, 'checklist_item.added', 'checklist_templates', req.params.id, req.body.text);
  res.redirect(`/checklists/templates/${req.params.id}`);
});
r.post('/checklists/items/:id/delete', requirePerm('checklists.templates'), (req, res) => {
  const it = db.get('SELECT * FROM checklist_items WHERE id = ?', req.params.id);
  if (db.get('SELECT 1 FROM checklist_responses WHERE item_id = ?', it.id)) {
    req.flash('error', 'This item has recorded answers, so it is kept for the audit trail. Edit the wording instead or create a new template version.');
  } else {
    db.run('DELETE FROM checklist_items WHERE id = ?', it.id);
    audit(req, 'checklist_item.removed', 'checklist_templates', it.template_id, it.text);
  }
  res.redirect(`/checklists/templates/${it.template_id}`);
});
r.post('/checklists/items/:id', requirePerm('checklists.templates'), (req, res) => {
  const it = db.get('SELECT * FROM checklist_items WHERE id = ?', req.params.id);
  db.update('checklist_items', it.id, { text: req.body.text, critical: req.body.critical ? 1 : 0, requires_photo: req.body.requires_photo ? 1 : 0, guidance: req.body.guidance || null });
  audit(req, 'checklist_item.edited', 'checklist_templates', it.template_id, { from: it.text, to: req.body.text });
  res.redirect(`/checklists/templates/${it.template_id}`);
});

module.exports = r;
