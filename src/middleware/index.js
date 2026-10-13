const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const session = require('express-session');
const multer = require('multer');
const ejs = require('ejs');
const db = require('../db');
const config = require('../config');
const access = require('../services/access');
const util = require('../lib/util');
const { icon } = require('../lib/icons');

// ── SQLite session store ──
class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.get('SELECT sess, expires FROM sessions WHERE sid = ?', sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.run('INSERT INTO sessions(sid, sess, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires', sid, JSON.stringify(sess), expires);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }
  destroy(sid, cb) { db.run('DELETE FROM sessions WHERE sid = ?', sid); cb?.(null); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
setInterval(() => db.run('DELETE FROM sessions WHERE expires < ?', Date.now()), 3600000).unref();

const IDLE_MS = 2 * 3600 * 1000; // PRD: 2-hour idle timeout
const sessions = session({
  store: new SqliteStore(),
  name: 'swg.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: IDLE_MS },
});

// ── Uploads (photos / receipts / evidence) ──
fs.mkdirSync(config.uploadDir, { recursive: true });
const ALLOWED = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf|text\/csv|application\/vnd\.ms-excel)$/;
const uploads = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 6)}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.test(file.mimetype)),
}).any();
const fileFor = (req, field) => req.files?.find((f) => f.fieldname === field)?.filename || null;

// ── CSRF (synchroniser token) ──
function csrf(req, res, next) {
  if (!req.session) return next();
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.body?._csrf || req.get('x-csrf-token');
  if (sent && sent.length === req.session.csrf.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf))) return next();
  const err = new Error('Your form expired. Please go back, refresh and try again.');
  err.status = 403;
  next(err);
}

// ── Current user + view helpers ──
function loadUser(req, res, next) {
  const id = req.session?.userId;
  // Idle timeout (server-side; the browser also syncs sign-out across tabs).
  if (id && req.session.lastSeen && Date.now() - req.session.lastSeen > IDLE_MS) {
    require('../services/audit').security(req, 'timeout', { userId: id });
    req.session.userId = null;
    req.session.timedOut = true;
  }
  if (req.session && req.session.userId && !req.path.startsWith('/session/')) req.session.lastSeen = Date.now();
  req.user = req.session?.userId ? db.get("SELECT * FROM users WHERE id = ? AND active = 1 AND COALESCE(status,'active') != 'inactive'", req.session.userId) : null;
  if (req.session?.userId && !req.user) req.session.userId = null;
  const user = req.user;
  Object.assign(res.locals, util, {
    icon,
    pageUrl: require('../lib/paging').pageUrl,
    user,
    path: req.path,
    query: req.query,
    can: (perm) => access.can(user, perm),
    roleLabel: access.roleLabel,
    flash: req.session?.flash || [],
    config: { currency: config.currency, aiEnabled: !!config.anthropicKey, isProd: config.isProd },
    unread: user ? db.val('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id) : 0,
    criticalOpen: user ? db.val(`SELECT COUNT(*) FROM incidents WHERE severity = 'critical' AND status NOT IN ('resolved','closed') AND ${access.siteFilter(user, 'site_id')}`) : 0,
    pendingApprovals: user && access.can(user, 'approvals.decide') ? db.val("SELECT COUNT(*) FROM approvals WHERE status = 'pending'") : 0,
    clockedIn: user ? db.get('SELECT a.*, s.name AS site_name FROM attendance a LEFT JOIN sites s ON s.id = a.site_id WHERE a.user_id = ? AND a.clock_out IS NULL ORDER BY a.id DESC LIMIT 1', user.id) : null,
    businessName: db.setting('business_name', 'Swaggers Pizza'),
    playbookVersion: db.setting('playbook_version', '2.0'),
    brand: {
      logo: db.setting('brand_logo', '/img/logo.png'),
      color: db.setting('brand_color', '#E8501E'),
      tagline: db.setting('brand_tagline', 'Staff Portal'),
    },
    demoMode: db.setting('demo_mode', '0') === '1',
    machinePortalUrl: db.setting('machine_portal_url', 'https://m.admin.mhtxg.weisao168.com/client/mobile/index.html#/home'),
    backHref: parentPath(req.path),
    initials: user ? user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '',
    serverNow: Date.now(),
    machineStats: user ? db.get(`SELECT SUM(status='online') online, SUM(status NOT IN ('decommissioned')) total FROM machines WHERE ${access.siteFilter(user, 'site_id')}`) : null,
  });
  if (req.session) req.session.flash = [];

  req.flash = (type, msg) => { req.session.flash = [...(req.session.flash || []), { type, msg }]; };
  res.page = (view, title, data = {}) => {
    const locals = { ...res.locals, ...data, title };
    ejs.renderFile(path.join(__dirname, '..', 'views', 'pages', `${view}.ejs`), locals, { async: false }, (err, body) => {
      if (err) return next(err);
      res.render('layout', { ...locals, body });
    });
  };
  res.back = (fallback = '/') => res.redirect(req.get('referer') || fallback);
  next();
}

// Where the Back button goes when there is no browser history (e.g. opened from a notification).
function parentPath(p) {
  if (p === '/' || !p) return null;
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return '/' + parts.slice(0, -1).join('/');
}

// Module-level guards so every area is deny-by-default and controlled from Access & Roles.
const MODULES = [
  ['/checklists', 'checklists.use'], ['/incidents', 'incidents.view'], ['/report', 'incidents.view'],
  ['/machines', 'machines.view'], ['/sites', 'sites.view'], ['/stock', 'stock.use'],
  ['/customers', 'customers.use'], ['/payments', 'customers.use'], ['/roster', 'roster.view'], ['/handover', 'roster.view'],
  ['/training', 'training.use'], ['/handbook', 'handbook.view'], ['/assistant', 'assistant.use'],
  ['/leaderboard', 'leaderboard.view'],
];
function moduleGuard(req, res, next) {
  const hit = MODULES.find(([prefix]) => req.path === prefix || req.path.startsWith(prefix + '/'));
  if (!hit || access.can(req.user, hit[1])) return next();
  return denied(req, next, hit[1]);
}
function denied(req, next, perm) {
  require('../services/audit').security(req, 'access.denied', { details: { path: req.path, perm } });
  const err = new Error('You do not have access to this page. Ask your Operations Manager if you need it.');
  err.status = 403;
  return next(err);
}

// Suspended staff can sign in and read, but cannot change anything.
function suspendedReadOnly(req, res, next) {
  if (req.user?.status === 'suspended' && !['GET', 'HEAD'].includes(req.method) && !['/logout', '/account/password', '/session/ping'].includes(req.path)) {
    const err = new Error('Your account is suspended (read-only). Speak to your manager.');
    err.status = 403;
    return next(err);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect(req.session?.timedOut ? '/login?timeout=1' : '/login');
  }
  if (req.user.must_change_password && !['/account/password', '/logout'].includes(req.path)) {
    return res.redirect('/account/password');
  }
  next();
}

const requirePerm = (...perms) => (req, res, next) => {
  if (perms.some((p) => access.can(req.user, p))) return next();
  return denied(req, next, perms.join('|'));
};

module.exports = { sessions, uploads, fileFor, csrf, loadUser, requireAuth, requirePerm, moduleGuard, suspendedReadOnly };
