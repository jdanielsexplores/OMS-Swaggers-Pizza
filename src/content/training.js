// Training modules + quizzes (Playbook section 7, extended).
// q(question, [options], correctIndex, explanation)
const q = (question, options, correct, explanation) => ({ question, options, correct, explanation });

module.exports = [
  {
    code: 'TR-01', title: 'Welcome to Swaggers Pizza', roles: '', sop_codes: 'SOP-21,SOP-24', practical: 0,
    summary: 'Our promise, the non-negotiable rules, your role and how to use the portal.',
    content: `## Our promise
Serve customers politely. Keep the machine and area clean. Protect food safety. Check payments and orders. Report problems early.

## The 10 non-negotiable rules
1. Be polite and calm, even when a customer is upset.
2. Never serve food if its safety or condition is in doubt.
3. Never invent cooking times, temperatures, storage limits or expiry rules.
4. Never ask for a Mobile Money PIN, bank PIN, password or OTP.
5. Never use a personal wallet or personal QR code to collect business payments.
6. Do not promise a refund unless authorised.
7. Do not force doors, bypass safety switches or open restricted panels.
8. Keep exits, walkways, fire equipment and airport/security routes clear.
9. Use your own staff account; never share passwords.
10. No third-party advertising on the pizza machine screen.`,
    quiz: [
      q('A customer offers to show you their Mobile Money PIN so you can "help faster". What do you do?', ['Accept and enter it quickly', 'Politely refuse — never see or handle a PIN', 'Write it down for later', 'Ask the Supervisor to enter it'], 1, 'Never ask for, see or handle a PIN, OTP or password.'),
      q('Your colleague forgot their portal password. They ask to use your login. You…', ['Share it, just this once', 'Refuse and tell them to ask the Manager for a reset', 'Log in for them', 'Write it on a note'], 1, 'Every staff member must use their own account.'),
      q('Which of these is allowed on the machine screen?', ['A partner bank advert', 'Approved Swaggers menu and customer info', 'A football match', 'Your own promotion'], 1, 'Only approved Swaggers Pizza content.'),
      q('When should you tick a checklist item?', ['At the start of the shift to save time', 'Only after the task is actually done', 'At the end of the week', 'When the Manager asks'], 1, 'Never tick a task before it is done.'),
    ],
  },
  {
    code: 'TR-02', title: 'Customer service the Swaggers way', roles: 'sales_rep,supervisor', sop_codes: 'SOP-02,SOP-08', practical: 1,
    summary: 'G.U.I.D.E. greeting, handling queues and the L.A.S.T. method for complaints.',
    content: `## G.U.I.D.E.
Greet · Understand · Inform · Direct · End well.

## Handling complaints — L.A.S.T.
Listen · Apologise · Solve or send · Thank.

Say: "I'm sorry this happened. I'll record it and contact the right person to help."`,
    quiz: [
      q('A customer is shouting because their pizza was late. Best first step?', ['Explain it is the machine\'s fault', 'Listen without interrupting', 'Offer a refund immediately', 'Call security'], 1, 'Listen first (L.A.S.T.).'),
      q('Can a Sales Rep promise a refund?', ['Yes, always', 'Only within written authority', 'Yes if under GHS 200', 'Only on weekends'], 1, 'Refunds must be authorised.'),
      q('How quickly should you acknowledge a waiting customer?', ['Within 30 seconds', 'Within 5 minutes', 'When you are free', 'Only if they ask'], 0, 'Service standard: 30 seconds.'),
    ],
  },
  {
    code: 'TR-03', title: 'QR / Mobile Money payments', roles: 'sales_rep,supervisor,accounts', sop_codes: 'SOP-03,SOP-18', practical: 1,
    summary: 'Guiding payments, spotting mismatches and recording payment exceptions safely.',
    content: `## Key points
- A screenshot alone may not prove the machine received payment.
- Money deducted but no order → **do not** ask for a second payment. Record a Payment Exception.
- Record only the last 4 digits of the customer's phone and the transaction reference.
- QR damaged? Pause that route and notify the Manager. Never use a personal QR.`,
    quiz: [
      q('Money left the customer\'s wallet but no order appeared. You…', ['Ask them to pay again', 'Record a Payment Exception and escalate', 'Give cash from your pocket', 'Tell them to call their bank'], 1, 'Record and escalate; never ask for a second payment immediately.'),
      q('The machine QR sticker is damaged. What do you NOT do?', ['Notify the Manager', 'Pause that payment route', 'Show your personal MoMo QR', 'Record an incident'], 2, 'Never substitute a personal QR code.'),
      q('Which customer details may you record for a payment issue?', ['Full phone number and PIN', 'Last 4 digits of phone and transaction reference', 'Card number', 'OTP'], 1, 'Minimum data only (SOP-23).'),
      q('The payment service is down and payments cannot be verified. You…', ['Keep selling and trust customers', 'Stop taking orders and display an approved notice', 'Take cash', 'Use your own phone'], 1, 'Stop orders if payment cannot be verified.'),
    ],
  },
  {
    code: 'TR-04', title: 'Food safety essentials', roles: '', sop_codes: 'SOP-04,SOP-11,SOP-12,SOP-17,SOP-25', practical: 1,
    summary: 'Approved products only, temperature logs, expiry, allergens and when to stop service.',
    content: `## Key points
- Use only approved products and recipes. Never invent temperatures or shelf life.
- Record temperatures at opening, mid-shift and closing.
- Out-of-range temperature: do not sell, re-check in 10 minutes, hold stock, raise a Food Safety incident.
- Allergen questions: use only approved information. If unsure, don't guess.`,
    quiz: [
      q('A temperature reading is outside the approved range. First action?', ['Sell quickly before it gets worse', 'Stop selling and re-check after 10 minutes', 'Ignore if the pizza looks fine', 'Change the machine temperature'], 1, 'Stop selling, re-check, hold stock, escalate.'),
      q('A pizza box has no expiry information. You…', ['Sell it', 'Do not sell; record and report', 'Write a date on it', 'Give it to a colleague'], 1, 'Do not sell food if expiry information is missing.'),
      q('A customer asks if the Veggie pizza is nut-free and you are unsure. You say…', ['"Yes, definitely"', '"I can\'t confirm that, here is the official information"', '"Probably"', '"Just try it"'], 1, 'Never guess about allergens.'),
      q('Which stock should be loaded first?', ['The newest', 'The one with the earliest expiry (FEFO)', 'Any', 'The biggest box'], 1, 'First Expiry, First Out.'),
    ],
  },
  {
    code: 'TR-05', title: 'Machine basics and fault reporting', roles: '', sop_codes: 'SOP-07,SOP-13,SOP-14,SOP-20', practical: 1,
    summary: 'Warning signs, severity levels, safe response and escalation.',
    content: `## Severity
- **Critical**: smoke, burning smell, exposed wiring, shock risk, serious leak, food-safety risk.
- **Major**: will not cook/dispense, repeated payment failures.
- **Minor**: screen mark, small external damage.

Make it safe → report in the portal → pause sales if needed → never repair or open restricted panels.`,
    quiz: [
      q('You smell burning from the machine. Severity?', ['Minor', 'Major', 'Critical', 'Not an incident'], 2, 'Burning smell is Critical / safety.'),
      q('Who may open restricted panels?', ['Any trained Sales Rep', 'Only an approved technician', 'The Supervisor', 'Site security'], 1, 'Only approved technicians.'),
      q('The machine shows an error. Should you keep restarting it?', ['Yes until it works', 'Only if the supplier-approved procedure allows it', 'Yes, 10 times max', 'Unplug it'], 1, 'Do not repeatedly restart unless approved.'),
      q('Ghana emergency number for the fire service?', ['192', '911', '999', '100'], 0, 'Fire 192 · Ambulance 193 · Police 191 · General 112.'),
    ],
  },
  {
    code: 'TR-06', title: 'Cleaning and refill', roles: 'sales_rep,stock_staff,supervisor', sop_codes: 'SOP-05,SOP-06,SOP-15', practical: 1,
    summary: 'Approved cleaning, safe refilling, FEFO and stock records.',
    content: `## Key points
- Approved chemicals and tools only; keep liquids away from electrics.
- Shut-down/cool-down before cleaning heated or moving parts.
- Refill only with the approved method; record quantity by flavour and batch.`,
    quiz: [
      q('Before cleaning a heated part you must…', ['Spray water to cool it', 'Follow approved shut-down and cool-down steps', 'Wear gloves only', 'Ask a customer to help'], 1, 'Follow approved shut-down / cool-down.'),
      q('How often should the screen and QR plate be wiped?', ['Once a week', 'Every 2 hours and when dirty', 'Never', 'Monthly'], 1, 'Minimum every 2 hours.'),
      q('After loading pizzas into the machine you must…', ['Do nothing', 'Record quantities by flavour and batch', 'Tell the customer', 'Throw away the box'], 1, 'Record in Stock → Load.'),
    ],
  },
  {
    code: 'TR-07', title: 'Supervisor & manager essentials', roles: 'supervisor,ops_manager', sop_codes: 'SOP-09,SOP-10,SOP-16,SOP-18,SOP-19,SOP-22', practical: 0,
    summary: 'Reviewing checklists, reconciliation, rosters, approvals and corrective actions.',
    content: `## Responsibilities
- Review every submitted checklist the same day; reject dishonest or incomplete ones.
- Verify daily close-outs and explain variance.
- Assign corrective actions with an owner and due date for every failed check.
- Never sign off unchecked work.`,
    quiz: [
      q('Variance on a daily close-out is GHS 45. You…', ['Ignore it', 'Explain it and link payment exceptions before verifying', 'Adjust the sales figure', 'Pay it yourself'], 1, 'Variance above GHS 20 or 2% must be explained.'),
      q('A checklist was submitted but you suspect items were ticked without doing them. You…', ['Approve it', 'Spot-verify and reject if not done, then coach the staff', 'Delete it', 'Ignore'], 1, 'Never sign off unchecked work.'),
    ],
  },
];
