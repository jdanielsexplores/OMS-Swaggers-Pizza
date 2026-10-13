// End-to-end workflow test against a demo database. Usage: DB_PATH=./data/test.db node scripts/flow-test.js
const assert = require('node:assert');
const app = require('../src/server');
const db = require('../src/db');

const PW = process.env.SEED_PASSWORD || 'demo123';
let base;

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(path, opts = {}) {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: this.cookie, ...(opts.headers || {}) } });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const text = await r.text();
    const m = text.match(/name="_csrf" value="([^"]+)/); if (m) this.csrf = m[1];
    return { status: r.status, location: r.headers.get('location'), text };
  }
  get(path) { return this.req(path); }
  async post(path, data = {}) {
    if (!this.csrf) await this.get('/login');
    const body = new URLSearchParams({ _csrf: this.csrf, ...data });
    const r = await this.req(path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    if (r.status >= 400) throw new Error(`POST ${path} → ${r.status}: ${r.text.match(/font-size:17px">([^<]*)/)?.[1] || r.text.slice(0, 200)}`);
    return r;
  }
  async postForm(path, data = {}, files = {}) {
    const fd = new FormData();
    fd.append('_csrf', this.csrf);
    for (const [k, v] of Object.entries(data)) fd.append(k, v);
    for (const [k, v] of Object.entries(files)) fd.append(k, new Blob([v], { type: 'image/png' }), 'photo.png');
    const r = await this.req(path, { method: 'POST', body: fd });
    if (r.status >= 400) throw new Error(`POST ${path} → ${r.status}`);
    return r;
  }
  async login(email) {
    await this.get('/login');
    const r = await this.post('/login', { email, password: PW });
    assert.equal(r.status, 302, `login ${email}`);
    await this.get('/');
    return this;
  }
}
const as = (email) => new Client().login(email);
const step = (name) => console.log(`✓ ${name}`);

