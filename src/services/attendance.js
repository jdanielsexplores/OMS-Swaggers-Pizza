// Attendance rules engine — the single source of truth for clock-in/out validation, lateness, overtime and absences.
// All times are server time in the business timezone (Africa/Accra = UTC+0, no daylight saving).
const db = require('../db');
const { today, nowTime, sqlNow, addDays, parseSql } = require('../lib/util');

const setting = (k, d) => Number(db.setting(k, d));
const rules = () => ({
  geofenceMode: db.setting('geofence_mode', 'enforce'),         // enforce | warn | off
  defaultRadius: setting('geofence_default_radius_m', '150'),
  maxAccuracy: setting('geofence_max_accuracy_m', '100'),        // reject very inaccurate GPS fixes
  graceMins: setting('late_grace_minutes', '5'),
  cutoffHours: setting('clockin_cutoff_hours', '5'),             // can't clock in later than start + 5h
  standardHours: setting('standard_work_hours', '8'),
  overtimeGraceHours: setting('overtime_grace_hours', '1'),
  earliestMins: setting('clockin_earliest_minutes', '60'),       // can't clock in more than 60 min early
});

// Haversine distance in metres.
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000; const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1); const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dow = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

// Which fence applies to this person at this site.
function fenceFor(user, site) {
  if (user.geofence_mode === 'exempt') return { exempt: true };
  if (user.geofence_mode === 'custom' && user.geo_lat != null) return { lat: user.geo_lat, lng: user.geo_lng, radius: user.geo_radius_m || rules().defaultRadius, label: 'personal location' };
  if (site?.latitude == null) return { missing: true };
  return { lat: site.latitude, lng: site.longitude, radius: site.geofence_radius_m || rules().defaultRadius, label: site.name };
}

// Server-side geofence check. Returns { ok, distance, message, warn }.
function checkFence(user, site, lat, lng, accuracy) {
  const r = rules();
  if (r.geofenceMode === 'off') return { ok: true };
  const f = fenceFor(user, site);
  if (f.exempt) return { ok: true, exempt: true };
  if (f.missing) return { ok: true, warn: `${site?.name || 'This site'} has no geofence location set yet — ask a manager to set it.` };
  if (lat == null || lng == null) return fail(r, 'Location is required to clock in. Allow location access in your browser and try again.');
  if (accuracy != null && accuracy > r.maxAccuracy) return fail(r, `Your GPS signal is too weak (±${Math.round(accuracy)} m). Step outside or wait a moment and try again.`);
  const d = distanceM(lat, lng, f.lat, f.lng);
  if (d > f.radius) return { ...fail(r, `You are ${Math.round(d)} m from ${f.label} (allowed: ${f.radius} m). You must be on site to clock in or out.`), distance: d };
  return { ok: true, distance: d };
}
const fail = (r, message) => (r.geofenceMode === 'warn' ? { ok: true, warn: message } : { ok: false, message });

// Scheduled start/end for a person on a date: rostered shift first, then their default work schedule.
function scheduleFor(userId, date, siteId) {
  const shift = db.get(`SELECT * FROM shifts WHERE user_id = ? AND shift_date = ? AND status != 'cancelled' ${siteId ? 'ORDER BY site_id = ? DESC,' : 'ORDER BY'} start_time LIMIT 1`, ...(siteId ? [userId, date, siteId] : [userId, date]));
  if (shift) return { start: shift.start_time, end: shift.end_time, shift_id: shift.id, site_id: shift.site_id, source: 'roster' };
  const u = db.get('SELECT work_days, work_start, work_end FROM users WHERE id = ?', userId);
  if (u && String(u.work_days || '').split(',').map(Number).includes(dow(date))) return { start: u.work_start || '07:00', end: u.work_end || '15:00', source: 'default' };
  return null;
}

const approvedLeave = (userId, date) => db.get("SELECT * FROM leave_requests WHERE user_id = ? AND status = 'approved' AND leave_type != 'late_permission' AND ? BETWEEN start_date AND end_date", userId, date);
const latePermission = (userId, date) => db.get("SELECT * FROM leave_requests WHERE user_id = ? AND status = 'approved' AND leave_type = 'late_permission' AND start_date = ? ORDER BY until_time DESC LIMIT 1", userId, date);

// Recalculate lateness / worked time / overtime for one attendance record.
function recalc(attendanceId) {
  const a = db.get('SELECT * FROM attendance WHERE id = ?', attendanceId);
  if (!a) return null;
  const r = rules();
  const date = a.work_date || a.clock_in.slice(0, 10);
  const sched = scheduleFor(a.user_id, date, a.site_id);
  const perm = latePermission(a.user_id, date);
  let effective = sched?.start || null;
  if (effective && perm?.until_time && toMin(perm.until_time) > toMin(effective)) effective = perm.until_time;
  const inMin = toMin(a.clock_in.slice(11, 16));
  const late = effective ? Math.max(0, inMin - toMin(effective) - r.graceMins) : 0;
  let worked = null; let ot = 0;
  if (a.clock_out) {
    worked = Math.max(0, Math.round((parseSql(a.clock_out) - parseSql(a.clock_in)) / 60000));
    ot = Math.max(0, Math.floor((worked - (r.standardHours + r.overtimeGraceHours) * 60) / 60));
  }
  if (a.overtime_override != null) ot = a.overtime_override;
  db.update('attendance', a.id, { work_date: date, scheduled_start: sched?.start || null, effective_start: effective, late_minutes: late, worked_minutes: worked, overtime_hours: ot, shift_id: a.shift_id || sched?.shift_id || null });
  return db.get('SELECT * FROM attendance WHERE id = ?', a.id);
}

