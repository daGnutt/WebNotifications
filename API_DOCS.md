# Web Notifications API Documentation

Base URL: `http://<host>:3000`

---

## Authentication

Most data endpoints require a valid `userId` (a UUID obtained from the auth endpoints). It can be passed as:

- **Query parameter**: `?userId=<uuid>`
- **Request body field**: `"userId": "<uuid>"`

If `userId` is missing or invalid, the server returns `401`.

---

## Endpoints

### Auth

#### `POST /api/auth`

Register a new user or log in to an existing account. This is the single sign-in/register endpoint — it creates the user on first call and verifies the password on subsequent calls.

**Request body**

| Field      | Type   | Required | Description                          |
|------------|--------|----------|--------------------------------------|
| `username` | string | Yes      | Unique username (automatically trimmed and lowercased) |
| `password` | string | Yes      | Plain-text password                  |
| `email`    | string | No       | Email address (used for resets)      |

**Responses**

| Status | Description                        | Body                                                    |
|--------|------------------------------------|---------------------------------------------------------|
| `200`  | Login successful                   | `{ success, created: false, user: { userId, username, email } }` |
| `201`  | Account created                    | `{ success, created: true, user: { userId, username, email } }` |
| `400`  | Missing username or password       | `{ success: false, error }`                             |
| `401`  | Incorrect password                 | `{ success: false, error }`                             |
| `500`  | Server error                       | `{ success: false, error }`                             |

---

#### `POST /api/auth/reset-request`

Send a 6-digit reset code to the user's registered email address. The code is valid for 15 minutes. Always returns the same response regardless of whether the username exists, to prevent username enumeration.

**Request body**

| Field      | Type   | Required | Description   |
|------------|--------|----------|---------------|
| `username` | string | Yes      | Account username (automatically trimmed and lowercased) |

**Responses**

| Status | Description            | Body                              |
|--------|------------------------|-----------------------------------|
| `200`  | Request processed      | `{ success: true, message }`      |
| `400`  | Missing username       | `{ success: false, error }`       |
| `500`  | Server error           | `{ success: false, error }`       |

---

#### `POST /api/auth/reset-confirm`

Verify a reset code and replace the account password. **All existing notifications and push subscriptions for the account are deleted** and a new user ID is issued.

**Request body**

| Field         | Type   | Required | Description                 |
|---------------|--------|----------|-----------------------------|
| `code`        | string | Yes      | 6-digit code from the email |
| `newPassword` | string | Yes      | Replacement password        |

**Responses**

| Status | Description                  | Body                                          |
|--------|------------------------------|-----------------------------------------------|
| `200`  | Reset successful             | `{ success: true, user: { userId, username, email } }` |
| `400`  | Missing fields or bad code   | `{ success: false, error }`                   |
| `500`  | Server error                 | `{ success: false, error }`                   |

---

### Notifications

#### `GET /api/notifications`

Retrieve all notifications for the authenticated user, ordered newest first.

**Query parameters**

| Parameter | Type   | Required | Description   |
|-----------|--------|----------|---------------|
| `userId`  | string | Yes      | User UUID     |

**Responses**

| Status | Description              | Body                    |
|--------|--------------------------|-------------------------|
| `200`  | Success                  | Array of notification objects |
| `401`  | Missing or invalid userId | `{ success: false, error }` |
| `500`  | Server error             | `{ success: false, error }` |

**Notification object**

```json
{
  "id": "1712870400000",
  "title": "Example",
  "body": "Notification body text",
  "timestamp": "2024-04-11T20:00:00.000Z",
  "appName": "Messages",
  "sourcePackage": "com.example.app",
  "isSilent": false,
  "actionTaken": "reply",
  "actionResponse": "OK"
}
```

> `actionTaken` and `actionResponse` are only present if an action was recorded via `POST /api/notifications/:id/actions`.
> `isSilent` is only present if it was included in the original POST payload.

**Conversation thread (`data.messages`)**

If the notification body is a messaging thread rather than plain text, pass a `data.messages` array. The UI renders it as an iMessage-style conversation instead of a plain body string.

```json
{
  "userId": "<uuid>",
  "title": "Alice",
  "data": {
    "messages": [
      {
        "sender": "Alice",
        "text": "Hey, you around?",
        "timestamp": "2026-04-12T18:30:00.000Z",
        "senderIcon": "<raw base64, data URI, or URL — optional>"
      },
      {
        "sender": "Alice",
        "text": "Call me when you can",
        "timestamp": "2026-04-12T18:31:00.000Z"
      },
      {
        "text": "On my way!",
        "timestamp": "2026-04-12T18:32:00.000Z"
      }
    ]
  }
}
```

