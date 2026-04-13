// Service Worker for Web Notifications
const CACHE_NAME = 'web-notifications-v5';

// Only truly static, versioned assets get cache-first treatment.
// index.html / '/' use network-first so page updates are always visible immediately.
const STATIC_ASSETS = [
  '/manifest.json',
  '/favicon.svg',
  '/qrcode.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  // Take control immediately — don't wait for all tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-first for the HTML page so updates are always picked up on reload.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for pre-cached static assets.
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Everything else (API calls, etc.) — always network.
  event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  const data = event.data.json();
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Check if any client window is open (regardless of focus)
      const hasOpenClient = clientList.length > 0;
      
      // Only show notification if no window is open at all
      if (!hasOpenClient) {
        return self.registration.showNotification(data.title, {
          body: data.body,
          icon: '/favicon.svg',
          data: {
            url: '/',
            notificationId: data.id
          }
        });
      }
      return Promise.resolve(); // Don't show any notification if any page is open
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      if (clientList.length > 0) {
        return clientList[0].focus();
      }
      return clients.openWindow('/');
    })
  );
});