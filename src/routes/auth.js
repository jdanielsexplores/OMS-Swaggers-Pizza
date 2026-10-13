const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { audit, security } = require('../services/audit');
const { requireAuth } = require('../middleware');
const { sqlNow, addMinutes } = require('../lib/util');

const r = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60000, limit: 30, standardHeaders: true, legacyHeaders: false });

function demoAccounts() {
  if (db.setting('demo_mode', '0') !== '1') return null;
  return {
    password: db.setting('demo_password', ''),
    users: db.all("SELECT username, name, role FROM users WHERE username IS NOT NULL AND active = 1 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'ops_manager' THEN 1 WHEN 'supervisor' THEN 2 WHEN 'sales_rep' THEN 3 WHEN 'stock_staff' THEN 4 WHEN 'accounts' THEN 5 ELSE 6 END, username"),
  };
}

r.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.page('login', 'Sign in', { email: '', demo: demoAccounts(), timedOut: req.query.timeout === '1' });
});

r.post('/login', loginLimiter, (req, res) => {
  const id = String(req.body.email || '').trim().toLowerCase();
  const fail = (msg) => { res.status(401); res.page('login', 'Sign in', { email: id, error: msg, demo: demoAccounts() }); };
  // Database-backed brute-force protection per IP (PRD: max 5 attempts / 15 min per account, plus IP throttle).
  const ipFails = db.val("SELECT COUNT(*) FROM security_log WHERE event = 'login.failed' AND ip = ? AND created_at >= datetime('now','-15 minutes')", req.ip);
  if (ipFails >= 20) { security(req, 'login.blocked_ip', { identifier: id }); return fail('Too many failed sign-ins from this device. Wait 15 minutes.'); }
  const u = db.get('SELECT * FROM users WHERE lower(email) = ? OR upper(staff_no) = upper(?) OR lower(username) = ?', id, id, id);
  if (!u || !u.active || u.status === 'inactive') { security(req, 'login.failed', { identifier: id, details: 'unknown or inactive account' }); return fail('Username or password is incorrect.'); }
  if (u.locked_until && u.locked_until > sqlNow()) { security(req, 'login.locked', { userId: u.id, identifier: id }); return fail('Account locked after too many attempts. Try again in 15 minutes or ask your Manager.'); }
  if (!bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    const n = (u.failed_logins || 0) + 1;
    db.update('users', u.id, { failed_logins: n, locked_until: n >= 5 ? addMinutes(new Date(), 15) : null });
    security(req, n >= 5 ? 'lockout' : 'login.failed', { userId: u.id, identifier: id, details: { attempt: n } });
    return fail(n >= 5 ? 'Too many attempts — account locked for 15 minutes.' : `Username or password is incorrect. ${5 - n} attempt(s) left before a 15-minute lock.`);
  }
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = u.id;
    req.session.lastSeen = Date.now();
    db.update('users', u.id, { failed_logins: 0, locked_until: null, last_login_at: sqlNow() });
    security(req, 'login.success', { userId: u.id, identifier: id });
    audit({ ...req, user: u }, 'login', 'users', u.id);
    const to = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(to);
  });
});

// Global sign-out: destroys the server session; other tabs notice via /session/ping and the storage event.
r.post('/logout', (req, res) => {
  if (req.user) security(req, 'logout');
  req.session.destroy(() => res.redirect('/login'));
});

// Lightweight session check used by the browser for idle-timeout and cross-tab sync (does not extend the session).
r.get('/session/ping', (req, res) => res.json({ signedIn: !!req.user, idleMs: 2 * 3600 * 1000 }));

r.get('/account', requireAuth, (req, res) => {
  const sites = db.all('SELECT s.name FROM user_sites us JOIN sites s ON s.id = us.site_id WHERE us.user_id = ?', req.user.id);
  const acks = db.all('SELECT * FROM acknowledgements WHERE user_id = ? ORDER BY signed_at DESC', req.user.id);
  res.page('account', 'My account', { sites, acks });
});

r.post('/account', requireAuth, (req, res) => {
  db.update('users', req.user.id, { phone: req.body.phone || null, emergency_contact: req.body.emergency_contact || null });
  req.flash('success', 'Profile updated.');
  res.redirect('/account');
});

r.get('/account/password', requireAuth, (req, res) => res.page('password', 'Change password'));

r.post('/account/password', requireAuth, (req, res) => {
  const { current, password, confirm } = req.body;
  const err = (m) => { req.flash('error', m); res.redirect('/account/password'); };
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) return err('Current password is wrong.');
  if (String(password).length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return err('Use at least 10 characters with letters and numbers.');
  if (password !== confirm) return err('The new passwords do not match.');
  if (bcrypt.compareSync(password, req.user.password_hash)) return err('Choose a different password from your current one.');
  db.update('users', req.user.id, { password_hash: bcrypt.hashSync(password, 11), must_change_password: 0 });
  security(req, 'password.changed');
  req.flash('success', 'Password changed.');
  res.redirect('/');
});

module.exports = r;
