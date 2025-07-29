// session-manager.js
const fs = require("fs-extra");
const path = require("path");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const sessions = new Map(); // userId => { sock, qrPath, timer, status, expiresAt }

function userDir(userId) {
  return path.join(__dirname, "users", userId);
}

function userFile(userId, f) {
  return path.join(userDir(userId), f);
}

async function startFreshSession(userId, { ttlMs = 5 * 60 * 1000 } = {}) {
  console.log(`\n🟡 [${userId}] Starting new session`);
  await stopSession(userId, { deleteAuth: true });
  fs.ensureDirSync(userDir(userId));
  fs.ensureDirSync(userFile(userId, "auth"));

  const { state, saveCreds } = await useMultiFileAuthState(userFile(userId, "auth"));
  const { version } = await fetchLatestBaileysVersion();

  console.log(`🟢 [${userId}] Using Baileys version: ${version.join(".")}`);
  const sock = makeWASocket({ version, auth: state });
  const qrPath = userFile(userId, "qr.png");
  const expiresAt = Date.now() + ttlMs;

  const info = { sock, qrPath, status: "pending_qr", expiresAt, timer: null };
  sessions.set(userId, info);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    console.log(`📶 [${userId}] connection.update: ${connection}`);

    if (qr && info.status === "pending_qr") {
      await QRCode.toFile(qrPath, qr);
      console.log(`✅ [${userId}] QR code saved: ${qrPath}`);
    }

    if (connection === "open") {
      info.status = "active";
      clearTimeout(info.timer);
      console.log(`✅ [${userId}] WhatsApp linked successfully.`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0] || "Unknown";
      console.log(`❌ [${userId}] Disconnected - Reason: ${reason} (Code ${code})`);

      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (!shouldReconnect) {
        console.log(`🧹 [${userId}] Session ended. Cleaning up.`);
        await stopSession(userId, { deleteAuth: true });
      } else {
        console.log(`🔁 [${userId}] Reconnecting socket...`);
        await startFreshSession(userId, { ttlMs });
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Auto-expire QR
  info.timer = setTimeout(async () => {
    if (info.status === "pending_qr") {
      console.log(`⌛ [${userId}] QR expired. Session terminated.`);
      await stopSession(userId, { deleteAuth: true });
    }
  }, ttlMs);

  console.log(`📆 [${userId}] QR valid until: ${new Date(expiresAt).toLocaleTimeString()}`);
  return { qrPath, expiresAt };
}

async function stopSession(userId, { deleteAuth = false } = {}) {
  const info = sessions.get(userId);
  if (!info) return;

  try {
    info.sock.end();
  } catch (e) {
    console.log(`⚠️ [${userId}] Error closing socket:`, e.message);
  }

  clearTimeout(info.timer);
  sessions.delete(userId);

  if (deleteAuth) {
    fs.removeSync(userFile(userId, "auth"));
    console.log(`🗑️ [${userId}] Auth files deleted`);
  }

  console.log(`🛑 [${userId}] Session fully stopped`);
}

function getSessionStatus(userId) {
  const info = sessions.get(userId);
  if (!info) return { status: "none" };
  return {
    status: info.status,
    qrExists: fs.existsSync(info.qrPath),
    expiresAt: info.expiresAt
  };
}

module.exports = {
  startFreshSession,
  stopSession,
  getSessionStatus
};
