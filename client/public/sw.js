self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
    data: { url: '/', roomId: (payload.data && payload.data.roomId) || null }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
