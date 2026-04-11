# Copilot Instructions

## Commands

```bash
npm start        # production
npm run dev      # nodemon watch mode (dev)
node --check server.js  # syntax check without running
```

No test or lint scripts are configured.

## Architecture

This is a single-file Express server (`server.js`) backed by SQLite (`notifications.db`) with a static single-page frontend (`public/index.html`).

```
Android device / curl
       │  POST /api/notifications
       ▼
  server.js  ──── SQLite (notifications.db)
       │                 ├── users
       │                 ├── notifications
       │                 └── push_subscriptions
       │
       ├── web-push ──► browser Service Worker (public/service-worker.js)
       └── static  ──► public/index.html (SPA, no framework)
```

**Data flow for incoming notifications:**
1. A POST to `/api/notifications` stores the notification in SQLite (with optional `userId`) and immediately fans out web-push messages to all matching `push_subscriptions`.
2. The frontend polls `/api/notifications` every 5 seconds; it also receives push notifications via the service worker when no page is open.

**User management flow:**
- `POST /api/auth` is the single sign-in/register endpoint — it creates the user on first call, verifies password on subsequent calls.
- Passwords are hashed with Node's built-in `crypto.scrypt` + random salt, stored as `salt:hash` in `users.password_hash`.
- The frontend persists the session in `localStorage` and re-validates it against `GET /api/users/:userId` on page load.
- `password_hash` is never returned by any GET endpoint.

**Push subscription ownership:**
- Subscriptions are stored with an optional `user_id`. When sending, if a `userId` is supplied the push goes only to that user's subscriptions; otherwise it broadcasts to all.
- The frontend passes `userId` inside the subscription payload to `POST /api/subscribe`.

**Service worker behaviour:**
- Push notifications are only shown by the service worker when **no** browser tab is open. If a tab is open, the page relies on its 5-second poll instead.

## Key conventions

- **Callback-based DB helpers** — all SQLite access goes through named helper functions (`addNotification`, `createUser`, etc.) that use Node-style `(err, result)` callbacks. Do not use `db.*` directly in route handlers.
- **`addNotification(notification, userId, callback)`** — always pass `userId` (use `null` for anonymous). There is intentionally only one definition of this function.
- **Notification `data` column** — the full notification object (including any `actions`, `actionTaken`, `actionResponse`) is stored as JSON in the `data` column. When reading, parse `row.data`; fall back to individual columns only on parse failure.
- **VAPID keys are hardcoded** in `server.js`. Do not rotate them without also clearing all stored `push_subscriptions`, as existing browser subscriptions will become invalid.
- **DB migrations** are handled inline in `initializeDatabase()` using `ALTER TABLE … ADD COLUMN` wrapped in a no-op callback to silently ignore "duplicate column" errors on existing databases.
- **No framework on the frontend** — plain JS with `fetch`. Keep it that way; do not introduce bundlers or npm-managed frontend dependencies.
