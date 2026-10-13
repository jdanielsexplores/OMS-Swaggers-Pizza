// Shared pagination + filter helpers for every list page.
const db = require('../db');

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * paginate(req, sql, params, { perPage, param })
 * `sql` must already contain WHERE / ORDER BY (no LIMIT). Several lists on one page use different `param`s
 * (e.g. 'page' and 'hpage') so each keeps its own position.
 */
function paginate(req, sql, params = [], opts = {}) {
  const param = opts.param || 'page';
  const perParam = param === 'page' ? 'per' : `${param}_per`;
  const perPage = clamp(Number(req.query[perParam]) || opts.perPage || 20, 5, 100);
  const total = Number(db.val(`SELECT COUNT(*) FROM (${sql})`, ...params) || 0);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = clamp(Number(req.query[param]) || 1, 1, pages);
  const rows = db.all(`${sql} LIMIT ? OFFSET ?`, ...params, perPage, (page - 1) * perPage);
  return { rows, page, pages, total, perPage, param, perParam, from: total ? (page - 1) * perPage + 1 : 0, to: Math.min(total, page * perPage) };
}

/**
 * Build a WHERE clause from query-string filters.
 * defs: { key: (value) => ['sql fragment with ?', ...params] | null }
 * Returns { where: 'a AND b', params: [...], f: { key: value } }.
 */
function filters(query, defs, base = []) {
  const where = [...base]; const params = []; const f = {};
  for (const [key, fn] of Object.entries(defs)) {
    const v = query[key];
    f[key] = v == null ? '' : String(v);
    if (v == null || v === '') continue;
    const out = fn(String(v));
    if (!out) continue;
    const [frag, ...p] = out;
    where.push(frag); params.push(...p);
  }
  return { where: where.length ? where.join(' AND ') : '1=1', params, f };
}

// Common filter shapes.
const F = {
  eq: (col) => (v) => [`${col} = ?`, v],
  dateFrom: (col) => (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? [`date(${col}) >= ?`, v] : null),
  dateTo: (col) => (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? [`date(${col}) <= ?`, v] : null),
  search: (...cols) => (v) => [`(${cols.map((c) => `COALESCE(${c},'') LIKE ?`).join(' OR ')})`, ...cols.map(() => `%${v}%`)],
};

// Build a URL to another page of the same list, keeping every other filter.
function pageUrl(path, query, param, n, extra = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...query, ...extra })) if (v !== '' && v != null && k !== param) q.set(k, v);
  if (n > 1) q.set(param, n);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

module.exports = { paginate, filters, F, pageUrl };
