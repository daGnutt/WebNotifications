// Web Notifications Server
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

// Set up web-push with VAPID keys
const vapidKeys = {
  publicKey: 'VAPID_PUBLIC_KEY_REMOVED',
  privateKey: 'VAPID_PRIVATE_KEY_REMOVED'
};

webpush.setVapidDetails(
  'mailto:example@yourdomain.org',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// In-memory storage for notifications
let notifications = [];

// In-memory storage for push subscriptions
let pushSubscriptions = [];

// API Endpoint to receive notifications from Android
app.post('/api/notifications', async (req, res) => {
  const notification = req.body;
  
  // Add timestamp if not provided
  if (!notification.timestamp) {
    notification.timestamp = new Date().toISOString();
  }
  
  // Add unique ID
  notification.id = Date.now().toString();
  
  // Store notification
  notifications.push(notification);
  
  console.log('Received notification:', notification);
  
  // Send push notifications to all subscribers
  try {
    await sendPushNotifications(notification);
  } catch (error) {
    console.error('Error sending push notifications:', error);
  }
  
  res.status(200).json({ success: true, id: notification.id });
});

// Function to send push notifications to all subscribers
async function sendPushNotifications(notification) {
  const notificationPayload = {
    title: notification.title || 'New Notification',
    body: notification.body || '',
    id: notification.id,
    timestamp: notification.timestamp
  };
  
  console.log('Sending push notifications to', pushSubscriptions.length, 'subscribers');
  
  const sendPromises = pushSubscriptions.map(subscription => {
    return webpush.sendNotification(subscription, JSON.stringify(notificationPayload))
      .catch(error => {
        console.error('Error sending push notification:', error);
        // If subscription is invalid, remove it
        if (error.statusCode === 410) { // Gone - subscription expired
          pushSubscriptions = pushSubscriptions.filter(s => s !== subscription);
        }
      });
  });
  
  await Promise.all(sendPromises);
}

// API Endpoint to get VAPID public key
app.get('/api/vapid-public-key', (req, res) => {
  res.status(200).json({ publicKey: vapidKeys.publicKey });
});

// API Endpoint to get all notifications
app.get('/api/notifications', (req, res) => {
  res.status(200).json(notifications);
});

// API Endpoint to dismiss a notification
app.delete('/api/notifications/:id', (req, res) => {
  const id = req.params.id;
  notifications = notifications.filter(n => n.id !== id);
  res.status(200).json({ success: true });
});

// API Endpoint to store push subscription
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  pushSubscriptions.push(subscription);
  console.log('New push subscription stored:', subscription.endpoint);
  res.status(200).json({ success: true });
});

// API Endpoint to send push notification (for testing)
app.post('/api/send-push', async (req, res) => {
  const { title, body } = req.body;
  
  try {
    // In a real implementation, you would use the web-push library here
    // to send push notifications to all subscribers
    console.log('Push notification would be sent to', pushSubscriptions.length, 'subscribers');
    console.log('Title:', title, 'Body:', body);
    
    // For now, we'll just add it to our regular notifications
    // so it appears when the user opens the page
    const notification = {
      title: title,
      body: body,
      timestamp: new Date().toISOString(),
      id: Date.now().toString()
    };
    
    notifications.push(notification);
    
    res.status(200).json({ success: true, id: notification.id });
  } catch (error) {
    console.error('Error sending push notification:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API Endpoint to handle notification actions
app.post('/api/notifications/:id/actions', (req, res) => {
  const id = req.params.id;
  const action = req.body.action;
  const response = req.body.response;
  
  console.log(`Action '${action}' performed on notification ${id} with response:`, response);
  
  // Find and update the notification
  const notificationIndex = notifications.findIndex(n => n.id === id);
  if (notificationIndex !== -1) {
    notifications[notificationIndex].actionTaken = action;
    notifications[notificationIndex].actionResponse = response;
  }
  
  res.status(200).json({ success: true });
});

// Serve HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});