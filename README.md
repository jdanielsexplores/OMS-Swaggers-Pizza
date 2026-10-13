# Swaggers Pizza — Operations Management System

**One system. Every location. Full control.**
The staff portal for `staff.swaggerspizza.com`: the Operations Playbook turned into daily practice for every Swaggers Pizza vending site, on phone or laptop.

It doesn't just collect records — it makes people act. A failed check raises an incident, the right person is notified, a technician is assigned, and the fault is tracked until it is fixed, verified and costed. If nobody responds, it escalates to the Owner.

---

## Quick start (your laptop)

Requires **Node.js 22.13+** (Node 24 recommended). No database server needed — it uses Node's built-in SQLite.

```bash
npm install
npm run dev
```

Open http://localhost:3000. On first start with an empty database, 30 days of realistic demo data is loaded (sites at Kotoka T3, UG Commonwealth Hall, UG Balme Library, Accra Mall and a planned office site).

**Demo sign-ins:** the sign-in page lists every demo account; tap one to sign in. They all share one simple password (`SEED_PASSWORD` in `.env.example`).

| Username | Role |
|---|---|
| `owner` | Owner / Director |
| `manager` | Operations Manager |
| `supervisor` / `supervisor2` | Supervisor (Airport + Mall / UG campus) |
| `staff` … `staff4` | Sales Reps (Airport, UG Hall, UG Library, Accra Mall) |
| `stock` | Stock Staff |
| `accounts` | Accounts |
| `tech` | Technician |

Turn the demo panel off in **Admin → Settings → demo mode** before going live.

Sign in as different people to see how each role only sees what it needs.

```bash
npm test          # 24 end-to-end workflow tests on a throwaway database
npm run playbook  # regenerate docs/Swaggers_Pizza_Operations_Playbook_v2.docx from the live SOP content
```

---

## What's inside (mapped to the brief)

| Goal | Where in the portal |
|---|---|
| **Standardise operations** | Handbook (25 SOPs with read-tracking & versioning), checklist library (opening, every-2-hours, refill, cleaning, closing, weekly deep clean, supervisor audit, airport & campus extras), editable templates |
| **Staff & accountability** | Own accounts, roles & site access, roster, GPS clock-in/out, late/missed-shift alerts, shift handovers, leave, tasks & corrective actions, staff performance scorecard, full audit log |
| **Machines & product quality** | Live machine status & uptime, incidents with severity/SLA/escalation, technician & vendor assignment, return-to-service checks, preventive maintenance, temperature logs, batch/expiry tracking, FEFO loading, hold & recall, waste with reasons, stock counts with variance |
| **Sales & cash-up** | Live sales stay in the **supplier's machine portal** (linked in the menu and on every machine). Each day staff record every machine's income, orders and status from it with a screenshot; Accounts reconciles against Mobile Money settlements. Payment exceptions, customer cases, QR feedback, refunds with approval limits |
| **Workforce (PRD)** | Geofenced clock-in/out with server time (Haversine check on the server), clock-in window and 5-hour cut-off, auto clock-out at 23:59, lateness / overtime engine (8 h + 1 h grace, whole hours), late permissions with automatic recalculation, manager attendance corrections with audit, duplicate prevention, overtime overrides, leave, one-click monthly payroll + payslips, leaderboard & Employee of the Month, Active / Suspended / Inactive staff |
| **Access control** | Access & Roles matrix (every module, per role, deny by default) + per-person grant/remove overrides, append-only audit and security logs, 2-hour idle timeout synced across tabs |
| **Train & guide staff** | 7 training modules with quizzes, practical sign-off, training matrix, "cleared to work alone" automation, playbook e-signature, **Ask Swaggers** AI assistant |
| **Better decisions** | Operations dashboard ("Needs attention"), Owner's View (P&L, location league table, flavour mix, reliability, staff scores, decisions waiting), Finance (P&L, site profitability, budgets), Reports + CSV exports |
| **Expansion** | New-site wizard with Owner approval + per-site launch-readiness checklist, machine registration, Machine API |

### Three levels of management
- **Owner** — Owner's View, finance, all approvals above limits, settings.
- **Operations Manager** — all sites, operations dashboard, staff, approvals within limits, reports.
- **Site staff** — Staff Home, their site's checklists, stock, reporting problems, customer cases, training.

Supervisors, Technicians, Stock Staff and Accounts each get a focused view. The full permission map is in `src/services/access.js`.

### Automation (runs every 5 minutes — `src/services/scheduler.js`)
- Failed critical checklist items / out-of-range temperatures → incident + alerts (food-safety ones pause sales).
- Incidents not acknowledged in time (Critical 15 min, Major 30 min) → escalated to Ops Manager & Owner; missed fix targets → Owner.
- Checklists not done 30 min after due time → staff on shift + Supervisor notified.
- Staff not clocked in 15 min after shift start; missed shifts recorded.
- Low / out-of-stock and expiring batches; expired batches blocked from loading.
- Preventive maintenance due; machines with no heartbeat marked offline.
- Unverified close-outs; daily summary to Owner & Ops Manager (AI-written when Claude is enabled).
- Nightly database backup (30 days kept).

