// Monthly payroll generated from authoritative records: compensation, attendance, overtime, leave and absences.
const db = require('../db');
const attendance = require('./attendance');
const { today } = require('../lib/util');

const monthBounds = (m) => { const [y, mo] = m.split('-').map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}`, days: last }; };
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function rates() {
  return {
    workingDays: Number(db.setting('payroll_working_days', '26')),      // for monthly → daily rate
    standardHours: Number(db.setting('standard_work_hours', '8')),
    otMultiplier: Number(db.setting('overtime_multiplier', '1.5')),
    latePerMinute: Number(db.setting('late_deduction_per_minute', '0')),
    lateFreeMinutes: Number(db.setting('late_free_minutes_month', '30')), // monthly allowance before deductions start
    ssnitPct: Number(db.setting('ssnit_employee_pct', '5.5')),
    deductAbsence: db.setting('deduct_absences', '1') === '1',
  };
}

function calcEmployee(u, month) {
  const r = rates();
  const { from, to } = monthBounds(month);
  const s = attendance.summary(u.id, from, to);
  const base = Number(u.base_salary || 0);
  let basePay; let dailyRate; let hourlyRate;
  if (u.pay_type === 'hourly') { hourlyRate = base; dailyRate = base * r.standardHours; basePay = round2((s.minutes / 60) * base); }
  else if (u.pay_type === 'daily') { dailyRate = base; hourlyRate = base / r.standardHours; basePay = round2(s.worked * base); }
  else { basePay = base; dailyRate = base / r.workingDays; hourlyRate = dailyRate / r.standardHours; }
  const allowances = Number(u.allowances || 0);
  const overtimePay = round2(s.ot * hourlyRate * r.otMultiplier);
  const absenceDeduction = u.pay_type === 'monthly' && r.deductAbsence ? round2(s.absent * dailyRate) : 0;
  const lateDeduction = round2(Math.max(0, s.late - r.lateFreeMinutes) * r.latePerMinute);
  const gross = round2(basePay + allowances + overtimePay);
  const ssnit = u.ssnit_applies ? round2(basePay * (r.ssnitPct / 100)) : 0;
  const other = Number(u.other_deductions || 0);
  const net = round2(Math.max(0, gross - absenceDeduction - lateDeduction - ssnit - other));
  return {
    user_id: u.id, pay_type: u.pay_type || 'monthly', base_pay: basePay, allowances,
    scheduled_days: s.scheduled, worked_days: s.worked, absent_days: s.absent, leave_days: s.leave,
    late_minutes: s.late, overtime_hours: s.ot, overtime_pay: overtimePay, absence_deduction: absenceDeduction,
    late_deduction: lateDeduction, ssnit, other_deductions: other, gross, net,
    details: JSON.stringify({ absences: s.absences, dailyRate: round2(dailyRate), hourlyRate: round2(hourlyRate), workedHours: round2(s.minutes / 60), rates: r }),
  };
}

// Generate (or regenerate while still draft) the payroll for a month.
function generate(month, userId) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Choose a month');
  if (month > today().slice(0, 7)) throw new Error('You cannot run payroll for a future month.');
  const existing = db.get('SELECT * FROM payroll_runs WHERE month = ?', month);
  if (existing?.status === 'finalized') throw new Error(`Payroll for ${month} is finalised and locked.`);
  const staff = db.all("SELECT * FROM users WHERE active = 1 AND role != 'owner' AND COALESCE(base_salary,0) > 0 ORDER BY name");
  return db.tx(() => {
    let runId = existing?.id;
    if (runId) db.run('DELETE FROM payroll_items WHERE run_id = ?', runId);
    else runId = db.insert('payroll_runs', { month, generated_by: userId });
    let gross = 0; let net = 0; let ded = 0;
    for (const u of staff) {
      const item = calcEmployee(u, month);
      db.insert('payroll_items', { run_id: runId, ...item });
      gross += item.gross; net += item.net; ded += item.gross - item.net;
    }
    db.update('payroll_runs', runId, { employees: staff.length, gross: round2(gross), net: round2(net), deductions: round2(ded), generated_by: userId, generated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    return runId;
  });
}

function finalize(runId, userId) {
  const run = db.get('SELECT * FROM payroll_runs WHERE id = ?', runId);
  if (!run || run.status === 'finalized') throw new Error('Already finalised');
  const cat = db.val("SELECT id FROM finance_categories WHERE name = 'Salaries/Wages'");
  db.tx(() => {
    db.update('payroll_runs', runId, { status: 'finalized', finalized_by: userId, finalized_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    db.insert('transactions', { kind: 'expense', category_id: cat, amount: run.gross, description: `Payroll ${run.month} (${run.employees} staff, net ${run.net})`, reference: `PAYROLL-${run.month}`, txn_date: monthBounds(run.month).to > today() ? today() : monthBounds(run.month).to, recorded_by: userId });
  });
}

module.exports = { generate, finalize, calcEmployee, rates, monthBounds };
