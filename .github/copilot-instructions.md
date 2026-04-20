# Copilot Instructions (WebNotifications)

These instructions describe **how this repo is intended to work** and the **constraints you must follow** when making changes.

## TL;DR (what to optimize for)

- Keep the project **simple**: a single-file Node/Express server + SQLite + static SPA.
- Prefer **small, surgical diffs** over refactors.
- Match existing style: **CommonJS**, **callback-based sqlite helpers**, **no frontend framework**.
- If you change any API contract, you **must update `API_DOCS.md`** in the same commit.

---

## Commands

```bash
npm start              # production
npm run dev            # dev (nodemon watch mode)
node --check server.js # syntax check without running
```

No test or lint scripts are configured. After changes, follow the **Smoke test checklist** below.

---

## Repository map (where things live)

- `server.js`
  - Express app + routes
  - SQLite initialization + inline migrations (`initializeDatabase()`)
  - Auth endpoints
  - SSE streaming endpoint
  - Web-push sending
- `notifications.db`
  - SQLite database file created/used by the server
- `public/index.html`
  - Static single-page frontend (no framework; plain JS + fetch)
- `public/service-worker.js`
  - Push notification handling
  - Cache strategy for static assets vs HTML shell
- `API_DOCS.md`
  - API contract reference (must stay in sync)
- `QR_CODE.md`
  - QR payload spec and client guidance

---

## Architecture overview

This is a single-file Express server (`server.js`) backed by SQLite (`notifications.db`) with a static single-page frontend (`public/index.html`).

**Upstream notification sender:** Notifications are typically sent to this backend by the Android app repository `@daGnutt/AndroidNotificationSender` (it posts into this backend’s API).

```
Android device / AndroidNotificationSender
       │  POST /api/notifications
       ▼
  server.js  ──── SQLite (notifications.db)
       │                 ├── users
       │                 ├── notifications
       │                 ├── push_subscriptions
       │                 └── reset_codes
       │
       ├── web-push ──► browser Service Worker (public/service-worker.js)
       └── static  ───► public/index.html (SPA, no framework)
```

---

## API quick map (high-level)

> NOTE: This is an index only. The source of truth is `API_DOCS.md`.

- Auth (unprotected):
  - `POST /api/auth`
  - `POST /api/auth/reset-request`
  - `POST /api/auth/reset-confirm`
- User (protected by `requireUserId`):
  - `GET /api/users/:userId`
- Notifications (protected by `requireUserId`):
  - `POST /api/notifications`
  - `GET /api/notifications`
  - `DELETE /api/notifications/:id` (and any other notification mutation endpoints)
- Realtime (protected by `requireUserId`):
  - `GET /api/notifications/stream` (SSE)
- Push (partially unprotected):
  - `GET /api/vapid-public-key` (unprotected)
  - `POST /api/subscribe` (protected by `requireUserId`)
  - Any push-test endpoints (if present) are protected

If you add/remove/rename endpoints or change request/response payloads, update `API_DOCS.md`.

---

## Data flows

### Incoming notifications

1. A sender (commonly `@daGnutt/AndroidNotificationSender`) issues `POST /api/notifications`.
2. The server stores the notification in SQLite (with optional `userId`) and immediately fans out web-push messages to all matching `push_subscriptions`.
3. If the notification has **no `title` AND no `body`**, it is silently dropped:
   - returns `200 { success: true, ignored: true }`
   - does **not** store or broadcast
4. The server pushes an SSE `update` event to connected browser tabs via `GET /api/notifications/stream`.
   - Tabs also receive web-push notifications via the service worker when no tab is open.

### User management

- `POST /api/auth` is the single sign-in/register endpoint:
  - creates the user on first call
  - verifies password on subsequent calls
- Passwords are hashed with Node's built-in `crypto.scrypt` + random salt.
  - Stored as `salt:hash` in `users.password_hash`.
- Frontend persists the session in `localStorage` and re-validates it against `GET /api/users/:userId` on page load.
- `password_hash` is never returned by any GET endpoint.

### Account reset (IMPORTANT)

- `POST /api/auth/reset-request` emails a 6-digit code
  - 15 minute TTL
  - stored in `reset_codes`
- `POST /api/auth/reset-confirm` verifies the code and performs a full account wipe:
  - wipes all user data (including subscriptions and notifications)
  - recreates the user entry with the new password

(Keep this behavior consistent unless explicitly asked to change it.)

---

## Auth / identity convention: `requireUserId` middleware (IMPORTANT)

- Applied to all data endpoints (notifications, subscribe, send-push, etc.).
- Reads `userId` from `req.query.userId` or `req.body.userId`.
- Validates the `userId` against the DB.
- Attaches the full user row to `req.user`.
- Returns 401 if missing or unrecognized.
- Auth endpoints (`/api/auth`, `/api/auth/reset-*`) and `/api/vapid-public-key` are intentionally exempt.

Security note:
- `userId` here is an **identifier**, not a cryptographically secure session token.
- Do not introduce new endpoints that treat `userId` as “proof of identity” beyond this repo’s established model unless the user explicitly requests an auth redesign.

---

## Push subscription ownership + broadcast rules

- Subscriptions are stored with an optional `user_id`.
- When sending:
  - If a `userId` is supplied, push goes only to that user's subscriptions.
  - Otherwise it broadcasts to all subscriptions.
