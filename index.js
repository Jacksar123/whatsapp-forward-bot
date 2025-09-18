// index.js
require("dotenv").config();
const fs = require("fs-extra");
const path = require("path");
const express = require("express");
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
  handleBroadcastMessage,
  cleanCategories // <-- import clean
} = require("./lib/broadcast");

const { handleIncomingImage } = require("./lib/media"); // <-- import image capture
const { cleanupOldMedia } = require("./cleanup");
const { loadUserState, saveUserState, notifyFrontend, getFrontendStatus } = require("./lib/state");

/* ---------------------------- global guards ----------------------------- */
process.on("uncaughtException", (err) => {
  const msg = String(err?.message || "");
  if (/Connection Closed|SOCKET_NOT_OPEN|stream closed/i.test(msg)) {
    console.warn("[guard] swallowed uncaughtException:", msg);
    return;
  }
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  const msg = String((reason && reason.message) || reason || "");
  if (/Connection Closed|SOCKET_NOT_OPEN|stream closed/i.test(msg)) {
    console.warn("[guard] swallowed unhandledRejection:", msg);
    return;
  }
  console.error("[unhandledRejection]", reason);
});

/* -------------------------------- config -------------------------------- */

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const HOST = "0.0.0.0";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30min idle
const DASHBOARD_URL = "https://whats-broadcast-hub.lovable.app";

// QR / reconnect tuning
const QR_DEBOUNCE_MS = 15_000;
const MAX_QR_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

/* --------------------------- global in-memory ---------------------------- */

const USERS = global.USERS || (global.USERS = {});

/* ------------------------------- helpers -------------------------------- */

function logMem() {
  const m = process.memoryUsage();
  const rss = (m.rss / 1048576).toFixed(1);
  const heap = (m.heapUsed / 1048576).toFixed(1);
  console.log(`[mem] rss=${rss}MB heapUsed=${heap}MB`);
}

function generateUsername() {
  return `user_${Math.random().toString(16).slice(2, 10)}`;
}

function mirrorToDisk(username) {
  const u = USERS[username];
  if (!u) return;
  try {
    const paths = getUserPaths(username);
    writeJSON(paths.categories, u.categories || {});
    writeJSON(paths.groups, u.allGroups || {});
    console.log(`[persist] Disk mirror saved for ${username}`);
  } catch (e) {
    console.warn(`[persist] Disk mirror failed for ${username}: ${e.message}`);
  }
}

async function persistUserState(username) {
  const u = USERS[username];
  if (!u) return;
  try {
    await saveUserState(username, u.categories || {}, u.allGroups || {});
  } catch (e) {
    console.warn(`[persist] Supabase save failed for ${username}: ${e.message}`);
  }
  mirrorToDisk(username);
}

async function wipeAuth(username) {
  try {
    const p = getUserPaths(username);
    await fs.remove(p.auth);
    console.log(`[${username}] 🔥 Auth folder wiped`);
  } catch (e) {
    console.warn(`[${username}] auth wipe failed: ${e.message}`);
  }
}

async function endSession(u = {}) {
  try {
    if (u.sock?.ev?.removeAllListeners) {
      try { u.sock.ev.removeAllListeners(); } catch {}
    }
    try { u.sock?.ws?.removeAllListeners?.("error"); } catch {}
    try { u.sock?.ws?.removeAllListeners?.("close"); } catch {}
    try { u.sock?.ws?.close?.(); } catch {}
    try { u.sock?.end?.(); } catch {}
  } catch {}
  u.sock = null;
  u.socketActive = false;
  u.connecting = false;
  u.readyForHeavyTasks = false;
}

/* ------------------------------ event binder ---------------------------- */

function bareJid(j) {
  const s = String(j || "");
  return s.replace(/:[^@]+(?=@)/, "");
}

