// Minimal offline app-shell cache so the PWA opens even with no signal
// (Bluetooth itself obviously still needs the lamp nearby, not the network).
//
// Network-first: always try the network so updates show up immediately; only fall
// back to the cached copy when there's no connection. Bump CACHE whenever the asset
// list changes so old installs purge their stale cache on the next activate.
const CACHE = 'philco-smart-color-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/ble.js',
  './js/telink-crypto.js',
  './js/telink-profiles.js',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
