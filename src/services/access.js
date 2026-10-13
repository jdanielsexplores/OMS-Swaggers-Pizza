// Role-based access control with editable role defaults, per-user overrides, and site scoping.
// Deny by default: a permission is only granted if the role has it or the user has an explicit grant.
const db = require('../db');
const { ROLES } = require('../content/reference');

const ALL = ['owner', 'ops_manager', 'accounts', 'supervisor', 'technician', 'stock_staff', 'sales_rep'];
const MGMT = ['owner', 'ops_manager'];

// [perm, label, default roles] grouped by module — this drives the Access & Roles screen.
const CATALOG = [
  { module: 'Dashboards', perms: [
    ['dashboard.ops', 'Operations dashboard', [...MGMT, 'supervisor', 'accounts']],
    ['dashboard.owner', "Owner's View (profit, staff scores)", ['owner']],
  ] },
  { module: 'Checklists', perms: [
    ['checklists.use', 'Complete checklists', ALL],
    ['checklists.review', 'Review & sign off checklists', [...MGMT, 'supervisor']],
    ['checklists.templates', 'Edit checklist templates', MGMT],
  ] },
  { module: 'Incidents & tasks', perms: [
    ['incidents.view', 'View & report incidents', ALL],
    ['incidents.manage', 'Acknowledge, assign & resolve incidents', [...MGMT, 'supervisor', 'technician']],
    ['incidents.close', 'Verify & close incidents', [...MGMT, 'supervisor']],
    ['tasks.assign', 'Assign tasks to others', [...MGMT, 'supervisor']],
  ] },
  { module: 'Machines & sites', perms: [
    ['machines.view', 'View machines', ALL],
    ['machines.manage', 'Change machine status, log maintenance', [...MGMT, 'technician']],
    ['sites.view', 'View sites', ALL],
    ['sites.manage', 'Create / edit sites and machines', MGMT],
    ['readiness.manage', 'Launch readiness', MGMT],
  ] },
  { module: 'Stock & food safety', perms: [
    ['stock.use', 'Load, waste, count, temperatures', ALL],
    ['stock.manage', 'Receive deliveries, handle restocks', [...MGMT, 'stock_staff', 'supervisor']],
    ['stock.batches', 'Hold / recall batches', [...MGMT, 'stock_staff']],
    ['products.manage', 'Menu & prices', MGMT],
  ] },
  { module: 'Sales & cash-up', perms: [
    ['sales.view', 'View sales & cash-ups', [...MGMT, 'supervisor', 'accounts']],
    ['sales.record', 'Record daily cash-up from machine portal', [...MGMT, 'supervisor', 'accounts']],
    ['payments.manage', 'Verify cash-ups, resolve payment exceptions', [...MGMT, 'accounts']],
    ['machine_portal.open', 'Open supplier machine portal link', [...MGMT, 'supervisor', 'accounts', 'technician']],
  ] },
  { module: 'Customers', perms: [
    ['customers.use', 'Record customer cases', ALL],
    ['cases.manage', 'Manage cases & request refunds', [...MGMT, 'supervisor', 'accounts']],
    ['refunds.pay', 'Pay approved refunds', ['owner', 'accounts']],
  ] },
  { module: 'People & HR', perms: [
    ['roster.view', 'View roster', ALL],
    ['roster.manage', 'Edit roster', [...MGMT, 'supervisor']],
    ['attendance.view', 'View team attendance', [...MGMT, 'supervisor']],
    ['attendance.manage', 'Add / edit attendance records', MGMT],
    ['leave.decide', 'Approve leave & late permissions', MGMT],
    ['users.manage', 'Manage staff accounts', MGMT],
    ['users.compensation', 'View & edit pay / compensation', ['owner', 'accounts']],
    ['payroll.manage', 'Generate & finalise payroll', ['owner', 'accounts']],
    ['leaderboard.view', 'Leaderboard & Employee of the Month', ALL],
    ['awards.manage', 'Award Employee of the Month', MGMT],
    ['access.manage', 'Edit roles & permissions', ['owner']],
  ] },
  { module: 'Knowledge & training', perms: [
    ['handbook.view', 'Read handbook & SOPs', ALL],
    ['sops.manage', 'Edit SOPs', MGMT],
    ['training.use', 'Take training', ALL],
    ['training.assess', 'Assess practical tests, see read-tracking', [...MGMT, 'supervisor']],
    ['assistant.use', 'Ask Swaggers AI assistant', ALL],
    ['announcements.post', 'Post announcements', [...MGMT, 'supervisor']],
  ] },
  { module: 'Business', perms: [
    ['approvals.decide', 'Decide approvals', MGMT],
    ['finance.view', 'View finance', ['owner', 'ops_manager', 'accounts']],
    ['finance.record', 'Record income & expenses', ['owner', 'ops_manager', 'accounts']],
    ['vendors.manage', 'Suppliers & technicians', [...MGMT, 'accounts']],
    ['reports.view', 'Reports & exports', [...MGMT, 'accounts', 'supervisor']],
    ['audit.view', 'Audit & security logs', MGMT],
    ['settings.manage', 'Company settings & branding', ['owner']],
  ] },
];
const PERM_LIST = CATALOG.flatMap((g) => g.perms.map(([p]) => p));
const DEFAULTS = Object.fromEntries(CATALOG.flatMap((g) => g.perms.map(([p, , roles]) => [p, roles])));

