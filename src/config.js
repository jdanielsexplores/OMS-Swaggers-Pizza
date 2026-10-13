const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const env = process.env;

// SESSION_SECRET from the environment wins. In production without one, generate a strong random secret once,
// store it next to the database (data dir, outside the web root) and reuse it, so restarts keep people signed in.
function resolveSessionSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (env.NODE_ENV !== 'production') return 'dev-only-change-me';
  const dir = path.dirname(env.DB_PATH || path.join(root, 'data', 'swaggers.db'));
  const file = path.join(dir, '.session-secret');
  try {
    if (fs.existsSync(file)) { const s = fs.readFileSync(file, 'utf8').trim(); if (s.length >= 32) return s; }
    fs.mkdirSync(dir, { recursive: true });
    const s = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, s, { mode: 0o600 });
    console.warn(`SESSION_SECRET not set — generated a random one and saved it to ${file}. Set SESSION_SECRET in your host's environment to manage it yourself.`);
    return s;
  } catch (e) {
    console.warn('SESSION_SECRET not set and the data folder is not writable — using a temporary secret (everyone is signed out on restart).');
    return crypto.randomBytes(48).toString('hex');
  }
}

module.exports = {
  root,
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT || 3000),
  baseUrl: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
  dbPath: env.DB_PATH || path.join(root, 'data', 'swaggers.db'),
  uploadDir: env.UPLOAD_DIR || path.join(root, 'data', 'uploads'),
  backupDir: env.BACKUP_DIR || path.join(root, 'data', 'backups'),
  sessionSecret: resolveSessionSecret(),
  timezone: env.TZ_NAME || 'Africa/Accra',
  currency: env.CURRENCY || 'GHS',
  smtp: env.SMTP_HOST ? {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    from: env.SMTP_FROM || 'Swaggers Pizza Ops <ops@swaggerspizza.com>',
  } : null,
  smsWebhook: env.SMS_WEBHOOK_URL || null,       // POST {to, message} — plug in Hubtel / Arkesel / mNotify
  smsToken: env.SMS_WEBHOOK_TOKEN || null,
  anthropicKey: env.ANTHROPIC_API_KEY || null,
  aiModel: env.AI_MODEL || 'claude-opus-5-5',
};
