// Smoke test: sign in as a role and GET a list of pages, reporting non-200s.
// Usage: node scripts/smoke.js <email> <path> [path...]
const app = require('../src/server');
const [email, ...paths] = process.argv.slice(2);
const srv = app.listen(0, async () => {
  const base = `http://localhost:${srv.address().port}`;
  try {
    let r = await fetch(base + '/login'); let cookie = r.headers.get('set-cookie').split(';')[0]; const html = await r.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)/)[1];
    r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, email, password: process.env.SEED_PASSWORD || 'demo123' }) });
    if (r.status !== 302) throw new Error('login failed ' + r.status);
    cookie = r.headers.get('set-cookie').split(';')[0];
    let bad = 0;
    for (const p of paths) {
      const x = await fetch(base + p, { headers: { cookie }, redirect: 'manual' }); const t = await x.text();
      const ok = x.status === 200 || x.status === 302;
      if (!ok) { bad++; const i = t.indexOf('<main'); console.log('FAIL', p, x.status, t.slice(i, i + 700).replace(/\s+/g, ' ')); } else console.log('ok  ', p, x.status, t.length);
    }
    console.log(bad ? `${bad} failures` : 'all ok');
  } catch (e) { console.error(e); }
  srv.close(); process.exit(0);
});
