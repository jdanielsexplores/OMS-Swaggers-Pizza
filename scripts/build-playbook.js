// Builds "Swaggers Pizza Operations Playbook & Staff Training Guide v2.0" (.docx)
// from the same SOP / checklist / training content the staff portal uses, so the two never drift apart.
// Usage: npm run playbook  →  docs/Swaggers_Pizza_Operations_Playbook_v2.docx
const fs = require('node:fs');
const path = require('node:path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, ShadingType,
  BorderStyle, LevelFormat, PageBreak, TableOfContents, Footer, Header, PageNumber, TabStopType,
} = require('docx');
const SOPS = require('../src/content/sops');
const CHECKLISTS = require('../src/content/checklists');
const TRAINING = require('../src/content/training');
const { READINESS, SITE_RULES, ROLES } = require('../src/content/reference');

const BRAND = 'D9480F'; const INK = '1C1917'; const MUTED = '78716C'; const TINT = 'FFF4ED'; const LINE = 'E7E5E4';
const PAGE_W = 11906; const MARGIN = 1134; const CONTENT_W = PAGE_W - MARGIN * 2; // A4, 2 cm margins
const FONT = 'Calibri';

let listInstance = 0;
const children = [];
const add = (...x) => children.push(...x);

// ── inline **bold** parsing ──
function runs(text, opts = {}) {
  const out = [];
  String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean).forEach((part) => {
    const bold = part.startsWith('**') && part.endsWith('**');
    out.push(new TextRun({ text: bold ? part.slice(2, -2) : part, bold: bold || opts.bold, color: opts.color, size: opts.size, italics: opts.italics, font: FONT }));
  });
  return out;
}
const p = (text, opts = {}) => new Paragraph({ children: runs(text, opts), spacing: { after: opts.after ?? 120, before: opts.before ?? 0 }, alignment: opts.align });
const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t, font: FONT })], pageBreakBefore: true });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t, font: FONT })] });
const h3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: t, font: FONT })] });
const bullet = (t) => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: runs(t), spacing: { after: 60 } });
function numbered(items) { listInstance++; return items.map((t) => new Paragraph({ numbering: { reference: 'steps', level: 0, instance: listInstance }, children: runs(t), spacing: { after: 60 } })); }

function callout(text, { fill = TINT, border = BRAND, label } = {}) {
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [CONTENT_W],
    rows: [new TableRow({ children: [new TableCell({
      width: { size: CONTENT_W, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
      borders: { left: { style: BorderStyle.SINGLE, size: 24, color: border }, top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } },
      margins: { top: 120, bottom: 120, left: 200, right: 200 },
      children: [new Paragraph({ children: [...(label ? [new TextRun({ text: `${label}  `, bold: true, color: border, font: FONT })] : []), ...runs(text)] })],
    })] })],
  });
}

function table(rows, widths, { header = true } = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const scaled = widths.map((w) => Math.floor((w / total) * CONTENT_W));
  scaled[scaled.length - 1] += CONTENT_W - scaled.reduce((a, b) => a + b, 0);
  const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: scaled,
    rows: rows.map((r, ri) => new TableRow({
      tableHeader: header && ri === 0,
      children: r.map((c, ci) => new TableCell({
        width: { size: scaled[ci], type: WidthType.DXA },
        shading: header && ri === 0 ? { type: ShadingType.CLEAR, fill: INK, color: 'auto' } : ri % 2 === 0 ? { type: ShadingType.CLEAR, fill: 'FAFAF9', color: 'auto' } : undefined,
        borders: { top: border, bottom: border, left: border, right: border },
        margins: { top: 70, bottom: 70, left: 110, right: 110 },
        children: String(c ?? '').split('\n').map((line) => new Paragraph({ children: runs(line, header && ri === 0 ? { bold: true, color: 'FFFFFF', size: 19 } : { size: 19 }) })),
      })),
    })),
  });
}
const spacer = () => new Paragraph({ children: [], spacing: { after: 80 } });

