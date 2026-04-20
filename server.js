// Web Notifications Server
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

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

// Initialise Firebase Admin SDK for FCM data messages (optional)
let fcmAdmin = null;
const fcmConfig = secrets.fcm || {};
if (fcmConfig.serviceAccount) {
  try {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(fcmConfig.serviceAccount) });
    fcmAdmin = admin;
    console.log('Firebase Admin SDK initialised — FCM enabled');
  } catch (e) {
    console.warn('Failed to initialise Firebase Admin SDK:', e.message);
  }
} else {
  console.warn('FCM service account not configured in secrets.json — FCM data push will be unavailable');
}

const app = express();
const PORT = process.env.PORT || 3000;

// Captured once at startup so SSE clients can detect a server restart and reload.
const SERVER_STARTED_AT = new Date().toISOString();

// Returns a shallow copy of obj with data URI strings replaced by a short summary.
function sanitizeForLog(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.startsWith('data:')) {
      const mimeEnd = value.indexOf(';');
      const prefix = mimeEnd !== -1 ? value.slice(0, mimeEnd) : 'data:';
      const sizeKb = Math.round(value.length / 1024);
      result[key] = `${prefix};base64 ... ${sizeKb}KB Data`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

// SSE clients: userId -> Map<sessionId, response>
const sseClients = new Map();

// In-memory notifications store: userId -> notification[]
const notificationsStore = new Map();

// In-memory set of all app names ever seen per user: userId -> Set<appName|null>
// Intentionally ephemeral — cleared on restart.
const seenApps = new Map();

function broadcastToUser(userId, event, data) {
  const sessions = sseClients.get(userId);
  if (!sessions || sessions.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sessions.values()) {
    res.write(payload);
  }
}

// Close and remove all open SSE connections for a user.
function disconnectSseClients(userId) {
  const sessions = sseClients.get(userId);
  if (!sessions) return;
  for (const res of sessions.values()) {
    try { res.end(); } catch (_) {}
  }
  sseClients.delete(userId);
}

// Delete a user and all their associated data from every table.
function purgeUser(userId, callback) {
  notificationsStore.delete(userId);
  db.serialize(() => {
    db.run('DELETE FROM notifications      WHERE user_id = ?', [userId]);
    db.run('DELETE FROM reset_codes        WHERE user_id = ?', [userId]);
    db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
    db.run('DELETE FROM device_tokens      WHERE user_id = ?', [userId]);
    db.run('DELETE FROM browser_sessions   WHERE user_id = ?', [userId]);
    db.run('DELETE FROM users              WHERE user_id = ?', [userId], callback);
  });
}

// Set up web-push with VAPID keys from secrets.json
const vapidKeys = secrets.vapid || {};
if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  console.warn('VAPID keys not configured in secrets.json — web push will be unavailable');
} else {
  webpush.setVapidDetails(
    vapidKeys.mailto || 'mailto:example@yourdomain.org',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
}

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || false,
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Rate limiters for auth endpoints
const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, please try again later.' }
});

const authResetRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many reset requests, please try again later.' }
});

const authResetConfirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, please try again later.' }
});

// Initialize SQLite database
const db = new sqlite3.Database(process.env.DB_PATH || './notifications.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase(() => {
      loadNotificationsFromDb(() => {
        sendResyncRequest();
        sendStartupReloadPush();
      });
    });
  }
});

function initializeDatabase(callback) {
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
    db.run(`ALTER TABLE users ADD COLUMN show_app_name INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN hidden_apps TEXT DEFAULT NULL`, () => {});
    
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

    // FCM device tokens — one row per device (token is globally unique)
    db.run(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        fcm_token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      )
    `);

    // Browser sessions — one row per logged-in browser profile
    db.run(`
      CREATE TABLE IF NOT EXISTS browser_sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        browser_label TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_active TEXT,
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      )
    `);

    // Persistent notification store — write-through cache backed by this table
    db.run(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (id, user_id),
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      )
    `, () => { if (callback) callback(); });
  });
}