function recalcUserDate(userId, date) {
  for (const a of db.all("SELECT id FROM attendance WHERE user_id = ? AND COALESCE(work_date, substr(clock_in,1,10)) = ?", userId, date)) recalc(a.id);
}

// Validate and perform a clock-in. Throws an Error with a user-friendly message on rejection.
function clockIn(user, site, { lat, lng, accuracy, ip }) {
  if (user.status === 'suspended' || !user.active) throw new Error('Your account is not active. Speak to your manager.');
  const date = today();
  const now = nowTime();
  if (db.get('SELECT 1 FROM attendance WHERE user_id = ? AND clock_out IS NULL', user.id)) throw new Error('You are already clocked in.');
  const r = rules();
  const leave = approvedLeave(user.id, date);
  if (leave) throw new Error(`You are on approved ${leave.leave_type} leave today.`);
  const sched = scheduleFor(user.id, date, site.id);
  if (sched) {
    if (toMin(now) < toMin(sched.start) - r.earliestMins) throw new Error(`Too early — your shift starts at ${sched.start}. You can clock in from ${fromMin(toMin(sched.start) - r.earliestMins)}.`);
    const perm = latePermission(user.id, date);
    const base = perm?.until_time && toMin(perm.until_time) > toMin(sched.start) ? perm.until_time : sched.start;
    if (toMin(now) > toMin(base) + r.cutoffHours * 60) throw new Error(`Clock-in closed at ${fromMin(toMin(base) + r.cutoffHours * 60)} (${r.cutoffHours} h after your start). Today counts as absent unless a manager corrects it.`);
  }
  const fence = checkFence(user, site, lat, lng, accuracy);
  if (!fence.ok) { const e = new Error(fence.message); e.geofence = true; e.distance = fence.distance; throw e; }
  const id = db.insert('attendance', { user_id: user.id, site_id: site.id, shift_id: sched?.shift_id, clock_in: sqlNow(), work_date: date, in_lat: lat, in_lng: lng, in_accuracy_m: accuracy, in_distance_m: fence.distance != null ? Math.round(fence.distance) : null, flags: fence.warn ? JSON.stringify({ warn: fence.warn }) : null, source: 'self' });
  if (sched?.shift_id) db.update('shifts', sched.shift_id, { status: 'in_progress' });
  return { record: recalc(id), warn: fence.warn, scheduled: sched };
}

function clockOut(user, { lat, lng, accuracy }) {
  const a = db.get('SELECT * FROM attendance WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1', user.id);
  if (!a) throw new Error('You are not clocked in.');
  const site = db.get('SELECT * FROM sites WHERE id = ?', a.site_id);
  const fence = checkFence(user, site, lat, lng, accuracy);
  if (!fence.ok) { const e = new Error(fence.message.replace('clock in or out', 'clock out')); e.geofence = true; e.distance = fence.distance; throw e; }
  db.update('attendance', a.id, { clock_out: sqlNow(), out_lat: lat, out_lng: lng, out_distance_m: fence.distance != null ? Math.round(fence.distance) : null });
  if (a.shift_id) db.update('shifts', a.shift_id, { status: 'completed' });
  return { record: recalc(a.id), warn: fence.warn };
}

// Scheduler: close any shift still open at 23:59 (flagged for manager review).
function autoClockOut() {
  const open = db.all("SELECT * FROM attendance WHERE clock_out IS NULL AND COALESCE(work_date, substr(clock_in,1,10)) < ?", today());
  const late = nowTime() >= '23:59' ? db.all("SELECT * FROM attendance WHERE clock_out IS NULL AND COALESCE(work_date, substr(clock_in,1,10)) = ?", today()) : [];
  for (const a of [...open, ...late]) {
    const date = a.work_date || a.clock_in.slice(0, 10);
    db.update('attendance', a.id, { clock_out: `${date} 23:59:00`, source: a.source === 'self' ? 'auto_clockout' : a.source, flags: JSON.stringify({ ...(a.flags ? JSON.parse(a.flags) : {}), auto_clockout: true }) });
    recalc(a.id);
  }
  return open.length + late.length;
}

// Per-person summary for a date range — used by payroll, scorecards and the attendance report.
function summary(userId, from, to) {
  let scheduled = 0; let worked = 0; let absent = 0; let leave = 0; let late = 0; let ot = 0; let minutes = 0;
  const absences = [];
  const golive = db.setting('attendance_start_date', '2000-01-01'); // days before go-live never count
  const hired = db.val('SELECT hired_on FROM users WHERE id = ?', userId) || '2000-01-01';
  for (let d = from > golive ? from : golive; d <= to && d <= today(); d = addDays(d, 1)) {
    if (d < hired) continue;
    const sched = scheduleFor(userId, d);
    const recs = db.all("SELECT * FROM attendance WHERE user_id = ? AND COALESCE(work_date, substr(clock_in,1,10)) = ?", userId, d);
    if (approvedLeave(userId, d)) { if (sched) leave++; continue; }
    if (sched) scheduled++;
    if (recs.length) {
      worked++;
      for (const a of recs) { late += a.late_minutes || 0; ot += a.overtime_hours || 0; minutes += a.worked_minutes || 0; }
    } else if (sched && d < today()) { absent++; absences.push(d); }
  }
  return { scheduled, worked, absent, leave, late, ot, minutes, absences };
}

module.exports = { rules, distanceM, checkFence, fenceFor, scheduleFor, recalc, recalcUserDate, clockIn, clockOut, autoClockOut, summary, toMin, fromMin };