Message fields:

| Field        | Type   | Required | Description                                           |
|--------------|--------|----------|-------------------------------------------------------|
| `text`       | string | Yes      | Message content                                       |
| `sender`     | string | No       | Sender name. Omit for self/outgoing messages          |
| `timestamp`  | string | No       | ISO 8601 timestamp shown in the bubble                |
| `senderIcon` | string | No       | Avatar — raw base64, data URI, or URL. Falls back to initials if absent |

Consecutive messages from the same sender are visually grouped (avatar and name shown only once per run).

---

#### `POST /api/notifications`

Receive a new notification, store it in memory, and immediately fan out web-push messages to all push subscriptions belonging to the user. If `isSilent` is `true`, the notification is stored and delivered via SSE only — no web-push message is sent.

**Request body**

| Field           | Type    | Required | Description                                                                                      |
|-----------------|---------|----------|--------------------------------------------------------------------------------------------------|
| `userId`        | string  | Yes      | User UUID                                                                                        |
| `title`         | string  | No       | Notification title                                                                               |
| `body`          | string  | No       | Notification body text                                                                           |
| `timestamp`     | string  | No       | ISO 8601 timestamp (auto-set if omitted)                                                         |
| `sourcePackage` | string  | No       | Android package name of the source app                                                           |
| `appName`       | string  | No       | Human-readable name of the source app                                                            |
| `icon`          | string  | No       | Base64-encoded PNG app icon                                                                      |
| `isSilent`      | boolean | No       | `true` if the notification channel importance is below `IMPORTANCE_DEFAULT` (no sound/vibration). Silent notifications are stored and delivered via SSE only — web-push is suppressed. |
| `actions`       | array   | No       | List of `{ semanticAction, title }` action objects                                               |
| `messages`      | array   | No       | MessagingStyle messages: `{ sender?, text, timestamp, senderIcon? }`                             |
| `...`           | any     | No       | Any additional fields are stored in `data`                                                       |

**Responses**

| Status | Description          | Body                            |
|--------|----------------------|---------------------------------|
| `200`  | Success              | `{ success: true, id: "<id>" }` |
| `401`  | Missing/invalid userId | `{ success: false, error }`   |

---

#### `DELETE /api/notifications/:id`

Delete a notification. Only the owning user can delete their own notifications.

**Important:** A notification whose action has been recorded (`actionTaken` is set) but not yet dispatched to the Android device (`actionDispatched` is falsy) cannot be deleted. This prevents the Android app from accidentally removing a notification before the action has been confirmed as handled. The Android app should only call DELETE when the user explicitly dismisses a notification — **not** after firing/dispatching an action.

**Path parameters**

| Parameter | Description         |
|-----------|---------------------|
| `id`      | Notification ID     |

**Query parameters**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `userId`  | string | Yes      | User UUID   |

**Responses**

| Status | Description                                              | Body                            |
|--------|----------------------------------------------------------|---------------------------------|
| `200`  | Deleted successfully                                     | `{ success: true }`             |
| `401`  | Missing/invalid userId                                   | `{ success: false, error }`     |
| `404`  | Notification not found                                   | `{ success: false, error }`     |
| `409`  | Action taken but not yet dispatched — deletion refused   | `{ success: false, error }`     |

---

#### `POST /api/notifications/:id/actions`

Record the action taken on a notification (e.g. a reply or button tap). Updates the `actionTaken` and `actionResponse` fields on the stored notification. Only the owning user can record an action on their own notification.

**Path parameters**

| Parameter | Description     |
|-----------|-----------------|
| `id`      | Notification ID |

**Request body**

| Field      | Type   | Required | Description                        |
|------------|--------|----------|------------------------------------|
| `userId`   | string | Yes      | User UUID                          |
| `action`   | string | Yes      | Action identifier (e.g. `"reply"`) |
| `response` | string | No       | User-provided response text        |

**Responses**

| Status | Description               | Body                            |
|--------|---------------------------|---------------------------------|
| `200`  | Action recorded           | `{ success: true }`             |
| `401`  | Missing/invalid userId    | `{ success: false, error }`     |
| `404`  | Notification not found    | `{ success: false, error }`     |

---

#### `POST /api/notifications/:id/actions/dispatched`

Acknowledge that the Android app has successfully dispatched the recorded action. Sets `actionDispatched: true` on the notification so subsequent polls know the action has been handled. Only the owning user can acknowledge their own notification.

