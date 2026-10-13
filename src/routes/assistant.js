const express = require('express');
const db = require('../db');
const ai = require('../services/ai');

const r = express.Router();

r.get('/assistant', (req, res) => {
  const history = req.session.chat || [];
  res.page('assistant', 'Ask Swaggers', { history, aiOn: ai.enabled(), q: req.query.q || '' });
});

r.post('/assistant', async (req, res, next) => {
  try {
    const question = String(req.body.question || '').trim().slice(0, 1000);
    if (!question) return res.redirect('/assistant');
    const history = req.session.chat || [];
    const { answer, source } = await ai.ask(question, history, req.user);
    history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    req.session.chat = history.slice(-12);
    const logId = db.insert('ai_logs', { user_id: req.user.id, question, answer });
    req.session.lastAiLog = logId;
    if (req.xhr || req.get('accept')?.includes('application/json')) return res.json({ answer, source, id: logId });
    res.redirect('/assistant#end');
  } catch (e) { next(e); }
});

r.post('/assistant/clear', (req, res) => { req.session.chat = []; res.redirect('/assistant'); });
r.post('/assistant/feedback', (req, res) => {
  if (req.session.lastAiLog) db.run('UPDATE ai_logs SET helpful = ? WHERE id = ? AND user_id = ?', req.body.helpful === '1' ? 1 : 0, req.session.lastAiLog, req.user.id);
  res.redirect('/assistant#end');
});

module.exports = r;
