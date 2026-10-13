// Background automation: escalations, missed tasks, stock/expiry alerts, maintenance, digests, backups.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const config = require('../config');
const { notify, once } = require('./notify');
const incidents = require('./incidents');
const metrics = require('./metrics');
const { today, nowTime, addDays, parseSql, money, num, sqlNow } = require('../lib/util');

const OPEN = incidents.OPEN_STATUSES.map((s) => `'${s}'`).join(',');
const minsSince = (s) => (Date.now() - parseSql(s).getTime()) / 60000;

function escalateIncidents() {
  for (const inc of db.all(`SELECT * FROM incidents WHERE status IN (${OPEN})`)) {
    const sla = incidents.SLA[inc.severity];
    const age = minsSince(inc.created_at);
    if (!inc.acknowledged_at && age > sla.ackMins && inc.escalation_level < 1) {
      db.update('incidents', inc.id, { escalation_level: 1 });
      incidents.timeline(inc.id, null, 'escalation', `Not acknowledged within ${sla.ackMins} min — escalated to Operations Manager and Owner.`);
      notify({ roles: ['ops_manager', 'owner'] }, { level: 'critical', title: `ESCALATED ${inc.ref}: not acknowledged`, body: inc.title, link: `/incidents/${inc.id}` });
    }
    if (inc.due_at && parseSql(inc.due_at) < new Date() && inc.escalation_level < 2) {
      db.update('incidents', inc.id, { escalation_level: 2 });
      incidents.timeline(inc.id, null, 'escalation', 'Resolution target missed — escalated to Owner.');
      notify({ roles: ['owner', 'ops_manager'] }, { level: 'critical', title: `OVERDUE ${inc.ref}`, body: `${inc.title} — resolution target missed`, link: `/incidents/${inc.id}` });
    }
  }
}

function missedChecklists() {
  const d = today(); const t = nowTime();
  const templates = db.all("SELECT * FROM checklist_templates WHERE active = 1 AND frequency = 'daily' AND due_time IS NOT NULL");
  for (const site of db.all("SELECT * FROM sites WHERE status = 'active'")) {
    if (site.opening_time && t < site.opening_time) continue;
    for (const tpl of templates) {
      if (tpl.site_type && tpl.site_type !== site.type) continue;
      // Grace period of 30 minutes after due time.
      const [h, m] = tpl.due_time.split(':').map(Number);
      const grace = `${String(Math.floor((h * 60 + m + 30) / 60) % 24).padStart(2, '0')}:${String((m + 30) % 60).padStart(2, '0')}`;
      if (t < grace) continue;
      const done = db.get("SELECT 1 FROM checklist_runs WHERE template_id = ? AND site_id = ? AND run_date = ? AND status IN ('submitted','reviewed')", tpl.id, site.id, d);
      if (done) continue;
      once(`missed:${tpl.id}:${site.id}:${d}`, () => {
        notify({ roles: ['supervisor', 'ops_manager'], siteId: site.id }, {
          level: 'warning', title: `Missed: ${tpl.name} at ${site.name}`, body: `Was due by ${tpl.due_time}. No submission yet.`, link: `/checklists?site=${site.id}`,
        });
        const onShift = db.all("SELECT DISTINCT user_id FROM shifts WHERE site_id = ? AND shift_date = ? AND status IN ('scheduled','in_progress')", site.id, d).map((r) => r.user_id);
        notify({ users: onShift }, { level: 'warning', title: `${tpl.name} is overdue`, body: `Please complete it now at ${site.name}.`, link: `/checklists/start/${tpl.id}?site=${site.id}` });
      });
    }
  }
}

function stockAlerts() {
  const d = today();
  const sites = db.all('SELECT id FROM sites').map((r) => r.id);
  for (const b of metrics.lowStock(sites)) {
    once(`lowstock:${b.location_id}:${b.product_id}:${d}`, () => notify({ roles: ['supervisor', 'stock_staff', 'ops_manager'], siteId: b.site_id }, {
      level: b.qty <= 0 ? 'critical' : 'warning',
      title: `${b.qty <= 0 ? 'OUT OF STOCK' : 'Low stock'}: ${b.product_name} — ${b.location_name}`,
      body: `${num(b.qty)} left (reorder level ${b.reorder_level}). Submit or dispatch a restock.`,
      link: '/stock/restock',
    }));
  }
  for (const b of metrics.expiring(24)) {
    once(`expiry:${b.id}:${d}`, () => notify({ roles: ['stock_staff', 'supervisor', 'ops_manager'] }, {
      level: 'warning', title: `Expiring soon: ${b.product_name} batch ${b.batch_no}`, body: `Expires ${b.expires_at}. Load first (FEFO) or remove when expired.`, link: '/stock/batches',
    }));
    if (parseSql(b.expires_at) < new Date()) db.update('batches', b.id, { status: 'expired' });
  }
}

function maintenanceDue() {
  const d = today();
  for (const m of db.all("SELECT * FROM machines WHERE status != 'decommissioned' AND last_service_on IS NOT NULL")) {
    const due = addDays(m.last_service_on, m.service_interval_days || 30);
    if (due <= d) once(`service:${m.id}:${due}`, () => notify({ roles: ['ops_manager', 'technician'] }, {
      level: 'warning', title: `Preventive maintenance due: ${m.code}`, body: `Last serviced ${m.last_service_on}; due ${due}.`, link: `/machines/${m.id}`,
    }));
  }
}

function overdueTasks() {
  for (const t of db.all("SELECT * FROM tasks WHERE status IN ('open','in_progress') AND due_at IS NOT NULL AND due_at < datetime('now')")) {
    once(`task:${t.id}:overdue`, () => {
      notify({ users: [t.assigned_to] }, { level: 'warning', title: `Overdue task: ${t.title}`, link: `/tasks/${t.id}` });
      notify({ users: [t.created_by], except: t.assigned_to }, { level: 'info', title: `Task overdue: ${t.title}`, link: `/tasks/${t.id}` });
    });
  }
}