// ── mini-markdown (same format as the portal) → docx ──
function markdown(src) {
  const out = []; let list = null; let tbl = null;
  const flush = () => {
    if (list) { out.push(...(list.type === 'ol' ? numbered(list.items) : list.items.map(bullet))); list = null; }
    if (tbl) { const cols = tbl[0].length; out.push(table(tbl, Array(cols).fill(1)), spacer()); tbl = null; }
  };
  for (const line of String(src).split('\n')) {
    const t = line.trim(); let m;
    if (!t) { flush(); continue; }
    if (t.startsWith('|')) { if (list) flush(); tbl = tbl || []; tbl.push(t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())); continue; }
    if (tbl) flush();
    if ((m = t.match(/^#{2,4}\s+(.*)/))) { flush(); out.push(h3(m[1])); continue; }
    if ((m = t.match(/^\d+\.\s+(.*)/))) { if (!list || list.type !== 'ol') { flush(); list = { type: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = t.match(/^[-*]\s+(.*)/))) { if (!list || list.type !== 'ul') { flush(); list = { type: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = t.match(/^>\s*(.*)/))) { flush(); const lm = m[1].match(/^([A-Z][A-Z \-]{2,}):\s*(.*)/); out.push(lm ? callout(lm[2], { label: lm[1] }) : callout(m[1]), spacer()); continue; }
    flush(); out.push(p(t));
  }
  flush();
  return out;
}

// ═════════════ COVER ═════════════
add(
  new Paragraph({ spacing: { before: 1800 }, children: [new TextRun({ text: 'SWAGGERS', bold: true, size: 96, color: BRAND, font: FONT })] }),
  new Paragraph({ children: [new TextRun({ text: 'PIZZA', bold: true, size: 96, color: INK, font: FONT })], spacing: { after: 500 } }),
  new Paragraph({ children: [new TextRun({ text: 'OPERATIONS PLAYBOOK', bold: true, size: 44, font: FONT })] }),
  new Paragraph({ children: [new TextRun({ text: '& STAFF TRAINING GUIDE', bold: true, size: 44, font: FONT })], spacing: { after: 200 } }),
  new Paragraph({ children: [new TextRun({ text: 'Version 2.0 — integrated with the Swaggers Staff Portal (staff.swaggerspizza.com)', size: 24, color: MUTED, font: FONT })], spacing: { after: 400 } }),
  p('A practical guide for safe, reliable pizza vending at airports, malls, offices, schools and other busy locations.', { size: 24 }),
  spacer(),
  callout('Serve customers politely. Keep the machine and area clean. Protect food safety. Check payments and orders. Report problems early.', { label: 'OUR PROMISE' }),
  new Paragraph({ spacing: { before: 1600 }, children: [new TextRun({ text: 'Prepared for internal Swaggers Pizza use · Ghana · Currency: GHS', color: MUTED, font: FONT })] }),
  new Paragraph({ children: [new PageBreak()] }),
);

// Document control + contents
add(
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Document control', font: FONT })] }),
  table([
    ['Version', 'Date', 'Change'],
    ['1.0', '12 October 2026', 'New operations playbook and training guide based on Swaggers Pizza requirements. Technical and food-safety details must be confirmed before launch.'],
    ['2.0', '12 October 2026', 'Expanded from 10 to 25 SOPs (temperature monitoring, waste, security, emergencies, cold-chain logistics, preventive maintenance, allergens, daily reconciliation, attendance & handover, escalation matrix, portal use, new-site launch, data privacy, hygiene, product recall). Added full checklist library, response-time targets, refund and spending authority limits, KPI targets, training modules with quizzes, and the live Staff Portal that automates these procedures.'],
  ], [1, 2, 7]),
  spacer(),
  callout('The Staff Portal is the live, controlling copy of every SOP and checklist. This document is generated from the same source. If the two ever differ, the approved version in the portal applies.', { label: 'IMPORTANT', fill: 'DBEAFE', border: '1D4ED8' }),
  new Paragraph({ children: [new PageBreak()] }),
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Contents', font: FONT })] }),
  new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),
);

// ═════════════ 1. HOW TO USE ═════════════
add(h1('1. How to use this playbook'),
  p('This guide explains daily work in simple English. Every staff member must read it, practise the steps and follow the rules. The Operations Manager must train staff and check that the rules are followed.'),
  bullet('Use the checklists every shift — in the Staff Portal. Never tick a task before it is done.'),
  bullet('Report problems as soon as you see them using the red **Report a problem** button. Do not hide mistakes.'),
  bullet('Only trained and approved people may open restricted panels, repair the machine or change restricted settings.'),
  bullet('When this guide says “confirm”, the Manager must get written instructions from the machine supplier, food-safety lead, payment provider or site manager — and record them in **Launch Readiness**.'),
  bullet('Not sure? Ask **Ask Swaggers** (the portal assistant, which only answers from approved documents) or your Supervisor. Never guess on safety, food or payments.'),
  spacer(),
  callout('This playbook does not replace the machine supplier manual, food-safety instructions, product labels, payment provider rules or site rules.', { label: 'IMPORTANT' }),
);

// ═════════════ 2. AT A GLANCE ═════════════
add(h1('2. Swaggers Pizza at a glance'),
  table([
    ['Item', 'Current operating plan'],
    ['Business', 'Swaggers Pizza automated pizza vending.'],
    ['Locations', 'Airport sites (e.g. Kotoka T3), malls, offices, university campuses and other busy public areas.'],
    ['Customer journey', 'Customer selects a pizza, pays using the approved QR/Mobile Money process, then the machine prepares and dispenses the order. A feedback QR on each machine lets customers rate us or report a problem.'],
    ['Opening target', 'Around 7:00 a.m.; each site’s approved hours are recorded on its Site page in the portal.'],
    ['Planned flavours', 'Meat, Veggie, Chicken, and Chicken & Beef Combo. Final names, recipes, allergens and prices need Owner approval (SOP-10).'],
    ['Payments', 'Preferred method: Mobile Money/QR only. Confirm the machine/provider can disable cash and card options. Every day is reconciled (SOP-18).'],
    ['Screen', 'Swaggers Pizza menu and customer information only. No third-party advertising.'],
    ['Cleaning and refill', 'Shared between Sales Reps and Operations/Stock Staff. Assigned per shift on the roster.'],
    ['Management', 'Owner approves major decisions; Operations Manager runs daily work; Supervisors run each site.'],
    ['Staff Portal', 'staff.swaggerspizza.com — checklists, incidents, stock, sales, training, approvals and dashboards on phone or laptop.'],
  ], [2, 7]),
);

// ═════════════ 3. ROLES ═════════════
add(h1('3. Roles, responsibilities and authority'),
  table([
    ['Role', 'Main duties', 'Limits', 'Portal access'],
    ['Owner / Director', 'Approve major spending, prices, new sites, menu changes, SOP changes and policy changes.', 'Do not bypass safety controls.', 'Everything, incl. Owner’s View, finance, settings.'],
    ['Operations Manager', 'Plan shifts, monitor sales/stock, train staff, handle escalations, coordinate technicians and report to Owner.', 'No unauthorised technical changes.', 'All sites; approvals up to limits; staff; reports.'],
    ['Site Supervisor / Shift Lead', 'Check opening, assign work, review checklists, confirm handover, coach staff.', 'Never sign off unchecked work.', 'Own sites; review queue; roster; tasks.'],
    ['Sales Rep / Customer Helper', 'Welcome customers, explain menu, help with screen and QR payment, guide collection, keep area tidy and report faults.', 'No restricted panels, repairs, PIN/OTP requests or unauthorised refunds.', 'Own site: checklists, report, stock, cases.'],
    ['Operations / Stock Staff', 'Receive stock, check records, refill as trained, rotate stock (FEFO), clean and count stock, deliver restocks.', 'Do not guess storage rules or use unverified product.', 'Stock receiving, batches, restock.'],
    ['Approved Technician', 'Perform authorised repairs, preventive maintenance and technical checks.', 'Return machine to service only after required safety/function checks.', 'Assigned incidents, machines, maintenance log.'],
    ['Customer Support / Accounts', 'Review payment evidence, reconcile transactions, pay approved refunds, record income and expenses.', 'Never request customer PINs, OTPs or passwords.', 'Payments, close-outs, refunds, finance.'],
  ], [2.2, 4, 2.6, 2.6]),
  h2('Approval authority (defaults — the Owner can change these in Settings)'),
  table([
    ['Decision', 'Who approves'],
    ['Refund up to GH₵100', 'Operations Manager'],
    ['Refund above GH₵100', 'Owner'],
    ['Expense up to GH₵500', 'No approval needed (recorded with receipt)'],
    ['Expense GH₵500 – GH₵2,000', 'Operations Manager'],
    ['Expense above GH₵2,000', 'Owner'],
    ['Price, flavour, promotion, screen content', 'Owner'],
    ['SOP / playbook change', 'Owner (drafts stay hidden until approved)'],
    ['New site or machine', 'Owner'],
    ['Leave requests', 'Operations Manager'],
    ['Release of stock on hold', 'Operations Manager or Owner'],
  ], [5, 4]),
);

// ═════════════ 4. RULES ═════════════
add(h1('4. Non-negotiable rules'),
  ...[
    'Be polite and calm, even when a customer is upset.',
    'Never serve food if its safety or condition is in doubt.',
    'Never invent cooking times, temperatures, storage limits or expiry rules.',
    'Never ask for a Mobile Money PIN, bank PIN, password or OTP.',
    'Never use a personal wallet or personal QR code to collect business payments.',
    'Do not promise a refund unless authorised.',
    'Do not force doors, bypass safety switches or open restricted panels.',
    'Keep exits, walkways, fire equipment and airport/security routes clear.',
    'Use your own staff account; never share passwords.',
    'No third-party advertising on the pizza machine screen.',
    'Record it when it happens — checklists, stock, waste, temperatures and problems are entered in the portal at the time, not later from memory.',
    'Nobody works alone until they are signed off as trained (quiz + practical) in the portal.',
  ].map(bullet),
);

// ═════════════ 5. SOPs ═════════════
add(h1('5. Standard Operating Procedures'),
  p('Each SOP below is also in the portal Handbook, where staff confirm they have read the current version. SOP-11 to SOP-25 are new in version 2.0.'),
  table([['Code', 'Procedure', 'Purpose'], ...SOPS.map((s) => [s.code, s.title, s.purpose])], [1.2, 3, 6]),
);
for (const s of SOPS) {
  add(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: `${s.code} — ${s.title}`, font: FONT })], pageBreakBefore: false, spacing: { before: 360 } }),
    p(`**Purpose:** ${s.purpose}`, { color: INK }),
    p(`**Applies to:** ${s.roles === 'all' ? 'All staff' : s.roles.split(',').map((r) => ROLES[r]?.label || r).join(', ')}`, { color: MUTED }),
    ...markdown(s.body));
}