function bindEventListeners(sock, username) {
  const u = USERS[username];

  // creds persistence
  sock.ev.on("creds.update", async () => {
    try { await u.saveCredsFn?.(); } catch (e) {
      console.warn(`[${username}] creds.update save failed: ${e.message}`);
    }
  });

  // connection lifecycle
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const now = Date.now();

    // ---- QR cooldown + debounce ----
    if (qr) {
      const COOLDOWN_MS = 30 * 60 * 1000; // 30m
      if (u.qrPausedUntil && now < u.qrPausedUntil) {
        // cooling down, skip
      } else {
        if (!u.lastQrAt || now - u.lastQrAt >= QR_DEBOUNCE_MS) {
          u.lastQrAt = now;
          u.lastQR = qr;
          u.qrTs = now;
          u.qrAttempts = (u.qrAttempts || 0) + 1;
          notifyFrontend(username, { qrAvailable: true });
          console.log(`[${username}] 🔄 QR generated (attempt ${u.qrAttempts})`);

          if (u.qrAttempts >= MAX_QR_ATTEMPTS) {
            u.qrPausedUntil = now + COOLDOWN_MS;
            u.lastQR = null;
            notifyFrontend(username, { qrAvailable: false });
            console.warn(
              `[${username}] ⚠️ Too many QR attempts. Paused ${COOLDOWN_MS / 60000}m`
            );
            try {
              await sock.sendMessage(u.ownerJid || sock.user.id, {
                text: `⚠️ Too many QR attempts. Paused 30 minutes. Try later.`
              });
            } catch {}
          }
        }
      }
    }

    if (connection === "open") {
      u.socketActive = true;
      u.connecting = false;
      u.ended = false;
      u.lastOpenAt = Date.now();
      u.lastActive = Date.now();

      const selfId = sock?.user?.id || "";
      u.selfJid = selfId;
      console.log(`[${username}] BOT JID: ${selfId}`);
      u.ownerJid = bareJid(selfId);

      u.lastQR = null;
      u.qrAttempts = 0;
      u.qrPausedUntil = 0;
      u.reconnectDelay = RECONNECT_BASE_MS;
      notifyFrontend(username, { connected: true, needsRelink: false, qrAvailable: false });

      if (!u.greeted) {
        u.greeted = true;
        const greeting =
          `✅ Connected!\n\nCommands:\n` +
          `• /text — switch to text mode\n` +
          `• /media — switch to image mode\n` +
          `• /cats — pick a category to send to\n` +
          `• /rescan — refresh groups\n\n` +
          `Now send a message or image to broadcast.`;
        try { await sock.sendMessage(u.ownerJid, { text: greeting }); } catch {}
      }

      setTimeout(async () => {
        try {
          u.readyForHeavyTasks = true;
          await autoScanAndCategorise(username, sock);
          // NEW: clean categories after a fresh scan to fix stale JIDs
          try {
            const res = cleanCategories(username);
            console.log(
              `[${username}] cleanCategories: kept=${res.kept} fixed=${res.fixed} dropped=${res.dropped}`
            );
          } catch (e) {
            console.warn(`[${username}] cleanCategories failed: ${e?.message || e}`);
          }
          await persistUserState(username);
        } catch (e) {
          console.error(`[${username}] autoScan error`, e);
        }
      }, 15_000);
    }

    if (connection === "close") {
      await persistUserState(username);

      const code =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.statusCode ??
        lastDisconnect?.output?.statusCode ??
        lastDisconnect?.reason;

      const message = lastDisconnect?.error?.message || "n/a";
      console.warn(`[${username}] Connection closed: code=${code} message=${message}`);

      if (String(message).toLowerCase().includes("bad-mac")) {
        console.error(`[${username}] ❌ Bad MAC → wiping auth & relogin`);
        await endSession(u);
        await wipeAuth(username);
        setTimeout(() => startUserSession(username).catch(() => {}), 3000);
        return;
      }

      await endSession(u);
      u.qrAttempts = 0;
      u.qrPausedUntil = 0;

      switch (code) {
        case 408:
          notifyFrontend(username, { connected: false });
          setTimeout(() => startUserSession(username).catch(() => {}), 2000);
          break;
        case DisconnectReason.connectionReplaced:
        case 440:
        case DisconnectReason.loggedOut:
          notifyFrontend(username, { connected: false, needsRelink: true });
          break;
        case DisconnectReason.restartRequired:
        case DisconnectReason.timedOut:
        default:
          notifyFrontend(username, { connected: false });
          u.reconnectDelay = Math.min(
            Math.max(u.reconnectDelay || RECONNECT_BASE_MS, RECONNECT_BASE_MS) * 2,
            RECONNECT_MAX_MS
          );
          setTimeout(
            () => startUserSession(username).catch(() => {}),
            5000 + Math.random() * 10000
          );
      }
    }
  });

  // inbound messages
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      u.lastActive = Date.now();
      for (const msg of messages || []) {
        const jid = msg?.key?.remoteJid || "";
        const fromMe = !!msg?.key?.fromMe;
        const kinds = Object.keys(msg?.message || {}).join("|") || "none";
        console.log(
          `[${username}] rx: chat=${jid} self=${bareJid(jid)===bareJid(USERS[username]?.ownerJid)} fromMe=${fromMe} kinds=${kinds}`
        );

        // (optional) learn owner from first DM if not set
        if (!USERS[username].ownerJid && jid.endsWith('@s.whatsapp.net')) {
          USERS[username].ownerJid = jid;
          console.log(`[${username}] learned ownerJid = ${USERS[username].ownerJid}`);
        }

        // If owner sends an image and we're in media mode, capture it to memory
        const isOwnerChat = !!USERS[username]?.ownerJid && String(jid) === String(USERS[username].ownerJid);
        const hasImage = !!msg?.message?.imageMessage;
        if (isOwnerChat && hasImage && (USERS[username].mode === 'media' || !USERS[username].mode)) {
          try {
            const captionText = msg.message.imageMessage.caption || '';
            await handleIncomingImage({ sock, USERS, username, msg, captionText });
            await sock.safeSend(jid, { text: '🖼️ Image saved. Use /cats to choose where to send.' }).catch(()=>{});
          } catch (e) {
            console.warn(`[${username}] failed to capture image: ${e?.message || e}`);
          }
        }

        await handleBroadcastMessage(username, msg, sock);
      }
    } catch (e) {
      console.error(`[${username}] messages.upsert error`, e);
    }
  });

  console.log(`[${username}] ✅ Event listeners bound`);
}