function machineHeartbeats() {
  const mins = Number(db.setting('heartbeat_timeout_mins', 20));
  for (const m of db.all("SELECT * FROM machines WHERE api_key IS NOT NULL AND last_heartbeat IS NOT NULL AND status IN ('online','degraded')")) {
    if (minsSince(m.last_heartbeat) > mins) {
      once(`hb:${m.id}:${m.last_heartbeat}`, () => {
        incidents.create({ site_id: m.site_id, machine_id: m.id, type: 'machine', severity: 'major', title: `${m.code} stopped reporting (no heartbeat for ${mins} min)`, source: 'system', sales_paused: 1 }, null);
      });
    }
  }
}

function missedShifts() {
  const d = today(); const t = nowTime();
  for (const s of db.all("SELECT * FROM shifts WHERE status = 'scheduled' AND (shift_date < ? OR (shift_date = ? AND end_time < ?))", d, d, t)) {
    const came = db.get('SELECT 1 FROM attendance WHERE shift_id = ? OR (user_id = ? AND COALESCE(work_date, date(clock_in)) = ?)', s.id, s.user_id, s.shift_date);
    db.update('shifts', s.id, { status: came ? 'completed' : 'missed' });
    if (!came) notify({ roles: ['supervisor', 'ops_manager'], siteId: s.site_id }, { level: 'warning', title: 'Missed shift (no clock-in)', body: `${db.val('SELECT name FROM users WHERE id = ?', s.user_id)} — ${s.shift_date} ${s.start_time}`, link: '/roster' });
  }
  // Late clock-in alert: shift started 15+ min ago, nobody clocked in.
  for (const s of db.all("SELECT * FROM shifts WHERE status = 'scheduled' AND shift_date = ? AND start_time <= ?", d, t)) {
    const [h, m] = s.start_time.split(':').map(Number); const [nh, nm] = t.split(':').map(Number);
    if (nh * 60 + nm - (h * 60 + m) < 15) continue;
    once(`late:${s.id}`, () => notify({ roles: ['supervisor', 'ops_manager'], siteId: s.site_id }, {
      level: 'warning', title: 'Staff not clocked in', body: `${db.val('SELECT name FROM users WHERE id = ?', s.user_id)} was due at ${s.start_time} (${db.val('SELECT name FROM sites WHERE id = ?', s.site_id)}).`, link: '/attendance',
    }));
  }
}

function closeoutChecks() {
  const cutoff = addDays(today(), -2);
  const n = db.val('SELECT COUNT(*) FROM daily_closeouts WHERE verified_at IS NULL AND business_date <= ?', cutoff);
  if (n) once(`closeouts:${today()}`, () => notify({ roles: ['accounts', 'owner'] }, { level: 'warning', title: `${n} daily close-out(s) unverified for 2+ days`, link: '/sales' }));
}

function dailyDigest() {
  const t = nowTime();
  const digestAt = db.setting('digest_time', '21:45');
  if (t < digestAt) return;
  once(`digest:${today()}`, async () => {
    const all = db.all('SELECT id FROM sites').map((r) => r.id);
    const d = today();
    const s = metrics.sales(all, d, d);
    const inc = metrics.incidentsSummary(all);
    const wasteUnits = metrics.waste(all, d, d).reduce((a, r) => a + r.units, 0);
    const comp = metrics.checklistCompliance(all, d, d);
    const avgComp = comp.length ? comp.reduce((a, r) => a + (r.compliance || 0), 0) / comp.length : 0;
    let body = `Revenue ${money(s.revenue)} · ${num(s.units)} pizzas · ${inc.open || 0} open incidents (${inc.critical || 0} critical) · waste ${num(wasteUnits)} · checklist compliance ${avgComp.toFixed(0)}%`;
    try {
      const ai = require('./ai');
      if (ai.enabled()) body = (await ai.dailySummary()) || body;
    } catch (e) { console.error('[digest ai]', e.message); }
    notify({ roles: ['owner', 'ops_manager'] }, { level: 'info', title: `Daily summary — ${d}`, body, link: '/reports/daily', email: true });
  });
}

function backup() {
  if (nowTime() < '02:00' || nowTime() > '03:00') return;
  once(`backup:${today()}`, () => {
    fs.mkdirSync(config.backupDir, { recursive: true });
    const file = path.join(config.backupDir, `swaggers-${today()}.db`);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      // Keep 30 days.
      for (const f of fs.readdirSync(config.backupDir).sort().slice(0, -30)) fs.unlinkSync(path.join(config.backupDir, f));
      db.setSetting('last_backup_at', sqlNow());
    } catch (e) { console.error('[backup]', e.message); }
  });
}

function autoClockOut() {
  const n = require('./attendance').autoClockOut();
  if (n) notify({ roles: ['ops_manager'] }, { level: 'warning', title: `${n} open shift(s) auto clocked-out at 23:59`, body: 'Please review and correct the times if needed.', link: '/attendance' });
}

const jobs = { autoClockOut, escalateIncidents, missedChecklists, stockAlerts, maintenanceDue, overdueTasks, machineHeartbeats, missedShifts, closeoutChecks, dailyDigest, backup };

function runAll() {
  for (const [name, fn] of Object.entries(jobs)) {
    try { fn(); } catch (e) { console.error(`[scheduler:${name}]`, e.message); }
  }
}

function start() {
  setTimeout(runAll, 5000);
  setInterval(runAll, 5 * 60 * 1000).unref();
}

module.exports = { start, runAll, jobs };