// ═════════════ 6. LOCATIONS ═════════════
add(h1('6. Extra rules by location'),
  table([['Location', 'Extra checks'], ...Object.entries(SITE_RULES).map(([k, v]) => [k === 'school' ? 'School / campus' : k === 'other' ? 'Other busy public site' : k[0].toUpperCase() + k.slice(1), v])], [2, 7]),
  spacer(),
  p('Airport and school/campus sites have an extra daily checklist in the portal (see section 8).'),
);

// ═════════════ 7. TRAINING ═════════════
add(h1('7. Staff training and sign-off'),
  p('A new staff member must complete the training modules (each with a short quiz, pass mark 80%) and a practical test observed by a Supervisor before working alone. The portal marks a person “cleared to work alone” automatically once every required module is passed.'),
  table([['Module', 'Covers', 'For', 'Practical test'], ...TRAINING.map((m) => [`${m.code} ${m.title}`, m.summary, m.roles ? m.roles.split(',').map((r) => ROLES[r]?.label.split(' /')[0] || r).join(', ') : 'Everyone', m.practical ? 'Yes' : 'No'])], [3, 4.5, 2.5, 1.2]),
  h2('Competencies — the staff member must show they can…'),
  table([
    ['Topic', 'Staff member must show they can…'],
    ['Customer service', 'Greet customers (G.U.I.D.E.), explain the menu and stay calm with complaints (L.A.S.T.).'],
    ['Machine basics', 'Use the customer-facing screen and identify warning signs without opening panels.'],
    ['QR / Mobile Money', 'Guide a customer through the approved payment flow and record a mismatch safely.'],
    ['Food safety', 'Follow approved hygiene, stock, temperature and allergen instructions and know when to stop service.'],
    ['Cleaning and refill', 'Complete only approved tasks and record them correctly (FEFO).'],
    ['Fault reporting', 'Identify critical faults, pause sales when needed and contact the right person.'],
    ['Portal use', 'Sign in with own account, clock in/out, complete checklists, record stock and report incidents.'],
  ], [2, 7]),
  h2('Sample quiz questions'),
  ...TRAINING.slice(0, 3).flatMap((m) => m.quiz.slice(0, 2).map((q) => p(`**${q.question}** — Answer: ${q.options[q.correct]}. ${q.explanation}`))),
  h2('Training record (paper backup)'),
  table([['Training record', 'Entry'], ['Staff name', ''], ['Role / site', ''], ['Trainer and date', ''], ['Modules passed', ''], ['Practical test passed', 'Yes / No — Retraining date: __________'], ['Staff signature', ''], ['Manager sign-off', '']], [3, 6]),
);

