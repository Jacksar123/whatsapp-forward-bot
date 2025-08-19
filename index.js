// index.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
// const cors = require("cors"); // not used (you set headers manually)
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
  readJSON
} = require("./lib/utils");

const {
  autoScanAndCategorise,
  handleBroadcastMessage
} = require("./lib/broadcast");

const { cleanupOldMedia } = require("./cleanup");
const { loadUserState, saveUserState } = require("./lib/state");

/* ----------------------------- config ----------------------------------- */

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DASHBOARD_URL = "https://whats-broadcast-hub.lovable.app";
const USERS = {};

// QR / reconnect tuning
const QR_DEBOUNCE_MS = 15_000;   // ignore QR updates within 15s
const MAX_QR_ATTEMPTS = 6;       // stop after 6 unscanned QRs
const QR_PAUSE_MS = 2 * 60_000;  // pause 2 minutes if attempts exceeded
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

/* ----------------------------- helpers ---------------------------------- */

function generateUsername() {
  return `user_${Math.random().toString(16).slice(2, 10)}`;
}

function persistUserState(username) {
  const u = USERS[username];
  if (!u) return;
  try {
    saveUserState(username, u.categories || {}, u.allGroups || {}); // Supabase (authoritative)
  } catch (err) {
    console.warn(`[persist] Supabase save failed for ${username}: ${err.message}`);
  }
  try {
    const paths = getUserPaths(username); // Disk mirror (backup)
    writeJSON(paths.categories, u.categories || {});
    writeJSON(paths.groups, u.allGroups || {});
    console.log(`[persist] Saved categories & groups for ${username}`);
  } catch (err) {
    console.warn(`[persist] Disk mirror failed for ${username}: ${err.message}`);
  }
}

function endUserSession(username) {
  const u = USERS[username];
  if (!u || u.ended) return;

  // persist before ending
  persistUserState(username);
  console.log(`[server] Ending session: ${username}`);
  u.ended = true;

  try {
    if (u.categoryTimeout) {
      clearTimeout(u.categoryTimeout);
      u.categoryTimeout = null;
    }

    if (u.sock?.ev?.removeAllListeners) {
      try { u.sock.ev.removeAllListeners("messages.upsert"); } catch {}
      try { u.sock.ev.removeAllListeners("connection.update"); } catch {}
      try { u.sock.ev.removeAllListeners("creds.update"); } catch {}
    }

    if (u.sock?.ws?.close) {
      u.sock.ws.close();
    }
  } catch (err) {
    console.warn(`[server] Error ending session: ${err.message}`);
  }

  delete USERS[username];
}

function bindEventListeners(sock, username) {
  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!USERS[username]) return; // guard if ended mid-flight
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
    const u = USERS[username] || (USERS[username] = {});
    const now = Date.now();

    // QR handling: debounce + attempt limits + pause window
    if (qr) {
      if (!(u.qrPausedUntil && now < u.qrPausedUntil)) {
        if (!u.lastQrAt || now - u.lastQrAt >= QR_DEBOUNCE_MS) {
          u.lastQrAt = now;
          u.qr = qr;
          u.qrAttempts = (u.qrAttempts || 0) + 1;
          console.log(`[${username}] 🔄 QR code generated (attempt ${u.qrAttempts})`);
          if (u.qrAttempts > MAX_QR_ATTEMPTS) {
            console.warn(
              `[${username}] QR attempts exceeded. Pausing QR regen for ${(QR_PAUSE_MS / 1000) | 0}s`
            );
            u.qr = null;
            u.qrPausedUntil = now + QR_PAUSE_MS;
          }
        }
      }
    }

    if (connection === "close") {
      // persist on close
      persistUserState(username);

      const code =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.statusCode ||
        lastDisconnect?.error?.reason ||
        0;

      // mark socket closed so no sends occur
      USERS[username].IS_OPEN = false;

      u.connected = false;
      u.needsReconnect = true;

      const isLoggedOut =
        code === DisconnectReason.loggedOut ||
        code === DisconnectReason.connectionReplaced ||
        // some builds surface 440 “Connection Closed” for permanent closes
        (code === 440 && /Connection Closed/i.test(lastDisconnect?.error?.message || ""));

      if (isLoggedOut) {
        USERS[username].SHOULD_RUN = false; // permanent stop
        console.warn(`[${username}] Connection closed (code: ${code}). Not reconnecting.`);
        // reset QR counters so frontend can fetch a fresh QR
        u.qr = null; u.qrAttempts = 0; u.qrPausedUntil = 0; u.reconnectDelay = RECONNECT_BASE_MS;
        return;
      }

      // otherwise backoff + reconnect (timedOut, restartRequired, etc.)
      u.reconnectDelay = Math.min(
        Math.max(u.reconnectDelay || RECONNECT_BASE_MS, RECONNECT_BASE_MS) * 2,
        RECONNECT_MAX_MS
      );

      console.warn(
        `[${username}] Connection closed (code: ${code}). Reconnect in ${u.reconnectDelay}ms`
      );
      setTimeout(() => startUserSession(username).catch(() => {}), u.reconnectDelay);
    }

    if (connection === "open") {
      console.log(`[${username}] ✅ Connected to WhatsApp`);
      u.connected = true;
      u.needsReconnect = false;
      u.lastActive = Date.now();
      u.qr = null;
      u.qrAttempts = 0;
      u.qrPausedUntil = 0;
      u.reconnectDelay = RECONNECT_BASE_MS;

      // mark socket healthy
      USERS[username].IS_OPEN = true;
      USERS[username].SHOULD_RUN = true;

      // default mode for new/rehydrated sessions if absent
      if (!u.mode) u.mode = 'media';

      // (Re)scan & categorise to pick up new groups; then persist
      await autoScanAndCategorise(sock, username, USERS);
      persistUserState(username);

      setTimeout(async () => {
        try {
          await sock.safeSend(sock.user.id, {
            text:
              `✅ WhatsApp connected.\n` +
              `Currently in *${u.mode}* mode.\n` +
              `Use /text to switch to text mode, /media to return.\n\n` +
              `Send an image (media mode) or a plain message (text mode) to begin.\n` +
              `/help for all commands.`
          });
        } catch (err) {
          console.warn(`[${username}] Welcome message failed: ${err.message}`);
        }
      }, 2000);
    }
  });

  sock.ev.on("creds.update", async () => {
    try {
      const u = USERS[username];
      if (u?.saveCredsFn) await u.saveCredsFn();
    } catch (e) {
      console.warn(`[${username}] creds.update save failed: ${e.message}`);
    }
  });

  console.log(`[${username}] ✅ Event listeners bound`);
}

