const crypto = require('node:crypto');
const config = require('../config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Dates — stored as UTC 'YYYY-MM-DD HH:MM:SS' (SQLite datetime('now')).
const tz = config.timezone;
const partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function localParts(d = new Date()) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}
const today = () => localParts().date;
const nowTime = () => localParts().time;
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMinutes = (date, n) => new Date(date.getTime() + n * 60000).toISOString().slice(0, 19).replace('T', ' ');
const parseSql = (s) => (s ? new Date(s.replace(' ', 'T') + (s.length > 10 && !s.endsWith('Z') ? 'Z' : '')) : null);

function fmtDate(s, opts = {}) {
  if (!s) return '—';
  const d = s.length <= 10 ? new Date(s + 'T12:00:00Z') : parseSql(s);
  return d.toLocaleDateString('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: opts.year === false ? undefined : 'numeric' });
}
function fmtDateTime(s) {
  if (!s) return '—';
  const d = parseSql(s);
  return d.toLocaleString('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(s) { if (!s) return '—'; return parseSql(s).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }); }
function ago(s) {
  if (!s) return '—';
  const mins = Math.round((Date.now() - parseSql(s).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}
function duration(mins) {
  if (mins == null) return '—';
  mins = Math.round(mins);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

let currencyCache = { at: 0, v: null };
const currencyCode = () => {
  if (Date.now() - currencyCache.at > 10000) { try { currencyCache = { at: Date.now(), v: require('../db').setting('currency', config.currency) }; } catch { currencyCache = { at: Date.now(), v: config.currency }; } }
  return currencyCache.v || config.currency;
};
const money = (n, dp = 2) => { const c = currencyCode(); return `${c === 'GHS' ? 'GH₵' : c + ' '}${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`; };
const num = (n, dp = 0) => Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: dp });
const pct = (n, dp = 0) => (n == null || Number.isNaN(n) ? '—' : `${Number(n).toFixed(dp)}%`);

const makeRef = (prefix) => `${prefix}-${today().replace(/-/g, '').slice(2)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const token = (n = 24) => crypto.randomBytes(n).toString('hex');

// Lightweight markdown → HTML for SOP / training content (trusted, admin-authored).
function md(src = '') {
  const lines = String(src).replace(/\r/g, '').split('\n');
  const out = [];
  let list = null; let table = null;
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\b(SOP-\d{2})\b/g, '<a href="/handbook/$1">$1</a>');
  const flush = () => {
    if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; }
    if (table) {
      const [head, ...rows] = table;
      out.push(`<div class="table-wrap"><table class="table"><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      table = null;
    }
  };
  for (const line of lines) {
    const t = line.trim();
    let m;
    if (!t) { flush(); continue; }
    if (t.startsWith('|')) {
      if (list) flush();
      table = table || [];
      table.push(t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      continue;
    }
    if (table) flush();
    if ((m = t.match(/^(#{2,4})\s+(.*)/))) { flush(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); continue; }
    if ((m = t.match(/^\d+\.\s+(.*)/))) { if (!list || list.tag !== 'ol') { flush(); list = { tag: 'ol', items: [] }; } list.items.push(inline(m[1])); continue; }
    if ((m = t.match(/^[-*]\s+(.*)/))) { if (!list || list.tag !== 'ul') { flush(); list = { tag: 'ul', items: [] }; } list.items.push(inline(m[1])); continue; }
    if ((m = t.match(/^>\s*(.*)/))) {
      flush();
      const body = inline(m[1]).replace(/^([A-Z][A-Z \-]{2,}:)/, '<strong>$1</strong>');
      out.push(`<div class="callout">${body}</div>`); continue;
    }
    flush();
    out.push(`<p>${inline(t)}</p>`);
  }
  flush();
  return out.join('\n');
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k] === '' ? null : obj[k]]));
const toNum = (v) => (v === '' || v == null ? null : Number(v));
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const badge = (s, label) => (s == null ? '' : `<span class="badge ${esc(String(s))}">${esc(label || titleCase(s))}</span>`);
const selected = (a, b) => (String(a ?? '') === String(b ?? '') ? 'selected' : '');
const chart = (cfg, cls = '') => `<div class="chart-box ${cls}"><canvas data-chart="${esc(JSON.stringify(cfg))}"></canvas></div>`;
const CHART_JS = '<script src="/vendor/chart.umd.min.js"></script>';
const checked = (v) => (v && v !== '0' ? 'checked' : '');

module.exports = {
  badge, selected, checked, chart, CHART_JS,
  esc, today, nowTime, sqlNow, addDays, addMinutes, parseSql, fmtDate, fmtDateTime, fmtTime, ago, duration,
  money, num, pct, makeRef, token, md, pick, toNum, titleCase, localParts,
};
