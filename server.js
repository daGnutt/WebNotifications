// Web Notifications Server
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// Load secrets (SMTP config, etc.)
let secrets = {};
try {
  secrets = require('./secrets.json');
} catch (e) {
  console.warn('secrets.json not found — email features will be unavailable');
}

function createMailTransport() {
  if (!secrets.smtp) return null;
  return nodemailer.createTransport(secrets.smtp);
}
const webpush = require('web-push');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// SSE clients: userId -> Set of response objects
const sseClients = new Map();

function broadcastToUser(userId, event, data) {
  const clients = sseClients.get(userId);
  if (!clients || clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

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
        email TEXT,
        password_hash TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_active TEXT
      )
    `);
    // Migrate existing databases that lack newer columns
    db.run(`ALTER TABLE users ADD COLUMN password_hash TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN email TEXT`, () => {});
    
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

    // Reset codes for account reset via email
    db.run(`
      CREATE TABLE IF NOT EXISTS reset_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
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
async function createUser(username, password, email, callback) {
  try {
    const userId = uuidv4();
    const passwordHash = await hashPassword(password);
    const stmt = db.prepare(
      'INSERT INTO users (user_id, username, email, password_hash, last_active) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run([userId, username, email || null, passwordHash, new Date().toISOString()], function(err) {
      if (err) console.error('Error creating user:', err.message);
      if (callback) callback(err, err ? null : { userId, username, email: email || null });
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

// Middleware — all data endpoints require a valid userId
function requireUserId(req, res, next) {
  const userId = req.query.userId || req.body.userId;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'userId is required' });
  }
  getUserById(userId, (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Database error' });
    if (!user) return res.status(401).json({ success: false, error: 'Invalid userId' });
    req.user = user;
    next();
  });
}

// API Endpoint to receive notifications from Android
app.post('/api/notifications', requireUserId, async (req, res) => {
  const { userId, ...notificationData } = req.body;
  const notification = notificationData;

  // Ignore notifications with no title and no body
  if (!notification.title?.trim() && !notification.body?.trim()) {
    return res.status(200).json({ success: true, ignored: true });
  }

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

    // Broadcast to any open SSE connections for this user
    if (userId) broadcastToUser(userId, 'update', { reason: 'new', id: notification.id });

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
app.get('/api/notifications', requireUserId, (req, res) => {
  getAllNotifications(req.user.user_id, (err, rows) => {
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

// SSE endpoint — keeps connection open and pushes update events to the browser
app.get('/api/notifications/stream', requireUserId, (req, res) => {
  const userId = req.user.user_id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Register this client
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);

  // Send an initial heartbeat so the browser knows it's connected
  res.write('event: connected\ndata: {}\n\n');

  // Keep-alive ping every 25 seconds to prevent proxy timeouts
  const heartbeat = setInterval(() => res.write(':ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(userId)?.delete(res);
    if (sseClients.get(userId)?.size === 0) sseClients.delete(userId);
  });
});

// API Endpoint to dismiss a notification
app.delete('/api/notifications/:id', requireUserId, (req, res) => {
  const id = req.params.id;
  const userId = req.user.user_id;
  // Only delete if the notification belongs to this user
  db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', [id, userId], function(err) {
    if (err) {
      console.error('Error deleting notification:', err);
      return res.status(500).json({ success: false, error: 'Failed to delete notification' });
    }
    broadcastToUser(userId, 'update', { reason: 'delete', id });
    res.status(200).json({ success: true });
  });
});

// API Endpoint to store push subscription
app.post('/api/subscribe', requireUserId, (req, res) => {
  const { userId, ...subscriptionData } = req.body;
  const subscription = subscriptionData;
  addPushSubscription(subscription, req.user.user_id, (err) => {
    if (err) {
      console.error('Error storing push subscription:', err);
      return res.status(500).json({ success: false, error: 'Failed to store subscription' });
    }
    console.log('New push subscription stored:', subscription.endpoint);
    res.status(200).json({ success: true });
  });
});

// API Endpoint to send push notification (for testing)
app.post('/api/send-push', requireUserId, async (req, res) => {
  const { title, body } = req.body;
  const userId = req.user.user_id;

  const notification = {
    title,
    body,
    timestamp: new Date().toISOString(),
    id: Date.now().toString()
  };

  addNotification(notification, userId, (err) => {
    if (err) {
      console.error('Error storing notification:', err);
      return res.status(500).json({ success: false, error: 'Failed to store notification' });
    }

    broadcastToUser(userId, 'update', { reason: 'new', id: notification.id });

    sendPushNotifications(notification, userId)
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
app.post('/api/notifications/:id/actions', requireUserId, (req, res) => {
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
      broadcastToUser(req.user.user_id, 'update', { reason: 'action', id });
      res.status(200).json({ success: true });
    });
  });
});

// User management API endpoints

// Unified auth: register (new user) or login (existing user)
app.post('/api/auth', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'username and password are required' });
  }

  getUserByUsername(username, async (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Database error' });

    if (!user) {
      // New user — register
      createUser(username, password, email, (createErr, newUser) => {
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
      res.status(200).json({ success: true, created: false, user: { userId: user.user_id, username: user.username, email: user.email || null } });
    }
  });
});

// POST /api/auth/reset-request — send a time-limited reset code to the user's email
app.post('/api/auth/reset-request', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ success: false, error: 'username is required' });

  getUserByUsername(username, (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Database error' });
    // Always respond the same way to avoid username enumeration
    if (!user || !user.email) {
      return res.status(200).json({ success: true, message: 'If an account with an email exists, a code has been sent.' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

    // Remove any existing codes for this user, then insert new one
    db.run('DELETE FROM reset_codes WHERE user_id = ?', [user.user_id], () => {
      db.run('INSERT INTO reset_codes (code, user_id, expires_at) VALUES (?, ?, ?)',
        [code, user.user_id, expiresAt], async (insertErr) => {
          if (insertErr) return res.status(500).json({ success: false, error: 'Failed to create reset code' });

          const transport = createMailTransport();
          if (!transport) {
            console.warn(`[reset] SMTP not configured. Code for ${username}: ${code}`);
            return res.status(200).json({ success: true, message: 'If an account with an email exists, a code has been sent.' });
          }

          try {
            await transport.sendMail({
              from: secrets.smtp.from,
              to: user.email,
              subject: 'Your account reset code',
              text: `Your reset code is: ${code}\n\nIt expires in 15 minutes. If you did not request this, ignore this email.`,
              html: `<p>Your reset code is: <strong>${code}</strong></p><p>It expires in 15 minutes. If you did not request this, ignore this email.</p>`
            });
          } catch (mailErr) {
            console.error('Failed to send reset email:', mailErr.message);
          }

          res.status(200).json({ success: true, message: 'If an account with an email exists, a code has been sent.' });
        });
    });
  });
});

// POST /api/auth/reset-confirm — verify code and recreate the account with a new password
app.post('/api/auth/reset-confirm', (req, res) => {
  const { code, newPassword } = req.body;
  if (!code || !newPassword) {
    return res.status(400).json({ success: false, error: 'code and newPassword are required' });
  }

  db.get('SELECT * FROM reset_codes WHERE code = ?', [code], (err, row) => {
    if (err) return res.status(500).json({ success: false, error: 'Database error' });
    if (!row) return res.status(400).json({ success: false, error: 'Invalid or expired code' });
    if (new Date(row.expires_at) < new Date()) {
      db.run('DELETE FROM reset_codes WHERE code = ?', [code], () => {});
      return res.status(400).json({ success: false, error: 'Invalid or expired code' });
    }

    getUserById(row.user_id, (userErr, user) => {
      if (userErr || !user) return res.status(500).json({ success: false, error: 'User not found' });

      const { username, email } = user;

      // Delete the old account and all associated data, then recreate
      db.serialize(() => {
        db.run('DELETE FROM reset_codes WHERE user_id = ?', [user.user_id]);
        db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [user.user_id]);
        db.run('DELETE FROM notifications WHERE user_id = ?', [user.user_id]);
        db.run('DELETE FROM users WHERE user_id = ?', [user.user_id], (delErr) => {
          if (delErr) return res.status(500).json({ success: false, error: 'Failed to reset account' });

          createUser(username, newPassword, email, (createErr, newUser) => {
            if (createErr) return res.status(500).json({ success: false, error: 'Failed to recreate account' });
            res.status(200).json({ success: true, user: newUser });
          });
        });
      });
    });
  });
});

app.post('/api/users', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'username and password are required' });
  }
  createUser(username, password, email, (err, user) => {
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
    res.status(200).json(rows.map(({ password_hash, user_id, ...u }) => ({
      guid: user_id,
      ...u
    })));
  });
});

