// Caches the app shell so the page opens without a network; models are cached by transformers.js (Cache API).
const CACHE = 'wr-shell-v2';
const SHELL = ['./', 'index.html', 'app.js', 'lib.js', 'pcm-worklet.js', 'translate-worker.js', 'manifest.webmanifest', 'sw.js', 'icon-180.png', 'icon-512.png'];
const NET_TIMEOUT_MS = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  // Network first (fresh code after an update); the cache answers when the network is slow (> 4 s) or down.
  // Only successful responses (r.ok) are cached.
  const net = fetch(req).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
    return r;
  });
  net.catch(() => {});
  e.respondWith((async () => {
    try {
      const r = await Promise.race([net, new Promise((res) => setTimeout(() => res(null), NET_TIMEOUT_MS))]);
      if (r) return r;
      return (await caches.match(req)) || net;
    } catch {
      return (await caches.match(req)) || Response.error();
    }
  })());
});
