const db = require('../db');

function audit(req, action, entity = null, entityId = null, details = null) {
  db.insert('audit_log', {
    user_id: req?.user?.id ?? null,
    action,
    entity,
    entity_id: entityId,
    details: details == null ? null : typeof details === 'string' ? details : JSON.stringify(details),
    ip: req?.ip ?? null,
  });
}

module.exports = { audit };

function security(req, event, { userId, identifier, details } = {}) {
  db.insert('security_log', {
    user_id: userId ?? req?.user?.id ?? null,
    event,
    identifier: identifier ?? null,
    details: details == null ? null : typeof details === 'string' ? details : JSON.stringify(details),
    ip: req?.ip ?? null,
    user_agent: req?.get?.('user-agent')?.slice(0, 200) ?? null,
  });
}

module.exports.security = security;
