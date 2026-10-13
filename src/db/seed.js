// Seed: core Swaggers content (always) + optional demo operations data.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('./index');
const SOPS = require('../content/sops');
const CHECKLISTS = require('../content/checklists');
const TRAINING = require('../content/training');
const REF = require('../content/reference');
const { today, addDays, makeRef } = require('../lib/util');

// Demo only: every demo account uses this one simple password (shown on the sign-in page while demo mode is on).
const SEED_PASSWORD = process.env.SEED_PASSWORD || 'demo123';

function core() {
  // Settings
  const defaults = {
    business_name: 'Swaggers Pizza', currency: 'GHS', temp_min: '-18', temp_max: '5',
    refund_manager_limit: '100', expense_manager_limit: '500', expense_owner_limit: '2000',
    variance_tolerance_amount: '20', variance_tolerance_pct: '2', waste_alert_pct: '5',
    digest_time: '21:45', heartbeat_timeout_mins: '20', ai_enabled: '1', playbook_version: '2.0',
    support_phone: '+233 00 000 0000', attendance_start_date: today(),
  };
  for (const [k, v] of Object.entries(defaults)) if (db.setting(k) === null) db.setSetting(k, v);

  for (const s of SOPS) {
    if (db.get('SELECT 1 FROM sops WHERE code = ?', s.code)) continue;
    db.insert('sops', { code: s.code, title: s.title, category: s.category, purpose: s.purpose, roles: s.roles, body: s.body.trim(), version: '2.0', status: 'approved', approved_at: "2026-10-12 00:00:00", review_due: addDays(today(), 180) });
  }
  for (const t of CHECKLISTS) {
    if (db.get('SELECT 1 FROM checklist_templates WHERE code = ?', t.code)) continue;
    const id = db.insert('checklist_templates', { code: t.code, name: t.name, category: t.category, description: t.description, frequency: t.frequency, due_time: t.due_time || null, roles: t.roles, site_type: t.site_type || null, sop_code: t.sop_code || null });
    t.items.forEach((it, i) => db.insert('checklist_items', { template_id: id, position: i + 1, text: it.text, guidance: it.guidance || null, response_type: it.type || 'yesno', critical: it.critical ? 1 : 0, requires_photo: it.photo ? 1 : 0 }));
  }
  TRAINING.forEach((m, i) => {
    if (db.get('SELECT 1 FROM training_modules WHERE code = ?', m.code)) return;
    const id = db.insert('training_modules', { code: m.code, title: m.title, summary: m.summary, content: m.content, roles: m.roles, sop_codes: m.sop_codes, practical_required: m.practical, position: i });
    for (const q of m.quiz) db.insert('quiz_questions', { module_id: id, question: q.question, options: JSON.stringify(q.options), correct_index: q.correct, explanation: q.explanation });
  });
  for (const name of REF.INCOME_CATEGORIES) db.run('INSERT OR IGNORE INTO finance_categories(kind, name) VALUES (?, ?)', 'income', name);
  for (const [name, parent] of REF.EXPENSE_CATEGORIES) db.run('INSERT OR IGNORE INTO finance_categories(kind, name, parent) VALUES (?, ?, ?)', 'expense', name, parent);
  if (!db.get('SELECT 1 FROM readiness_items WHERE site_id IS NULL')) {
    REF.READINESS.forEach(([item, owner], i) => db.insert('readiness_items', { item, owner_source: owner, position: i }));
  }
  if (!db.get("SELECT 1 FROM stock_locations WHERE kind = 'central'")) db.insert('stock_locations', { name: 'Central Store / Kitchen', kind: 'central' });
}

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function demo() {
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pickW = (arr, w) => { let r = Math.random() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; } return arr[0]; };

  // Sites & machines
  const sites = [
    { code: 'KIA', latitude: 5.6052, longitude: -0.1668, geofence_radius_m: 150, name: 'Kotoka International Airport – T3', type: 'airport', city: 'Accra', address: 'Terminal 3 Departures, Airport', opening_time: '06:00', closing_time: '22:00', contact_name: 'GACL Concessions Desk' },
    { code: 'UGH', latitude: 5.651, longitude: -0.196, geofence_radius_m: 150, name: 'University of Ghana – Commonwealth Hall', type: 'school', city: 'Legon', address: 'Commonwealth Hall Forecourt', opening_time: '07:00', closing_time: '21:00', contact_name: 'Hall Administrator' },
    { code: 'UGL', latitude: 5.6506, longitude: -0.1869, geofence_radius_m: 150, name: 'University of Ghana – Balme Library', type: 'school', city: 'Legon', address: 'Balme Library Annex', opening_time: '07:00', closing_time: '21:00', contact_name: 'Library Facilities' },
    { code: 'ACM', latitude: 5.6213, longitude: -0.1736, geofence_radius_m: 150, name: 'Accra Mall', type: 'mall', city: 'Accra', address: 'Ground Floor, Food Court Entrance', opening_time: '09:00', closing_time: '21:00', contact_name: 'Mall Management' },
    { code: 'OAS', latitude: 5.6055, longitude: -0.1795, geofence_radius_m: 150, name: 'One Airport Square (Offices)', type: 'office', city: 'Accra', address: 'Lobby, Airport City', opening_time: '07:00', closing_time: '19:00', status: 'planning', contact_name: 'Facilities Manager' },
  ];
  const siteIds = {};
  for (const s of sites) siteIds[s.code] = db.insert('sites', { ...s, status: s.status || 'active', emergency_contact: 'Fire 192 · Ambulance 193 · Police 191 · Site security on duty' });
  const machineIds = {};
  for (const s of sites) {
    const code = `SWG-${s.code}-01`;
    const deviceNo = { KIA: 'CYJ7000142', UGH: 'CYJ7000143', UGL: 'CYJ7000144', ACM: 'CYJ7000145', OAS: 'CYJ7000146' }[s.code];
    machineIds[s.code] = db.insert('machines', {
      code, site_id: siteIds[s.code], model: 'Automated Pizza Vending Unit (model TBC)', serial_no: `SN-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      capacity: 60, status: s.status === 'planning' ? 'maintenance' : 'online', installed_on: addDays(today(), -rnd(40, 120)),
      last_service_on: addDays(today(), -rnd(5, 34)), service_interval_days: 30, api_key: `swg_${crypto.randomBytes(16).toString('hex')}`,
      payment_qr_ref: `MOMO-QR-${s.code}-01`, supplier_device_no: deviceNo,
    });
    db.insert('stock_locations', { name: `Machine ${code}`, kind: 'machine', site_id: siteIds[s.code], machine_id: machineIds[s.code] });
    db.insert('machine_status_log', { machine_id: machineIds[s.code], status: s.status === 'planning' ? 'maintenance' : 'online', reason: 'Installed', started_at: addDays(today(), -60) + ' 08:00:00' });
  }
  for (const s of sites) REF.READINESS.slice(1, 15).forEach(([item, owner], i) => db.insert('readiness_items', { site_id: siteIds[s.code], item, owner_source: owner, position: i, status: s.status === 'planning' ? (i < 4 ? 'confirmed' : 'open') : 'confirmed' }));

  // Products
  const products = [
    ['PZ-MEAT', 'Meat Feast', 85, 38, 'Wheat (gluten), milk, may contain soya — CONFIRM WITH SUPPLIER', '#c2410c'],
    ['PZ-VEG', 'Veggie Supreme', 75, 31, 'Wheat (gluten), milk — CONFIRM WITH SUPPLIER', '#15803d'],
    ['PZ-CHK', 'Chicken Supreme', 85, 37, 'Wheat (gluten), milk — CONFIRM WITH SUPPLIER', '#ca8a04'],
    ['PZ-CBC', 'Chicken & Beef Combo', 95, 44, 'Wheat (gluten), milk, may contain soya — CONFIRM WITH SUPPLIER', '#7c2d12'],
  ];
  const IMG = { 'PZ-MEAT': '/img/pizza-meat-feast.jpg', 'PZ-VEG': '/img/pizza-veggie.jpg', 'PZ-CHK': '/img/pizza-bbq-chicken.jpg', 'PZ-CBC': '/img/pizza-bbq-chicken-swirl.jpg' };
  const pIds = products.map(([sku, name, price, cost, allergens, colour]) => db.insert('products', { sku, name, price, unit_cost: cost, allergens, colour, image: IMG[sku], category: 'pizza', reorder_level: 6, approved: 1, shelf_life_hours: null, description: `${name} — Swaggers signature pizza. Recipe pending final approval.` }));

  // Proposed flavours — not yet approved by the Owner, so they are inactive and unavailable.
  db.insert('products', { sku: 'PZ-PEP', name: 'Pepperoni Classic', price: 85, unit_cost: 36, colour: '#b91c1c', image: '/img/pizza-pepperoni.jpg', category: 'pizza', reorder_level: 6, approved: 0, available: 0, active: 0, description: 'Proposed new flavour — awaiting Owner approval.' });
  db.insert('products', { sku: 'PZ-BRK', name: 'Swaggers Breakfast', price: 80, unit_cost: 34, colour: '#d97706', image: '/img/pizza-breakfast.jpg', category: 'pizza', reorder_level: 6, approved: 0, available: 0, active: 0, description: 'Egg & bacon breakfast pizza for airport early flights — awaiting Owner approval.' });

  // Vendors
  const vendors = [
    ['VendTech Ghana Ltd (machine supplier)', 'technician', 'Service Desk', '+233 30 000 0001', 'service@example.com', 4],
    ['Golden Crust Foods (pizza supplier)', 'food_supplier', 'Sales', '+233 30 000 0002', 'orders@example.com', 24],
    ['MoMo / QR Payment Provider', 'payment_provider', 'Merchant Support', '+233 30 000 0003', 'merchant@example.com', 2],
    ['CoolChain Logistics', 'logistics', 'Dispatch', '+233 30 000 0004', null, 6],
    ['CleanPro Supplies', 'cleaning', 'Accounts', '+233 30 000 0005', null, 48],
  ];
  const vIds = vendors.map(([name, category, contact_name, phone, email, sla]) => db.insert('vendors', { name, category, contact_name, phone, email, sla_hours: sla }));

  // People
  const pw = hash(SEED_PASSWORD);
  const people = [
    // staff_no, name, email, role, sites, username, monthly pay (GHS), allowances
    ['SWG-001', 'Owner (Director)', 'owner@swaggerspizza.com', 'owner', [], 'owner', 0, 0],
    ['SWG-002', 'Abena Mensah', 'ops@swaggerspizza.com', 'ops_manager', [], 'manager', 6500, 500],
    ['SWG-003', 'Kwame Asante', 'kwame@swaggerspizza.com', 'supervisor', ['KIA', 'ACM'], 'supervisor', 3800, 300],
    ['SWG-004', 'Efua Boateng', 'efua@swaggerspizza.com', 'supervisor', ['UGH', 'UGL'], 'supervisor2', 3800, 300],
    ['SWG-005', 'Kofi Owusu', 'kofi@swaggerspizza.com', 'sales_rep', ['KIA'], 'staff', 2400, 200],
    ['SWG-006', 'Ama Darko', 'ama@swaggerspizza.com', 'sales_rep', ['UGH'], 'staff2', 2400, 200],
    ['SWG-007', 'Yaw Adjei', 'yaw@swaggerspizza.com', 'sales_rep', ['UGL'], 'staff3', 2200, 200],
    ['SWG-008', 'Akosua Frimpong', 'akosua@swaggerspizza.com', 'sales_rep', ['ACM'], 'staff4', 2400, 200],
    ['SWG-009', 'Kojo Appiah', 'kojo@swaggerspizza.com', 'stock_staff', ['KIA', 'UGH', 'UGL', 'ACM'], 'stock', 2700, 400],
    ['SWG-010', 'Esi Quaye', 'accounts@swaggerspizza.com', 'accounts', [], 'accounts', 4200, 300],
    ['SWG-011', 'Nii Armah', 'tech@swaggerspizza.com', 'technician', ['KIA', 'UGH', 'UGL', 'ACM', 'OAS'], 'tech', 3500, 500],
  ];
  const uIds = {};
  for (const [staff_no, name, email, role, siteCodes, username, pay, allow] of people) {
    const mobile = ['owner', 'ops_manager', 'technician', 'stock_staff', 'accounts'].includes(role);
    const id = db.insert('users', { staff_no, name, email, role, username, password_hash: pw, must_change_password: 0, cleared_to_work_alone: 1, phone: `+233 24 ${rnd(100, 999)} ${rnd(1000, 9999)}`, hired_on: addDays(today(), -rnd(60, 400)), status: 'active', pay_type: 'monthly', base_salary: pay, allowances: allow, geofence_mode: mobile ? 'exempt' : 'site', work_days: '1,2,3,4,5,6', work_start: '07:00', work_end: '15:00' });
    uIds[email.split('@')[0]] = id;
    for (const c of siteCodes) db.insert('user_sites', { user_id: id, site_id: siteIds[c] });
  }
  const repFor = { KIA: uIds.kofi, UGH: uIds.ama, UGL: uIds.yaw, ACM: uIds.akosua };
  const supFor = { KIA: uIds.kwame, ACM: uIds.kwame, UGH: uIds.efua, UGL: uIds.efua };

  // Training records + acknowledgement
  const modules = db.all('SELECT id FROM training_modules');
  for (const uid of Object.values(uIds)) {
    for (const m of modules) if (Math.random() < 0.8) db.insert('training_records', { user_id: uid, module_id: m.id, quiz_score: rnd(80, 100), quiz_passed: 1, attempts: 1, quiz_completed_at: addDays(today(), -rnd(10, 40)) + ' 10:00:00', practical_passed: 1, practical_assessor: uIds.ops, practical_at: addDays(today(), -rnd(5, 30)) + ' 12:00:00' });
    db.insert('acknowledgements', { user_id: uid, document: 'playbook', version: '1.0', signature: db.val('SELECT name FROM users WHERE id = ?', uid) });
  }
  db.update('users', uIds.yaw, { cleared_to_work_alone: 0 });

  // Stock — weekly batches to central, daily loads to machines, sales, waste.
  const central = db.val("SELECT id FROM stock_locations WHERE kind = 'central'");
  const locFor = Object.fromEntries(Object.entries(machineIds).map(([c, m]) => [c, db.val('SELECT id FROM stock_locations WHERE machine_id = ?', m)]));
  const activeCodes = ['KIA', 'UGH', 'UGL', 'ACM'];
  const demand = { KIA: 1.6, ACM: 1.2, UGH: 1.0, UGL: 0.7 };
  const hours = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  const hourW = [1, 4, 5, 4, 3, 5, 9, 9, 6, 4, 5, 7, 8, 6, 4, 2];
  const flavourW = [32, 18, 27, 23];
  const catId = (name) => db.val('SELECT id FROM finance_categories WHERE name = ?', name);
  const DAYS = 30;

  const onHand = Object.fromEntries(activeCodes.map((c) => [c, {}]));
  db.tx(() => {
    const batchOf = {};
    for (let d = DAYS; d >= 0; d--) {
      const day = addDays(today(), -d);
      if ((DAYS - d) % 7 === 0) {
        pIds.forEach((pid, i) => {
          const bid = db.insert('batches', { product_id: pid, batch_no: `GC-${day.replace(/-/g, '')}-${i + 1}`, supplier_id: vIds[1], produced_on: day, expires_at: addDays(day, 60) + ' 23:59:00', received_at: day + ' 06:00:00' });
          batchOf[pid] = bid;
          db.insert('stock_movements', { product_id: pid, batch_id: bid, to_location_id: central, qty: 280, kind: 'receive', reason: 'Weekly delivery', unit_cost: products[i][3], user_id: uIds.kojo, occurred_at: day + ' 06:30:00' });
          db.insert('transactions', { kind: 'expense', category_id: catId('Ingredients'), vendor_id: vIds[1], amount: 280 * products[i][3], description: `Pizza stock — ${products[i][1]} ×280`, txn_date: day, recorded_by: uIds.accounts });
        });
      }
      for (const code of activeCodes) {
        const mid = machineIds[code]; const sid = siteIds[code]; const loc = locFor[code];
        // Morning top-up to par level (FEFO from central), like a real restock run.
        const PAR = Math.round(10 + demand[code] * 8);
        const stockSvc = require('../services/stock');
        pIds.forEach((pid) => {
          let need = PAR - (onHand[code][pid] || 0);
          for (const b of stockSvc.fefo(central, pid)) {
            if (need <= 0) break;
            const take = Math.min(need, b.qty);
            stockSvc.move({ product_id: pid, batch_id: b.id, from: central, to: loc, qty: take, kind: 'load', user_id: uIds.kojo, occurred_at: day + ' 06:45:00' });
            need -= take; onHand[code][pid] = (onHand[code][pid] || 0) + take;
          }
        });
        // Sales (a flavour that sells out stops selling — shows up as a stock-out)
        const isDown = code === 'UGL' && d === 9;
        const weekend = [0, 6].includes(new Date(day).getDay());
        const base = Math.round(30 * demand[code] * (code.startsWith('UG') && weekend ? 0.5 : 1) * (0.85 + Math.random() * 0.3));
        const n = isDown ? 6 : base;
        const sold = [0, 0, 0, 0];
        for (let k = 0; k < n; k++) {
          const fi = pickW([0, 1, 2, 3], flavourW); const h = pickW(hours, hourW);
          if (h < Number((sites.find((s) => s.code === code).opening_time).slice(0, 2))) continue;
          if ((onHand[code][pIds[fi]] || 0) - sold[fi] <= 0) continue;
          const failed = Math.random() < 0.015;
          db.insert('sales', { machine_id: mid, site_id: sid, product_id: pIds[fi], order_ref: `ORD-${code}-${day.replace(/-/g, '')}-${k}`, qty: 1, unit_price: products[fi][2], amount: products[fi][2], payment_method: 'momo', payment_ref: `MP${crypto.randomBytes(5).toString('hex').toUpperCase()}`, payment_status: 'confirmed', dispense_status: failed ? 'failed' : 'dispensed', source: 'machine_api', sold_at: `${day} ${String(h).padStart(2, '0')}:${String(rnd(0, 59)).padStart(2, '0')}:00` });
          if (!failed) sold[fi] += 1;
        }
        pIds.forEach((pid, i) => { if (sold[i]) { stockSvc.consume({ location_id: loc, product_id: pid, qty: sold[i], kind: 'sale', occurred_at: day + ' 22:00:00' }); onHand[code][pid] -= sold[i]; } });
        // Waste
        if (Math.random() < 0.35) {
          const fi = rnd(0, 3); const q = Math.min(rnd(1, 3), onHand[code][pIds[fi]] || 0);
          if (q > 0) { stockSvc.consume({ location_id: loc, product_id: pIds[fi], qty: q, kind: 'waste', reason: pickW(['machine_fault', 'damaged', 'quality_reject', 'expired'], [3, 3, 2, 1]), user_id: repFor[code], occurred_at: day + ' 20:30:00' }); onHand[code][pIds[fi]] -= q; }
        }

        if (d === 0) continue; // today's checklists left for staff
        // Checklists (≈92% completion)
        for (const tplCode of ['OPEN', 'CLEAN', 'CLOSE']) {
          if (Math.random() > 0.92) continue;
          const tpl = db.get('SELECT * FROM checklist_templates WHERE code = ?', tplCode);
          const items = db.all('SELECT * FROM checklist_items WHERE template_id = ?', tpl.id);
          const t = tplCode === 'OPEN' ? '07:05:00' : tplCode === 'CLEAN' ? '13:40:00' : '21:20:00';
          const runId = db.insert('checklist_runs', { template_id: tpl.id, site_id: sid, machine_id: mid, user_id: repFor[code], run_date: day, started_at: `${day} ${t}`, submitted_at: `${day} ${t}`, status: Math.random() < 0.6 ? 'reviewed' : 'submitted', reviewed_by: supFor[code] });
          let fails = 0;
          for (const it of items) {
            const isTemp = it.response_type === 'temperature';
            const fail = !isTemp && Math.random() < 0.03;
            fails += fail ? 1 : 0;
            db.insert('checklist_responses', { run_id: runId, item_id: it.id, answer: isTemp ? 'value' : fail ? 'no' : 'yes', value: isTemp ? (rnd(20, 45) / 10) : null, answered_at: `${day} ${t}` });
          }
          db.update('checklist_runs', runId, { score: Math.round(((items.length - fails) / items.length) * 100), failed_count: fails });
        }
        // Temperatures
        for (const t of ['07:00', '14:00', '21:00']) { const r = rnd(18, 48) / 10; db.insert('temperature_logs', { site_id: sid, machine_id: mid, location_label: 'Machine storage', reading: r, min_allowed: -18, max_allowed: 5, in_range: r <= 5 ? 1 : 0, user_id: repFor[code], recorded_at: `${day} ${t}:00` }); }
        // Daily close-out
        if (d > 1) {
          const tot = db.get('SELECT COUNT(*) n, COALESCE(SUM(amount),0) a FROM sales WHERE machine_id = ? AND date(sold_at) = ?', mid, day);
          const off = Math.random() < 0.1 ? rnd(1, 3) * 85 : 0;
          db.insert('daily_closeouts', { site_id: sid, machine_id: mid, business_date: day, machine_reported_orders: tot.n, machine_reported_amount: tot.a, provider_settled_amount: tot.a - off, system_orders: tot.n, system_amount: tot.a, variance: -off, submitted_by: supFor[code], verified_by: d > 3 ? uIds.accounts : null, verified_at: d > 3 ? `${addDays(day, 1)} 10:00:00` : null, notes: off ? 'Provider settlement short — see payment exceptions' : null });
        }
      }
      // Monthly-ish expenses
      if (d % 10 === 0) {
        db.insert('transactions', { kind: 'expense', category_id: catId('Machine Electricity'), amount: rnd(600, 900), description: 'Machine electricity — all sites', txn_date: day, recorded_by: uIds.accounts });
        db.insert('transactions', { kind: 'expense', category_id: catId('Transport & Fuel'), amount: rnd(400, 700), description: 'Delivery van fuel', txn_date: day, recorded_by: uIds.accounts });
      }
    }
    const monthStart = today().slice(0, 8) + '01';
    for (const [cat, amt, desc] of [['Salaries/Wages', 18500, 'Monthly payroll (11 staff)'], ['Site Rent / Commission', 7200, 'Site commissions — KIA, ACM, UG'], ['SIM / Data Bundles', 480, 'Machine data bundles'], ['Software/IoT Subscriptions', 950, 'Vending telemetry + payments'], ['Payment Provider Fees', 1350, 'MoMo merchant fees'], ['Marketing & Promotions', 2500, 'Campus launch promo']]) {
      db.insert('transactions', { kind: 'expense', category_id: catId(cat), amount: amt, description: desc, txn_date: monthStart, recorded_by: uIds.accounts });
    }
    db.insert('transactions', { kind: 'income', category_id: catId('Event/Activation Revenue'), amount: 3200, description: 'Corporate sampling event — Airport City', txn_date: addDays(today(), -6), recorded_by: uIds.accounts });
  });

  // Incidents (history + live)
  const incidents = require('../services/incidents');
  const mk = (code, data, daysAgo, resolveAfterMins) => {
    const inc = incidents.create({ site_id: siteIds[code], machine_id: machineIds[code], ...data }, { id: repFor[code] });
    const created = `${addDays(today(), -daysAgo)} ${String(rnd(8, 18)).padStart(2, '0')}:${String(rnd(0, 59)).padStart(2, '0')}:00`;
    db.run('UPDATE incidents SET created_at = ?, due_at = datetime(?, ?) WHERE id = ?', created, created, `+${incidents.SLA[data.severity].resolveMins} minutes`, inc.id);
    db.run('UPDATE incident_updates SET created_at = ? WHERE incident_id = ?', created, inc.id);
    if (resolveAfterMins != null) {
      db.run("UPDATE incidents SET status = 'closed', acknowledged_at = datetime(?, '+12 minutes'), resolved_at = datetime(?, ?), closed_at = datetime(?, ?), downtime_minutes = ?, assigned_to = ?, resolution = ?, return_to_service_checked = 1 WHERE id = ?",
        created, created, `+${resolveAfterMins} minutes`, created, `+${resolveAfterMins + 60} minutes`, resolveAfterMins, uIds.tech, 'Fixed by approved technician; test order passed.', inc.id);
      db.run("UPDATE machine_status_log SET started_at = ?, ended_at = datetime(?, ?) WHERE machine_id = ? AND reason LIKE ?", created, created, `+${resolveAfterMins} minutes`, machineIds[code], `${inc.ref}%`);
      incidents.setMachineStatus(machineIds[code], 'online', 'Restored', null);
    }
    return inc;
  };
  mk('UGL', { type: 'machine', severity: 'major', title: 'Machine not dispensing — error E-12', error_message: 'E-12 dispense jam', sales_paused: 1 }, 9, 300);
  mk('KIA', { type: 'payment', severity: 'major', title: 'Repeated QR payment failures', sales_paused: 0 }, 14, 95);
  mk('UGL', { type: 'machine', severity: 'minor', title: 'Screen scratch near QR plate' }, 18, 2400);
  mk('ACM', { type: 'stock', severity: 'minor', title: 'Chicken Supreme sold out by 2pm' }, 5, 180);
  mk('UGL', { type: 'machine', severity: 'major', title: 'Oven heating slowly — long wait times', error_message: 'W-04 heat slow' }, 3, 420);
  const live1 = mk('KIA', { type: 'machine', severity: 'minor', title: 'Collection door squeaks loudly', description: 'Door works but makes loud noise. Customers notice.' }, 1, null);
  incidents.assign(live1.id, uIds.tech, { id: uIds.ops });
  mk('ACM', { type: 'payment', severity: 'major', title: 'Customer charged twice for one pizza', payment_ref: 'MP7F3A21C9', description: 'Customer shows two debits of GHS 85 within 1 minute.' }, 0, null);

  // Payment exceptions, customer cases, refunds
  const case1 = db.insert('customer_cases', { ref: makeRef('CS'), site_id: siteIds.ACM, machine_id: machineIds.ACM, category: 'payment', channel: 'in_person', customer_name: 'Customer (ends 4471)', product_id: pIds[0], payment_ref: 'MP7F3A21C9', description: 'Charged twice for one Meat Feast.', status: 'awaiting_refund', created_by: uIds.akosua, assigned_to: uIds.accounts });
  const pe1 = db.insert('payment_exceptions', { site_id: siteIds.ACM, machine_id: machineIds.ACM, kind: 'duplicate', amount: 85, payment_ref: 'MP7F3A21C9', customer_phone_last4: '4471', occurred_at: today() + ' 12:41:00', status: 'investigating', case_id: case1, reported_by: uIds.akosua });
  const rf = db.insert('refunds', { case_id: case1, payment_exception_id: pe1, amount: 85, reason: 'Duplicate debit confirmed on provider portal', requested_by: uIds.accounts });
  require('../services/approvals').request({ kind: 'refund', title: 'Refund GH₵85 — duplicate MoMo debit (Accra Mall)', amount: 85, entity: 'refunds', entity_id: rf, required_role: 'ops_manager' }, { id: uIds.accounts });
  db.insert('payment_exceptions', { site_id: siteIds.KIA, machine_id: machineIds.KIA, kind: 'deducted_no_order', amount: 95, payment_ref: 'MP19BC00E1', customer_phone_last4: '0932', occurred_at: addDays(today(), -1) + ' 18:02:00', status: 'open', reported_by: uIds.kofi });
  db.insert('customer_cases', { ref: makeRef('CS'), site_id: siteIds.UGH, machine_id: machineIds.UGH, category: 'praise', channel: 'qr_feedback', description: 'Best late-night snack on campus. Please add a spicy option!', rating: 5, status: 'closed', created_by: null });
  db.insert('customer_cases', { ref: makeRef('CS'), site_id: siteIds.UGL, machine_id: machineIds.UGL, category: 'quality', channel: 'qr_feedback', product_id: pIds[1], description: 'Veggie pizza was only warm, not hot.', rating: 2, status: 'open', created_by: null, assigned_to: uIds.efua });
  db.insert('customer_cases', { ref: makeRef('CS'), site_id: siteIds.KIA, machine_id: machineIds.KIA, category: 'suggestion', channel: 'qr_feedback', description: 'Would love a combo with a drink for travellers.', rating: 4, status: 'open', created_by: null });

  // Tasks, approvals, announcements
  const task = (o) => db.insert('tasks', { created_by: uIds.ops, ...o });
  task({ title: 'Agree root cause of repeated faults on SWG-UGL-01 with VendTech', kind: 'corrective_action', site_id: siteIds.UGL, machine_id: machineIds.UGL, assigned_to: uIds.ops, priority: 'high', due_at: addDays(today(), 2) + ' 17:00:00' });
  task({ title: 'Replace damaged QR sticker at KIA', kind: 'task', site_id: siteIds.KIA, assigned_to: uIds.kwame, priority: 'normal', due_at: addDays(today(), -1) + ' 17:00:00' });
  task({ title: 'Complete practical sign-off for Yaw Adjei', kind: 'follow_up', site_id: siteIds.UGL, assigned_to: uIds.efua, priority: 'high', due_at: addDays(today(), 3) + ' 12:00:00' });
  task({ title: 'Collect electrical installation approval for One Airport Square', kind: 'project', site_id: siteIds.OAS, assigned_to: uIds.ops, priority: 'normal', due_at: addDays(today(), 10) + ' 12:00:00' });
  require('../services/approvals').request({ kind: 'price_change', title: 'Increase Chicken & Beef Combo to GH₵99', details: 'Supplier cost up 8%. Competitor combo at GH₵105.', amount: 99, entity: 'products', entity_id: pIds[3], payload: { product_id: pIds[3], new_price: 99 }, required_role: 'owner' }, { id: uIds.ops });
  require('../services/approvals').request({ kind: 'new_site', title: 'Approve second machine at Kotoka T3 (Arrivals)', details: 'KIA is the top site by revenue; queue >5 at peak 3 days a week. Est. payback 7 months.', amount: 65000, required_role: 'owner' }, { id: uIds.ops });
  db.insert('announcements', { title: 'Welcome to the Swaggers Staff Portal', body: 'From today all checklists, stock records, faults and customer issues are recorded here. Please read the Handbook and sign the Playbook v2.0 acknowledgement.', pinned: 1, requires_ack: 1, created_by: uIds.ops });
  db.insert('announcements', { title: 'Campus exam season', body: 'UG sites expect late-evening peaks for the next 3 weeks. Supervisors: check stock at 18:00 daily.', audience: `site:${siteIds.UGH}`, created_by: uIds.efua });

  // Roster: this week + next
  for (let d = -3; d <= 7; d++) {
    const day = addDays(today(), d);
    for (const code of activeCodes) {
      const s = sites.find((x) => x.code === code);
      const id1 = db.insert('shifts', { user_id: repFor[code], site_id: siteIds[code], machine_id: machineIds[code], shift_date: day, start_time: s.opening_time, end_time: '15:00', shift_type: 'opening', duties: 'opening,customer,cleaning', status: d < 0 ? 'completed' : 'scheduled', created_by: uIds.ops });
      db.insert('shifts', { user_id: supFor[code], site_id: siteIds[code], machine_id: machineIds[code], shift_date: day, start_time: '14:00', end_time: s.closing_time, shift_type: 'closing', duties: 'customer,refill,closing', status: d < 0 ? 'completed' : 'scheduled', created_by: uIds.ops });
      if (d < 0) db.insert('attendance', { user_id: repFor[code], shift_id: id1, site_id: siteIds[code], clock_in: `${day} ${s.opening_time}:00`, clock_out: `${day} 15:05:00`, late_minutes: Math.random() < 0.15 ? rnd(5, 20) : 0 });
    }
    if (d >= 0 && d < 5) db.insert('shifts', { user_id: uIds.kojo, site_id: siteIds.KIA, shift_date: day, start_time: '05:30', end_time: '13:30', shift_type: 'restock', duties: 'refill,stock', status: 'scheduled', created_by: uIds.ops });
  }
  // A month of attendance history on everyone's default schedule (Mon–Sat 07:00–15:00) for payroll & leaderboard.
  const homeSite = Object.fromEntries(db.all('SELECT user_id, MIN(site_id) site_id FROM user_sites GROUP BY user_id').map((x) => [x.user_id, x.site_id]));
  const reliability = { [uIds.kofi]: 0.99, [uIds.ama]: 0.96, [uIds.yaw]: 0.88, [uIds.akosua]: 0.94, [uIds.kwame]: 0.97, [uIds.efua]: 0.98, [uIds.kojo]: 0.95, [uIds.accounts]: 0.99, [uIds.tech]: 0.93, [uIds.ops]: 0.99 };
  db.tx(() => {
    for (let d = 35; d >= 1; d--) {
      const day = addDays(today(), -d);
      if (new Date(day + 'T12:00:00Z').getUTCDay() === 0) continue;
      for (const [uid, rel] of Object.entries(reliability)) {
        if (Math.random() > rel) continue; // absent
        if (db.get('SELECT 1 FROM attendance WHERE user_id = ? AND date(clock_in) = ?', Number(uid), day)) continue;
        const lateBy = Math.random() < (1 - rel) * 3 ? rnd(8, 40) : rnd(-15, 4);
        const inMin = 7 * 60 + lateBy; const outMin = 15 * 60 + (Math.random() < 0.2 ? rnd(90, 200) : rnd(0, 30));
        const t = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
        db.insert('attendance', { user_id: Number(uid), site_id: homeSite[uid] || siteIds.KIA, clock_in: `${day} ${t(inMin)}`, clock_out: `${day} ${t(outMin)}`, work_date: day, source: 'self' });
      }
    }
  });
  db.insert('leave_requests', { user_id: uIds.ama, start_date: addDays(today(), -12), end_date: addDays(today(), -11), leave_type: 'sick', reason: 'Malaria — doctor\'s note provided', status: 'approved', decided_by: uIds.ops });
  db.insert('leave_requests', { user_id: uIds.yaw, start_date: addDays(today(), 2), end_date: addDays(today(), 2), leave_type: 'late_permission', until_time: '09:30', reason: 'Exam at Legon until 9am', status: 'pending' });

  // Recalculate demo attendance through the rules engine and award last month's Employee of the Month.
  const att = require('../services/attendance');
  for (const a of db.all('SELECT id FROM attendance')) att.recalc(a.id);
  db.insert('employee_awards', { month: addDays(today().slice(0, 8) + '01', -1).slice(0, 7), user_id: uIds.kofi, score: 96, citation: 'Never missed a checklist, first to report the QR fault at T3, and customers mention him by name.', awarded_by: uIds.ops });
  db.setSetting('attendance_start_date', addDays(today(), -35));
  db.setSetting('demo_mode', '1');
  db.setSetting('demo_password', SEED_PASSWORD);
  db.run("DELETE FROM notifications"); // start demo with a clean inbox
  return { password: SEED_PASSWORD };
}

function run({ demo: withDemo = true } = {}) {
  core();
  if (withDemo && !db.get('SELECT 1 FROM users LIMIT 1')) {
    const r = demo();
    console.log('Demo data loaded. Demo accounts are listed on the sign-in page (Admin → Settings → demo mode).');
    return r;
  }
  if (!db.get('SELECT 1 FROM users LIMIT 1')) {
    const pw = process.env.SEED_PASSWORD || crypto.randomBytes(9).toString('base64url');
    db.insert('users', { staff_no: 'SWG-001', name: 'Owner', email: process.env.OWNER_EMAIL || 'owner@swaggerspizza.com', role: 'owner', password_hash: hash(pw), must_change_password: 1 });
    console.log(`Owner account created: ${process.env.OWNER_EMAIL || 'owner@swaggerspizza.com'} / ${pw} (you must change it on first login)`);
  }
}

module.exports = { run, core };
if (require.main === module) run({ demo: !process.argv.includes('--no-demo') });
