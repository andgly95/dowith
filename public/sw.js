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
// A nudge, pushed from the server. The only thing that arrives with the app shut.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Do With', {
    body: [d.body, d.detail].filter(Boolean).join('\n'),
    // Per-list tag, so two lists don't replace each other's nudge but the same
    // list updating twice does.
    tag: d.tag || 'dowith',
    renotify: true,
    icon: '/icon.svg',
    data: { spaceId: d.spaceId || null },
  }));
});

// Tapping it should land you in the list it was about, not on the shelf.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.spaceId;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow ? self.clients.openWindow(id ? `/?list=${id}` : '/') : undefined;
  }));
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