// Send { type: "resync" } to all registered FCM device tokens (or a single specific token).
// Called at startup and when a new token is registered, so Android devices re-POST their
// buffered notifications after the server loses its in-memory notification store.
async function sendResyncRequest(specificToken) {
  if (!fcmAdmin) return;

  let tokens;
  if (specificToken) {
    tokens = [specificToken];
  } else {
    tokens = await new Promise((resolve, reject) => {
      db.all('SELECT fcm_token FROM device_tokens', (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => r.fcm_token));
      });
    });
  }

  if (tokens.length === 0) return;
  console.log(`Sending FCM resync request to ${tokens.length} device(s)`);

  const results = await Promise.allSettled(
    tokens.map(token => fcmAdmin.messaging().send({ token, data: { type: 'resync' } }))
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const err = result.reason;
      console.error('FCM resync error for token', tokens[i], ':', err.message);
      if (
        err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token'
      ) {
        deleteDeviceToken(tokens[i], () => {});
      }
    }
  });
}

// Send a {type:"reload"} web-push to every stored subscription so open browser tabs
// and service workers know the server restarted and should reload for fresh code.
async function sendStartupReloadPush() {
  if (!vapidKeys.publicKey || !vapidKeys.privateKey) return;
  const rows = await new Promise(resolve => {
    getAllPushSubscriptions((err, r) => resolve(err ? [] : r));
  });
  if (rows.length === 0) return;
  console.log(`Sending startup reload push to ${rows.length} subscription(s)`);
  const payload = JSON.stringify({ type: 'reload' });
  await Promise.allSettled(
    rows.map(row => {
      const sub = JSON.parse(row.subscription_data);
      return webpush.sendNotification(sub, payload).catch(err => {
        if (err.statusCode === 410) {
          deletePushSubscription(sub.endpoint, () => {});
        }
      });
    })
  );
}

// In-memory notification helpers (write-through cache; DB is source of truth on startup)
function getAllNotifications(userId, callback) {
  const notifications = userId
    ? (notificationsStore.get(userId) || [])
    : Array.from(notificationsStore.values()).flat();
  const sorted = [...notifications].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  callback(null, sorted);
}

function addNotification(notification, userId, callback) {
  const key = userId || '__anonymous__';
  if (!notificationsStore.has(key)) notificationsStore.set(key, []);
  notificationsStore.get(key).unshift(notification);
  if (!seenApps.has(key)) seenApps.set(key, new Set());
  seenApps.get(key).add(notification.appName || null);
  if (userId) {
    const stmt = db.prepare('INSERT OR REPLACE INTO notifications (id, user_id, payload, received_at) VALUES (?, ?, ?, ?)');
    stmt.run([notification.id, userId, JSON.stringify(notification), notification.timestamp || new Date().toISOString()], (err) => {
      if (err) console.error('Error persisting notification:', err.message);
      if (callback) callback(null);
    });
    stmt.finalize();
  } else {
    if (callback) callback(null);
  }
}

function deleteNotification(userId, id) {
  const notifications = notificationsStore.get(userId);
  if (!notifications) return false;
  const idx = notifications.findIndex(n => n.id === id);
  if (idx === -1) return false;
  notifications.splice(idx, 1);
  db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', [id, userId], (err) => {
    if (err) console.error('Error deleting notification from DB:', err.message);
  });
  return true;
}

function getNotification(userId, id) {
  const notifications = notificationsStore.get(userId);
  return notifications ? notifications.find(n => n.id === id) : null;
}

function persistNotification(userId, notification) {
  db.run('UPDATE notifications SET payload = ? WHERE id = ? AND user_id = ?',
    [JSON.stringify(notification), notification.id, userId], (err) => {
      if (err) console.error('Error updating notification in DB:', err.message);
    });
}

function loadNotificationsFromDb(callback) {
  db.all('SELECT user_id, payload FROM notifications ORDER BY received_at ASC', (err, rows) => {
    if (err) {
      console.error('Error loading notifications from DB:', err.message);
      return callback ? callback() : undefined;
    }
    for (const row of rows) {
      try {
        const notification = JSON.parse(row.payload);
        const key = row.user_id;
        if (!notificationsStore.has(key)) notificationsStore.set(key, []);
        notificationsStore.get(key).unshift(notification);
        if (!seenApps.has(key)) seenApps.set(key, new Set());
        seenApps.get(key).add(notification.appName || null);
      } catch (e) {
        console.error('Error parsing persisted notification:', e.message);
      }
    }
    console.log(`Loaded ${rows.length} notification(s) from database`);
    if (callback) callback();
  });
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
function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : null;
}

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

function getAllPushSubscriptions(callback) {
  db.all('SELECT * FROM push_subscriptions', callback);
}

