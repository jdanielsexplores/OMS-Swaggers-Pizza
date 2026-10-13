// Incident lifecycle: record → notify → assign → track → verify → close.
const db = require('../db');
const { notify } = require('./notify');
const { makeRef, addMinutes, sqlNow, parseSql, titleCase } = require('../lib/util');

const SLA = {
  critical: { ackMins: 15, resolveMins: 4 * 60, label: 'Ack 15 min · fix 4 h' },
  major: { ackMins: 30, resolveMins: 24 * 60, label: 'Ack 30 min · fix 24 h' },
  minor: { ackMins: 8 * 60, resolveMins: 7 * 24 * 60, label: 'Ack same day · fix 7 days' },
};
const OPEN_STATUSES = ['open', 'acknowledged', 'assigned', 'in_progress', 'awaiting_verification'];
const TYPES = ['machine', 'payment', 'food_safety', 'stock', 'customer', 'site_safety', 'security', 'other'];

function setMachineStatus(machineId, status, reason, userId) {
  const m = db.get('SELECT * FROM machines WHERE id = ?', machineId);
  if (!m || m.status === status) return;
  const now = sqlNow();
  db.run('UPDATE machine_status_log SET ended_at = ? WHERE machine_id = ? AND ended_at IS NULL', now, machineId);
  db.insert('machine_status_log', { machine_id: machineId, status, reason, started_at: now, user_id: userId });
  db.update('machines', machineId, { status, status_reason: reason, status_changed_at: now });
}

function timeline(incidentId, userId, kind, body) {
  db.insert('incident_updates', { incident_id: incidentId, user_id: userId, kind, body });
  db.run("UPDATE incidents SET updated_at = datetime('now') WHERE id = ?", incidentId);
}

function create(data, user) {
  const severity = data.severity || 'minor';
  const due = addMinutes(new Date(), SLA[severity].resolveMins);
  const id = db.insert('incidents', {
    ref: makeRef('INC'),
    site_id: data.site_id || null,
    machine_id: data.machine_id || null,
    type: data.type || 'other',
    severity,
    title: data.title,
    description: data.description,
    action_taken: data.action_taken,
    error_message: data.error_message,
    order_ref: data.order_ref,
    payment_ref: data.payment_ref,
    sales_paused: data.sales_paused ? 1 : 0,
    reported_by: user?.id ?? null,
    source: data.source || 'staff',
    source_id: data.source_id,
    due_at: due,
  });
  const inc = db.get('SELECT * FROM incidents WHERE id = ?', id);
  timeline(id, user?.id, 'system', `Reported (${severity}, ${titleCase(inc.type)}) via ${inc.source}.`);

  if (inc.machine_id && (inc.sales_paused || severity !== 'minor')) {
    setMachineStatus(inc.machine_id, inc.sales_paused ? 'offline' : 'degraded', `${inc.ref}: ${inc.title}`, user?.id);
  }
  const site = inc.site_id ? db.get('SELECT name FROM sites WHERE id = ?', inc.site_id) : null;
  const level = severity === 'critical' ? 'critical' : severity === 'major' ? 'warning' : 'info';
  const roles = severity === 'minor' ? ['ops_manager', 'supervisor'] : ['ops_manager', 'supervisor', ...(severity === 'critical' ? ['owner'] : [])];
  if (inc.type === 'payment') roles.push('accounts');
  if (inc.type === 'machine' && severity !== 'minor') roles.push('technician');
  notify({ roles, siteId: inc.site_id, except: user?.id }, {
    level,
    title: `${severity.toUpperCase()}: ${inc.title}`,
    body: `${site?.name || 'No site'} · ${titleCase(inc.type)}${inc.sales_paused ? ' · SALES PAUSED' : ''}`,
    link: `/incidents/${id}`,
  });
  return inc;
}

function changeStatus(id, status, user, note) {
  const inc = db.get('SELECT * FROM incidents WHERE id = ?', id);
  if (!inc) throw new Error('Incident not found');
  const patch = { status };
  const now = sqlNow();
  if (status === 'acknowledged' && !inc.acknowledged_at) patch.acknowledged_at = now;
  if (['assigned', 'in_progress'].includes(status) && !inc.acknowledged_at) patch.acknowledged_at = now;
  if (status === 'resolved') {
    patch.resolved_at = now;
    patch.downtime_minutes = Math.round((Date.now() - parseSql(inc.created_at).getTime()) / 60000);
  }
  if (status === 'closed') patch.closed_at = now;
  db.update('incidents', id, patch);
  timeline(id, user?.id, 'status', `Status → ${titleCase(status)}${note ? `: ${note}` : ''}`);

  if (['resolved', 'closed'].includes(status) && inc.machine_id) {
    const stillOpen = db.val(`SELECT COUNT(*) FROM incidents WHERE machine_id = ? AND id != ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) AND severity != 'minor'`, inc.machine_id, id, ...OPEN_STATUSES);
    if (!stillOpen) setMachineStatus(inc.machine_id, 'online', `Returned to service after ${inc.ref}`, user?.id);
  }
  if (inc.reported_by && inc.reported_by !== user?.id) {
    notify({ users: [inc.reported_by] }, { level: status === 'resolved' ? 'success' : 'info', title: `${inc.ref} is now ${titleCase(status)}`, body: inc.title, link: `/incidents/${id}` });
  }
}

function assign(id, assigneeId, user, vendorId) {
  const inc = db.get('SELECT * FROM incidents WHERE id = ?', id);
  const patch = { assigned_to: assigneeId || null, vendor_id: vendorId || null };
  if (OPEN_STATUSES.slice(0, 2).includes(inc.status)) patch.status = 'assigned';
  if (!inc.acknowledged_at) patch.acknowledged_at = sqlNow();
  db.update('incidents', id, patch);
  const who = assigneeId ? db.get('SELECT name FROM users WHERE id = ?', assigneeId)?.name : null;
  const vendor = vendorId ? db.get('SELECT name FROM vendors WHERE id = ?', vendorId)?.name : null;
  timeline(id, user?.id, 'assign', `Assigned to ${[who, vendor].filter(Boolean).join(' / ') || 'nobody'}`);
  if (assigneeId) notify({ users: [assigneeId] }, { level: inc.severity === 'critical' ? 'critical' : 'warning', title: `Assigned to you: ${inc.ref}`, body: inc.title, link: `/incidents/${id}` });
}

module.exports = { SLA, OPEN_STATUSES, TYPES, create, changeStatus, assign, timeline, setMachineStatus };
