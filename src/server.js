// Swaggers Pizza — Operations Management System (staff.swaggerspizza.com)
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const db = require('./db');
const mw = require('./middleware');

if (config.isProd && (config.sessionSecret === 'dev-only-change-me' || config.sessionSecret.length < 24)) {
  console.error('Refusing to start: set a long random SESSION_SECRET in .env for production.');
  process.exit(1);
}

if (!db.get('SELECT 1 FROM users LIMIT 1')) {
  console.log('Empty database — loading Swaggers Pizza starter data…');
  require('./db/seed').run({ demo: process.env.SEED_DEMO !== 'false' });
}

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://api.qrserver.com'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '7d' : 0 }));
app.use('/vendor', express.static(path.join(config.root, 'node_modules', 'chart.js', 'dist'), { maxAge: '30d' }));
app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Machine / provider integration API (API-key auth, no session).
app.use('/api/v1', express.json({ limit: '1mb' }), rateLimit({ windowMs: 60000, limit: 600 }), require('./routes/api'));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(mw.sessions);
app.use(mw.uploads);
app.use(mw.csrf);
app.use(mw.loadUser);

// Public (no login): customer feedback via QR on each machine.
app.use('/f', rateLimit({ windowMs: 15 * 60000, limit: 30 }), require('./routes/public'));
app.use(require('./routes/auth'));

// Everything below needs a signed-in staff member.
app.use(mw.requireAuth);
app.use(mw.suspendedReadOnly);
app.use(mw.moduleGuard);
app.use('/uploads', express.static(config.uploadDir, { maxAge: '1d' }));
for (const r of ['home', 'sites', 'people', 'hr', 'checklists', 'incidents', 'stock', 'sales', 'customers', 'work', 'finance', 'knowledge', 'reports', 'admin', 'assistant']) {
  app.use(require(`./routes/${r}`));
}

app.use((req, res) => { res.status(404); res.page('error', 'Not found', { status: 404, message: 'That page does not exist.' }); });
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status);
  const message = status >= 500 && config.isProd ? 'Something went wrong. It has been logged.' : err.message;
  if (req.xhr || req.path.startsWith('/api')) return res.json({ error: message });
  if (!res.page) return res.send(message);
  res.page('error', 'Error', { status, message });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Swaggers OMS running on ${config.baseUrl}`);
    require('./services/scheduler').start();
  });
}

module.exports = app;