function addPushSubscription(subscription, userId, callback) {
  // Check if the endpoint already exists so we can log new vs updated
  db.get('SELECT endpoint FROM push_subscriptions WHERE endpoint = ?', [subscription.endpoint], (err, existing) => {
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, subscription_data) VALUES (?, ?, ?)'
    );
    stmt.run([
      subscription.endpoint,
      userId || null,
      JSON.stringify(subscription)
    ], function(runErr) {
      if (runErr) console.error('Error adding push subscription:', runErr.message);
      if (callback) callback(runErr, { isNew: !existing });
    });
    stmt.finalize();
  });
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

// Device token helpers (FCM)
function addDeviceToken(userId, token, callback) {
  db.run(
    'INSERT OR REPLACE INTO device_tokens (fcm_token, user_id, created_at) VALUES (?, ?, ?)',
    [token, userId, new Date().toISOString()],
    function(err) {
      if (err) console.error('Error adding device token:', err.message);
      if (callback) callback(err, this);
    }
  );
}

function getDeviceTokensForUser(userId, callback) {
  db.all('SELECT fcm_token FROM device_tokens WHERE user_id = ?', [userId], callback);
}

function deleteDeviceToken(token, callback) {
  db.run('DELETE FROM device_tokens WHERE fcm_token = ?', [token], function(err) {
    if (err) console.error('Error deleting device token:', err.message);
    if (callback) callback(err, this);
  });
}

// Browser session helpers
function createOrRefreshSession(sessionId, userId, browserLabel, callback) {
  db.run(
    `INSERT INTO browser_sessions (session_id, user_id, browser_label, created_at, last_active)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET last_active = excluded.last_active, browser_label = excluded.browser_label`,
    [sessionId, userId, browserLabel || 'Unknown browser', new Date().toISOString(), new Date().toISOString()],
    function(err) {
      if (err) console.error('Error creating/refreshing session:', err.message);
      if (callback) callback(err, this);
    }
  );
}

function getSessionsForUser(userId, callback) {
  db.all('SELECT session_id, browser_label, created_at, last_active FROM browser_sessions WHERE user_id = ? ORDER BY last_active DESC', [userId], callback);
}

function deleteSession(sessionId, callback) {
  db.run('DELETE FROM browser_sessions WHERE session_id = ?', [sessionId], function(err) {
    if (err) console.error('Error deleting session:', err.message);
    if (callback) callback(err, this);
  });
}