// ═════════════ 8. CHECKLISTS ═════════════
add(h1('8. Checklist library'),
  p('All checklists are completed in the portal. Items marked CRITICAL automatically raise an incident and alert the Manager if answered “No” (or if a temperature is out of range). Items marked PHOTO need a photo. Use the paper versions below only if the portal is unavailable, then enter them later.'),
  table([['Checklist', 'When', 'Due by', 'SOP'], ...CHECKLISTS.map((c) => [c.name, c.frequency.replace('_', ' ') + (c.site_type ? ` (${c.site_type} sites)` : ''), c.due_time || '—', c.sop_code || '—'])], [4, 2.5, 1.2, 1.2]),
);
for (const c of CHECKLISTS) {
  add(h2(c.name), p(c.description, { color: MUTED }),
    table([['Check', 'Yes / No / N/A', 'Notes'], ...c.items.map((it) => [`${it.text}${it.critical ? '  [CRITICAL]' : ''}${it.photo ? '  [PHOTO]' : ''}${it.type === 'temperature' ? '  — reading: ______ °C' : ''}`, '', ''])], [6, 1.6, 2.4]),
    p('Date: ____________  Site: ____________________  Machine ID: ____________  Staff: ____________________  Time: ________', { size: 18, before: 80 }));
}

// ═════════════ 9. PORTAL ═════════════
add(h1('9. The Swaggers Staff Portal'),
  p('The portal at staff.swaggerspizza.com turns this playbook into daily practice. It works on phones and laptops and can be installed on a phone’s home screen. It does not just collect information — it helps people act: every problem is recorded, the right person is notified, work is assigned and tracked until it is fixed and verified.'),
  table([
    ['Portal area', 'Purpose'],
    ['Staff Home', 'Clock in/out with location, today’s shift and machine, checklists due, tasks, announcements and handover from the last shift.'],
    ['Checklists', 'Opening, during-shift, refill, cleaning, closing, weekly, supervisor audit and site-specific checklists with name, time, photos and an audited correction trail.'],
    ['Report a problem', 'Machine faults, payment problems, food safety, stock, customer, site safety and security issues with severity and photo.'],
    ['Incidents', 'Acknowledge → assign technician/vendor → resolve with root cause and cost → verify and close. Response targets and automatic escalation.'],
    ['Machines', 'Live status, uptime, faults, stock in machine, temperature log, preventive maintenance log, customer feedback QR poster, telemetry API key.'],
    ['Stock & food safety', 'Receive deliveries with batch/expiry/temperature, FEFO loading, waste with reasons, stock counts with variance, batch hold/recall, restock requests, temperature log.'],
    ['Sales & cash-up', "Live sales stay in the supplier's machine portal (linked from the menu). Staff record each machine's daily income, orders and status from it with a screenshot; Accounts reconciles against Mobile Money settlements. Payment exceptions tracked to resolution."],
    ['Customers', 'Complaints, QR feedback, ratings, refund requests and payment through Accounts.'],
    ['Approvals', 'Refunds, expenses, prices, menu, SOP changes, new sites, leave — with authority limits.'],
    ['Roster & attendance', 'Weekly roster, geofenced clock-in/out with server time, lateness and overtime engine, auto clock-out at 23:59, manager corrections with audit trail, handovers.'],
    ['Leave & late permission', 'Leave requests and late permissions ("arrive by" time) with inline approval; approving recalculates attendance automatically.'],
    ['Payroll', 'One-click monthly payroll from pay settings, attendance, overtime, leave and absences; SSNIT and lateness deductions; finalise to lock, notify staff and post the expense; payslips for staff.'],
    ['Leaderboard', 'Monthly ranking (attendance, punctuality, checklist quality, reliability) and Employee of the Month.'],
    ['Access & roles', 'Owner chooses which areas each role can use and can grant or remove access for one person. Deny by default.'],
    ['Training & Handbook', 'All SOPs with read tracking, playbook e-signature, modules, quizzes, practical sign-off, training matrix.'],
    ['Ask Swaggers', 'AI assistant that answers staff questions only from approved Swaggers documents and cites the SOP.'],
    ['Operations dashboard', '“Needs attention” list, machines and stock, checklist compliance, revenue and demand by hour.'],
    ['Owner’s View', 'Revenue, gross and net profit, location league table, flavour mix, machine reliability, staff performance, decisions waiting.'],
    ['Finance & Reports', 'P&L, site profitability, budgets, waste, compliance, uptime, repeat faults, CSV exports.'],
    ['Admin', 'Company settings and branding, attendance and payroll rates, menu and prices, suppliers, append-only audit and security logs, backups.'],
  ], [2.2, 7]),
  h2('What the portal does automatically'),
  ...[
    'Raises an incident and alerts the Manager when a critical checklist item fails or a temperature is out of range.',
    'Escalates an unacknowledged incident to the Owner (Critical: 15 min) and any incident that misses its fix target.',
    'Flags missed checklists 30 minutes after their due time and notifies staff on shift and the Supervisor.',
    'Alerts when staff have not clocked in 15 minutes after a shift starts, and marks missed shifts.',
    'Sends low-stock / out-of-stock and expiring-batch alerts; never moves held, recalled or expired stock.',
    'Warns when preventive maintenance is due and highlights machines with repeat faults.',
    'Marks a machine offline and raises an incident if it stops sending heartbeats (when telemetry is connected).',
    'Flags close-out variances above tolerance and unverified close-outs older than two days.',
    'Sends the Owner and Operations Manager a daily summary at the end of the day.',
    'Takes a nightly database backup and keeps 30 days.',
  ].map(bullet),
  h2('Portal security rules'),
  ...[
    'Each staff member has a separate account; temporary passwords must be changed at first sign-in. Accounts lock after 5 wrong passwords in 15 minutes.',
    'Sessions end after 2 hours of inactivity; signing out in one browser tab signs out every tab.',
    'Staff can be Active, Suspended (read-only) or Inactive (cannot sign in).',
    'Staff see only the sites and records needed for their role. Leavers are deactivated immediately, which signs them out.',
    'Machine admin passwords, payment secrets and customer financial credentials are never stored in the portal.',
    'Every submission and change is recorded with who and when; checklist corrections require a reason (audit trail).',
    'Only the last 4 digits of a customer’s phone number are recorded for payment issues; customer contact details are restricted (Ghana Data Protection Act, 2012 — Act 843).',
    'Secure hosting with HTTPS, nightly backups and quarterly access reviews.',
  ].map(bullet),
);