Alerts appear in-app; **Critical** alerts also go by email (SMTP) and SMS (webhook) when configured.

---

## Deploying to staff.swaggerspizza.com

Any small Linux VPS works (1 vCPU / 1 GB RAM is plenty to start — e.g. DigitalOcean, Hetzner, AWS Lightsail).

1. **DNS:** add an `A` record `staff` → your server's IP at your domain registrar.
2. **Server:** install Node 24 and nginx, copy this folder to `/opt/swaggers-oms`, then:
   ```bash
   cd /opt/swaggers-oms && npm ci --omit=dev
   cp .env.example .env    # set SESSION_SECRET, BASE_URL, SEED_DEMO=false, SMTP…, ANTHROPIC_API_KEY
   ```
3. **Run as a service:** copy `deploy/swaggers-oms.service` to `/etc/systemd/system/` → `systemctl enable --now swaggers-oms`.
   The first start prints the Owner's one-time password in the log (`journalctl -u swaggers-oms`). You must change it at first sign-in.
4. **HTTPS:** copy `deploy/nginx-staff.swaggerspizza.com.conf` into nginx, then `certbot --nginx -d staff.swaggerspizza.com`.
5. **Backups:** nightly backups land in `data/backups`. Also copy them off the server (e.g. a daily `rclone` to Google Drive).

Docker alternative: `docker compose up -d` (uses `Dockerfile` + `docker-compose.yml`, data in a named volume).

### First-day setup checklist (as Owner)
1. Admin → Settings: logo and brand colour, the **machine portal link**, attendance rules (geofence mode, grace, cut-off), payroll rates (overtime, SSNIT, lateness), refund/expense limits and the **approved temperature range**. Switch **demo mode off**.
2. Admin → Menu & prices: final flavour names, prices, unit costs and **approved** allergen text.
3. Sites → New site for each location — stand at the machine and tap **Use my location** to set the geofence. Machines → Register machine with its **supplier device number** (as shown in the machine portal); print each machine's **Feedback QR poster**.
4. Staff → Add staff (temporary passwords are shown once), assign sites, then set each person's **schedule, pay and geofence rule** (site / custom / exempt for mobile roles). Review **Access & Roles**.
5. Roster → add shifts. Staff then sign in, sign the playbook, and complete training.
6. Launch Readiness → work through every open item with evidence.

---

## Machine portal & optional integration

The machine supplier's portal is the live source for sales, orders, faults and remote machine settings. The staff portal links to it (menu → **Machine Portal**, Sales & Cash-up, each machine page) and records each day's figures from it in **Sales & Cash-up**. Change the link in Admin → Settings.

If the supplier later offers a data feed, it can post to the built-in Machine API (key on each machine page, Owner only):

```
POST /api/v1/machine/heartbeat   {"temperature": 3.4}
POST /api/v1/machine/sale        {"order_ref":"A1029","sku":"PZ-MEAT","amount":85,"payment_ref":"MP7F3A"}
POST /api/v1/machine/fault       {"code":"E-12","message":"Dispense jam","severity":"major"}
Header: Authorization: Bearer <machine api key>
```

## Security
- Individual accounts, bcrypt-hashed passwords, forced change of temporary passwords, lockout after 5 failed attempts in 15 minutes, database-backed IP throttling, 2-hour idle timeout with cross-tab sign-out.
- Server-side geofencing (the browser only supplies coordinates; distance is calculated on the server) and server time for every clock-in.
- Append-only audit and security logs (database triggers block edits and deletes).
- Deny-by-default permissions per module (Access & Roles), per-person overrides, site scoping on every page and action; no one approves their own requests; suspended staff are read-only.
- CSRF protection on every form, secure session cookies, Helmet security headers / CSP, upload type & size limits.
- Audit log of every important action; checklist corrections require a reason.
- Only last 4 digits of customer phone numbers for payment issues; contact details restricted (Ghana Data Protection Act 843).
- The app refuses to start in production without a strong `SESSION_SECRET`.

## Project layout
```
src/
  server.js            app entry (Express 5)
  config.js            environment settings
  db/                  schema.sql, SQLite wrapper, seed (core content + demo data)
  content/             SOPs, checklists, training/quizzes, roles, readiness, finance categories  ← the playbook "source of truth"
  services/            access control, incidents, stock ledger, approvals, notifications, metrics, scheduler, AI
  routes/              one file per module
  views/               EJS templates (layout + pages + partials)
public/                CSS design system, JS, PWA manifest & service worker, icons
scripts/               build-playbook.js (docx), flow-test.js, smoke.js
deploy/                nginx + systemd configs
docs/                  generated Playbook v2.0 (.docx), downloadable from the Handbook page
```

## Still to confirm before launch (not guessed by the system)
Exact machine model/capacity, supplier start-up/shut-down/cleaning procedures, cooking settings, recipes & allergens, storage temperatures & shelf life, refill method, QR provider order-matching and settlement export, how to disable cash/card, warranty/technician contacts, site permissions. These are all tracked in **Launch Readiness**.
