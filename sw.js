// Service Worker for HARUMPHERS PWA
const CACHE_NAME = 'harumphers-v3';
const urlsToCache = [
  '/',
  '/index.html',
  '/directory.html',
  '/events.html',
  '/manifest.json',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});
