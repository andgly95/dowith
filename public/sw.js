// Network-first with a cache fallback: deploys are never stale, but the app still
// opens with no signal.
const CACHE = 'dowith-v1';
const SHELL = ['/', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the API — a stale list would show things that are already done.
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(request).then((res) => {
    if (res && res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(request, c)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(request).then(hit => hit || caches.match('/'))));
});