async function main() {
  const kofi = await as('kofi@swaggerspizza.com');
  const kwame = await as('kwame@swaggerspizza.com');
  const ops = await as('ops@swaggerspizza.com');
  const owner = await as('owner@swaggerspizza.com');
  const accounts = await as('accounts@swaggerspizza.com');
  const KIA = db.val("SELECT id FROM sites WHERE code = 'KIA'");
  const M1 = db.val("SELECT id FROM machines WHERE code = 'SWG-KIA-01'");

  // Make clock-in independent of the time of day the test runs.
  db.setSetting('clockin_cutoff_hours', '24'); db.setSetting('clockin_earliest_minutes', '1440');
  const kofiId = db.val("SELECT id FROM users WHERE email = 'kofi@swaggerspizza.com'");
  db.run('DELETE FROM attendance WHERE user_id = ? AND COALESCE(work_date, date(clock_in)) = ?', kofiId, require('../src/lib/util').today());

  // 1. Geofenced clock-in: rejected far away, accepted on site (server-side Haversine check)
  await kofi.post('/attendance/in', { site_id: KIA, lat: '5.6500', lng: '-0.1900', accuracy: '10' });
  assert(!db.get('SELECT 1 FROM attendance WHERE user_id = ? AND clock_out IS NULL', kofiId), 'should be rejected outside the fence');
  assert(db.get("SELECT 1 FROM security_log WHERE event = 'geofence.rejected' AND user_id = ?", kofiId));
  await kofi.post('/attendance/in', { site_id: KIA, lat: '5.6053', lng: '-0.1667', accuracy: '12' });
  const att = db.get('SELECT * FROM attendance WHERE user_id = ? AND clock_out IS NULL', kofiId);
  assert(att && att.in_distance_m < 150 && att.work_date, 'clock-in inside the fence with server time');
  step('Geofence: clock-in 5 km away rejected (security-logged); on-site clock-in accepted with distance recorded');

  // 2. Opening checklist with a failed temperature → critical food-safety incident + sales paused
  const tpl = db.val("SELECT id FROM checklist_templates WHERE code = 'OPEN'");
  let r = await kofi.get(`/checklists/start/${tpl}?site=${KIA}`);
  const runId = Number(r.location.split('/').pop());
  await kofi.get(`/checklists/run/${runId}`);
  const items = db.all('SELECT * FROM checklist_items WHERE template_id = ?', tpl);
  const answers = { action: 'submit', machine_id: M1 };
  const photos = {};
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000000200015e2c2b2a0000000049454e44ae426082', 'hex');
  for (const it of items) { answers[`item_${it.id}`] = it.response_type === 'temperature' ? '9.5' : 'yes'; if (it.requires_photo) photos[`photo_${it.id}`] = png; }
  const before = db.val('SELECT COUNT(*) FROM incidents');
  await kofi.postForm(`/checklists/run/${runId}`, answers, photos);
  const run = db.get('SELECT * FROM checklist_runs WHERE id = ?', runId);
  assert.equal(run.status, 'submitted'); assert.equal(run.failed_count, 1);
  const inc = db.get('SELECT * FROM incidents ORDER BY id DESC LIMIT 1');
  assert(db.val('SELECT COUNT(*) FROM incidents') === before + 1 && inc.type === 'food_safety' && inc.severity === 'critical' && inc.sales_paused === 1);
  assert.equal(db.val('SELECT status FROM machines WHERE id = ?', M1), 'offline');
  assert(db.val("SELECT COUNT(*) FROM notifications WHERE title LIKE 'CRITICAL%' AND user_id = (SELECT id FROM users WHERE role = 'owner')") > 0);
  step('Failed temperature on checklist → critical incident, machine offline, owner alerted');

  // 3. Supervisor reviews and returns the checklist
  await kwame.post(`/checklists/run/${runId}/review`, { decision: 'approve', review_notes: 'Stock held, technician called' });
  assert.equal(db.val('SELECT status FROM checklist_runs WHERE id = ?', runId), 'reviewed');
  step('Supervisor signs off checklist');

  // 4. Ops manager acknowledges, assigns technician, technician resolves with return-to-service, supervisor closes
  const tech = await as('tech@swaggerspizza.com');
  await ops.post(`/incidents/${inc.id}/ack`);
  await ops.post(`/incidents/${inc.id}/assign`, { assigned_to: db.val("SELECT id FROM users WHERE role = 'technician'"), vendor_id: '' , severity: 'critical' });
  await tech.get(`/incidents/${inc.id}`);
  await tech.post(`/incidents/${inc.id}/status`, { status: 'resolved', root_cause: 'Door seal loose', resolution: 'Seal replaced, temp back to 3°C', cost: '150', return_to_service_checked: '1' });
  assert.equal(db.val('SELECT status FROM incidents WHERE id = ?', inc.id), 'resolved');
  assert.equal(db.val('SELECT status FROM machines WHERE id = ?', M1), 'online');
  assert(db.get("SELECT 1 FROM transactions WHERE description LIKE ?", `Repair ${inc.ref}%`));
  await kwame.post(`/incidents/${inc.id}/status`, { status: 'closed', note: 'Verified on site' });
  assert.equal(db.val('SELECT status FROM incidents WHERE id = ?', inc.id), 'closed');
  step('Incident acknowledged → assigned → resolved (cost booked, machine back online) → verified & closed');

  // 5. Report a payment problem → incident + payment exception
  await kofi.post('/report', { type: 'payment', severity: 'major', site_id: KIA, machine_id: M1, title: 'Customer debited, no order', payment_kind: 'deducted_no_order', amount: '85', phone_last4: '1234', payment_ref: 'MPTEST001' });
  const pe = db.get("SELECT * FROM payment_exceptions WHERE payment_ref = 'MPTEST001'");
  assert(pe && pe.customer_phone_last4 === '1234');
  step('Report a payment problem → incident + payment exception (last 4 digits only)');

  // 6. Accounts requests refund → ops approves → accounts pays
  await accounts.post(`/payments/${pe.id}`, { status: 'investigating', resolution: 'Confirmed on provider portal', request_refund: '1' });
  const appr = db.get("SELECT * FROM approvals WHERE kind = 'refund' AND status = 'pending' ORDER BY id DESC LIMIT 1");
  await ops.post(`/approvals/${appr.id}`, { decision: 'approve', notes: 'OK' });
  const rf = db.get('SELECT * FROM refunds WHERE id = ?', appr.entity_id);
  assert.equal(rf.status, 'approved');
  await accounts.post(`/customers/refunds/${rf.id}/pay`, { paid_ref: 'REV-777' });
  assert.equal(db.val('SELECT status FROM refunds WHERE id = ?', rf.id), 'paid');
  assert.equal(db.val('SELECT status FROM payment_exceptions WHERE id = ?', pe.id), 'refunded');
  step('Refund: requested → approved by Ops Manager → paid by Accounts → exception closed');

  // 7. Stock: load machine (FEFO), waste, count with shortage → incident
  const central = db.val("SELECT id FROM stock_locations WHERE kind = 'central'");
  const loc = db.val('SELECT id FROM stock_locations WHERE machine_id = ?', M1);
  const meat = db.val("SELECT id FROM products WHERE sku = 'PZ-MEAT'");
  const stock = require('../src/services/stock');
  const b0 = stock.balance(loc, meat);
  await kofi.post('/stock/load', { from_id: central, machine_id: M1, [`qty_${meat}`]: '10' });
  assert.equal(stock.balance(loc, meat), b0 + 10);
  await kofi.post('/stock/waste', { location_id: loc, product_id: meat, qty: '2', reason: 'damaged' });
  assert.equal(stock.balance(loc, meat), b0 + 8);
  await kofi.post('/stock/count', { location_id: loc, [`count_${meat}`]: String(b0 + 3), [`why_${meat}`]: '' });
  assert.equal(stock.balance(loc, meat), b0 + 3);
  assert(db.get("SELECT 1 FROM incidents WHERE type = 'stock' AND title LIKE 'Unexplained stock shortage%'"));
  step('Stock: FEFO load, waste, count shortage → ledger adjusted + shortage incident');

  // 8. Batch recall alerts sites
  const batch = stock.fefo(loc, meat).find((b) => b.id);
  await ops.post(`/stock/batches/${batch.id}/status`, { status: 'recalled', reason: 'Supplier recall notice' });
  assert(db.get("SELECT 1 FROM notifications WHERE title LIKE 'RECALL:%' AND user_id = (SELECT id FROM users WHERE email = 'kofi@swaggerspizza.com')"));
  await ops.post(`/stock/batches/${batch.id}/status`, { status: 'released', reason: 'Test over' });
  step('Batch recall notifies staff at sites holding that batch');

  // 9. Price change by ops → owner approves → price updated
  await ops.post(`/admin/products/${meat}`, { name: 'Meat Feast', price: '89', unit_cost: '38', reorder_level: '12', available: '1', active: '1', reason: 'Cost increase' });
  assert.equal(db.val('SELECT price FROM products WHERE id = ?', meat), 85);
  const pa = db.get("SELECT * FROM approvals WHERE kind = 'price_change' AND entity_id = ? AND status = 'pending'", meat);
  await owner.post(`/approvals/${pa.id}`, { decision: 'approve' });
  assert.equal(db.val('SELECT price FROM products WHERE id = ?', meat), 89);
  step('Price change: requested by Ops Manager, only applied after Owner approval');

  // 10. SOP edit stays draft until owner approves
  const sop = db.get("SELECT * FROM sops WHERE code = 'SOP-02'");
  await ops.post('/handbook/save', { code: 'SOP-02', title: sop.title, category: sop.category, purpose: sop.purpose, roles: sop.roles, body: sop.body + '\n\n> NEW: Offer the combo of the day.', change_note: 'Add upsell' });
  assert(!db.val("SELECT body FROM sops WHERE code = 'SOP-02'").includes('combo of the day'));
  const sa = db.get("SELECT * FROM approvals WHERE kind = 'sop_change' AND status = 'pending' ORDER BY id DESC LIMIT 1");
  await owner.post(`/approvals/${sa.id}`, { decision: 'approve' });
  const sop2 = db.get("SELECT * FROM sops WHERE code = 'SOP-02'");
  assert(sop2.body.includes('combo of the day') && sop2.version === '2.1');
  step('SOP change kept as draft, published as v2.1 only after Owner approval');

  // 11. Training quiz + practical sign-off
  const mod = db.get("SELECT * FROM training_modules WHERE code = 'TR-03'");
  const qs = db.all('SELECT * FROM quiz_questions WHERE module_id = ?', mod.id);
  const yaw = await as('yaw@swaggerspizza.com');
  await yaw.post('/training/TR-03/quiz', Object.fromEntries(qs.map((q) => [`q_${q.id}`, String(q.correct_index)])));
  const yawId = db.val("SELECT id FROM users WHERE email = 'yaw@swaggerspizza.com'");
  assert.equal(db.get('SELECT * FROM training_records WHERE user_id = ? AND module_id = ?', yawId, mod.id).quiz_score, 100);
  const efua = await as('efua@swaggerspizza.com');
  await efua.post('/training/TR-03/practical', { user_id: yawId, result: 'pass', notes: 'Handled mock mismatch well' });
  assert.equal(db.get('SELECT practical_passed FROM training_records WHERE user_id = ? AND module_id = ?', yawId, mod.id).practical_passed, 1);
  step('Training: quiz scored 100%, practical signed off by supervisor');

  // 12. Customer case + playbook acknowledgement
  await kofi.post('/customers', { category: 'quality', machine_id: M1, description: 'Pizza was cold', rating: '2' });
  assert(db.get("SELECT 1 FROM customer_cases WHERE description = 'Pizza was cold'"));
  await kofi.post('/handbook/acknowledge', { agree: '1', signature: 'Kofi Owusu' });
  assert(db.get("SELECT 1 FROM acknowledgements WHERE signature = 'Kofi Owusu' AND version = '2.0'"));
  step('Customer case recorded; playbook v2.0 e-signed');

  // 13. Handover + clock out (geofenced)
  await kofi.post('/handover', { site_id: KIA, stock_summary: 'OK', open_issues: 'none', notes: 'Keys with Kwame' });
  await kofi.post('/attendance/out', { lat: '5.6052', lng: '-0.1668', accuracy: '9' });
  assert(db.get('SELECT clock_out FROM attendance WHERE id = ?', att.id).clock_out);
  step('Shift handover submitted and clocked out inside the geofence');

  // 13b. Late permission: approving it recalculates lateness (effective start = permitted time)
  const d0 = require('../src/lib/util').addDays(require('../src/lib/util').today(), -2);
  db.run('DELETE FROM attendance WHERE user_id = ? AND COALESCE(work_date, date(clock_in)) = ?', yawId, d0);
  await ops.post('/hr/attendance', { user_id: yawId, site_id: db.val("SELECT id FROM sites WHERE code='UGL'"), date: d0, clock_in: '09:10', clock_out: '17:00', reason: 'Phone died — confirmed by supervisor' });
  const lpBefore = db.get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', yawId, d0);
  assert(lpBefore.late_minutes > 0, 'late before permission');
  const yaw2 = await as('yaw@swaggerspizza.com');
  await yaw2.post('/leave', { leave_type: 'late_permission', start_date: d0, until_time: '09:30', reason: 'Exam' });
  const lp = db.get("SELECT * FROM leave_requests WHERE user_id = ? AND leave_type = 'late_permission' AND start_date = ?", yawId, d0);
  await ops.post(`/leave/${lp.id}/decide`, { decision: 'approve' });
  const lpAfter = db.get('SELECT * FROM attendance WHERE id = ?', lpBefore.id);
  assert.equal(lpAfter.late_minutes, 0); assert.equal(lpAfter.effective_start, '09:30');
  step(`Late permission approved → attendance recalculated (late ${lpBefore.late_minutes} → 0 min, start 09:30)`);

  // 13c. Daily cash-up from the supplier portal + Accounts verification
  const yday = require('../src/lib/util').addDays(require('../src/lib/util').today(), -1);
  const chk = db.val("SELECT id FROM products WHERE sku = 'PZ-CHK'");
  await kwame.post('/sales/cashup', { machine_id: M1, business_date: yday, machine_reported_amount: '1720', machine_reported_orders: '20', machine_status: 'online', [`qty_${chk}`]: '8', notes: 'From portal' });
  const co = db.get('SELECT * FROM daily_closeouts WHERE machine_id = ? AND business_date = ?', M1, yday);
  assert.equal(co.machine_reported_amount, 1720);
  assert.equal(db.val("SELECT ROUND(SUM(amount),2) FROM sales WHERE machine_id = ? AND date(sold_at) = ? AND source = 'supplier_portal'", M1, yday), 1720);
  await accounts.post(`/sales/closeouts/${co.id}/verify`, { provider_settled_amount: '1715' });
  assert(db.get('SELECT verified_at FROM daily_closeouts WHERE id = ?', co.id).verified_at);
  step('Cash-up recorded from the machine portal (sales + stock updated), verified by Accounts with MoMo settlement');

  // 13d. Payroll: generate last month, finalise, staff can see payslip
  const lastMonth = require('../src/lib/util').addDays(require('../src/lib/util').today().slice(0, 8) + '01', -1).slice(0, 7);
  await accounts.post('/payroll/generate', { month: lastMonth });
  const payRun = db.get('SELECT * FROM payroll_runs WHERE month = ?', lastMonth);
  assert(payRun && payRun.employees >= 9 && payRun.net > 0);
  await accounts.post(`/payroll/${payRun.id}/finalize`);
  assert.equal(db.val('SELECT status FROM payroll_runs WHERE id = ?', payRun.id), 'finalized');
  assert(db.get("SELECT 1 FROM transactions WHERE reference = ?", `PAYROLL-${lastMonth}`));
  const slip = await kofi.get('/payroll/my'); assert(slip.text.includes(lastMonth));
  step(`Payroll ${lastMonth}: generated for ${payRun.employees} staff (net ${Math.round(payRun.net)}), finalised, expense posted, payslip visible to staff`);

  // 13e. Access: remove one permission from one person
  const ownerC = owner;
  await ownerC.post(`/users/${kofiId}/permissions`, { 'perm:stock.use': 'deny' });
  const denied = await kofi.get('/stock'); assert.equal(denied.status, 403);
  await ownerC.post(`/users/${kofiId}/permissions`, {});
  assert.equal((await kofi.get('/stock')).status, 200);
  step('Access override: stock removed for one sales rep → 403, restored → 200');

  // 13f. Suspended staff are read-only
  db.run("UPDATE users SET status = 'suspended' WHERE id = ?", yawId);
  assert.equal((await yaw2.get('/')).status, 200);
  await assert.rejects(() => yaw2.post('/customers', { category: 'quality', description: 'x' }));
  db.run("UPDATE users SET status = 'active' WHERE id = ?", yawId);
  step('Suspended account can sign in and read, but cannot change anything');

  // 13g. Logs are append-only
  assert.throws(() => db.run('DELETE FROM security_log'));
  assert.throws(() => db.run("UPDATE audit_log SET action = 'x'"));
  step('Audit and security logs cannot be edited or deleted');

  // 14. Machine API: heartbeat, sale, fault
  const key = db.val('SELECT api_key FROM machines WHERE id = ?', M1);
  const api = (p, body) => fetch(`${base}/api/v1${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }).then((x) => x.json().then((j) => ({ status: x.status, j })));
  assert.equal((await api('/machine/heartbeat', { temperature: 3.2 })).j.ok, true);
  const s1 = await api('/machine/sale', { order_ref: 'API-ORDER-1', sku: 'PZ-CHK', amount: 85, payment_ref: 'MPAPI1' });
  assert.equal(s1.status, 201);
  assert.equal((await api('/machine/sale', { order_ref: 'API-ORDER-1', sku: 'PZ-CHK', amount: 85 })).j.duplicate, true);
  const f1 = await api('/machine/fault', { code: 'E-31', message: 'Oven heater fault', severity: 'major' });
  assert.equal(f1.status, 201);
  const bad = await fetch(`${base}/api/v1/machine/heartbeat`, { method: 'POST', headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401);
  step('Machine API: heartbeat, sale (idempotent), fault → incident; bad key rejected');

  // 15. Public QR feedback
  const pub = new Client();
  await pub.get('/f/SWG-KIA-01');
  await pub.post('/f/SWG-KIA-01', { rating: '5', category: 'praise', description: 'Brilliant at 5am before my flight!' });
  assert(db.get("SELECT 1 FROM customer_cases WHERE channel = 'qr_feedback' AND description LIKE 'Brilliant%'"));
  step('Customer QR feedback captured without login');

  // 16. Security: CSRF + role guard + lockout
  const noCsrf = await fetch(`${base}/report`, { method: 'POST', headers: { cookie: kofi.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
  assert.equal(noCsrf.status, 403);
  await assert.rejects(() => kofi.post('/admin/settings', { temp_max: '99' }));
  assert.notEqual(db.setting('temp_max'), '99');
  const intruder = new Client(); await intruder.get('/login');
  for (let i = 0; i < 5; i++) await intruder.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: intruder.csrf, email: 'yaw@swaggerspizza.com', password: 'wrong' }) });
  assert(db.val("SELECT locked_until FROM users WHERE email = 'yaw@swaggerspizza.com'"));
  db.run("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE email = 'yaw@swaggerspizza.com'");
  assert(db.get("SELECT 1 FROM security_log WHERE event = 'lockout'"));
  step('Security: CSRF enforced, staff cannot change settings, account locks after 5 bad passwords');

  // 17. Scheduler runs cleanly
  require('../src/services/scheduler').runAll();
  step('Automation scheduler ran (escalations, missed checklists, stock, maintenance, heartbeats)');

  console.log('\nAll workflow tests passed.');
}

const srv = app.listen(0, () => {
  base = `http://localhost:${srv.address().port}`;
  main().then(() => { srv.close(); process.exit(0); }).catch((e) => { console.error('\n✗ FAILED:', e.message); console.error(e.stack.split('\n').slice(1, 4).join('\n')); srv.close(); process.exit(1); });
});