function getSession(sessionId, callback) {
  db.get('SELECT * FROM browser_sessions WHERE session_id = ?', [sessionId], callback);
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

// Normalize icon: accepts a URL, a data URI, or raw base64 (assumes PNG)
function normalizeIcon(icon) {
  if (!icon || typeof icon !== 'string') return null;
  if (icon.startsWith('data:')) return icon;
  if (icon.startsWith('http://') || icon.startsWith('https://')) return icon;
  return `data:image/png;base64,${icon}`;
}

// Normalize actions: accept 'action' (singular), 'buttons', or 'intents' as aliases
function normalizeActions(n) {
  if (n.actions) return;
  const raw = n.action ?? n.buttons ?? n.intents;
  if (!raw) return;
  const arr = Array.isArray(raw) ? raw : [typeof raw === 'string' ? { title: raw } : raw];
  n.actions = arr;
  delete n.action; delete n.buttons; delete n.intents;
}

// API Endpoint to receive notifications from Android
app.post('/api/notifications', requireUserId, async (req, res) => {
  const { userId, ...notificationData } = req.body;
  const notification = notificationData;

  // Ignore notifications with no title and no body
  if (!notification.title?.trim() && !notification.body?.trim()) {
    return res.status(200).json({ success: true, ignored: true });
  }

  // Normalise icon to a data URI (accepts URL, data URI, or raw base64)
  if (notification.icon) notification.icon = normalizeIcon(notification.icon);

  // Normalise actions from any common alternative field name
  normalizeActions(notification);

  // Add timestamp if not provided
  if (!notification.timestamp) {
    notification.timestamp = new Date().toISOString();
  }

  // Add unique ID
  notification.id = uuidv4();

  // Store notification in memory
  addNotification(notification, userId, () => {
    console.log('Received notification:', sanitizeForLog(notification));

    // Broadcast to any open SSE connections for this user
    if (userId) broadcastToUser(userId, 'update', { reason: 'new', id: notification.id });

    // Silent notifications are delivered via SSE only — no web-push popup.
    if (notification.isSilent) {
      return res.status(200).json({ success: true, id: notification.id });
    }

    // Send push notifications to all subscribers (or user-specific ones)
    sendPushNotifications(notification, userId)
      .then(() => {
        res.status(200).json({ success: true, id: notification.id });
      })
      .catch((error) => {
        console.error('Error sending push notifications:', error);
        res.status(200).json({ success: true, id: notification.id });
      });
  });
});

// Function to send push notifications to all subscribers
async function sendPushNotifications(notification, userId) {
  const notificationPayload = {
    title: notification.title || 'New Notification',
    body: notification.body || '',
    id: notification.id,
    timestamp: notification.timestamp,
    appName: notification.appName || null
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

// Send FCM data messages to all registered devices for a user
async function sendFcmDataMessages(userId, payload) {
  if (!fcmAdmin) return;
  const tokens = await new Promise((resolve, reject) => {
    getDeviceTokensForUser(userId, (err, rows) => {
      if (err) return reject(err);
      resolve(rows.map(r => r.fcm_token));
    });
  });
  if (tokens.length === 0) return;

  // FCM data messages require all values to be strings
  const data = {};
  for (const [k, v] of Object.entries(payload)) data[k] = String(v);

  const results = await Promise.allSettled(
    tokens.map(token => fcmAdmin.messaging().send({ token, data }))
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const err = result.reason;
      console.error('FCM send error for token', tokens[i], ':', err.message);
      if (
        err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token'
      ) {
        deleteDeviceToken(tokens[i], () => {});
      }
    }
  });
}

// API Endpoint to get VAPID public key
app.get('/api/vapid-public-key', (req, res) => {
  res.status(200).json({ publicKey: vapidKeys.publicKey });
});

// API Endpoint to get all notifications
app.get('/api/notifications', requireUserId, (req, res) => {
  getAllNotifications(req.user.user_id, (err, notifications) => {
    if (err) {
      console.error('Error fetching notifications:', err);
      return res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
    }
    res.status(200).json(notifications);
  });
});

// SSE endpoint — keeps connection open and pushes update events to the browser
app.get('/api/notifications/stream', requireUserId, (req, res) => {
  const userId = req.user.user_id;
  const sessionId = req.query.sessionId || null;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Register this client keyed by sessionId (or a fallback UUID for anonymous tabs)
  const clientKey = sessionId || uuidv4();
  if (!sseClients.has(userId)) sseClients.set(userId, new Map());
  sseClients.get(userId).set(clientKey, res);

  // Send an initial heartbeat so the browser knows it's connected.
  // Include SERVER_STARTED_AT so tabs can detect a server restart and reload.
  res.write(`event: connected\ndata: ${JSON.stringify({ startedAt: SERVER_STARTED_AT })}\n\n`);

  // Keep-alive ping every 25 seconds to prevent proxy timeouts
  const heartbeat = setInterval(() => res.write(':ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(userId)?.delete(clientKey);
    if (sseClients.get(userId)?.size === 0) sseClients.delete(userId);
  });
});

// API Endpoint to dismiss a notification
app.delete('/api/notifications/:id', requireUserId, (req, res) => {
  const id = req.params.id;
  const userId = req.user.user_id;

  // Refuse to delete a notification whose action has been recorded but not yet
  // dispatched to the Android device.  This prevents the Android app from
  // accidentally wiping the notification before the web UI has reflected the
  // action state — the Android app should only DELETE on explicit user dismiss,
  // not after firing an intent/action.
  const notification = getNotification(userId, id);
  if (notification?.actionTaken && !notification?.actionDispatched) {
    return res.status(409).json({
      success: false,
      error: 'Cannot delete a notification with a pending action that has not been dispatched yet'
    });
  }

  const deleted = deleteNotification(userId, id);
  if (!deleted) {
    return res.status(404).json({ success: false, error: 'Notification not found' });
  }
  console.log(`Notification deleted: ${id} (user: ${userId})`);
  broadcastToUser(userId, 'update', { reason: 'delete', id });
  sendFcmDataMessages(userId, { type: 'dismiss', notificationId: id })
    .catch(e => console.error('FCM dismiss error:', e.message));
  res.status(200).json({ success: true });
});

// API Endpoint to store push subscription
app.post('/api/subscribe', requireUserId, (req, res) => {
  const { userId, ...subscriptionData } = req.body;
  const subscription = subscriptionData;
  addPushSubscription(subscription, req.user.user_id, (err, meta) => {
    if (err) {
      console.error('Error storing push subscription:', err);
      return res.status(500).json({ success: false, error: 'Failed to store subscription' });
    }
    if (meta?.isNew) {
      console.log('New push subscription stored:', subscription.endpoint);
    } else {
      console.log('Push subscription refreshed (already known):', subscription.endpoint);
    }
    res.status(200).json({ success: true });
  });
});

// API Endpoint to register an FCM device token
app.post('/api/device-tokens', requireUserId, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'token is required' });
  addDeviceToken(req.user.user_id, token, (err) => {
    if (err) {
      console.error('Error storing device token:', err);
      return res.status(500).json({ success: false, error: 'Failed to store device token' });
    }
    console.log('FCM device token stored for user', req.user.user_id);
    sendResyncRequest(token).catch(e => console.error('FCM resync error after token register:', e.message));
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

  addNotification(notification, userId, () => {
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
  const userId = req.user.user_id;

  console.log(`Action '${action}' performed on notification ${id} with response:`, response);

  const notification = getNotification(userId, id);
  if (!notification) {
    return res.status(404).json({ success: false, error: 'Notification not found' });
  }

  notification.actionTaken = action;
  notification.actionResponse = response;
  delete notification.actionDispatched;
  persistNotification(userId, notification);

  broadcastToUser(userId, 'update', { reason: 'action', id });
  const fcmPayload = { type: 'action', notificationId: id, actionTaken: String(action) };
  if (response != null) fcmPayload.actionResponse = String(response);
  sendFcmDataMessages(userId, fcmPayload)
    .catch(e => console.error('FCM action error:', e.message));
  // Auto-confirm after 30 s if the Android device never calls /dispatched (e.g. offline)
  setTimeout(() => {
    if (notification.actionTaken && !notification.actionDispatched) {
      notification.actionDispatched = true;
      broadcastToUser(userId, 'update', { reason: 'action', id });
    }
  }, 30000);
  res.status(200).json({ success: true });
});

// API Endpoint for the Android endpoint app to acknowledge it has dispatched an action.
// Call this after successfully sending the reply/action so subsequent polls ignore it.
app.post('/api/notifications/:id/actions/dispatched', requireUserId, (req, res) => {
  const id = req.params.id;
  const userId = req.user.user_id;

  const notification = getNotification(userId, id);
  if (!notification) {
    return res.status(404).json({ success: false, error: 'Notification not found' });
  }

  if (!notification.actionTaken) {
    return res.status(400).json({ success: false, error: 'No action to acknowledge' });
  }

  notification.actionDispatched = true;
  persistNotification(userId, notification);
  broadcastToUser(userId, 'update', { reason: 'action', id });
  res.status(200).json({ success: true });
});

// User management API endpoints

// Unified auth: register (new user) or login (existing user)
app.post('/api/auth', authLoginLimiter, async (req, res) => {
  const { password, email } = req.body;
  const username = normalizeUsername(req.body.username);
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'username and password are required' });
  }

  getUserByUsername(username, async (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Database error' });

    if (!user) {
      // New user — register
      createUser(username, password, email, (createErr, newUser) => {
        if (createErr) return res.status(500).json({ success: false, error: 'Failed to create user' });
        console.log(`User registered: ${username} (${newUser.userId})`);
        res.status(201).json({ success: true, created: true, user: { ...newUser, showAppName: false } });
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
      if (!valid) {
        console.log(`Login failed (wrong password): ${username}`);
        return res.status(401).json({ success: false, error: 'Incorrect password' });
      }

      console.log(`User logged in: ${username} (${user.user_id})`);
      updateUserLastActive(user.user_id, () => {});
      res.status(200).json({ success: true, created: false, user: { userId: user.user_id, username: user.username, email: user.email || null, showAppName: !!user.show_app_name, hiddenApps: (() => { try { return user.hidden_apps ? JSON.parse(user.hidden_apps) : []; } catch { return []; } })() } });
    }
  });
});

// POST /api/auth/reset-request — send a time-limited reset code to the user's email
app.post('/api/auth/reset-request', authResetRequestLimiter, (req, res) => {
  const username = normalizeUsername(req.body.username);
  if (!username) return res.status(400).json({ success: false, error: 'username is required' });

  getUserByUsername(username, (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'Database error' });
    // Always respond the same way to avoid username enumeration
    if (!user || !user.email) {
      return res.status(200).json({ success: true, message: 'If an account with an email exists, a code has been sent.' });
    }

    const code = crypto.randomBytes(32).toString('hex');
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
app.post('/api/auth/reset-confirm', authResetConfirmLimiter, (req, res) => {
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
      purgeUser(user.user_id, (delErr) => {
        if (delErr) return res.status(500).json({ success: false, error: 'Failed to reset account' });
        console.log(`Account reset: ${username} (old user_id: ${user.user_id})`);
        disconnectSseClients(user.user_id);
        createUser(username, newPassword, email, (createErr, newUser) => {
          if (createErr) return res.status(500).json({ success: false, error: 'Failed to recreate account' });
          res.status(200).json({ success: true, user: newUser });
        });
      });
    });
  });
});


