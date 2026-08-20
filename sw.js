'use strict';

const CACHE_NAME = 'elistly-shell-v14';
const APP_SHELL = [
  './',
  './index.html',
  './app.html',
  './styles.css?v=18',
  './app.js?v=22',
  './device-intake.js?v=3',
  './lib/db.js?v=1',
  './faq.js',
  './sample-data.js',
  './setup-blank.js',
  './setup-library.js',
  './setup-it.js',
  './setup-staff.js',
  './setup-property.js',
  './version-history.js',
  './manifest.webmanifest',
  './favicon.ico',
  './img/elistly-logo.svg',
  './img/elistly-logo-black.svg',
  './img/elistly-logo-white.svg',
  './img/pwa-192.png',
  './img/pwa-512.png',
  './img/apple-touch-icon.png',
  './img/elistly-app.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('elistly-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) return;

  if (reqUrl.pathname.endsWith('/config.js') || reqUrl.pathname.endsWith('/config.example.js')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(event.request)) ||
            (await cache.match('./app.html')) ||
            (await cache.match('./index.html'));
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