// ═════════════ 10. KPIs ═════════════
add(h1('10. Management measures and targets'),
  table([
    ['Measure', 'Why it matters', 'Target'],
    ['Orders and sales by site / machine / flavour', 'Shows demand and helps plan stock.', 'Tracked daily'],
    ['Paid orders vs dispensed orders', 'Finds orders that may be stuck or mismatched.', '0 unresolved after 48 h'],
    ['Payment failures and unmatched payments', 'Helps spot QR or provider problems.', 'Reviewed within 1 business day'],
    ['Machine uptime and downtime', 'Shows whether customers can buy.', '≥ 97% per machine'],
    ['Stock use, waste and variance', 'Controls costs and reduces losses.', 'Waste < 5% of units sold; count variance explained'],
    ['Checklist completion', 'Shows whether daily controls are followed.', '≥ 95% on time'],
    ['Temperature readings', 'Proves food was stored safely.', '3 per machine per day; 0 unactioned breaches'],
    ['Complaints and time to resolve', 'Tracks customer experience and open cases.', 'Update within 48 h; rating ≥ 4.3★'],
    ['Incident response', 'Faster fixes = more sales.', 'Critical ack ≤ 15 min, fix ≤ 4 h; Major ack ≤ 30 min, fix ≤ 24 h'],
    ['Daily close-out', 'Every cedi matches a pizza.', 'Variance ≤ GH₵20 or 2%; verified within 2 days'],
    ['Training completion', 'Shows who is ready to work alone.', '100% before working alone'],
    ['Attendance', 'Right person, right place.', '≥ 98% shifts attended; lateness tracked'],
  ], [3.2, 3.5, 3]),
);