app.patch('/api/users/:userId/email', requireUserId, (req, res) => {
  if (req.params.userId !== req.user.user_id) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const { email } = req.body;
  db.run('UPDATE users SET email = ? WHERE user_id = ?', [email || null, req.user.user_id], function(err) {
    if (err) return res.status(500).json({ success: false, error: 'Failed to update email' });
    if (this.changes === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.status(200).json({ success: true });
  });
});

app.patch('/api/users/:userId/preferences', requireUserId, (req, res) => {
  const { show_app_name, hidden_apps } = req.body;
  const fields = [];
  const params = [];

  if (show_app_name !== undefined) {
    fields.push('show_app_name = ?');
    params.push(show_app_name ? 1 : 0);
  }

  if (hidden_apps !== undefined) {
    if (hidden_apps === null) {
      fields.push('hidden_apps = ?');
      params.push(null);
    } else if (Array.isArray(hidden_apps)) {
      fields.push('hidden_apps = ?');
      params.push(JSON.stringify(hidden_apps));
    } else {
      return res.status(400).json({ success: false, error: 'hidden_apps must be an array or null' });
    }
  }

  if (fields.length === 0) {
    return res.status(400).json({ success: false, error: 'No valid fields to update' });
  }

  params.push(req.user.user_id);
  db.run(`UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`, params, function(err) {
    if (err) return res.status(500).json({ success: false, error: 'Failed to update preferences' });
    res.status(200).json({ success: true });
  });
});

app.get('/api/users/:userId', requireUserId, (req, res) => {
  if (req.params.userId !== req.user.user_id) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const sessionId = req.query.sessionId || null;
  const respond = () => {
    updateUserLastActive(req.user.user_id, () => {});
    const { password_hash, ...safeUser } = req.user;
    res.status(200).json(safeUser);
  };
  if (sessionId) {
    getSession(sessionId, (err, session) => {
      if (err) return res.status(500).json({ success: false, error: 'Database error' });
      if (!session) return res.status(401).json({ success: false, error: 'session_revoked' });
      respond();
    });
  } else {
    respond();
  }
});

// GET /api/users/:userId/known-apps — returns all app names ever seen for this user (in-memory, ephemeral)
app.get('/api/users/:userId/known-apps', requireUserId, (req, res) => {
  if (req.params.userId !== req.user.user_id) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const key = req.user.user_id;
  const apps = seenApps.has(key) ? [...seenApps.get(key)] : [];
  res.status(200).json({ apps });
});

app.delete('/api/users/:userId', requireUserId, (req, res) => {
  if (req.params.userId !== req.user.user_id) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const userId = req.user.user_id;
  purgeUser(userId, (err) => {
    if (err) return res.status(500).json({ success: false, error: 'Failed to delete account' });
    console.log(`Account deleted: ${req.user.username} (${userId})`);
    disconnectSseClients(userId);
    res.status(200).json({ success: true });
  });
});

app.get('/api/users/:userId/notifications', requireUserId, (req, res) => {  if (req.params.userId !== req.user.user_id) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  getAllNotifications(req.user.user_id, (err, notifications) => {
    if (err) return res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
    res.status(200).json(notifications);
  });
});

// Browser session endpoints

// POST /api/sessions — register or refresh a browser session
app.post('/api/sessions', requireUserId, (req, res) => {
  const { sessionId, browserLabel } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId is required' });
  createOrRefreshSession(sessionId, req.user.user_id, browserLabel, (err) => {
    if (err) return res.status(500).json({ success: false, error: 'Failed to register session' });
    res.status(200).json({ success: true });
  });
});

// GET /api/users/:userId/sessions — list all browser sessions for the user
app.get('/api/users/:userId/sessions', requireUserId, (req, res) => {
  if (req.params.userId !== req.user.user_id) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  getSessionsForUser(req.user.user_id, (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: 'DB error' });
    res.status(200).json({ success: true, sessions: rows });
  });
});

