// Minimal service worker: cache static assets; always go to network for pages (data must be live).
const CACHE = 'swg-static-v2';
const ASSETS = ['/img/logo.png', '/img/machine.png', '/manifest.webmanifest'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (ASSETS.includes(url.pathname) || url.pathname.startsWith('/vendor/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => new Response('<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:system-ui;padding:24px"><h2>You are offline</h2><p>The staff portal needs a connection. Use the paper checklists (Playbook Appendix A/B), photograph them and enter them when you are back online. If there is a safety issue, call your Manager now.</p>', { headers: { 'Content-Type': 'text/html' } })));
  }
});