// ═════════════ 11. READINESS ═════════════
add(h1('11. Launch readiness — items to confirm'),
  p('Keep each item open until there is an approved answer. Do not fill gaps by guessing. The portal holds a business-wide list and a per-site list for every new location, with evidence and who confirmed it.'),
  table([['Item to confirm', 'Owner / source', 'Status'], ...READINESS.map(([i, o]) => [i, o, 'Open'])], [5, 3, 1.2]),
);

// ═════════════ 12. ROADMAP ═════════════
add(h1('12. Growth roadmap'),
  p('One system. Every location. Full control. The aim is that Swaggers Pizza can be managed from a phone or laptop, with a clear view of what is happening at every location, what needs attention and who is responsible.'),
  table([
    ['Phase', 'What it delivers', 'Status in the portal'],
    ['1 — Operations foundation', 'Digital SOPs, staff accounts, opening/closing checklists, cleaning records, stock logs, incident reporting, manager approvals.', 'Built'],
    ['2 — Business monitoring', 'Sales and payment reporting, machine status, waste monitoring, staff performance, automated alerts.', "Built. Live machine data stays in the supplier's machine portal; daily figures are recorded and reconciled in the staff portal. A Machine API is ready if the supplier later offers a data feed."],
    ['3 — Automation & AI', 'AI assistant on approved documents, guided procedures, daily summaries, recurring-problem detection.', 'Built (needs an Anthropic API key to switch on the AI; keyword search works without it).'],
    ['4 — Multi-location expansion', 'Add sites and machines, compare locations, keep central standards.', 'Built — new site wizard with readiness checklist, league table, site profitability.'],
  ], [2.5, 4.5, 3.5]),
  h2('Recommended next steps'),
  ...[
    'Confirm the open launch-readiness items with the machine supplier, food-safety lead and payment provider — especially temperature ranges, shelf life and refill method.',
    'Ask the machine supplier for telemetry/API access so sales, faults and temperatures flow in automatically.',
    'Ask the payment provider for a daily settlement export (or webhook) to automate reconciliation.',
    'Print and install the customer feedback QR poster on every machine.',
    'Run a two-week pilot with the portal at one site, review with the Owner, then roll out.',
  ].map(bullet),
);