**Path parameters**

| Parameter | Description     |
|-----------|-----------------|
| `id`      | Notification ID |

**Request body**

| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| `userId` | string | Yes      | User UUID   |

**Responses**

| Status | Description                    | Body                            |
|--------|--------------------------------|---------------------------------|
| `200`  | Acknowledged                   | `{ success: true }`             |
| `400`  | No action recorded to ack      | `{ success: false, error }`     |
| `401`  | Missing/invalid userId         | `{ success: false, error }`     |
| `404`  | Notification not found         | `{ success: false, error }`     |

---

### Push Subscriptions

#### `GET /api/vapid-public-key`

Retrieve the VAPID public key needed to subscribe to web push in the browser.

**No authentication required.**

**Responses**

| Status | Body                          |
|--------|-------------------------------|
| `200`  | `{ publicKey: "<base64url>" }` |

---

#### `POST /api/subscribe`

Register a browser push subscription for the authenticated user. Uses `INSERT OR REPLACE`, so re-registering the same endpoint updates it.

**Request body**

The body must be a valid [PushSubscription](https://developer.mozilla.org/en-US/docs/Web/API/PushSubscription) object with an additional `userId` field:

| Field      | Type   | Required | Description                  |
|------------|--------|----------|------------------------------|
| `userId`   | string | Yes      | User UUID                    |
| `endpoint` | string | Yes      | Push service URL             |
| `keys`     | object | Yes      | `{ p256dh, auth }` key pair  |

**Responses**

| Status | Description             | Body                        |
|--------|-------------------------|-----------------------------|
| `200`  | Subscription stored     | `{ success: true }`         |
| `401`  | Missing/invalid userId  | `{ success: false, error }` |
| `500`  | Server error            | `{ success: false, error }` |

---

#### `GET /api/fcm/status`

Returns the FCM health for the authenticated user: whether the server has FCM configured, and how many Android devices have registered tokens.

**Query parameters**

| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| `userId` | string | Yes      | User UUID   |

**Responses**

| Status | Description             | Body                                                          |
|--------|-------------------------|---------------------------------------------------------------|
| `200`  | OK                      | `{ success: true, configured: bool, deviceCount: number }`   |
| `401`  | Missing/invalid userId  | `{ success: false, error }`                                   |
| `500`  | Server error            | `{ success: false, error }`                                   |

- `configured`: `true` if `secrets.fcm.serviceAccount` is set and the Firebase Admin SDK initialised successfully.
- `deviceCount`: number of FCM device tokens currently registered for the user.

---

#### `POST /api/fcm/resync`

Manually triggers a `resync` FCM data message to all Android devices registered for the authenticated user. This causes the Android app to re-POST any buffered notifications to the server. Useful when the server has restarted and lost its in-memory notification store, or when the user wants to force a sync.

**Query parameters / body**

| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| `userId` | string | Yes      | User UUID   |

**Responses**

| Status | Description                    | Body                                     |
|--------|--------------------------------|------------------------------------------|
| `200`  | Resync sent (or 0 devices)     | `{ success: true, sent: number }`        |
| `401`  | Missing/invalid userId         | `{ success: false, error }`              |
| `503`  | FCM not configured on server   | `{ success: false, error }`              |
| `500`  | Server error                   | `{ success: false, error }`              |

- `sent`: the number of devices that were successfully reached.

---

#### `POST /api/device-tokens`

Register an FCM device token for the authenticated user. Uses `INSERT OR REPLACE`, so re-registering the same token is safe. FCM data messages are sent to all registered tokens when the user dismisses a notification or records an action.

**Request body**

| Field    | Type   | Required | Description        |
|----------|--------|----------|--------------------|
| `userId` | string | Yes      | User UUID          |
| `token`  | string | Yes      | FCM registration token |

**Responses**

| Status | Description             | Body                        |
|--------|-------------------------|-----------------------------|
| `200`  | Token stored            | `{ success: true }`         |
| `400`  | Missing token           | `{ success: false, error }` |
| `401`  | Missing/invalid userId  | `{ success: false, error }` |
| `500`  | Server error            | `{ success: false, error }` |

**FCM data message payloads**

When a notification is **dismissed**:
```json
{ "type": "dismiss", "notificationId": "<id>" }
```

When an **action** is recorded:
```json
{ "type": "action", "notificationId": "<id>", "actionTaken": "<action>", "actionResponse": "<text>" }
```
(`actionResponse` is omitted if not provided.)

When the server requests a **resync** of buffered notifications:
```json
{ "type": "resync" }
```
The server sends this in two situations:
1. **Server startup** — sent to every registered FCM device token so Android devices re-POST any notifications the server lost when it restarted (the in-memory store is wiped on restart).
2. **New token registered** — sent immediately to the newly registered token so the device replays its buffered notifications without waiting for the next restart.

The Android app should respond to `type: "resync"` by re-POSTing all locally buffered recent notifications to `POST /api/notifications`.

> All values in FCM data messages are strings as required by the FCM protocol.

---

#### `POST /api/send-push`

Create and immediately push a notification. Identical to `POST /api/notifications` but intended for testing from the browser UI.

**Request body**

| Field    | Type   | Required | Description       |
|----------|--------|----------|-------------------|
| `userId` | string | Yes      | User UUID         |
| `title`  | string | Yes      | Notification title |
| `body`   | string | Yes      | Notification body  |

**Responses**

| Status | Description           | Body                            |
|--------|-----------------------|---------------------------------|
| `200`  | Success               | `{ success: true, id: "<id>" }` |
| `401`  | Missing/invalid userId | `{ success: false, error }`    |
| `500`  | Server error          | `{ success: false, error }`     |

---

### Users

#### `GET /api/users/:userId`

Get the authenticated user's own profile. Updates `last_active` on each call. **Password hash is excluded.**

**Query parameters**

| Parameter   | Type   | Required | Description                                                                 |
|-------------|--------|----------|-----------------------------------------------------------------------------|
| `userId`    | string | Yes      | User UUID                                                                   |
| `sessionId` | string | No       | Browser session UUID. If provided and not found in DB, returns `401 session_revoked`. |

**Responses**

| Status | Description                      | Body                                                    |
|--------|----------------------------------|---------------------------------------------------------|
| `200`  | Success                          | `{ user_id, username, email, created_at, last_active }` |
| `401`  | Missing/invalid userId or session revoked | `{ success: false, error }` (error is `"session_revoked"` when session was deleted) |
| `403`  | Forbidden (wrong user)           | `{ success: false, error }`                             |
| `500`  | Server error                     | `{ success: false, error }`                             |

---

#### `GET /api/users/:userId/notifications`

Get all notifications for the authenticated user. The path `:userId` must match the authenticated `userId`.

**Query parameters**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `userId`  | string | Yes      | User UUID   |

**Responses**

| Status | Description              | Body                          |
|--------|--------------------------|-------------------------------|
| `200`  | Success                  | Array of notification objects |
| `401`  | Missing/invalid userId   | `{ success: false, error }`   |
| `403`  | Forbidden (wrong user)   | `{ success: false, error }`   |
| `500`  | Server error             | `{ success: false, error }`   |

---

#### `DELETE /api/users/:userId`

Permanently delete the account and **all associated data** (notifications, push subscriptions, FCM device tokens, reset codes). The path `:userId` must match the authenticated `userId`. Any open SSE connections for the user are closed immediately.

**Query parameter:** `userId` (required, as with all protected endpoints).

**Responses**

| Status | Description              | Body                        |
|--------|--------------------------|-----------------------------|
| `200`  | Account deleted          | `{ success: true }`         |
| `401`  | Missing/invalid userId   | `{ success: false, error }` |
| `403`  | Forbidden (wrong user)   | `{ success: false, error }` |
| `500`  | Server error             | `{ success: false, error }` |

---

#### `PATCH /api/users/:userId/email`
Update the email address for the authenticated user. The path `:userId` must match the authenticated `userId`.

**Request body**

| Field    | Type   | Required | Description                              |
|----------|--------|----------|------------------------------------------|
| `userId` | string | Yes      | User UUID                                |
| `email`  | string | No       | New email address. Omit or set to `null` to clear. |

**Responses**

| Status | Description              | Body                        |
|--------|--------------------------|-----------------------------|
| `200`  | Updated                  | `{ success: true }`         |
| `401`  | Missing/invalid userId   | `{ success: false, error }` |
| `403`  | Forbidden (wrong user)   | `{ success: false, error }` |
| `404`  | User not found           | `{ success: false, error }` |
| `500`  | Server error             | `{ success: false, error }` |

---

#### `PATCH /api/users/:userId/preferences`
Update user preferences. The path `:userId` must match the authenticated `userId`. Only fields that are present in the request body are updated.

**Request body**

| Field         | Type            | Required | Description                                                   |
|---------------|-----------------|----------|---------------------------------------------------------------|
| `userId`      | string          | Yes      | User UUID                                                     |
| `show_app_name` | integer (0/1) | No       | Whether to show the app name on notification cards (`1` = show, `0` = hide). |
| `hidden_apps` | array or null   | No       | List of app name strings whose notifications are hidden in the frontend. Pass `null` or `[]` to show all apps. |

**Responses**

| Status | Description              | Body                        |
|--------|--------------------------|-----------------------------|
| `200`  | Updated                  | `{ success: true }`         |
| `400`  | No valid fields / invalid `hidden_apps` type | `{ success: false, error }` |
| `401`  | Missing/invalid userId   | `{ success: false, error }` |
| `500`  | Server error             | `{ success: false, error }` |

---

### Browser Sessions

#### `POST /api/sessions`

Register or refresh a browser session. Call this after login and after a successful `restoreSession`. Updates `last_active` if the session already exists.

**Request body**

| Field          | Type   | Required | Description                                     |
|----------------|--------|----------|-------------------------------------------------|
| `userId`       | string | Yes      | User UUID                                       |
| `sessionId`    | string | Yes      | Browser session UUID (generated client-side and persisted in `localStorage`) |
| `browserLabel` | string | No       | Human-readable browser/OS label (e.g. `"Chrome on Windows"`) |

**Responses**

| Status | Description              | Body                        |
|--------|--------------------------|-----------------------------|
| `200`  | Registered/refreshed     | `{ success: true }`         |
| `400`  | Missing `sessionId`      | `{ success: false, error }` |
| `401`  | Missing/invalid userId   | `{ success: false, error }` |
| `500`  | Server error             | `{ success: false, error }` |

---

#### `GET /api/users/:userId/known-apps`

Returns all app names that have ever been seen in notifications for this user since the server last started. This list is **in-memory and ephemeral** — it is cleared when the server restarts, but it persists across individual notification deletions. It is used by the frontend to keep the App Filters list populated even after short-lived notifications have been dismissed.

**Query parameters**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `userId`  | string | Yes      | Must match the authenticated user. |

**Response**

| Status | Meaning | Body |
|--------|---------|------|
| `200`  | Success | `{ apps: (string | null)[] }` — array of app name strings; `null` represents notifications with no app name set. |
| `401`  | Missing/invalid userId | `{ success: false, error }` |
| `403`  | userId mismatch | `{ success: false, error }` |

---

#### `GET /api/users/:userId/sessions`

List all active browser sessions for the authenticated user, ordered by most recently active first.

**Query parameters**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `userId`  | string | Yes      | User UUID   |

**Responses**

| Status | Description              | Body                                                                         |
|--------|--------------------------|------------------------------------------------------------------------------|
| `200`  | Success                  | `{ success: true, sessions: [{ session_id, browser_label, created_at, last_active }] }` |
| `401`  | Missing/invalid userId   | `{ success: false, error }`                                                  |
| `403`  | Forbidden (wrong user)   | `{ success: false, error }`                                                  |
| `500`  | Server error             | `{ success: false, error }`                                                  |

---

#### `DELETE /api/sessions/:sessionId`

Revoke a browser session. The session must belong to the authenticated user. If the target session has an open SSE connection, a `logout` event is pushed to it immediately.

**Query parameters**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `userId`  | string | Yes      | User UUID   |

**Responses**

| Status | Description              | Body                        |
|--------|--------------------------|-----------------------------|
| `200`  | Session revoked          | `{ success: true }`         |
| `401`  | Missing/invalid userId   | `{ success: false, error }` |
| `403`  | Forbidden (session belongs to another user) | `{ success: false, error }` |
| `404`  | Session not found        | `{ success: false, error }` |
| `500`  | Server error             | `{ success: false, error }` |

---

## Error Format

All error responses share a common shape:

```json
{
  "success": false,
  "error": "Human-readable description"
}
```

## Notes

- **Notifications are stored in memory only** — they are lost when the server restarts. The Android sender app is expected to resend notifications after a restart.
- Users inactive for **30 days** are automatically pruned along with all their notifications, push subscriptions, FCM device tokens, and browser sessions.
- Browser sessions inactive for **30 days** are pruned independently of user activity.
- Expired push subscriptions (HTTP 410 from the push service) are removed automatically when a push delivery fails.
- FCM device tokens that return `registration-token-not-registered` or `invalid-registration-token` are removed automatically.
- VAPID keys are static. If they are rotated, all stored push subscriptions must be cleared.
- FCM requires `secrets.fcm.serviceAccount` to be populated (see `secrets.example.json`). The server starts without it but FCM data messages will not be sent.
