// Service Worker — Alagio Warehouse PWA
const CACHE = 'alagio-v1';

// При установке — кэшируем основные файлы
self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Стратегия: сначала сеть, потом кэш
self.addEventListener('fetch', e => {
  // API запросы — всегда через сеть
  if (e.request.url.includes('/api/')) return;
  
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Кэшируем успешные ответы
        const clone = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