/* ------------------------------ start session --------------------------- */

async function startUserSession(username) {
  const existing = USERS[username] || (USERS[username] = {});
  if (existing.socketActive || existing.connecting) return;
  existing.connecting = true;

  const paths = getUserPaths(username);
  await ensureDir(paths.base);
  await ensureDir(paths.auth);
  await ensureDir(paths.data);
  await ensureDir(paths.media);

  let persisted = {};
  try { persisted = await loadUserState(username); } catch {}
  const savedCategories = persisted.categories || readJSON(paths.categories, {});
  const savedGroups = persisted.groups || readJSON(paths.groups, {});

  Object.assign(USERS[username], {
    categories: savedCategories,
    allGroups: savedGroups,
    pendingImage: null,
    pendingText: null,
    lastPromptChat: null,
    mode: existing.mode || "media",
    ended: false,
    socketActive: false,
    lastOpenAt: 0,
    lastActive: Date.now(),
    lastQR: null, qrTs: 0,
    lastQrAt: 0, qrAttempts: 0, qrPausedUntil: 0,
    reconnectDelay: RECONNECT_BASE_MS,
    readyForHeavyTasks: false,
    selfJid: null,
    ownerJid: existing.ownerJid || null
  });

  const logger = P({ level: "silent" });
  const { state, saveCreds } = await useMultiFileAuthState(paths.auth);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: ["WhatsBroadcaster", "Chrome", "118"],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.safeSend = async (jid, content, opts = {}) => {
    const u = USERS[username];
    if (!u?.socketActive) throw new Error("SOCKET_NOT_OPEN");
    try {
      return await sock.sendMessage(jid, content, opts);
    } catch (err) {
      if (/Connection Closed|SOCKET_NOT_OPEN/i.test(err?.message)) return;
      throw err;
    }
  };

  USERS[username].sock = sock;
  USERS[username].saveCredsFn = saveCreds;

  bindEventListeners(sock, username);

  USERS[username].connecting = false;
  console.log(`[INIT] session started for ${username}`);
}

/* -------------------------------- express -------------------------------- */

const app = express();
app.use(express.json({ limit: "5mb" }));

// ----- CORS (env override supported) -----
const DEFAULT_ALLOWED = [
  "https://whats-broadcast-hub.lovable.app",
  "https://preview--whats-broadcast-hub.lovable.app",
  "https://forwardly.online" // add your custom domain here
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED.join(","))
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// routes
app.use("/quick-actions", require("./routes/quick-actions")(USERS));
app.use("/get-categories", require("./routes/get-categories")(USERS));
app.use("/set-categories", require("./routes/set-categories")(USERS));
app.use("/admin", require("./routes/admin")(USERS, startUserSession, async (username) => {
  const u = USERS[username];
  if (!u) return;
  await persistUserState(username);
  await endSession(u);
  delete USERS[username];
}));

// ✅ NEW: live group list (ground-truth JIDs)
app.use("/admin/list-groups", require("./routes/list-groups")(USERS));

