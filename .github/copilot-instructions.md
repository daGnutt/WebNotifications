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
       │                 ├── push_subscriptions
       │                 └── reset_codes
       │
       ├── web-push ──► browser Service Worker (public/service-worker.js)
       └── static  ──► public/index.html (SPA, no framework)
```

**Data flow for incoming notifications:**
1. A POST to `/api/notifications` stores the notification in SQLite (with optional `userId`) and immediately fans out web-push messages to all matching `push_subscriptions`.
2. If the notification has no `title` **and** no `body`, it is silently dropped (returns `200 { success: true, ignored: true }`) without storing or broadcasting.
3. The server pushes an SSE `update` event to connected browser tabs via `GET /api/notifications/stream`; tabs also receive web-push notifications via the service worker when no tab is open.

**User management flow:**
- `POST /api/auth` is the single sign-in/register endpoint — it creates the user on first call, verifies password on subsequent calls.
- Passwords are hashed with Node's built-in `crypto.scrypt` + random salt, stored as `salt:hash` in `users.password_hash`.
- The frontend persists the session in `localStorage` and re-validates it against `GET /api/users/:userId` on page load.
- `password_hash` is never returned by any GET endpoint.
- Account reset: `POST /api/auth/reset-request` emails a 6-digit code (15 min TTL, stored in `reset_codes`). `POST /api/auth/reset-confirm` verifies the code, wipes all user data, and recreates the account with a new GUID and password.

**`requireUserId` middleware:**
- Applied to all data endpoints (notifications, subscribe, send-push, etc.).
- Reads `userId` from `req.query.userId` or `req.body.userId`, validates it against the DB, and attaches the full user row as `req.user`. Returns 401 if absent or unrecognised.
- Auth endpoints (`/api/auth`, `/api/auth/reset-*`) and `/api/vapid-public-key` are intentionally exempt.

**Push subscription ownership:**
- Subscriptions are stored with an optional `user_id`. When sending, if a `userId` is supplied the push goes only to that user's subscriptions; otherwise it broadcasts to all.
- The frontend passes `userId` inside the subscription payload to `POST /api/subscribe`.

**SSE real-time push:**
- `GET /api/notifications/stream` (protected by `requireUserId`) opens a persistent `text/event-stream` connection.
- The server holds open connections in a `sseClients` Map keyed by `user_id`. A 25s `:ping` comment is sent periodically to prevent proxy timeouts.
- `broadcastToUser(userId, payload)` is called after every mutation (new notification, delete, action update) and sends `event: update\ndata: {...}\n\n`.
- The frontend listens with `EventSource`, calls `fetchNotifications()` on each `update` event, and falls back to a 30-second poll on SSE error.

**Service worker behaviour:**
- Push notifications are only shown by the service worker when **no** browser tab is open. If a tab is open, the SSE stream handles real-time updates instead.
- **Service worker cache strategy** — `index.html`/`/` use network-first (always fresh on reload); truly static assets (`manifest.json`, `favicon.svg`, `qrcode.min.js`) use cache-first. API calls bypass the SW cache entirely. Cache name is currently `web-notifications-v5`; bump it in `service-worker.js` whenever any cached static asset changes.

**QR code configuration:**
- A "QR Code" button appears in the user bar once logged in.
- Clicking it opens a modal with a QR code encoding `{ "serverUrl": "http://...", "userId": "uuid" }` — intentionally no username or password.
- The QR code is rendered by `qrcodejs@1.0.0` served locally from `public/qrcode.min.js` (API: `new QRCode(domElement, { text, width, height, correctLevel })`).
- See `QR_CODE.md` for the full payload specification and client implementation guidance.

**Frontend animations:**
- `initialLoadDone` flag (set after first successful render, reset on logout): prevents the 2-second notification delay on page load/reload; new arrivals during a live session get the delay.
- Incoming notifications trigger a 4px fixed indicator bar at the top of the page (breathes green), then slide in with `slideInNotification` + `glowPulse` CSS.
- Dismissed notifications get the `dismissNotification` CSS (slide right + red glow); the API DELETE fires via `animationend`, not a timeout.
- Favicon is canvas-drawn (no external image) and updated on every poll: shows the unread count badge, rings the bell on new arrivals via `animateFaviconBell`.

## Key conventions

- **Callback-based DB helpers** — all SQLite access goes through named helper functions (`addNotification`, `createUser`, etc.) that use Node-style `(err, result)` callbacks. Do not use `db.*` directly in route handlers.
- **`addNotification(notification, userId, callback)`** — always pass `userId` (use `null` for anonymous). There is intentionally only one definition of this function.
- **Notification `data` column** — the full notification object (including any `actions`, `actionTaken`, `actionResponse`) is stored as JSON in the `data` column. When reading, parse `row.data`; fall back to individual columns only on parse failure.
- **VAPID keys are hardcoded** in `server.js`. Do not rotate them without also clearing all stored `push_subscriptions`, as existing browser subscriptions will become invalid.
- **DB migrations** are handled inline in `initializeDatabase()` using `ALTER TABLE … ADD COLUMN` wrapped in a no-op callback to silently ignore "duplicate column" errors on existing databases.
- **No framework on the frontend** — plain JS with `fetch`. Keep it that way; do not introduce bundlers or npm-managed frontend dependencies.
- **uuid must stay at `^9.0.0`** — uuid v10+ is ESM-only and breaks `require()` in this CommonJS server. Do not upgrade.
- **Dual-stack binding** — the server uses `http.createServer(app)` + `server.listen({ host: '::', ipv6Only: false })` to accept both IPv4 and IPv6 connections on a single socket. Do not switch back to `app.listen()`.

## After making changes

- **Update `API_DOCS.md`** whenever any API endpoint is added, removed, or its request/response contract changes.
- **Commit and push all changes** (code, documentation, and any other modified files) in a single commit before considering the task done.
