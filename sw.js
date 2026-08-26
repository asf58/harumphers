const CACHE_NAME = 'harumphers-v32';
const APP_SHELL = [
  './',
  './index.html',
  './directory.html',
  './events.html',
  './manifest.json',
  './assets/harumphers-client.js',
  './apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        return caches.match(new URL('./index.html', self.registration.scope));
      }
      throw new Error('The requested resource is unavailable offline.');
    }
  })());
});