// ═════════════ APPENDICES ═════════════
add(h1('Appendix A — Quick reference card'),
  table([
    ['Situation', 'Do this'],
    ['Smoke, burning smell, exposed wires, shock risk', 'Stop sales if safe. Keep people away. Alert site security and Manager. Fire 192 · Ambulance 193 · Police 191 · Emergency 112. Report as CRITICAL.'],
    ['Money taken, no pizza', 'Do NOT ask the customer to pay again. Record a payment exception (last 4 digits + reference). Tell them they’ll get an update within 48 h.'],
    ['Temperature out of range', 'Do not sell. Re-check in 10 minutes. If still out: hold stock, report CRITICAL, call Manager.'],
    ['Customer complaint', 'L.A.S.T. — Listen, Apologise, Solve or send, Thank. Record a customer case.'],
    ['Machine error', 'Record the error code, pause sales if it can’t serve, report. Don’t keep restarting.'],
    ['Low stock', 'Load from store (FEFO) or submit a restock request in the portal.'],
    ['Not sure what to do', 'Check the Handbook, Ask Swaggers, or call your Supervisor. Never guess.'],
  ], [3, 6]),
  spacer(),
  callout('Greet · Understand · Inform · Direct · End well', { label: 'G.U.I.D.E.' }), spacer(),
  callout('Listen · Apologise · Solve or send · Thank', { label: 'L.A.S.T.' }),
);
add(h1('Appendix B — Incident report form (paper backup)'),
  table([['Field', 'Details'], ['Date / time', ''], ['Site / machine ID', ''], ['Incident type', 'Machine / Payment / Food safety / Stock / Customer / Site safety / Security / Other'], ['Severity', 'Critical / Major / Minor'], ['Order ID / payment reference', ''], ['What happened?', '\n\n'], ['Action taken (sales paused?)', '\n'], ['Who was notified and when?', ''], ['Evidence reference, if approved', ''], ['Manager review / outcome', '\n'], ['Closed by / date', '']], [3, 6]),
);
add(h1('Appendix C — Staff acknowledgement'),
  p('I confirm that I have received and read the Swaggers Pizza Operations Playbook and Staff Training Guide (version 2.0). I understand that I must follow approved machine, food-safety, payment, site and security procedures. I will report problems honestly and will not do work I am not trained or authorised to do.'),
  p('(Staff sign this electronically in the portal: Handbook → Sign acknowledgement.)', { color: MUTED }),
  spacer(),
  ...['Staff name', 'Role / site', 'Signature', 'Date', 'Manager / trainer'].map((l) => p(`${l}: ______________________________________________`, { after: 240 })),
);

