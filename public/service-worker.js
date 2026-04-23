// Service Worker for Web Notifications
const CACHE_NAME = 'web-notifications-v5';

// Apps hidden by the user — updated via postMessage from the page
let hiddenApps = new Set();

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

self.addEventListener('message', (event) => {
  if (event.data?.type === 'set-hidden-apps') {
    hiddenApps = new Set(Array.isArray(event.data.hiddenApps) ? event.data.hiddenApps : []);
  }
});

self.addEventListener('push', (event) => {
  const data = event.data.json();

  // Server-restart reload signal — tell all open tabs to reload for fresh code.
  if (data.type === 'reload') {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        clientList.forEach(client => client.postMessage({ type: 'reload' }));
      })
    );
    return;
  }

  // Suppress push notifications for apps the user has hidden
  if (data.appName && hiddenApps.has(data.appName)) {
    return;
  }

  event.waitUntil(
    (async () => {
      // If the notification has a userId, verify it still exists on the server before
      // showing it. This prevents stale queued pushes (e.g. turn-by-turn navigation
      // notifications already dismissed on the phone) from popping up when the browser
      // opens. On network failure we fall through and show anyway (fail-open).
      if (data.userId && data.id) {
        try {
          const checkRes = await fetch(
            `/api/notifications/${encodeURIComponent(data.id)}/check?userId=${encodeURIComponent(data.userId)}`
          );
          if (!checkRes.ok) return; // 404 = already dismissed — skip
        } catch (_) {
          // Offline or server error — show the notification so real ones aren't lost
        }
      }

      const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Show notification unless a window is actively focused
      const hasFocusedClient = clientList.some(c => c.focused);

      if (!hasFocusedClient) {
        return self.registration.showNotification(data.title, {
          body: data.body,
          icon: '/favicon.svg',
          data: {
            url: '/',
            notificationId: data.id
          }
        });
      }
      // Don't show any notification if any page is open
    })()
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