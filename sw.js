/* Renzku Smart Stack — minimal service worker
   Only job: let the viewer's "match notifications" show reliably via
   registration.showNotification() and bring the tab to front on tap.
   This does NOT add offline caching or true push-from-server delivery —
   see the note in script.js's notify() function for why. */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