- The frontend includes `userId` in the subscription payload to `POST /api/subscribe`.

---

## Realtime: SSE behavior

- `GET /api/notifications/stream` (protected by `requireUserId`) opens a persistent `text/event-stream` connection.
- The server tracks open connections in a `sseClients` Map keyed by `user_id`.
- A 25s `:ping` comment is sent periodically to prevent proxy timeouts.
- `broadcastToUser(userId, payload)` is called after every mutation (new notification, delete, action update) and sends:

  `event: update\ndata: {...}\n\n`

- The frontend listens with `EventSource`, calls `fetchNotifications()` on each `update` event, and falls back to a 30-second poll on SSE error.

---

## Service worker behavior (push + caching)

### Push display rule

- Push notifications are only shown by the service worker when **no** browser tab is open.
- If a tab is open, the SSE stream handles real-time updates instead.

### Cache strategy

- `/` and `index.html`: network-first (always fresh on reload)
- Truly static assets (e.g. `manifest.json`, `favicon.svg`, `qrcode.min.js`): cache-first

When changing caching rules, keep the “HTML shell stays fresh” behavior unless explicitly asked otherwise.

---

## QR code configuration

- A "QR Code" button appears in the user bar once logged in.
- Clicking opens a modal with a QR code encoding:

  `{ "serverUrl": "http://...", "userId": "uuid" }`

  Intentionally **no username or password**.

- QR code is rendered by `qrcodejs@1.0.0` served locally from `public/qrcode.min.js`:

  `new QRCode(domElement, { text, width, height, correctLevel })`

- See `QR_CODE.md` for the full payload specification and client implementation guidance.

---

## Frontend UX / animations (keep behavior)

- `initialLoadDone` flag:
  - set after first successful render
  - reset on logout
  - prevents the 2-second notification delay on page load/reload
  - new arrivals during a live session get the delay
- Incoming notifications:
  - show a 4px fixed indicator bar at top (breathes green)
  - slide in with `slideInNotification` + `glowPulse` CSS
- Dismissed notifications (user-initiated via close button):
  - element is removed from the DOM immediately (no animation)
  - API DELETE fires concurrently (not gated on animation)
- Backend-initiated removals (SSE `delete` event):
  - use `dismissNotification` CSS (fade + red glow) via `animateBackendRemoval`
  - element is removed after `animationend` with a height-collapse transition
- Favicon:
  - canvas-drawn (no external image)
  - updated on every poll
  - shows unread count badge and bell “ring” animation via `animateFaviconBell`

---

## Key conventions / constraints (DO / DON’T)

### SQLite access

- DO route all SQLite access through named helper functions (`addNotification`, `createUser`, etc.).
- DO keep the helpers **callback-based** using Node-style `(err, result)` callbacks.
- DON’T introduce ad-hoc `db.*` calls for general notification or user CRUD — use the named helpers.
- Small, self-contained operations that don’t warrant a reusable helper (e.g. reset-code insert/delete, inline `UPDATE users SET email`, inline `UPDATE users SET preferences`) may live directly in the route handler, but keep them minimal.

### `addNotification(notification, userId, callback)`

- Always pass `userId` (use `null` for anonymous).
- There is intentionally only **one** definition of this function.
- Don’t duplicate it; modify the existing helper if behavior changes.

### Notification storage model

- The `notifications.payload` column stores the full notification object as JSON:
  - including `actions`, `actionTaken`, `actionResponse`, etc.
- When reading, parse `row.payload` and treat it as the source of truth for notification payload.

### VAPID keys (web-push)

- VAPID keys live in `secrets.json` under the `vapid` key (`publicKey`, `privateKey`, `mailto`), not hardcoded in `server.js`.
- DON’T rotate keys without also clearing stored `push_subscriptions`, because existing browser subscriptions will become invalid.

### Migrations

- Migrations are handled inline in `initializeDatabase()` using:
  - `ALTER TABLE ... ADD COLUMN`
  - wrapped in a callback that ignores “duplicate column” errors
- Keep migrations backward-compatible and safe on existing DB files.

### Frontend dependencies

- No framework on the frontend — plain JS with `fetch`.
- Don’t introduce bundlers or npm-managed frontend dependencies.

### Node module system / uuid

- Server is CommonJS (`require()`).
- `uuid` must stay at `^9.0.0` (v10+ is ESM-only and breaks `require()`).
- Don’t upgrade `uuid` past v9 unless you also migrate the server to ESM (not desired by default).

### Networking

- Dual-stack binding is intentional:
  - `http.createServer(app)`
  - `server.listen({ host: '::', ipv6Only: false })`
- Don’t switch away from this unless explicitly requested.

---

## After making changes (required)

1. Update `API_DOCS.md` if any endpoint or payload changed.
2. Run:
   - `node --check server.js`
   - `npm run dev` and verify basic functionality
3. Commit and push **all** changes** (code + docs) in a single commit.

### Smoke test checklist (manual)
- Login/register via the SPA.
- Load notifications list.
- Send a notification (via UI or curl / Android sender) and verify:
  - stored in DB
  - appears in UI
  - SSE updates when tab is open
- Close the tab and verify:
  - push shows via the service worker
- Subscribe/unsubscribe behavior remains correct.
- If you changed reset/auth flows:
  - verify reset request and confirm behavior (including account wipe + recreation)