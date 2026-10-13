// Swaggers OMS — progressive enhancements (pages still work without JS).
function toggleTheme() {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('swg-theme', root.dataset.theme); } catch (e) { /* storage unavailable */ }
}

// ── Back button: previous page when we came from inside the portal, otherwise the parent section ──
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => {
  let internal = false;
  try { internal = document.referrer && new URL(document.referrer).origin === location.origin && document.referrer !== location.href; } catch (e) { /* ignore */ }
  if (internal && history.length > 1) history.back(); else location.href = b.dataset.back || '/';
}));

document.addEventListener('click', (e) => {
  if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar') && !e.target.closest('.menu-btn')) document.body.classList.remove('nav-open');
});

// Confirm important submits: <form data-confirm="…">
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset.confirm;
  if (msg && !confirm(msg)) { e.preventDefault(); return; }
  const btn = e.submitter;
  if (btn && !e.defaultPrevented && !btn.name) setTimeout(() => { btn.disabled = true; }, 0);
});

// Auto-submit selects: <select data-autosubmit>
document.querySelectorAll('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));

// ── Geolocation for clock-in/out (the server re-checks the geofence; this is only to capture the fix) ──
function haversine(a, b, c, d) { const R = 6371000, r = (x) => x * Math.PI / 180; const x = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
document.querySelectorAll('form[data-geo]').forEach((form) => {
  const status = form.parentElement.querySelector('.geo-status') || form.querySelector('.geo-status');
  const say = (txt, cls) => { if (status) { status.textContent = txt; status.className = 'geo-status ' + (cls || ''); } };
  if (!navigator.geolocation) { say('Location not available on this device — ask your manager.', 'bad'); return; }
  say('📍 Getting your location…');
  let fix = null;
  const update = () => {
    const sel = form.querySelector('select[name=site_id]');
    const opt = sel ? sel.options[sel.selectedIndex] : form.querySelector('[data-lat]');
    if (!fix) return;
    const lat = Number(opt?.dataset.lat), lng = Number(opt?.dataset.lng), rad = Number(opt?.dataset.radius || 150);
    if (!opt || !opt.dataset.lat) { say(`📍 Location captured (±${Math.round(fix.accuracy)} m)`, 'good'); return; }
    const d = haversine(fix.latitude, fix.longitude, lat, lng);
    if (d <= rad) say(`✓ You're ${Math.round(d)} m from site — inside the ${rad} m zone (±${Math.round(fix.accuracy)} m)`, 'good');
    else say(`✕ You're ${d > 2000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'} from site — you must be within ${rad} m to clock in`, 'bad');
  };
  navigator.geolocation.watchPosition((pos) => {
    fix = pos.coords;
    form.querySelector('[name=lat]').value = fix.latitude.toFixed(6);
    form.querySelector('[name=lng]').value = fix.longitude.toFixed(6);
    const acc = form.querySelector('[name=accuracy]'); if (acc) acc.value = Math.round(fix.accuracy);
    update();
  }, (err) => say(err.code === 1 ? '✕ Location permission denied — allow location for this site in your browser settings.' : '✕ Could not get your location — move outside and try again.', 'bad'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 20000 });
  form.querySelector('select[name=site_id]')?.addEventListener('change', update);
});

// ── Live clock showing SERVER time (Africa/Accra) ──
document.querySelectorAll('[data-server-now]').forEach((el) => {
  const offset = Number(el.dataset.serverNow) - Date.now();
  const tick = () => { el.textContent = new Date(Date.now() + offset).toLocaleTimeString('en-GB', { timeZone: 'Africa/Accra', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  tick(); setInterval(tick, 1000);
});
// Elapsed shift timer: <span data-since="2026-10-13 07:02:00">
document.querySelectorAll('[data-since]').forEach((el) => {
  const start = new Date(el.dataset.since.replace(' ', 'T') + 'Z').getTime();
  const offset = Number(el.dataset.offset || 0);
  const tick = () => { const m = Math.max(0, Math.floor((Date.now() + offset - start) / 60000)); el.textContent = `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  tick(); setInterval(tick, 30000);
});

// ── Idle timeout (2 h) with cross-tab sync ──
(function idle() {
  const csrf = document.querySelector('meta[name=csrf-token]');
  if (!csrf) return;
  const IDLE = 2 * 60 * 60 * 1000;
  const KEY = 'swg-last-activity';
  const mark = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) { /* ignore */ } };
  let last = 0;
  ['click', 'keydown', 'touchstart', 'scroll'].forEach((ev) => addEventListener(ev, () => { if (Date.now() - last > 15000) { last = Date.now(); mark(); } }, { passive: true }));
  mark();
  const signOut = (reason) => {
    try { localStorage.setItem('swg-logout', String(Date.now())); } catch (e) { /* ignore */ }
    fetch('/logout', { method: 'POST', headers: { 'x-csrf-token': csrf.content, 'content-type': 'application/x-www-form-urlencoded' }, body: '' }).finally(() => { location.href = '/login' + (reason === 'timeout' ? '?timeout=1' : ''); });
  };
  setInterval(() => {
    let t = Date.now(); try { t = Number(localStorage.getItem(KEY)) || Date.now(); } catch (e) { /* ignore */ }
    if (Date.now() - t > IDLE) signOut('timeout');
  }, 30000);
  // Another tab signed out → follow it.
  addEventListener('storage', (e) => { if (e.key === 'swg-logout') location.href = '/login'; });
  document.getElementById('logout-form')?.addEventListener('submit', () => { try { localStorage.setItem('swg-logout', String(Date.now())); } catch (e) { /* ignore */ } });
  // Server-side session ended (e.g. global sign-out, password reset) → leave.
  setInterval(() => fetch('/session/ping', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => { if (!j.signedIn) location.href = '/login?timeout=1'; }).catch(() => {}), 60000);
})();

// ── Demo account quick-fill on the sign-in page ──
document.querySelectorAll('[data-demo-user]').forEach((b) => b.addEventListener('click', () => {
  const f = b.closest('.card').querySelector('form');
  f.querySelector('[name=email]').value = b.dataset.demoUser;
  f.querySelector('[name=password]').value = b.dataset.demoPass || '';
  f.requestSubmit ? f.requestSubmit() : f.submit();
}));

// ── Charts: <canvas data-chart='{…}'> ──
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
window.addEventListener('load', () => {
  if (!window.Chart) return;
  Chart.defaults.font.family = "'Plus Jakarta Sans', system-ui, sans-serif";
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--line');
  document.querySelectorAll('canvas[data-chart]').forEach((c) => {
    const cfg = JSON.parse(c.dataset.chart);
    cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: { duration: 900, easing: 'easeOutQuart' }, plugins: { legend: { display: cfg.type === 'doughnut', position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } } }, scales: cfg.type === 'doughnut' ? undefined : { x: { grid: { display: false } }, y: { grid: { color: cssVar('--line') }, border: { display: false } } } }, cfg.options || {});
    new Chart(c, cfg);
  });
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ── Mobile: collapse filter bars behind a "Filters" button (auto-open when a filter is active) ──
(function collapseFilters() {
  if (!matchMedia('(max-width: 900px)').matches) return;
  document.querySelectorAll('form.filterbar').forEach((form) => {
    const isDefault = (el) => el.dataset.default !== undefined ? el.value === el.dataset.default : el.tagName === 'SELECT' ? el.selectedIndex === 0 || ['all', 'open'].includes(el.value) : !el.value;
    const active = [...form.querySelectorAll('input:not([type=hidden]), select')].filter((el) => (el.type === 'checkbox' ? el.checked : !isDefault(el))).length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn sm filter-toggle';
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 5h18M6 12h12M10 19h4"/></svg>Filters${active ? ` <span class="badge brand">${active}</span>` : ''}`;
    form.before(btn);
    if (!active) form.hidden = true;
    btn.addEventListener('click', () => { form.hidden = !form.hidden; });
  });
})();
