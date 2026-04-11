// Web Notifications Server
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
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
        password_hash TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_active TEXT
      )
    `);
    // Migrate existing databases that lack the password_hash column
    db.run(`ALTER TABLE users ADD COLUMN password_hash TEXT`, () => {});
    
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

// Password hashing helpers (using built-in crypto — no extra deps)
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

function verifyPassword(password, hash) {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(':');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(Buffer.from(derived.toString('hex')), Buffer.from(key)));
    });
  });
}

// User management functions
async function createUser(username, password, callback) {
  try {
    const userId = uuidv4();
    const passwordHash = await hashPassword(password);
    const stmt = db.prepare(
      'INSERT INTO users (user_id, username, password_hash, last_active) VALUES (?, ?, ?, ?)'
    );
    stmt.run([userId, username, passwordHash, new Date().toISOString()], function(err) {
      if (err) console.error('Error creating user:', err.message);
      if (callback) callback(err, err ? null : { userId, username });
    });
    stmt.finalize();
  } catch (err) {
    if (callback) callback(err, null);
  }
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
  const { userId, ...notificationData } = req.body;
  const notification = notificationData;

  // Add timestamp if not provided
  if (!notification.timestamp) {
    notification.timestamp = new Date().toISOString();
  }

  // Add unique ID
  notification.id = Date.now().toString();

  // Store notification in database
  addNotification(notification, userId, (err) => {
    if (err) {
      console.error('Error storing notification:', err);
      return res.status(500).json({ success: false, error: 'Failed to store notification' });
    }

    console.log('Received notification:', notification);

    // Send push notifications to all subscribers (or user-specific ones)
    sendPushNotifications(notification, userId)
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
  const userId = req.query.userId || null;
  getAllNotifications(userId, (err, rows) => {
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
  const { userId, ...subscriptionData } = req.body;
  const subscription = subscriptionData;
  addPushSubscription(subscription, userId || null, (err) => {
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
  const { title, body, userId } = req.body;

  const notification = {
    title,
    body,
    timestamp: new Date().toISOString(),
    id: Date.now().toString()
  };

  addNotification(notification, userId || null, (err) => {
    if (err) {
      console.error('Error storing notification:', err);
      return res.status(500).json({ success: false, error: 'Failed to store notification' });
    }

    sendPushNotifications(notification, userId || null)
      .then(() => {
        res.status(200).json({ success: true, id: notification.id });
      })
      .catch((error) => {
        console.error('Error sending push notifications:', error);
        res.status(500).json({ success: false, error: error.message });
      });
  });
});

// API Endpoint to handle notification actions
app.post('/api/notifications/:id/actions', (req, res) => {
  const id = req.params.id;
  const action = req.body.action;
  const response = req.body.response;

  console.log(`Action '${action}' performed on notification ${id} with response:`, response);

  db.get('SELECT * FROM notifications WHERE id = ?', [id], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    let data = {};
    try { data = JSON.parse(row.data); } catch (e) {}
    data.actionTaken = action;
    data.actionResponse = response;

    db.run('UPDATE notifications SET data = ? WHERE id = ?', [JSON.stringify(data), id], (updateErr) => {
      if (updateErr) console.error('Error updating notification action:', updateErr.message);
      res.status(200).json({ success: true });
    });
  });
});

// User management API endpoints

// Unified auth: register (new user) or login (existing user)
app.post('/api/auth', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'username and password are required' });
  }

  getUserByUsername(username, async (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Database error' });

    if (!user) {
      // New user — register
      createUser(username, password, (createErr, newUser) => {
        if (createErr) return res.status(500).json({ success: false, error: 'Failed to create user' });
        res.status(201).json({ success: true, created: true, user: newUser });
      });
    } else {
      // Existing user — verify password
      if (!user.password_hash) {
        // Legacy account with no password: set the password now
        try {
          const hash = await new Promise((resolve, reject) => {
            const salt = crypto.randomBytes(16).toString('hex');
            crypto.scrypt(password, salt, 64, (e, key) => e ? reject(e) : resolve(`${salt}:${key.toString('hex')}`));
          });
          db.run('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, user.user_id], () => {});
        } catch (e) { /* non-fatal */ }
        updateUserLastActive(user.user_id, () => {});
        return res.status(200).json({ success: true, created: false, user: { userId: user.user_id, username: user.username } });
      }

      const valid = await verifyPassword(password, user.password_hash).catch(() => false);
      if (!valid) return res.status(401).json({ success: false, error: 'Incorrect password' });

      updateUserLastActive(user.user_id, () => {});
      res.status(200).json({ success: true, created: false, user: { userId: user.user_id, username: user.username } });
    }
  });
});

app.post('/api/users', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'username and password are required' });
  }
  createUser(username, password, (err, user) => {
    if (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        return res.status(409).json({ success: false, error: 'Username already exists' });
      }
      return res.status(500).json({ success: false, error: 'Failed to create user' });
    }
    res.status(201).json({ success: true, user });
  });
});

app.get('/api/users', (req, res) => {
  getAllUsers((err, rows) => {
    if (err) return res.status(500).json({ success: false, error: 'Failed to fetch users' });
    res.status(200).json(rows.map(({ password_hash, ...u }) => u));
  });
});

app.get('/api/users/by-username/:username', (req, res) => {
  getUserByUsername(req.params.username, (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Failed to fetch user' });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.status(200).json(user);
  });
});

app.get('/api/users/:userId', (req, res) => {
  getUserById(req.params.userId, (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Failed to fetch user' });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    updateUserLastActive(user.user_id, () => {});
    const { password_hash, ...safeUser } = user;
    res.status(200).json(safeUser);
  });
});

app.get('/api/users/:userId/notifications', (req, res) => {
  getAllNotifications(req.params.userId, (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
    const notifications = rows.map(row => {
      try { return JSON.parse(row.data); } catch (e) {
        return { id: row.id, title: row.title, body: row.body, timestamp: row.timestamp };
      }
    });
    res.status(200).json(notifications);
  });
});

// Serve HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});