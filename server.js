// Web Notifications Server
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const webpush = require('web-push');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

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

// Initialize SQLite database
const db = new sqlite3.Database('./notifications.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // Create users table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_active TEXT
      )
    `);
    
    // Create notifications table with user_id
    db.run(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT,
        body TEXT,
        timestamp TEXT,
        data TEXT,
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      )
    `);
    
    // Create push_subscriptions table with user_id
    db.run(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        user_id TEXT,
        subscription_data TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      )
    `);
  });
}

// Database helper functions
function getAllNotifications(userId, callback) {
  if (userId) {
    db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY timestamp DESC', [userId], callback);
  } else {
    db.all('SELECT * FROM notifications ORDER BY timestamp DESC', callback);
  }
}

function addNotification(notification, userId, callback) {
  const stmt = db.prepare(
    'INSERT INTO notifications (id, user_id, title, body, timestamp, data) VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmt.run([
    notification.id,
    userId || null,
    notification.title,
    notification.body,
    notification.timestamp,
    JSON.stringify(notification)
  ], function(err) {
    if (err) console.error('Error adding notification:', err.message);
    if (callback) callback(err, this);
  });
  stmt.finalize();
}

// User management functions
function createUser(username, callback) {
  const userId = uuidv4();
  const stmt = db.prepare(
    'INSERT INTO users (user_id, username, last_active) VALUES (?, ?, ?)'
  );
  stmt.run([userId, username, new Date().toISOString()], function(err) {
    if (err) console.error('Error creating user:', err.message);
    if (callback) callback(err, err ? null : { userId, username });
  });
  stmt.finalize();
}

function getUserById(userId, callback) {
  db.get('SELECT * FROM users WHERE user_id = ?', [userId], callback);
}

function getUserByUsername(username, callback) {
  db.get('SELECT * FROM users WHERE username = ?', [username], callback);
}

function updateUserLastActive(userId, callback) {
  db.run('UPDATE users SET last_active = ? WHERE user_id = ?', [new Date().toISOString(), userId], function(err) {
    if (err) console.error('Error updating user last active:', err.message);
    if (callback) callback(err, this);
  });
}

function getAllUsers(callback) {
  db.all('SELECT * FROM users', callback);
}

function addNotification(notification, callback) {
  const stmt = db.prepare(
    'INSERT INTO notifications (id, title, body, timestamp, data) VALUES (?, ?, ?, ?, ?)'
  );
  stmt.run([
    notification.id,
    notification.title,
    notification.body,
    notification.timestamp,
    JSON.stringify(notification)
  ], function(err) {
    if (err) console.error('Error adding notification:', err.message);
    if (callback) callback(err, this);
  });
  stmt.finalize();
}

function deleteNotification(id, callback) {
  db.run('DELETE FROM notifications WHERE id = ?', [id], function(err) {
    if (err) console.error('Error deleting notification:', err.message);
    if (callback) callback(err, this);
  });
}

function getAllPushSubscriptions(callback) {
  db.all('SELECT * FROM push_subscriptions', callback);
}

function addPushSubscription(subscription, userId, callback) {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, subscription_data) VALUES (?, ?, ?)'
  );
  stmt.run([
    subscription.endpoint,
    userId || null,
    JSON.stringify(subscription)
  ], function(err) {
    if (err) console.error('Error adding push subscription:', err.message);
    if (callback) callback(err, this);
  });
  stmt.finalize();
}

function getPushSubscriptionsForUser(userId, callback) {
  db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId], callback);
}

function deletePushSubscription(endpoint, callback) {
  db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint], function(err) {
    if (err) console.error('Error deleting push subscription:', err.message);
    if (callback) callback(err, this);
  });
}

// API Endpoint to receive notifications from Android
app.post('/api/notifications', async (req, res) => {
  const notification = req.body;
  
  // Add timestamp if not provided
  if (!notification.timestamp) {
    notification.timestamp = new Date().toISOString();
  }
  
  // Add unique ID
  notification.id = Date.now().toString();
  
  // Store notification in database
  addNotification(notification, (err) => {
    if (err) {
      console.error('Error storing notification:', err);
      return res.status(500).json({ success: false, error: 'Failed to store notification' });
    }
    
    console.log('Received notification:', notification);
    
    // Send push notifications to all subscribers
    sendPushNotifications(notification)
      .then(() => {
        res.status(200).json({ success: true, id: notification.id });
      })
      .catch((error) => {
        console.error('Error sending push notifications:', error);
        res.status(200).json({ success: true, id: notification.id }); // Still return success for notification storage
      });
  });
});

// Function to send push notifications to all subscribers
async function sendPushNotifications(notification, userId) {
  const notificationPayload = {
    title: notification.title || 'New Notification',
    body: notification.body || '',
    id: notification.id,
    timestamp: notification.timestamp
  };
  
  // Get push subscriptions from database (filter by userId if provided)
  const subscriptions = await new Promise((resolve, reject) => {
    if (userId) {
      getPushSubscriptionsForUser(userId, (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(row => JSON.parse(row.subscription_data)));
      });
    } else {
      getAllPushSubscriptions((err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(row => JSON.parse(row.subscription_data)));
      });
    }
  });
  
  console.log('Sending push notifications to', subscriptions.length, 'subscribers');
  
  const sendPromises = subscriptions.map(subscription => {
    return webpush.sendNotification(subscription, JSON.stringify(notificationPayload))
      .catch(error => {
        console.error('Error sending push notification:', error);
        // If subscription is invalid, remove it from database
        if (error.statusCode === 410) { // Gone - subscription expired
          deletePushSubscription(subscription.endpoint, (err) => {
            if (err) console.error('Error removing expired subscription:', err);
          });
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
  getAllNotifications((err, rows) => {
    if (err) {
      console.error('Error fetching notifications:', err);
      return res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
    }
    
    // Parse the stored JSON data
    const notifications = rows.map(row => {
      try {
        return JSON.parse(row.data);
      } catch (e) {
        return {
          id: row.id,
          title: row.title,
          body: row.body,
          timestamp: row.timestamp
        };
      }
    });
    
    res.status(200).json(notifications);
  });
});

// API Endpoint to dismiss a notification
app.delete('/api/notifications/:id', (req, res) => {
  const id = req.params.id;
  deleteNotification(id, (err) => {
    if (err) {
      console.error('Error deleting notification:', err);
      return res.status(500).json({ success: false, error: 'Failed to delete notification' });
    }
    res.status(200).json({ success: true });
  });
});

// API Endpoint to store push subscription
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  addPushSubscription(subscription, (err) => {
    if (err) {
      console.error('Error storing push subscription:', err);
      return res.status(500).json({ success: false, error: 'Failed to store subscription' });
    }
    console.log('New push subscription stored:', subscription.endpoint);
    res.status(200).json({ success: true });
  });
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