async function startUserSession(username) {
  // Idempotent + simple concurrency guard
  const existing = USERS[username];
  if (existing?.sock && existing.connected && !existing.ended) {
    return existing;
  }
  if (existing?.restarting) return existing;
  USERS[username] = { ...(existing || {}), restarting: true };

  const paths = getUserPaths(username);
  ensureDir(paths.base);

  // --- Supabase-first rehydrate (with disk fallback) ---
  let persisted = {};
  try {
    persisted = await loadUserState(username);
  } catch (e) {
    console.warn(`[rehydrate] Supabase load failed for ${username}: ${e.message}`);
  }
  const savedCategories = (persisted && persisted.categories) || readJSON(paths.categories, {});
  const savedGroups = (persisted && persisted.groups) || readJSON(paths.groups, {});

  USERS[username] = {
    ...(USERS[username] || {}),
    sock: null,
    qr: null,
    categories: savedCategories,    // { [category]: [groupJids...] }
    allGroups: savedGroups,         // { [jid]: { id, name } }
    pendingImage: null,             // legacy fields kept for safety
    pendingText: null,
    lastPromptChat: null,
    ended: false,
    connected: false,
    restarting: true,
    lastActive: Date.now(),
    lastQrAt: 0,
    qrAttempts: 0,
    qrPausedUntil: 0,
    reconnectDelay: RECONNECT_BASE_MS,
    categoryTimeout: null,
    needsReconnect: false,
    mode: (existing && existing.mode) || 'media',
    IS_OPEN: false,
    SHOULD_RUN: true
  };

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
    browser: ["Ubuntu", "Chrome", "20.04"],
    printQRInTerminal: false
  });

  // ---- health flags per user ----
  USERS[username].IS_OPEN = false;
  USERS[username].SHOULD_RUN = true;

  // ---- safe send wrapper: never send if closed; swallow mid-flight closes ----
  sock.safeSend = async (jid, content, opts = {}) => {
    const U = USERS[username];
    if (!U?.IS_OPEN || !U?.SHOULD_RUN) throw new Error('SOCKET_NOT_OPEN');
    try {
      return await sock.sendMessage(jid, content, opts);
    } catch (err) {
      if (/Connection Closed|SOCKET_NOT_OPEN/i.test(err?.message)) return;
      throw err;
    }
  };

  USERS[username].sock = sock;
  USERS[username].saveCredsFn = saveCreds;

  sock.ev.on("creds.update", saveCreds);
  bindEventListeners(sock, username);

  USERS[username].restarting = false;
  return USERS[username];
}

/* ----------------------------- express ---------------------------------- */

const app = express();
app.use(express.json());

// You already set CORS headers manually below
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

// ADMIN ROUTE GUARD
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

// Create user session
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

// Return QR code for client (with pause status)
app.get("/get-qr/:username", (req, res) => {
  const { username } = req.params;
  const u = USERS[username];

  if (!u) return res.status(404).json({ error: "User not found" });

  const now = Date.now();
  if (u.qrPausedUntil && now < u.qrPausedUntil) {
    return res.status(429).json({
      message: "QR temporarily paused",
      pausedUntil: u.qrPausedUntil,
      retryAfterMs: u.qrPausedUntil - now
    });
  }
  if (!u.qr) return res.status(202).json({ message: "QR not ready yet" });

  return res.status(200).json({ qr: u.qr });
});