// Seed role defaults for any permission not seen before (so admin removals stick across upgrades).
function ensureDefaults() {
  for (const [perm, roles] of Object.entries(DEFAULTS)) {
    if (db.setting(`perm_known:${perm}`)) continue;
    for (const r of roles) db.run('INSERT OR IGNORE INTO role_permissions(role, perm) VALUES (?, ?)', r, perm);
    db.setSetting(`perm_known:${perm}`, '1');
  }
}
ensureDefaults();

let cache = null;
const load = () => {
  if (cache) return cache;
  const roles = {};
  for (const r of db.all('SELECT role, perm FROM role_permissions')) (roles[r.role] ||= new Set()).add(r.perm);
  const users = {};
  for (const r of db.all('SELECT user_id, perm, effect FROM user_permissions')) (users[r.user_id] ||= {})[r.perm] = r.effect;
  cache = { roles, users };
  return cache;
};
const invalidate = () => { cache = null; };

function can(user, perm) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (user.status === 'suspended' && !/\.(view|use)$/.test(perm)) return false;
  const c = load();
  const o = c.users[user.id]?.[perm];
  if (o === 'deny') return false;
  if (o === 'grant') return true;
  return !!c.roles[user.role]?.has(perm);
}

const seesAllSites = (user) => ['owner', 'ops_manager', 'accounts'].includes(user.role);
function siteIds(user) {
  if (seesAllSites(user)) return db.all('SELECT id FROM sites').map((r) => r.id);
  return db.all('SELECT site_id FROM user_sites WHERE user_id = ?', user.id).map((r) => r.site_id);
}
function siteFilter(user, col = 'site_id') {
  if (seesAllSites(user)) return '1=1';
  const ids = siteIds(user);
  return ids.length ? `${col} IN (${ids.map(Number).join(',')})` : '1=0';
}
const sitesFor = (user) => db.all(`SELECT * FROM sites WHERE ${siteFilter(user, 'id')} AND status != 'closed' ORDER BY name`);
const machinesFor = (user) => db.all(`SELECT m.*, s.name AS site_name FROM machines m LEFT JOIN sites s ON s.id = m.site_id WHERE ${siteFilter(user, 'm.site_id')} AND m.status != 'decommissioned' ORDER BY s.name, m.code`);
const canSite = (user, siteId) => seesAllSites(user) || siteIds(user).includes(Number(siteId));
const roleLabel = (r) => ROLES[r]?.label || r;
const usersByRole = (...roles) => db.all(`SELECT * FROM users WHERE active = 1 AND role IN (${roles.map(() => '?').join(',')})`, ...roles);

module.exports = { CATALOG, PERM_LIST, DEFAULTS, can, invalidate, ensureDefaults, seesAllSites, siteIds, siteFilter, sitesFor, machinesFor, canSite, roleLabel, usersByRole, ROLES };
