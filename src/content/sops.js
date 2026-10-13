// Swaggers Pizza Standard Operating Procedures — Playbook v2.0
// Source: "Operations Playbook & Staff Training Guide" v1.0 (12 Oct 2026), extended.
// Body format: lightweight markdown (## heading, 1. steps, - bullets, > callout, | tables |).

module.exports = [
  {
    code: 'SOP-01', title: 'Open the site', category: 'operations',
    roles: 'supervisor,sales_rep,stock_staff',
    purpose: 'Make sure every machine opens safe, clean, stocked and able to take verified payments by the rostered opening time (target 07:00).',
    body: `
## When
Every day, before the site's approved opening time. Arrive at least 20 minutes before opening.

## Steps
1. Arrive at the rostered time and **clock in on the portal** (Staff Home → Clock in). Location is recorded.
2. Check that the site is safe and access rules are being followed. Keep walkways, exits and fire equipment clear.
3. Inspect the machine exterior for damage, tampering, broken seals, unusual noise, smell or warning messages.
4. Check that power and connectivity appear normal (screen on, network indicator, no error code). Do not touch exposed wires or open panels.
5. Check the menu and available flavours against stock. Mark unavailable any flavour you cannot supply safely.
6. Record the chiller/storage temperature in the portal. If out of range, follow SOP-11 — do not open for sale.
7. Complete the approved hygiene and food-safety checks (hands washed, uniform, sanitiser stocked, collection area clean).
8. Run only supplier-approved start-up checks. Do not change settings.
9. Run the approved payment test (test order or provider test) where one has been provided.
10. Submit the **Opening Checklist** in the portal. Any "No" on a critical item automatically raises an incident and alerts the Manager.
11. Tell the Manager immediately if a safety, food, payment or machine check fails. Do not open for sale until cleared.

> TARGET: Machine "Ready for sale" by opening time, opening checklist submitted no later than 15 minutes after opening.

## Records
Opening checklist, temperature log, opening stock count, any incidents.`,
  },
  {
    code: 'SOP-02', title: 'Help a customer buy pizza', category: 'customer',
    roles: 'sales_rep,supervisor',
    purpose: 'Give every customer the same friendly, fast and accurate Swaggers experience at every location.',
    body: `
## The Swaggers greeting (5 steps — "G.U.I.D.E.")
- **G**reet: smile, eye contact, "Welcome to Swaggers Pizza! Can I help you choose?"
- **U**nderstand: ask what they like; offer the bestseller if they hesitate.
- **I**nform: explain flavours, price and approx. wait time using approved menu and allergen info only.
- **D**irect: guide to the QR / Mobile Money payment step — never touch their phone unless they ask, never see their PIN.
- **E**nd well: explain collection, thank them, invite feedback via the QR feedback code.

## Steps
1. Greet the customer and ask if they need help.
2. Show how to select a flavour. Use approved menu/allergen information when answering ingredient questions (SOP-17).
3. Confirm the flavour and price shown on screen before payment.
4. Guide the customer to the approved QR/Mobile Money payment step. Never handle their PIN or ask them to reveal it.
5. Wait for the machine or approved payment system to confirm the order. A screenshot alone may not prove the machine received payment.
6. If payment is confirmed, explain the on-screen collection steps and wait time.
7. If money appears deducted but no order appears, **do not ask the customer to pay again**. Record a Payment Exception in the portal and escalate (SOP-03).
8. Thank the customer and invite them to report any issue or give feedback.

> SERVICE STANDARD: Acknowledge a waiting customer within 30 seconds. Queue longer than 5 people → call the Supervisor for support.`,
  },
  {
    code: 'SOP-03', title: 'QR / Mobile Money payment problems', category: 'payments',
    roles: 'sales_rep,supervisor,accounts,ops_manager',
    purpose: 'Handle payment problems safely, without losing customer money or business money, and without guessing.',
    body: `
## Decision table
| Situation | Staff action |
| Payment confirmed and order appears | Let the customer follow the collection steps. |
| Money deducted but no order | Do not request a second payment. Record time, amount, order/reference, last 4 digits of phone and machine ID as a Payment Exception; escalate. |
| Payment pending or failed | Follow provider instructions. Do not guess whether money was taken. Wait up to 2 minutes then record. |
| QR damaged or will not load | Pause the affected payment route and notify the Manager. Never substitute a personal QR code. |
| Wrong amount or duplicate payment | Record available references and escalate for reconciliation. |
| Payment service down | Stop taking orders if payment cannot be verified. Display only an approved service notice. Raise a Major incident. |

## Rules
- Never ask for, see, write down or store a PIN, OTP, password or full card number.
- Never use a personal wallet or personal QR to collect business money.
- Never give cash refunds from your own pocket.
- Accounts must review every open Payment Exception within **1 business day**; customer must receive an update within **48 hours**.

## Reconciliation
Each day Accounts matches provider settlements to machine orders in the portal (SOP-18). Unmatched payments stay open until resolved.`,
  },
  {
    code: 'SOP-04', title: 'Food quality and safe service', category: 'food_safety',
    roles: 'all',
    purpose: 'Protect customers and the Swaggers brand by serving only safe, approved, high-quality pizza.',
    body: `
## Steps
1. Use only approved products, ingredients and recipes.
2. Check labels, batch details, expiry/use-by information and packaging as required by the approved food-safety plan.
3. Follow the approved storage and temperature logs (SOP-11). If a reading is outside the safe limit, hold the affected stock and contact the Manager.
4. Do not sell food if packaging is damaged, product identity is unclear, expiry information is missing or safety is in doubt.
5. Do not change cooking time, temperature or machine settings. Only authorised people may do this under the approved supplier procedure.
6. If a customer reports a possible food-safety issue: apologise, record a **Food Safety incident (Critical)**, put the batch on hold in the portal, and escalate immediately.

## Quality spot-check (once per shift)
- Look: correct colour, toppings evenly spread, box clean and closed.
- Temperature: served hot as the machine is designed.
- Record the spot-check on the During-Shift checklist.

> MUST BE APPROVED IN WRITING: recipes, allergens, ingredient declarations, storage temperatures, shelf life, loading/refill method, cooking settings, cleaning chemicals and cleaning frequency. Do not invent these values.`,
  },
  {
    code: 'SOP-05', title: 'Receive and refill stock', category: 'stock',
    roles: 'stock_staff,supervisor,sales_rep',
    purpose: 'Keep every machine stocked with safe, traceable product and every unit accounted for.',
    body: `
## Receiving
1. Accept stock only from an approved supplier or authorised Swaggers delivery.
2. Check product name, quantity, batch/lot, expiry information, packaging and delivery temperature.
3. Record received quantities and any rejected or damaged items in **Stock → Receive**.
4. Store products using approved handling instructions immediately.

## Refilling a machine
5. Use FEFO (First Expiry, First Out) — the portal shows which batch to load first.
6. Refill only after training and only using the supplier-approved method. Do not open restricted panels.
7. Record quantities loaded by flavour and batch in **Stock → Load machine**.
8. Complete the Refill checklist.
9. Report shortages, waste or unexplained differences — never "adjust" a count without an explanation.

## Restock triggers
- Machine stock below reorder level → portal raises a low-stock alert and the Supervisor submits a Restock Request.
- Restock Requests should be delivered the same day for "urgent" and next morning for "normal".`,
  },
  {
    code: 'SOP-06', title: 'Clean the machine and customer area', category: 'cleaning',
    roles: 'sales_rep,stock_staff,supervisor',
    purpose: 'Keep food-contact areas hygienic and the customer area inviting.',
    body: `
## Steps
1. Follow the written cleaning schedule approved for the exact machine model and food-contact surfaces.
2. Use only approved cleaning products and tools. Never mix chemicals.
3. Follow approved shut-down, cool-down and isolation steps before cleaning any area with heat or moving parts.
4. Keep liquids away from electrical parts, screens, sockets and openings not intended for cleaning.
5. Clean only parts you are trained and permitted to clean. Do not dismantle restricted parts.
6. Clean floors, collection areas and customer touchpoints according to the site schedule.
7. Record the task, time and staff member in the Cleaning checklist. Report damage or residue that cannot be safely removed.

## Minimum schedule (until supplier schedule is confirmed)
| Area | Frequency |
| Screen, buttons, QR plate | Every 2 hours and when visibly dirty |
| Collection door / tray (exterior) | Every 2 hours |
| Floor and bin around machine | Every 2 hours; bin emptied when 3/4 full |
| Machine exterior panels | Opening and closing |
| Approved internal food-contact areas | As per supplier schedule — trained staff only |
| Deep clean | Weekly, logged in the Weekly Deep-Clean checklist |`,
  },
  {
    code: 'SOP-07', title: 'Machine fault or safety issue', category: 'safety',
    roles: 'all',
    purpose: 'Respond to faults quickly and safely, get the machine back in service and learn from repeat problems.',
    body: `
## Severity levels
| Level | Examples | Action | Response target |
| Critical / safety | Smoke, burning smell, exposed wiring, shock risk, unsafe heat, serious leak, food-safety risk | Stop sales if safe. Keep people away. Alert site management and Swaggers Manager. Call emergency services if needed. Do not touch or repair. | Manager acknowledges in 15 min; technician on site within 4 hrs |
| Major / service stopped | Will not cook/dispense, repeated payment failures, serious error code | Pause affected sales, record error and contact Manager/approved technician. | Acknowledge in 30 min; fix within 24 hrs |
| Minor / still safe | Screen mark, small external damage, slow screen | Record it and notify Manager. Do not ignore it. | Acknowledge same day; fix within 7 days |

## Steps
1. Make the area safe first.
2. Report in the portal (**Report a Problem**): site, machine, time, error message, order/payment reference, photo if safe.
3. Set "Sales paused" if you stopped selling — the machine status turns red on every dashboard.
4. Do not repeatedly restart the machine unless the supplier-approved procedure allows it.
5. Only an approved technician may open restricted panels or repair the machine.
6. Return to service only after the authorised person confirms it is safe and required tests pass (portal "return-to-service check").

> The portal escalates automatically: an unacknowledged Critical incident goes to the Owner after 15 minutes.`,
  },
  {
    code: 'SOP-08', title: 'Customer complaint or refund', category: 'customer',
    roles: 'sales_rep,supervisor,accounts,ops_manager',
    purpose: 'Turn an unhappy customer into a loyal one by listening, recording and following through.',
    body: `
## The L.A.S.T. method
- **L**isten without interrupting.
- **A**pologise sincerely: "I'm sorry this happened."
- **S**olve or send: "I'll record it and contact the right person to help."
- **T**hank them for telling us.

## Steps
1. Listen without arguing.
2. Record a Customer Case: issue, time, site, machine ID, flavour, order ID and payment reference. Collect contact details only when needed (SOP-23).
3. Never record a PIN, OTP, password or full payment card details.
4. Do not promise a refund or compensation unless it is within your written authority.
5. Send the case to the Manager or approved support contact (automatic in the portal).
6. Update the case when the outcome is confirmed; do not close it early.

## Refund authority (default — Owner may change in Settings)
| Amount | Who approves |
| Up to the manager limit (default GHS 100) | Operations Manager |
| Above the manager limit | Owner |
| Any refund | Paid only by Accounts through the official provider; never cash from staff |`,
  },
  {
    code: 'SOP-09', title: 'Close and hand over', category: 'operations',
    roles: 'supervisor,sales_rep,stock_staff',
    purpose: 'End every shift with clean machines, accurate records and a clear handover so nothing is forgotten.',
    body: `
## Steps
1. Follow the approved end-of-day machine and sales procedure.
2. Complete cleaning tasks due for the shift.
3. Record remaining stock, waste, damaged products and stock differences (Stock → Count).
4. Enter the machine's end-of-day sales total for the daily close-out (SOP-18).
5. List unresolved orders, payment complaints, machine alerts and customer cases in the **Shift Handover**.
6. Leave the machine in the approved end-of-shift state. Do not switch off power unless instructed by the approved procedure.
7. Submit the Closing Checklist and brief the next shift or Manager. The incoming person acknowledges the handover in the portal.
8. Secure the area, follow site closing rules and clock out.`,
  },
  {
    code: 'SOP-10', title: 'Menu, prices and screen content', category: 'management',
    roles: 'owner,ops_manager',
    purpose: 'Keep what customers see accurate, approved and on-brand.',
    body: `
## Rules
- Show only approved Swaggers Pizza products and current prices.
- Only the Owner or a manager with written authority may approve a flavour, price, promotion or customer-facing message. Price changes are requested and approved in the portal (Approvals).
- No third-party adverts or unrelated content may appear on the machine screen.
- Check spelling, price, availability and the customer order path before publishing a change.
- Test changes using the approved process before making them live.
- Mark unavailable any flavour that cannot be supplied safely or reliably.

## Change process
1. Manager submits a Price/Menu change request with reason and effective date.
2. Owner approves or rejects in the portal.
3. On approval the system updates the price list; Supervisor updates the machine using the approved process and confirms with a test order.`,
  },
  {
    code: 'SOP-11', title: 'Temperature and food-safety monitoring', category: 'food_safety',
    roles: 'sales_rep,stock_staff,supervisor',
    purpose: 'Prove that product is stored at safe temperatures from delivery to sale.',
    body: `
## Steps
1. Record the machine storage temperature at opening, mid-shift and closing (minimum 3 readings per day).
2. Record delivery cooler temperature when receiving stock.
3. The portal compares the reading to the approved range for that product. Until the supplier confirms the range, the system uses the Manager-entered range in Settings.
4. **Out of range:** do not sell. Re-check after 10 minutes. If still out of range, put affected stock "On hold" in the portal, raise a Food Safety incident and call the Manager.
5. Never move held stock back to sale without Manager release recorded in the portal.

> A missing temperature reading counts as a failed check on the daily compliance score.`,
  },
  {
    code: 'SOP-12', title: 'Waste, expiry and disposal', category: 'stock',
    roles: 'stock_staff,sales_rep,supervisor',
    purpose: 'Control waste cost and make sure no expired or unsafe product reaches a customer.',
    body: `
## Steps
1. Check expiry dates at opening and every refill. The portal flags batches expiring within 24 hours.
2. Remove expired, damaged or held product immediately.
3. Record every wasted unit in **Stock → Waste** with reason: expired, damaged, machine fault, quality reject, recall, other.
4. Dispose of food waste using the site's approved waste route; never give expired product away to staff or customers.
5. Supervisor reviews waste daily; waste above 5% of units sold at a site triggers a corrective action.

## Waste reasons tracked
| Reason | Typical cause | Prevention |
| Expired | Over-ordering, poor FEFO | Use reorder levels, load oldest first |
| Damaged | Rough handling, crushing | Correct crates, trained loading |
| Machine fault | Failed cook/dispense | Fault reporting, preventive maintenance |
| Quality reject | Wrong appearance/temperature | Spot checks, supplier feedback |`,
  },
  {
    code: 'SOP-13', title: 'Machine security, tamper and theft', category: 'safety',
    roles: 'all',
    purpose: 'Protect machines, stock, money and people.',
    body: `
## Steps
1. Check seals, locks and panels at opening and closing; photograph any change.
2. Never leave restricted keys unattended. Keys are signed out and back in on the shift handover.
3. If you notice tampering, forced entry or a suspicious person: do not confront. Move to safety, inform site security and raise a **Security** incident.
4. At airports, follow airport security instructions and report suspicious items to security immediately.
5. Never share portal passwords, machine admin PINs or payment credentials.`,
  },
  {
    code: 'SOP-14', title: 'Emergencies and evacuation', category: 'safety',
    roles: 'all',
    purpose: 'Keep people safe first in fire, medical, power or security emergencies.',
    body: `
## Steps
1. People first, machine second. Follow the site's emergency instructions and alarms.
2. Fire or smoke from the machine: stop sales, keep people away, alert site security, call emergency services (Ghana: 112 / Fire 192 / Ambulance 193 / Police 191). Use an extinguisher only if trained and safe.
3. Medical emergency: call site first-aid / 193. Do not give food or drink.
4. Power failure: stop sales, record the time, note stock at risk and follow SOP-11 for temperature.
5. After the emergency, raise an incident with full details and a timeline.

> Every site's emergency contacts are listed on the Site page of the portal. Learn them in your first week.`,
  },
  {
    code: 'SOP-15', title: 'Stock delivery and cold-chain logistics', category: 'stock',
    roles: 'stock_staff,ops_manager',
    purpose: 'Move stock from the central store to each site safely, on time and fully traceable.',
    body: `
## Steps
1. Plan the route from approved Restock Requests (Stock → Restock requests).
2. Pick stock using FEFO and record a **Transfer** from Central Store to the vehicle/site in the portal.
3. Pre-chill the cooler; record departure temperature.
4. On arrival record arrival temperature. If out of range, follow SOP-11.
5. The receiving staff member counts and confirms the transfer. Differences are recorded immediately.
6. Mark the Restock Request as Delivered.`,
  },
  {
    code: 'SOP-16', title: 'Preventive maintenance', category: 'safety',
    roles: 'technician,ops_manager',
    purpose: 'Prevent breakdowns by servicing machines on schedule.',
    body: `
## Steps
1. Each machine has a service interval (default 30 days). The portal shows machines due or overdue.
2. Only approved technicians perform preventive maintenance using the supplier checklist.
3. Record findings, work done, parts used, cost and test results in **Machines → Maintenance log**.
4. A machine returns to "Online" only after tests pass.
5. The Operations Manager reviews machines with 3+ faults in 30 days and agrees a root-cause action with the supplier.`,
  },
  {
    code: 'SOP-17', title: 'Allergen and ingredient enquiries', category: 'food_safety',
    roles: 'all',
    purpose: 'Answer customer questions about ingredients honestly and safely.',
    body: `
## Steps
1. Use only the approved allergen information shown in the portal (Menu page) and on the machine.
2. If you are not sure, say so: "I can't confirm that, so I don't want to guess. Here is the official information."
3. Never say a product is "safe for" an allergy unless the approved label says so.
4. Record serious allergen concerns as a Customer Case (category: food safety).`,
  },
  {
    code: 'SOP-18', title: 'Daily cash-up and reconciliation', category: 'payments',
    roles: 'supervisor,accounts,ops_manager',
    purpose: "Make sure every cedi received matches a pizza sold, every day, using the supplier's machine portal as the live source.",
    body: `
## Where the figures come from
Live sales, orders and machine status are shown in the **supplier's machine portal** (opened from Sales & Cash-up or any machine page). The staff portal does not count sales itself — it records each day's figures from the machine portal and reconciles them.

## Steps
1. At closing (or first thing next morning), the Supervisor opens the machine portal and selects each machine by its **device number** (e.g. CYJ7000142).
2. Record the machine's **income** and **number of orders** for the day in **Sales & Cash-up → Record cash-up**, plus its status (online / offline).
3. Where possible, record the number of pizzas sold per flavour — this keeps machine stock and flavour reports accurate.
4. Attach a **screenshot** of the portal as evidence.
5. Accounts enters the **Mobile Money settled** amount from the provider statement and verifies the cash-up.
6. A variance above GH₵20 or 2% must be explained and linked to Payment Exceptions before it can be verified.
7. Cash-ups not verified within 2 days appear on the Owner's dashboard.

> If the machine portal shows a machine OFFLINE, also report a fault (SOP-07).`,
  },
  {
    code: 'SOP-19', title: 'Attendance, punctuality and shift handover', category: 'people',
    roles: 'all',
    purpose: 'Ensure the right person is in the right place, and nothing gets lost between shifts.',
    body: `
## Clocking in and out
- Clock in and out on the portal **at your site**. Your phone's location is checked on the server against the site's geofence (default 150 m). Outside the zone, clock-in is refused.
- The time recorded is **server time** (Africa/Accra), not your phone's clock.
- You can clock in up to 60 minutes before your start time. More than 5 hours after your start, clock-in closes and the day counts as absent unless a manager corrects it.
- Forgot to clock out? Open shifts are closed automatically at 23:59 and flagged for the manager.

## Lateness and overtime
- You are late if you clock in more than 5 minutes after your start time (or after the time in an approved **late permission**).
- Overtime counts in whole hours after 8 hours of work plus a 1-hour grace period.
- Late by more than 10 minutes → message your Supervisor before your shift starts.

## Leave and late permission
- Request leave in the portal at least 7 days ahead (except emergencies).
- Need to arrive late (exam, hospital visit)? Request a **late permission** with an "arrive by" time. When approved, that day is recalculated automatically.
- Shift swaps must be approved by the Supervisor in advance.

## Handover must include
- Stock remaining and any shortages
- Open incidents, payment exceptions and customer cases
- Machine status and any warnings
- Keys and equipment handed over
- Anything the next shift must do first`,
  },
  {
    code: 'SOP-20', title: 'Escalation matrix and response times', category: 'management',
    roles: 'all',
    purpose: 'Everyone knows who to call, how fast, and what happens if nobody answers.',
    body: `
## Matrix
| Issue | First contact | If no response | Then |
| Critical safety / food safety | Supervisor + Ops Manager (immediately) | Owner after 15 min | Emergency services if needed |
| Machine down (Major) | Ops Manager | Owner after 2 hrs | Supplier service escalation |
| Payment exception | Supervisor → Accounts | Ops Manager after 24 hrs | Payment provider |
| Stock-out | Supervisor → Stock staff | Ops Manager after 2 hrs | — |
| Customer complaint | Supervisor | Ops Manager after 24 hrs | Owner if reputational |
| Security / theft | Site security + Ops Manager | Owner immediately | Police 191 |

The portal applies these timings automatically and records every escalation on the incident timeline.`,
  },
  {
    code: 'SOP-21', title: 'Using the staff portal', category: 'people',
    roles: 'all',
    purpose: 'Use staff.swaggerspizza.com correctly and securely every shift.',
    body: `
## Every shift
1. Sign in with your own account. Never share passwords.
2. Clock in, then check **Staff Home** for your site, machine, tasks and announcements.
3. Complete checklists as you do the work — never tick a task before it is done.
4. Report problems immediately from the red **Report a Problem** button.
5. Record stock, waste and temperatures as they happen.
6. Complete the handover and clock out.

## If the portal is unavailable
Use the paper checklists (Appendix A/B), photograph them, and enter them in the portal as soon as it returns. Tell the Manager.

## Ask Swaggers (AI assistant)
Ask questions about procedures. It answers only from approved Swaggers documents. If it is unsure it will tell you to contact the Manager. It does not replace a Manager's decision.`,
  },
  {
    code: 'SOP-22', title: 'Opening a new site or machine', category: 'management',
    roles: 'owner,ops_manager',
    purpose: 'Grow without rebuilding — every new site launches to the same standard.',
    body: `
## Steps
1. Owner approves the site (New Site approval) including expected sales, rent/commission and payback.
2. Ops Manager creates the site in the portal; the Launch Readiness checklist is generated automatically.
3. Confirm every readiness item with evidence (electrical approval, site permissions, emergency contacts, payment QR test…).
4. Register the machine(s), stock location and payment QR reference.
5. Assign and train staff; each must pass training and practical sign-off before working alone.
6. Run a soft launch day with the Ops Manager present.
7. Review the first 14 days of sales, waste and faults with the Owner.`,
  },
  {
    code: 'SOP-23', title: 'Customer data and privacy', category: 'people',
    roles: 'all',
    purpose: 'Respect customers and comply with the Ghana Data Protection Act, 2012 (Act 843).',
    body: `
## Rules
- Collect only what is needed to resolve the case (name and phone number at most).
- For payments, record only the **last 4 digits** of the customer phone number and the transaction reference.
- Never photograph a customer or their phone screen showing personal details without consent.
- Never share customer details on personal WhatsApp or social media.
- Customer data is visible only to roles that need it and is deleted when no longer needed.`,
  },
  {
    code: 'SOP-24', title: 'Personal hygiene, uniform and conduct', category: 'people',
    roles: 'all',
    purpose: 'Look professional and keep food safe.',
    body: `
## Standards
- Clean Swaggers uniform and name badge every shift.
- Hands washed or sanitised before and after cleaning, refilling and handling waste.
- Hair tied back; no strong perfume; nails short and clean.
- Do not work with food if you have vomiting, diarrhoea, fever or infected cuts — tell your Supervisor.
- No eating, smoking or phone calls while serving customers (except work use of the portal).
- Be polite and calm, even when a customer is upset.`,
  },
  {
    code: 'SOP-25', title: 'Product hold and recall', category: 'food_safety',
    roles: 'ops_manager,stock_staff,supervisor',
    purpose: 'Remove a suspect batch from every machine fast and prove it was done.',
    body: `
## Steps
1. Ops Manager sets the batch to **On hold** or **Recalled** in Stock → Batches. The portal notifies every site holding that batch.
2. Staff remove the affected units immediately and confirm the quantity removed.
3. Removed units are recorded as Waste (reason: recall) or Return to supplier.
4. Ops Manager confirms all locations are clear and records the root cause with the supplier.
5. Owner is informed of every recall.`,
  },
];
