require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const P = require('pino');
const cors = require('cors');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const {
  autoScanAndCategorise,
  handleBroadcastMessage
} = require('./lib/broadcast');

const { cleanupOldMedia } = require("./cleanup");

const PORT = process.env.PORT || 10000;
const USERS = {};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function userBase(username) {
  return path.join(__dirname, 'users', username);
}

function generateUsername() {
  return `user_${Math.random().toString(16).slice(2, 10)}`;
}

function endUserSession(username) {
  const u = USERS[username];
  if (!u || !u.sock || u.ended) return;

  console.log(`[server] Ending session: ${username}`);
  u.ended = true;

  try {
    if (u.sock?.ws?._socket?.readable) {
      u.sock.end();
    }
  } catch (err) {
    console.warn(`[server] Error while ending session for ${username}:`, err.message);
  }

  delete USERS[username];
}

function bindEventListeners(sock, username) {
  sock.ev.on('messages.upsert', async ({ messages }) => {
    USERS[username].lastActive = Date.now();
    for (const msg of messages) {
      try {
        await handleBroadcastMessage(username, msg, USERS);
      } catch (err) {
        console.error(`[${username}] Error handling msg:`, err);
      }
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (!USERS[username]) USERS[username] = {};
    if (qr) {
      USERS[username].qr = qr;
      console.log(`[${username}] 🔄 New QR code generated`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode || 'unknown';
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.warn(`[${username}] Connection closed (code: ${code}). Reconnect: ${shouldReconnect}`);
      USERS[username].connected = false;
      if (shouldReconnect) setTimeout(() => startUserSession(username), 3000);
    } else if (connection === 'open') {
      console.log(`[${username}] ✅ WhatsApp connected.`);
      USERS[username].connected = true;
      USERS[username].lastActive = Date.now();
      USERS[username].qr = null; // Clear QR after successful connection

      await autoScanAndCategorise(sock, username, USERS);

      setTimeout(async () => {
        try {
          await sock.sendMessage(sock.user.id, {
            text: '✅ WhatsApp connected.\nSend an image to begin.\n/help for commands.'
          });
        } catch (err) {
          console.warn(`[${username}] Failed to send welcome message:`, err.message);
        }
      }, 2000);
    }
  });

  console.log(`[${username}] ✅ Bound event listeners.`);
}

async function startUserSession(username) {
  for (const existing in USERS) {
    if (existing !== username) {
      endUserSession(existing);
    }
  }

  // ✅ Register user early to avoid QR 404 issues
  USERS[username] = {
    sock: null,
    qr: null,
    categories: {},
    allGroups: {},
    pendingImage: null,
    lastPromptChat: null,
    ended: false,
    restarting: false,
    connected: false,
    lastActive: Date.now()
  };

  const base = userBase(username);
  ensureDir(base);
  const logger = P({ level: 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(path.join(base, 'auth_info'));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: ['Chrome (Linux)', 'Chrome', '127.0.0.1']
  });

  USERS[username].sock = sock;

  sock.ev.on('creds.update', saveCreds);
  bindEventListeners(sock, username);

  return USERS[username];
}

// EXPRESS SETUP
const app = express();
app.use(express.json());

// ✅ CORS for frontend preview and prod
const allowedOrigins = [
  "https://whats-broadcast-hub.lovable.app",
  "https://preview--whats-broadcast-hub.lovable.app"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ✅ Modular Routes
app.use('/quick-actions', require('./routes/quick-actions')(USERS));
app.use('/get-categories', require('./routes/get-categories')(USERS));
app.use('/set-categories', require('./routes/set-categories')(USERS));

// ROUTES
app.post('/create-user', async (req, res) => {
  try {
    let { username } = req.body || {};
    if (!username) {
      username = generateUsername();
      console.log(`[server] new user: ${username}`);
    }
    await startUserSession(username);
    res.json({ ok: true, username });
  } catch (err) {
    console.error('/create-user failed', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/get-qr/:username', (req, res) => {
  const { username } = req.params;
  const u = USERS[username];

  if (!u) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!u.qr) {
    return res.status(202).json({ message: 'QR not ready yet' });
  }

  return res.status(200).json({ qr: u.qr });
});

// HEALTH CHECK
app.get('/health', (_, res) => res.send('OK'));

// ✅ Rehydrate USERS from disk on startup
const userDirs = fs.readdirSync(path.join(__dirname, 'users'));
for (const username of userDirs) {
  const base = path.join(__dirname, 'users', username);
  const categoriesPath = path.join(base, 'categories.json');
  const groupsPath = path.join(base, 'all_groups.json');

  const categories = fs.existsSync(categoriesPath)
    ? JSON.parse(fs.readFileSync(categoriesPath))
    : {};
  const allGroups = fs.existsSync(groupsPath)
    ? JSON.parse(fs.readFileSync(groupsPath))
    : {};

  USERS[username] = {
    sock: null,
    qr: null,
    categories,
    allGroups,
    pendingImage: null,
    lastPromptChat: null,
    connected: false,
    ended: true,
    restarting: false,
    lastActive: Date.now()
  };

  console.log(`[INIT] Rehydrated ${username} from disk`);
}

// 🧹 Schedule media cleanup every 6 hours
setInterval(() => {
  console.log("🧹 Starting media cleanup...");
  cleanupOldMedia();
}, 6 * 60 * 60 * 1000);

cleanupOldMedia(); // Run once on startup

// LAUNCH
app.listen(PORT, () => {
  console.log(`✅ Bot server running on port ${PORT}`);
});
