// Notifications: in-app always; email (SMTP) and SMS (webhook) when configured.
const db = require('../db');
const config = require('../config');

let mailer = null;
if (config.smtp) {
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport(config.smtp);
}

async function sendEmail(to, subject, text) {
  if (!mailer || !to) return;
  try { await mailer.sendMail({ from: config.smtp.from, to, subject, text }); }
  catch (e) { console.error('[email]', e.message); }
}
async function sendSms(to, message) {
  if (!config.smsWebhook || !to) return;
  try {
    await fetch(config.smsWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.smsToken ? { Authorization: `Bearer ${config.smsToken}` } : {}) },
      body: JSON.stringify({ to, message: message.slice(0, 300) }),
    });
  } catch (e) { console.error('[sms]', e.message); }
}

/**
 * notify({ users | roles | siteId }, { level, title, body, link })
 * - roles: array of roles; combined with siteId, site-scoped roles only get it if assigned to that site.
 */
function notify(target, msg) {
  const ids = new Set(target.users || []);
  if (target.roles?.length) {
    const rows = db.all(`SELECT id, role FROM users WHERE active = 1 AND role IN (${target.roles.map(() => '?').join(',')})`, ...target.roles);
    for (const u of rows) {
      if (target.siteId && !['owner', 'ops_manager', 'accounts'].includes(u.role)) {
        if (!db.get('SELECT 1 FROM user_sites WHERE user_id = ? AND site_id = ?', u.id, target.siteId)) continue;
      }
      ids.add(u.id);
    }
  }
  const level = msg.level || 'info';
  for (const id of ids) {
    if (!id || id === target.except) continue;
    db.insert('notifications', { user_id: id, level, title: msg.title, body: msg.body || null, link: msg.link || null });
    if (level === 'critical' || msg.email) {
      const u = db.get('SELECT email, phone FROM users WHERE id = ?', id);
      const link = msg.link ? `\n\n${config.baseUrl}${msg.link}` : '';
      sendEmail(u?.email, `[Swaggers ${level.toUpperCase()}] ${msg.title}`, `${msg.body || ''}${link}`);
      if (level === 'critical') sendSms(u?.phone, `SWAGGERS ${msg.title}. ${msg.body || ''}`);
    }
  }
  return ids.size;
}

// Send an alert only once per key (e.g. 'lowstock:12:2026-10-12').
function once(key, fn) {
  if (db.get('SELECT 1 FROM alerts_sent WHERE key = ?', key)) return false;
  db.run('INSERT INTO alerts_sent(key) VALUES (?)', key);
  fn();
  return true;
}

module.exports = { notify, once, sendEmail, sendSms };
