# Web Notifications API Documentation

## Overview

This service provides API endpoints to receive notification pushes from Android phones and displays them in a web interface. The service supports receiving notifications, dismissing them, and handling notification actions like quick replies.

## API Endpoints

### 1. Receive Notification (POST)

**Endpoint:** `/api/notifications`

**Method:** POST

**Description:** Receive a new notification from an Android device.

**Request Body:**
```json
{
  "title": "Notification Title",
  "body": "Notification message content",
  "timestamp": "2023-04-11T12:00:00Z",  // optional, will be auto-generated if not provided
  "actions": [  // optional
    {
      "type": "reply",
      "title": "Reply"
    },
    {
      "type": "action1",
      "title": "Action 1"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "id": "1681212000000"
}
```

### 2. Get All Notifications (GET)

**Endpoint:** `/api/notifications`

**Method:** GET

**Description:** Retrieve all active notifications.

**Response:**
```json
[
  {
    "id": "1681212000000",
    "title": "Notification Title",
    "body": "Notification message content",
    "timestamp": "2023-04-11T12:00:00.000Z",
    "actions": [
      {
        "type": "reply",
        "title": "Reply"
      }
    ]
  }
]
```

### 3. Dismiss Notification (DELETE)

**Endpoint:** `/api/notifications/:id`

**Method:** DELETE

**Description:** Dismiss a specific notification.

**Response:**
```json
{
  "success": true
}
```

### 4. Handle Notification Action (POST)

**Endpoint:** `/api/notifications/:id/actions`

**Method:** POST

**Description:** Handle an action performed on a notification (like quick reply).

**Request Body:**
```json
{
  "action": "reply",
  "response": "This is my reply message"
}
```

**Response:**
```json
{
  "success": true
}
```

## Android Integration Guide

### Using Firebase Cloud Messaging (FCM)

To push notifications from your Android app to this web service:

1. **Set up FCM in your Android app**

2. **Create a Cloud Function** to forward FCM messages to this service:

```javascript
const functions = require('firebase-functions');
const axios = require('axios');

exports.forwardNotification = functions.messaging.onMessageReceived((message) => {
  // Forward the notification to your web service
  return axios.post('http://your-server-address/api/notifications', {
    title: message.notification.title,
    body: message.notification.body,
    actions: message.data.actions ? JSON.parse(message.data.actions) : []
  });
});
```

### Direct HTTP Requests

You can also send notifications directly from your Android app using HTTP:

```java
// Android Java example
OkHttpClient client = new OkHttpClient();

String json = "{\"title\":\"Test Notification\",\"body\":\"This is a test message\"}";
RequestBody body = RequestBody.create(json, JSON);
Request request = new Request.Builder()
    .url("http://your-server-address/api/notifications")
    .post(body)
    .build();

client.newCall(request).enqueue(new Callback() {
    @Override
    public void onFailure(Call call, IOException e) {
        e.printStackTrace();
    }

    @Override
    public void onResponse(Call call, Response response) throws IOException {
        if (response.isSuccessful()) {
            // Notification sent successfully
        }
    }
});
```

## Web Interface

The web interface is available at the root URL (`/`). It displays all active notifications and allows users to:

- View notification details (title, body, timestamp)
- Dismiss notifications
- Perform actions on notifications (like quick replies)

The interface automatically refreshes every 5 seconds to show new notifications.

## Running the Service

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
node server.js
```

3. Access the web interface at `http://localhost:3000`

## Configuration

- **Port:** Change the port by setting the `PORT` environment variable
- **CORS:** The service uses CORS middleware to allow cross-origin requests
- **Storage:** Notifications are stored in memory (restarting the server clears all notifications)

## Security Considerations

For production use, consider:
- Adding authentication for the API endpoints
- Using HTTPS instead of HTTP
- Implementing persistent storage for notifications
- Adding rate limiting to prevent abuse