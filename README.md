# Web Notifications

A self-hosted service that receives push notifications from Android devices and displays them in a web interface. Supports multiple users, real-time SSE updates, browser push notifications, QR-code device setup, and account management.

## Running

```bash
npm install
npm start        # production
npm run dev      # watch mode (nodemon)
```

Access the web interface at `http://localhost:3000`.  
Set the `PORT` environment variable to change the port.

The server listens on all IPv4 **and** IPv6 interfaces (`::`, dual-stack).

## Running with Docker

```bash
# 1. Create secrets.json from the example and fill it in
cp secrets.example.json secrets.json

# 2. Build and start
docker compose up -d

# 3. View logs
docker compose logs -f
```

The container exposes port **3000**. The SQLite database is stored in a named Docker volume (`db-data`) and persists across restarts. `secrets.json` is bind-mounted read-only from the project directory — it is never baked into the image.

Useful commands:

```bash
docker compose stop
docker compose restart
docker compose down          # stops; data volume is preserved
docker compose down -v       # stops AND deletes the database volume
```

To change the host port, edit `docker-compose.yml`:
```yaml
ports:
  - "8080:3000"   # serve on host port 8080
```

## Installing as a systemd service

Run the installer to set up a persistent **systemd user service** that starts automatically on boot and restarts on failure:

```bash
./install.sh
```

The script will:
- Install npm dependencies
- Copy `secrets.example.json` → `secrets.json` if missing
- Write `~/.config/systemd/user/web-notifications.service`
- Enable and start the service
- Enable linger so the service survives logout

Useful commands after installation:

```bash
systemctl --user status  web-notifications
systemctl --user restart web-notifications
systemctl --user stop    web-notifications
journalctl --user -u     web-notifications -f
```

## Configuration

Copy `secrets.example.json` to `secrets.json`. VAPID keys are required for browser push notifications; SMTP is required for email-based account reset.

```json
{
  "vapid": {
    "publicKey": "<your VAPID public key>",
    "privateKey": "<your VAPID private key>",
    "mailto": "mailto:you@example.com"
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "auth": {
      "user": "your@example.com",
      "pass": "yourpassword"
    },
    "from": "Web Notifications <your@example.com>"
  }
}
```

Generate VAPID keys with:
```bash
npx web-push generate-vapid-keys
```

`secrets.json` is gitignored. If VAPID keys are absent, web push is unavailable. If SMTP is absent, reset codes are printed to the server console as a fallback.

## Web Interface

Sign in (or register) with a username and password. Once signed in you can:

- View and dismiss your notifications
- Click your user ID to copy it to the clipboard
- Set or update your email address (used for account reset)
- Reset your account via a 6-digit email code (deletes all data and recreates the account)
- Generate a **QR code** to configure a smartphone — click the "QR Code" button in the user bar (see [QR_CODE.md](QR_CODE.md))

Append **`?demo`** to the URL (e.g. `http://localhost:3000/?demo`) to enable **Demo mode** — notification titles, bodies, and sender names are blurred so the interface can be shown publicly without revealing content.

New notifications are delivered in real-time via **Server-Sent Events** (SSE) while a tab is open. Browser push notifications are delivered via the service worker when no tab is open. Incoming notifications slide in with an animation; dismissed notifications fade out with a red flash. The favicon badge shows the unread count.

Silent notifications (those with `isSilent: true`) are displayed in a separate **🔇 Silent** section below regular notifications.

## API

> **All data endpoints require a valid `userId`** (obtained from `POST /api/auth`). Requests without a recognised `userId` return `401 Unauthorized`. The only unauthenticated endpoints are `/api/auth`, `/api/auth/reset-*`, and `/api/vapid-public-key`.

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth` | Sign in or register. Returns `{ user }`. |
| `POST` | `/api/auth/reset-request` | Send a 6-digit reset code to the user's email (valid 15 min). |
| `POST` | `/api/auth/reset-confirm` | Verify code and recreate the account with a new password. |

**`POST /api/auth`**
```json
{ "username": "alice", "password": "secret" }
```

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/notifications` | Receive a notification, store it in memory, and fan out push + SSE to subscribers. Requires `userId`. Silently ignored if both `title` and `body` are blank. |
| `GET` | `/api/notifications?userId=<id>` | List notifications for the given user. |
| `GET` | `/api/notifications/stream?userId=<id>` | SSE stream — pushes `update` events to open browser tabs in real time. |
| `DELETE` | `/api/notifications/:id` | Dismiss a notification (only the owning user may delete). |
| `POST` | `/api/notifications/:id/actions` | Record an action/reply on a notification (web UI → Android). |
| `POST` | `/api/notifications/:id/actions/dispatched` | Acknowledge the Android app has sent the action. Prevents re-processing on subsequent polls. |
| `POST` | `/api/send-push` | Trigger a web-push to all subscriptions for the given user without storing a notification. |

