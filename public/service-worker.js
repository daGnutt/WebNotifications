// Service Worker for Web Notifications
const CACHE_NAME = 'web-notifications-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(ASSETS_TO_CACHE);
      })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        return response || fetch(event.request);
      })
  );
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
          icon: '/icon.png',
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