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

## Configuration

Copy `secrets.example.json` to `secrets.json` and fill in your SMTP details to enable email-based account reset:

```json
{
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

`secrets.json` is gitignored. If it is absent, reset codes are printed to the server console as a fallback.

## Web Interface

Sign in (or register) with a username and password. Once signed in you can:

- View and dismiss your notifications
- Click your user ID to copy it to the clipboard
- Set or update your email address (used for account reset)
- Reset your account via a 6-digit email code (deletes all data and recreates the account)
- Generate a **QR code** to configure a smartphone — click the "QR Code" button in the user bar (see [QR_CODE.md](QR_CODE.md))

New notifications are delivered in real-time via **Server-Sent Events** (SSE) while a tab is open. Browser push notifications are delivered via the service worker when no tab is open. Incoming notifications slide in with an animation; dismissed notifications fade out with a red flash. The favicon badge shows the unread count.

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
| `POST` | `/api/notifications` | Receive a notification (fans out push + SSE to subscribers). Requires `userId`. Silently ignored if both `title` and `body` are blank. |
| `GET` | `/api/notifications?userId=<id>` | List notifications for the given user. |
| `GET` | `/api/notifications/stream?userId=<id>` | SSE stream — pushes `update` events to open browser tabs in real time. |
| `DELETE` | `/api/notifications/:id` | Dismiss a notification (only the owning user may delete). |
| `POST` | `/api/notifications/:id/actions` | Record an action (e.g. quick reply) on a notification. |
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
  "userId": "optional — targets a specific user's push subscriptions",
  "timestamp": "optional — auto-generated if omitted",
  "actions": [
    { "type": "reply", "title": "Reply" },
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
| `GET` | `/api/users/:userId/notifications` | List notifications for a user. |
| `PATCH` | `/api/users/:userId/email` | Set or update the user's email address. |

### Push Subscriptions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/subscribe` | Store a browser push subscription (optionally linked to a `userId`). |
| `GET` | `/api/vapid-public-key` | Returns the VAPID public key for push subscription setup. |

## Android Integration

### Direct HTTP

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

### Firebase Cloud Messaging

```javascript
exports.forwardNotification = functions.messaging.onMessageReceived((message) => {
  return axios.post('http://your-server-address/api/notifications', {
    title: message.notification.title,
    body: message.notification.body,
    userId: message.data.userId,
    actions: message.data.actions ? JSON.parse(message.data.actions) : []
  });
});
```

## Data Retention

Users inactive for **30 days** are automatically pruned at server startup and every 24 hours thereafter. Pruning cascades to their notifications, push subscriptions, and reset codes.

## Security Notes

- Passwords are hashed with `scrypt` (Node built-in `crypto`) — no plaintext storage.
- `password_hash` is never returned by any API endpoint.
- VAPID keys are hardcoded in `server.js`. Rotating them requires clearing all stored push subscriptions.
- For production, run behind HTTPS and consider adding rate limiting.