// ═════════════ BUILD ═════════════
const doc = new Document({
  creator: 'Swaggers Pizza', title: 'Swaggers Pizza Operations Playbook & Staff Training Guide v2.0',
  features: { updateFields: true },
  styles: {
    default: { document: { run: { font: FONT, size: 21, color: INK } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 36, bold: true, color: BRAND, font: FONT }, paragraph: { spacing: { before: 240, after: 200 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 27, bold: true, color: INK, font: FONT }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 22, bold: true, color: BRAND, font: FONT }, paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 2 } },
    ],
  },
  numbering: { config: [
    { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
    { reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] },
  ] },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Swaggers Pizza · Operations Playbook v2.0', color: MUTED, size: 16, font: FONT })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }], children: [new TextRun({ text: 'Internal use · Live copy: staff.swaggerspizza.com/handbook', color: MUTED, size: 16, font: FONT }), new TextRun({ children: ['\tPage ', PageNumber.CURRENT], color: MUTED, size: 16, font: FONT })] })] }) },
    children,
  }],
});

const outDir = path.join(__dirname, '..', 'docs');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'Swaggers_Pizza_Operations_Playbook_v2.docx');
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(out, buf); console.log(`Wrote ${out} (${(buf.length / 1024).toFixed(0)} KB)`); });
