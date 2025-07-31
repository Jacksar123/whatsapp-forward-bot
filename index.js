require('dotenv').config(); // Load .env variables

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
    for (const msg of messages) {
      try {
        await handleBroadcastMessage(username, msg, USERS);
      } catch (err) {
        console.error(`[${username}] Error handling msg:`, err);
      }
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) USERS[username].qr = qr;

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.warn(`[${username}] Connection closed (code: ${code}). Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(() => startUserSession(username), 3000);
    } else if (connection === 'open') {
      console.log(`[${username}] WhatsApp connected.`);
      await autoScanAndCategorise(sock, username, USERS);
      sock.sendMessage(sock.user.id, {
        text: '✅ WhatsApp connected.\nSend an image to begin.\n/help for commands.'
      });
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

  USERS[username] = {
    sock,
    qr: null,
    categories: {},
    allGroups: {},
    pendingImage: null,
    lastPromptChat: null,
    ended: false,
    restarting: false
  };

  sock.ev.on('creds.update', saveCreds);
  bindEventListeners(sock, username);

  return USERS[username];
}

// EXPRESS SETUP
const app = express();
app.use(express.json());

// ✅ FIXED CORS
app.use(cors({
  origin: 'https://whats-broadcast-hub.lovable.app',
  methods: ['GET', 'POST'],
  credentials: true
}));

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
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ qr: u.qr });
});

// HEALTH CHECK
app.get('/health', (_, res) => res.send('OK'));

// LAUNCH
app.listen(PORT, () => {
  console.log(`✅ Bot server running on port ${PORT}`);
});
