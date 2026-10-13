const path = require('node:path');

const root = path.resolve(__dirname, '..');
const env = process.env;

module.exports = {
  root,
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT || 3000),
  baseUrl: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
  dbPath: env.DB_PATH || path.join(root, 'data', 'swaggers.db'),
  uploadDir: env.UPLOAD_DIR || path.join(root, 'data', 'uploads'),
  backupDir: env.BACKUP_DIR || path.join(root, 'data', 'backups'),
  sessionSecret: env.SESSION_SECRET || 'dev-only-change-me',
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
