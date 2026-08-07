/* Renzku Smart Stack — service worker
   Two jobs:
   1. Offline app shell: precache the core files on install and serve them
      from cache so the app still loads — and an in-progress match can keep
      running — with no internet connection. All match/queue state itself
      already lives in IndexedDB/localStorage (see the top of script.js), so
      once the shell is cached, going offline mid-session doesn't stop or
      reset anything local; only the optional live host-sync / viewer-link
      features (which need Supabase) stop working until you're back online.
   2. Let the viewer's "match notifications" show reliably via
      registration.showNotification() and bring the tab to front on tap.
      This does NOT add true push-from-server delivery — a viewer tab still
      has to be open and polling for that part to work. */

const CACHE_VERSION = 'v1';
const CACHE_NAME = 'renzku-shell-' + CACHE_VERSION;

// Same-origin files needed to render and run the app with no network at
// all. Cross-origin resources (Google Fonts, hCaptcha, Supabase) are
// deliberately left alone below — the app already degrades gracefully
// without them (captcha/live-sync are optional, not required to run a
// local session).
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './hcaptcha-stub.js',
  './qrcode.min.js',
  './notify.wav',
  './favicon.ico',
  './icon-192.png',
  './icon-512.png',
  './badge-96.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {}) // a single missing/blocked file shouldn't abort install
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle same-origin GETs — everything else (Supabase API calls,
  // fonts, hCaptcha, POSTs, etc.) passes straight through to the network
  // untouched, exactly as if this service worker weren't here.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HTML navigations: try the network first so a returning visitor always
  // gets the latest version when online, but fall back to the cached shell
  // the instant the network is unavailable — this is what keeps the app
  // loadable (and a match running) with no internet.
  if (req.mode === 'navigate'){
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else same-origin (CSS/JS/images/audio): serve from cache
  // immediately if we have it, and refresh the cache in the background
  // when online so the next offline visit stays up to date.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok){
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
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