// DELETE /api/sessions/:sessionId — revoke a session; push logout event if connected
app.delete('/api/sessions/:sessionId', requireUserId, (req, res) => {
  const sessionId = req.params.sessionId;
  const userId = req.user.user_id;
  // Verify the session belongs to this user before deleting
  getSession(sessionId, (err, session) => {
    if (err) return res.status(500).json({ success: false, error: 'DB error' });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (session.user_id !== userId) return res.status(403).json({ success: false, error: 'Forbidden' });
    deleteSession(sessionId, (delErr) => {
      if (delErr) return res.status(500).json({ success: false, error: 'Failed to delete session' });
      console.log(`Session revoked: ${sessionId} (user: ${userId})`);
      // Push a logout event to that specific SSE connection if it's open
      const userSessions = sseClients.get(userId);
      if (userSessions) {
        const targetRes = userSessions.get(sessionId);
        if (targetRes) {
          try {
            targetRes.write(`event: logout\ndata: ${JSON.stringify({ sessionId })}\n\n`);
            targetRes.end();
          } catch (_) {}
          userSessions.delete(sessionId);
          if (userSessions.size === 0) sseClients.delete(userId);
        }
      }
      res.status(200).json({ success: true });
    });
  });
});

// GET /api/fcm/status — FCM health for the authenticated user
app.get('/api/fcm/status', requireUserId, (req, res) => {
  const userId = req.user.user_id;
  getDeviceTokensForUser(userId, (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: 'DB error' });
    res.status(200).json({
      success: true,
      configured: !!fcmAdmin,
      deviceCount: rows.length
    });
  });
});