// Connection status
app.get("/connection-status/:username", (req, res) => {
  const { username } = req.params;
  const user = USERS[username];
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json({ connected: !!user.connected, needsReconnect: !!user.needsReconnect });
});

// QR status for UI
app.get("/qr-status/:username", (req, res) => {
  const u = USERS[req.params.username];
  if (!u) return res.status(404).json({ error: "User not found" });
  const now = Date.now();
  res.json({
    qrReady: !!u.qr,
    qrAttempts: u.qrAttempts || 0,
    pausedUntil: u.qrPausedUntil || 0,
    pausedForMs: u.qrPausedUntil && u.qrPausedUntil > now ? (u.qrPausedUntil - now) : 0
  });
});

// Allow frontend to reset QR pause / attempts
app.post("/reset-qr/:username", (req, res) => {
  const u = USERS[req.params.username];
  if (!u) return res.status(404).json({ error: "User not found" });
  u.qr = null;
  u.qrAttempts = 0;
  u.qrPausedUntil = 0;
  return res.json({ ok: true });
});

// Optional: debug persisted state quickly
app.get("/debug/state/:username", async (req, res) => {
  try {
    const data = await loadUserState(req.params.username);
    return res.json({ username: req.params.username, ...data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "failed" });
  }
});

// Health check
app.get("/health", (_, res) => res.send("OK"));

/* --------------------------- boot rehydrate ------------------------------ */
/**
 * File-based boot rehydrate kept as a safety net.
 * With Supabase in place, cloud is authoritative,
 * but this preserves prior on-disk sessions if present.
 */
const usersDirPath = path.join(__dirname, "users");
if (fs.existsSync(usersDirPath)) {
  const userDirs = fs.readdirSync(usersDirPath);
  for (const username of userDirs) {
    const paths = getUserPaths(username);
    const categories = readJSON(paths.categories, {});
    const allGroups = readJSON(paths.groups, {});

    USERS[username] = {
      sock: null,
      qr: null,
      categories,
      allGroups,
      pendingImage: null,
      pendingText: null,
      lastPromptChat: null,
      connected: false,
      ended: true,
      restarting: false,
      lastActive: Date.now(),
      lastQrAt: 0,
      qrAttempts: 0,
      qrPausedUntil: 0,
      reconnectDelay: RECONNECT_BASE_MS,
      categoryTimeout: null,
      needsReconnect: false,
      mode: 'media',
      IS_OPEN: false,
      SHOULD_RUN: true
    };

    console.log(`[INIT] Rehydrated ${username}`);
  }
}

/* ---------------------- background maintenance --------------------------- */

// Media cleanup every 6 hours (harmless now that media is in-memory)
setInterval(() => {
  console.log("🧹 Starting media cleanup...");
  cleanupOldMedia();
}, 6 * 60 * 60 * 1000);

cleanupOldMedia(); // once on startup

// --- Auto-end sessions after 30 minutes of inactivity ---
setInterval(() => {
  const now = Date.now();

  for (const username in USERS) {
    const u = USERS[username];
    if (!u || u.ended || !u.connected) continue;

    const idle = now - (u.lastActive || 0);
    if (idle <= SESSION_TIMEOUT_MS) continue;

    console.log(`[TIMEOUT] Ending session for ${username} after ${Math.round(idle/60000)} min idle`);

    // Best-effort notification before closing the socket
    try {
      if (u.sock?.user?.id) {
        u.sock.safeSend(u.sock.user.id, {
          text:
            `🕒 Session paused due to 30 minutes of inactivity.\n` +
            `Please reconnect on your dashboard:\n${DASHBOARD_URL}\n\n` +
            `If a QR is shown, scan it to resume.`
        }).catch(() => {});
      }
    } catch {}

    // Stop any pending category selection timers
    if (u.categoryTimeout) {
      clearTimeout(u.categoryTimeout);
      u.categoryTimeout = null;
    }

    // Mark so UI can show "needs reconnect"
    u.needsReconnect = true;

    // Persist state then end the session (closes WS, removes listeners)
    persistUserState(username);
    endUserSession(username);
  }
}, 60 * 1000);

// Low-overhead memory monitor
setInterval(() => {
  const m = process.memoryUsage();
  const rss = (m.rss / 1048576).toFixed(1);
  const heap = (m.heapUsed / 1048576).toFixed(1);
  console.log(`[mem] rss=${rss}MB heapUsed=${heap}MB`);
}, 120_000);

/* -------------------------------- start ---------------------------------- */

const appPort = PORT;
const host = "0.0.0.0";
app.listen(appPort, host, () => {
  console.log(`🚀 Bot server running on port ${appPort}`);
});