// create user
app.post("/create-user", async (req, res) => {
  try {
    let { username } = req.body || {};
    if (!username) {
      username = generateUsername();
      console.log(`[server] Generated new user: ${username}`);
    }
    await startUserSession(username);
    res.json({ ok: true, username });
  } catch (e) {
    console.error("/create-user failed:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// status endpoints
app.get("/status/:username", async (req, res) => {
  const username = req.params.username;
  const u = USERS[username] || {};
  const status = await getFrontendStatus(username);
  res.json({
    ok: true,
    connected: !!u.socketActive,
    connecting: !!u.connecting,
    needsRelink: !!status.needsRelink,
    qrAvailable: !!status.qrAvailable,
    ownerJid: u.ownerJid || null,
    ts: Date.now()
  });
});

app.get("/connection-status/:username", async (req, res) => {
  const u = USERS[req.params.username];
  if (!u) return res.status(404).json({ error: "User not found" });
  const status = await getFrontendStatus(req.params.username);
  res.json({
    connected: !!u.socketActive,
    needsReconnect: !!status.needsRelink
  });
});

app.get("/qr-status/:username", (req, res) => {
  const u = USERS[req.params.username];
  if (!u) return res.status(404).json({ error: "User not found" });
  const now = Date.now();
  res.json({
    qrReady: !!u.lastQR,
    qrAttempts: u.qrAttempts || 0,
    pausedUntil: u.qrPausedUntil || 0,
    pausedForMs: u.qrPausedUntil && u.qrPausedUntil > now ? (u.qrPausedUntil - now) : 0
  });
});

app.post("/reset-qr/:username", (req, res) => {
  const u = USERS[req.params.username];
  if (!u) return res.status(404).json({ error: "User not found" });
  u.lastQR = null;
  u.qrAttempts = 0;
  u.qrPausedUntil = 0;
  notifyFrontend(req.params.username, { qrAvailable: false });
  res.json({ ok: true });
});

app.get("/get-qr/:username", (req, res) => {
  const u = USERS[req.params.username];
  if (!u) return res.status(404).json({ error: "User not found" });
  if (!u.lastQR) {
    return res.json({ ok: false, error: "QR not available yet", retry: true });
  }
  res.json({ ok: true, qr: u.lastQR, ts: u.qrTs || Date.now() });
});

app.get("/debug/state/:username", async (req, res) => {
  try {
    const data = await loadUserState(req.params.username);
    res.json({ username: req.params.username, ...data });
  } catch (e) {
    res.status(500).json({ error: "failed" });
  }
});

app.get("/health", (_req, res) => res.send("OK"));

/* ---------------------------- boot rehydrate ---------------------------- */

const usersDirPath = path.join(__dirname, "users");
if (fs.existsSync(usersDirPath)) {
  const userDirs = fs.readdirSync(usersDirPath);
  for (const username of userDirs) {
    const paths = getUserPaths(username);
    const categories = readJSON(paths.categories, {});
    const allGroups = readJSON(paths.groups, {});
    USERS[username] = {
      sock: null,
      socketActive: false,
      connecting: false,
      ended: true,
      lastOpenAt: 0,
      lastActive: Date.now(),
      categories,
      allGroups,
      pendingImage: null,
      pendingText: null,
      lastPromptChat: null,
      mode: "media",
      lastQR: null, qrTs: 0,
      lastQrAt: 0, qrAttempts: 0, qrPausedUntil: 0,
      reconnectDelay: RECONNECT_BASE_MS,
      readyForHeavyTasks: false,
      selfJid: null,
      ownerJid: null
    };
    console.log(`[INIT] Rehydrated ${username}`);
  }
}

/* ------------------------ background maintenance ------------------------ */

setInterval(() => {
  try { cleanupOldMedia(); } catch (e) { console.error("[cleanup] error", e); }
}, 6 * 60 * 60 * 1000);
cleanupOldMedia();

setInterval(() => {
  const now = Date.now();
  for (const [username, u] of Object.entries(USERS)) {
    if (!u.socketActive && !u.connecting) continue;
    const last = u.lastActive || 0;
    if (last && now - last > SESSION_TIMEOUT_MS) {
      console.log(`[${username}] idle timeout — ending session & wiping auth`);
      (async () => {
        try {
          if (u.ownerJid) {
            await u.sock?.safeSend?.(u.ownerJid, {
              text: `🕒 Session paused due to inactivity.\nReopen dashboard to resume:\n${DASHBOARD_URL}`
            }).catch(() => {});
          }
        } catch {}
        await persistUserState(username);
        await endSession(u);
        await wipeAuth(username);
        notifyFrontend(username, { connected: false, needsRelink: true, qrAvailable: false });
      })();
    }
  }
}, 60_000);

setInterval(logMem, 120_000);

/* --------------------------------- start -------------------------------- */

console.log("[broadcast] build=warm406+r2 DIAG/targets/membership"); // banner
app.listen(PORT, HOST, () => {
  console.log(`🚀 server running http://${HOST}:${PORT}`);
  const BOOT_USER = process.env.BOOT_USER;
  if (BOOT_USER) {
    console.log(`[INIT] Booting user ${BOOT_USER}`);
    startUserSession(BOOT_USER).catch((e) => console.error("[boot] error", e));
  }
});
