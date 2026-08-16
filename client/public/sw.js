const CACHE = 'pulseroom-shell-v1';
const SHELL_URLS = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Offline cache strategy:
//  - navigations: network-first, fall back to the cached app shell when offline
//  - same-origin static assets (hashed Vite bundles) + Google Fonts:
//    stale-while-revalidate (serve cached instantly, refresh in background)
//  - /api, /socket.io, /uploads are NEVER cached (private media + live data)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Never cache live data / private media.
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/uploads/')
    ) {
      return;
    }
    // Never cache Vite dev modules (would break HMR) or the worker itself.
    if (
      url.pathname === '/sw.js' ||
      url.pathname.startsWith('/src/') ||
      url.pathname.startsWith('/@') ||
      url.pathname.startsWith('/node_modules/')
    ) {
      return;
    }
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match('/index.html').then((hit) => hit || caches.match('/'))
        )
    );
    return;
  }

  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !isFont) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'PulseRoom', body: event.data ? event.data.text() : 'New message' };
  }

  const title = payload.title || 'PulseRoom';
  const options = {
    body: payload.body || 'You have a new message.',
    tag: (payload.data && payload.data.roomId) ? `pulseroom-${payload.data.roomId}` : 'pulseroom',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: '/', roomId: (payload.data && payload.data.roomId) || null }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const roomId = (event.notification.data && event.notification.data.roomId) || null;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Prefer an already-open window: focus it and deep-link to the room.
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus();
          if (roomId) {
            client.postMessage({ type: 'OPEN_ROOM', roomId });
          }
          return;
        }
      }
      const url = roomId ? `/?room=${roomId}` : '/';
      return clients.openWindow(url);
    })
  );
});