**Send a notification to a specific user:**
```bash
# 1. Look up the user's ID
curl http://localhost:3000/api/users/by-username/alice

# 2. Send the notification
curl -X POST http://localhost:3000/api/notifications \
  -H "Content-Type: application/json" \
  -d '{"userId": "<guid>", "title": "Hello", "body": "Message text"}'
```

Optional fields on `POST /api/notifications`:

```json
{
  "userId":        "optional — targets a specific user's push subscriptions",
  "timestamp":     "optional — ISO 8601, auto-generated if omitted",
  "icon":          "optional — URL, data URI, or raw base64 image",
  "appName":       "optional — source app display name",
  "sourcePackage": "optional — Android package name (e.g. com.example.app)",
  "isSilent":      "optional — true if the notification has no sound/vibration",
  "actions": [
    { "type": "reply",   "title": "Reply" },
    { "type": "action1", "title": "Approve" }
  ]
}
```

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/users` | List all users (`guid`, `username`, `email`, `created_at`, `last_active`). |
| `GET` | `/api/users/:userId` | Get a single user (also updates `last_active`). |
| `GET` | `/api/users/by-username/:username` | Look up a user by username. |
| `GET` | `/api/users/:userId/notifications` | List notifications for a user (no auth required — for Android polling). |
| `PATCH` | `/api/users/:userId/email` | Set or update the user's email address. |
| `PATCH` | `/api/users/:userId/preferences` | Update display preferences (e.g. `show_app_name`). |

### Push Subscriptions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/subscribe` | Store a browser push subscription (optionally linked to a `userId`). |
| `GET` | `/api/vapid-public-key` | Returns the VAPID public key for push subscription setup. |

## Android Integration

### Sending notifications

Use the `userId` and `serverUrl` from the QR code scan (see [QR_CODE.md](QR_CODE.md)):

```java
OkHttpClient client = new OkHttpClient();
String json = "{\"title\":\"Test\",\"body\":\"Hello from Android\",\"userId\":\"<guid>\"}";
RequestBody body = RequestBody.create(json, MediaType.get("application/json"));
Request request = new Request.Builder()
    .url("http://your-server-address/api/notifications")
    .post(body)
    .build();
client.newCall(request).enqueue(callback);
```

### Handling action replies from the web UI

When the user replies to or acts on a notification in the web interface, the action is saved back to the notification. The Android app should poll for pending actions and dispatch them (e.g. send a SMS reply, perform a system action).

#### Poll for pending actions

```
GET {serverUrl}/api/users/{userId}/notifications
```

Filter the response for notifications where `actionTaken` is set and `actionDispatched` is not `true`:

```kotlin
val pending = notifications.filter { n ->
    n.actionTaken != null && n.actionDispatched != true
}
```

Each pending notification contains:

| Field | Description |
|-------|-------------|
| `id` | Notification ID |
| `actionTaken` | The action key chosen by the user (e.g. `"reply"`) |
| `actionResponse` | The typed reply text, if any |
| `sourcePackage` | Android package name to route the action back (if supplied when sending) |

#### Acknowledge dispatch

After successfully dispatching an action, mark it as done so it isn't re-processed on the next poll:

```
POST {serverUrl}/api/notifications/{id}/actions/dispatched
Content-Type: application/json

{ "userId": "<guid>" }
```

Returns `{ "success": true }`. The notification's `actionDispatched` field is set to `true`. If the user takes a new action in the web UI later, `actionDispatched` is cleared automatically.

## Data Retention

Users inactive for **30 days** are automatically pruned at server startup and every 24 hours thereafter. Pruning cascades to their notifications, push subscriptions, and reset codes.

## Security Notes

- Passwords are hashed with `scrypt` (Node built-in `crypto`) — no plaintext storage.
- `password_hash` is never returned by any API endpoint.
- VAPID keys are stored in `secrets.json` (gitignored). Rotating them requires clearing all stored push subscriptions.
- For production, run behind HTTPS and consider adding rate limiting.