// POST /api/fcm/resync — manually trigger a resync request to all registered Android devices
app.post('/api/fcm/resync', requireUserId, async (req, res) => {
  if (!fcmAdmin) return res.status(503).json({ success: false, error: 'FCM not configured' });
  const userId = req.user.user_id;
  getDeviceTokensForUser(userId, async (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: 'DB error' });
    if (rows.length === 0) return res.status(200).json({ success: true, sent: 0 });
    console.log(`Manual FCM resync requested by user ${userId} — ${rows.length} device(s)`);
    const tokens = rows.map(r => r.fcm_token);
    const results = await Promise.allSettled(
      tokens.map(token => fcmAdmin.messaging().send({ token, data: { type: 'resync' } }))
    );
    let sent = 0;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        sent++;
      } else {
        const e = result.reason;
        console.error('FCM resync error for token', tokens[i], ':', e.message);
        if (
          e.code === 'messaging/registration-token-not-registered' ||
          e.code === 'messaging/invalid-registration-token'
        ) {
          deleteDeviceToken(tokens[i], () => {});
        }
      }
    });
    res.status(200).json({ success: true, sent });
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
    ids.forEach(id => notificationsStore.delete(id));
    const placeholders = ids.map(() => '?').join(',');
    db.serialize(() => {
      db.run(`DELETE FROM notifications      WHERE user_id IN (${placeholders})`, ids);
      db.run(`DELETE FROM reset_codes        WHERE user_id IN (${placeholders})`, ids);
      db.run(`DELETE FROM push_subscriptions WHERE user_id IN (${placeholders})`, ids);
      db.run(`DELETE FROM device_tokens      WHERE user_id IN (${placeholders})`, ids);
      db.run(`DELETE FROM browser_sessions   WHERE user_id IN (${placeholders})`, ids);
      db.run(`DELETE FROM users              WHERE user_id IN (${placeholders})`, ids, (delErr) => {
        if (!delErr) console.log(`Pruned ${ids.length} inactive user(s) (last active before ${cutoff})`);
      });
    });
  });
  // Also prune browser sessions older than 30 days (regardless of user activity)
  db.run(`DELETE FROM browser_sessions WHERE last_active < ?`, [cutoff], function(err) {
    if (!err && this.changes > 0) console.log(`Pruned ${this.changes} stale browser session(s)`);
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