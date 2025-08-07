require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const P = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const {
  ensureDir,
  getUserPaths,
  writeJSON,
  readJSON,
  getUserBasePath
} = require("./lib/utils");

const {
  autoScanAndCategorise,
  handleBroadcastMessage
} = require("./lib/broadcast");

const { cleanupOldMedia } = require("./cleanup");

const PORT = process.env.PORT || 10000;
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const USERS = {};

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
    console.warn(`[server] Error ending session: ${err.message}`);
  }

  delete USERS[username];
}

function bindEventListeners(sock, username) {
  sock.ev.on("messages.upsert", async ({ messages }) => {
    USERS[username].lastActive = Date.now();
    for (const msg of messages) {
      try {
        await handleBroadcastMessage(username, msg, USERS);
      } catch (err) {
        console.error(`[${username}] Message error:`, err);
      }
    }
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (!USERS[username]) USERS[username] = {};
    if (qr) {
      USERS[username].qr = qr;
      console.log(`[${username}] 🔄 QR code generated`);
    }

    if (connection === "close") {
      const code =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.statusCode ||
        "unknown";

      const shouldReconnect = code !== DisconnectReason.loggedOut;
      USERS[username].connected = false;

      console.warn(`[${username}] Connection closed (code: ${code})`);
      if (shouldReconnect) setTimeout(() => startUserSession(username), 3000);
    }

    if (connection === "open") {
      console.log(`[${username}] ✅ Connected to WhatsApp`);
      USERS[username].connected = true;
      USERS[username].lastActive = Date.now();
      USERS[username].qr = null;

      await autoScanAndCategorise(sock, username, USERS);

      setTimeout(async () => {
        try {
          await sock.sendMessage(sock.user.id, {
            text: "✅ WhatsApp connected.\nSend an image to begin.\n/help for commands."
          });
        } catch (err) {
          console.warn(`[${username}] Welcome message failed:`, err.message);
        }
      }, 2000);
    }
  });

  console.log(`[${username}] ✅ Event listeners bound`);
}

async function startUserSession(username) {
  // Only allow 1 active session at a time
  for (const other of Object.keys(USERS)) {
    if (other !== username) endUserSession(other);
  }

  USERS[username] = {
    sock: null,
    qr: null,
    categories: {},
    allGroups: {},
    pendingImage: null,
    lastPromptChat: null,
    ended: false,
    connected: false,
    restarting: false,
    lastActive: Date.now()
  };

  const paths = getUserPaths(username);
  ensureDir(paths.base);

  const logger = P({ level: "silent" });
  const { state, saveCreds } = await useMultiFileAuthState(paths.auth);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: ["Ubuntu", "Chrome", "20.04"]
  });

  USERS[username].sock = sock;

  sock.ev.on("creds.update", saveCreds);
  bindEventListeners(sock, username);

  return USERS[username];
}

// EXPRESS SETUP
const app = express();
app.use(express.json());

const allowedOrigins = [
  "https://whats-broadcast-hub.lovable.app",
  "https://preview--whats-broadcast-hub.lovable.app"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ✅ ADMIN ROUTE GUARD
app.use("/admin", (req, res, next) => {
  const token = req.headers["authorization"];
  if (token !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ROUTES
app.use("/quick-actions", require("./routes/quick-actions")(USERS));
app.use("/get-categories", require("./routes/get-categories")(USERS));
app.use("/set-categories", require("./routes/set-categories")(USERS));
app.use("/admin", require("./routes/admin")(USERS, startUserSession, endUserSession));

// ✅ Create user session
app.post("/create-user", async (req, res) => {
  try {
    let { username } = req.body || {};
    if (!username) {
      username = generateUsername();
      console.log(`[server] Generated new user: ${username}`);
    }
    await startUserSession(username);
    res.json({ ok: true, username });
  } catch (err) {
    console.error("/create-user failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Return QR code for client
app.get("/get-qr/:username", (req, res) => {
  const { username } = req.params;
  const u = USERS[username];

  if (!u) return res.status(404).json({ error: "User not found" });
  if (!u.qr) return res.status(202).json({ message: "QR not ready yet" });

  return res.status(200).json({ qr: u.qr });
});

// ✅ Connection status
app.get("/connection-status/:username", (req, res) => {
  const { username } = req.params;
  const user = USERS[username];
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json({ connected: !!user.connected });
});

// ✅ Health check
app.get("/health", (_, res) => res.send("OK"));

// ✅ Rehydrate users on startup
const userDirs = fs.readdirSync(path.join(__dirname, "users"));
for (const username of userDirs) {
  const paths = getUserPaths(username);
  const categories = readJSON(paths.categories);
  const allGroups = readJSON(paths.groups);

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

  console.log(`[INIT] Rehydrated ${username}`);
}

// 🧹 Media cleanup every 6 hours
setInterval(() => {
  console.log("🧹 Starting media cleanup...");
  cleanupOldMedia();
}, 6 * 60 * 60 * 1000);

cleanupOldMedia(); // Run once on startup

// 🕒 Auto-end sessions after inactivity
setInterval(() => {
  const now = Date.now();

  for (const username in USERS) {
    const user = USERS[username];

    if (
      user.connected &&
      !user.ended &&
      now - user.lastActive > SESSION_TIMEOUT_MS
    ) {
      console.log(`[TIMEOUT] Ending session for ${username} due to inactivity.`);

      try {
        if (user.sock) {
          user.sock.sendMessage(user.sock.user.id, {
            text: `🕒 Session ended after 15 minutes of inactivity.\nReconnect by scanning a new QR.`
          });
        }
      } catch (err) {
        console.warn(`[${username}] Failed to send timeout message:`, err.message);
      }

      endUserSession(username);
    }
  }
}, 60 * 1000); // check every minute

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Bot server running on port ${PORT}`);
});
