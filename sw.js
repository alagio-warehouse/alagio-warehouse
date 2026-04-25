// Service Worker — Alagio Warehouse PWA
// Стратегия: ТОЛЬКО сеть, без кэширования HTML
// Это предотвращает показ устаревших данных

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Удаляем все старые кэши
  e.waitUntil(
    caches.keys().then(keys => 
      Promise.all(keys.map(key => caches.delete(key)))
    ).then(() => clients.claim())
  );
});

// Всегда через сеть — никакого кэша
self.addEventListener('fetch', e => {
  // Пропускаем всё через сеть напрямую
  e.respondWith(fetch(e.request));
});
