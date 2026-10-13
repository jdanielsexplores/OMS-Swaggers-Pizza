// "Ask Swaggers" — AI assistant grounded on approved Swaggers documents.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise falls back to keyword search over the SOPs.
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const config = require('../config');
const metrics = require('./metrics');
const { today, money, num } = require('../lib/util');

const client = config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null;
const enabled = () => !!client && db.setting('ai_enabled', '1') === '1';

function knowledgeBase() {
  const sops = db.all("SELECT code, title, purpose, body, version FROM sops WHERE status = 'approved' ORDER BY code");
  const products = db.all('SELECT name, price, allergens, description FROM products WHERE active = 1 AND approved = 1');
  return [
    '# Swaggers Pizza approved operating documents',
    ...sops.map((s) => `\n## ${s.code} — ${s.title} (v${s.version})\nPurpose: ${s.purpose}\n${s.body}`),
    '\n## Approved menu',
    ...products.map((p) => `- ${p.name}: ${money(p.price)}. Allergens: ${p.allergens || 'not yet confirmed — do not guess'}. ${p.description || ''}`),
  ].join('\n');
}

const SYSTEM = `You are "Ask Swaggers", the staff assistant for Swaggers Pizza, an automated pizza vending business in Ghana.
Answer staff questions using ONLY the approved Swaggers documents provided below. Write in simple, friendly English suitable for frontline staff reading on a phone.
- Cite the SOP code(s) you relied on, e.g. "(SOP-03)".
- Give numbered steps when the answer is a procedure.
- If the documents do not cover the question, or the question needs a value the documents say must be confirmed (temperatures, cooking settings, shelf life, refund decisions), say so plainly and tell them to contact their Supervisor or Operations Manager. Never invent values.
- For anything involving smoke, fire, electric shock, injury or food poisoning, start with "Make it safe first" and the emergency steps.
- Never ask for or repeat PINs, OTPs, passwords or card numbers.`;

async function call(system, messages, effort = 'low') {
  const response = await client.beta.messages.create({
    model: config.aiModel,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort },
    system,
    messages,
  });
  if (response.stop_reason === 'refusal') return null;
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function ask(question, history = [], user) {
  if (!enabled()) return { answer: fallbackAnswer(question), source: 'search' };
  try {
    const system = [
      { type: 'text', text: SYSTEM },
      { type: 'text', text: knowledgeBase(), cache_control: { type: 'ephemeral' } },
    ];
    const messages = [...history.slice(-6), { role: 'user', content: `${user ? `(Asked by ${user.name}, role: ${user.role})\n` : ''}${question}` }];
    const answer = await call(system, messages);
    return { answer: answer || 'I can\'t help with that one. Please ask your Supervisor or Operations Manager.', source: 'ai' };
  } catch (e) {
    console.error('[ai]', e.status || '', e.message);
    return { answer: fallbackAnswer(question), source: 'search', error: true };
  }
}

// Keyword search over SOPs, used when AI is off or unavailable.
function fallbackAnswer(question) {
  const words = String(question).toLowerCase().match(/[a-z]{3,}/g) || [];
  const stop = new Set(['the', 'and', 'what', 'how', 'should', 'when', 'where', 'can', 'for', 'with', 'this', 'that', 'does', 'have', 'you', 'are', 'who']);
  const SYN = { paid: ['payment', 'deducted'], pay: ['payment'], charged: ['payment', 'duplicate'], money: ['payment', 'deducted'], momo: ['mobile', 'payment'], cold: ['quality', 'temperature'], hot: ['temperature'], broken: ['fault'], error: ['fault'], smoke: ['critical', 'emergency'], fire: ['emergency'], refill: ['refill', 'load'], late: ['attendance'], expired: ['expiry', 'waste'] };
  const terms = words.filter((w) => !stop.has(w)).flatMap((w) => [w, ...(SYN[w] || [])]);
  const scored = db.all("SELECT code, title, purpose, body FROM sops WHERE status = 'approved'").map((s) => {
    const hay = `${s.title} ${s.title} ${s.purpose} ${s.body}`.toLowerCase();
    return { ...s, score: terms.reduce((a, t) => a + (hay.split(t).length - 1), 0) };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  if (!scored.length) return 'I couldn\'t find that in the handbook. Please ask your Supervisor or Operations Manager.';
  return `These procedures look relevant:\n\n${scored.map((s) => `• ${s.code} — ${s.title}: ${s.purpose}`).join('\n')}\n\nOpen them in the Handbook for the full steps.`;
}

// Short management summary of today's operations (used by the daily digest and owner dashboard).
async function dailySummary() {
  if (!enabled()) return null;
  const all = db.all('SELECT id FROM sites').map((r) => r.id);
  const d = today();
  const facts = {
    date: d,
    sales: metrics.sales(all, d, d),
    bySite: metrics.salesBySite(all, d, d),
    byFlavour: metrics.salesByProduct(all, d, d),
    incidents: metrics.incidentsSummary(all),
    openIncidents: db.all("SELECT ref, severity, type, title FROM incidents WHERE status NOT IN ('resolved','closed') ORDER BY created_at DESC LIMIT 15"),
    waste: metrics.waste(all, d, d),
    checklistCompliance: metrics.checklistCompliance(all, d, d).map((r) => ({ site: r.name, compliance: r.compliance })),
    uptime: metrics.uptime(all, 1).map((m) => ({ machine: m.code, uptime: Math.round(m.uptime), faults30d: m.faults_30d })),
    lowStock: metrics.lowStock(all).map((b) => `${b.product_name} @ ${b.location_name}: ${num(b.qty)}`),
    openPaymentExceptions: db.val("SELECT COUNT(*) FROM payment_exceptions WHERE status IN ('open','investigating')"),
  };
  try {
    return await call(
      'You write a concise end-of-day operations brief for the owner of Swaggers Pizza (Ghana, currency GHS). Max 120 words, plain text. Lead with the headline numbers, then the 2-3 things that need management attention and who should act. No preamble.',
      [{ role: 'user', content: JSON.stringify(facts) }],
      'medium',
    );
  } catch (e) { console.error('[ai summary]', e.message); return null; }
}

module.exports = { ask, enabled, dailySummary, fallbackAnswer };