app.patch('/api/users/:userId/email', (req, res) => {
  const { email } = req.body;
  db.run('UPDATE users SET email = ? WHERE user_id = ?', [email || null, req.params.userId], function(err) {
    if (err) return res.status(500).json({ success: false, error: 'Failed to update email' });
    if (this.changes === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.status(200).json({ success: true });
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

// Prune users inactive for 30+ days along with all their associated data
function pruneInactiveUsers() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.all('SELECT user_id FROM users WHERE last_active < ?', [cutoff], (err, rows) => {
    if (err || !rows.length) return;
    const ids = rows.map(r => r.user_id);
    const placeholders = ids.map(() => '?').join(',');
    db.serialize(() => {
      db.run(`DELETE FROM reset_codes       WHERE user_id IN (${placeholders})`, ids);
      db.run(`DELETE FROM push_subscriptions WHERE user_id IN (${placeholders})`, ids);
      db.run(`DELETE FROM notifications      WHERE user_id IN (${placeholders})`, ids);
      db.run(`DELETE FROM users              WHERE user_id IN (${placeholders})`, ids, (delErr) => {
        if (!delErr) console.log(`Pruned ${ids.length} inactive user(s) (last active before ${cutoff})`);
      });
    });
  });
}

// Run once at startup, then every 24 hours
pruneInactiveUsers();
setInterval(pruneInactiveUsers, 24 * 60 * 60 * 1000);

// Start server — bind to :: with ipv6Only:false for dual-stack (IPv4 + IPv6)
const server = http.createServer(app);
server.listen({ port: PORT, host: '::', ipv6Only: false }, () => {
  console.log(`Server running on port ${PORT} (IPv4 + IPv6)`);
});