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
  await stopSession(userId, { deleteAuth: true }); // Kill old session if exists
  fs.ensureDirSync(userDir(userId));
  fs.ensureDirSync(userFile(userId, "auth"));

  const { state, saveCreds } = await useMultiFileAuthState(userFile(userId, "auth"));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state });
  const qrPath = userFile(userId, "qr.png");
  const expiresAt = Date.now() + ttlMs;

  const info = { sock, qrPath, status: "pending_qr", expiresAt, timer: null };
  sessions.set(userId, info);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr && info.status === "pending_qr") {
      await QRCode.toFile(qrPath, qr);
      console.log(`✅ [${userId}] QR saved to ${qrPath}`);
    }

    if (connection === "open") {
      info.status = "active";
      clearTimeout(info.timer);
      console.log(`✅ [${userId}] Connected`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0] || "Unknown";
      console.log(`❌ [${userId}] Disconnected: ${reason} (${code})`);

      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (!shouldReconnect) {
        await stopSession(userId, { deleteAuth: true });
      } else {
        console.log(`🔁 [${userId}] Reconnecting...`);
        await startFreshSession(userId, { ttlMs });
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Set timeout to auto-kill expired QR sessions
  info.timer = setTimeout(async () => {
    if (info.status === "pending_qr") {
      console.log(`⌛ [${userId}] QR expired, killing session`);
      await stopSession(userId, { deleteAuth: true });
    }
  }, ttlMs);

  return { qrPath, expiresAt };
}

async function stopSession(userId, { deleteAuth = false } = {}) {
  const info = sessions.get(userId);
  if (!info) return;
  try {
    info.sock.end();
  } catch (_) {}
  clearTimeout(info.timer);
  sessions.delete(userId);
  if (deleteAuth) fs.removeSync(userFile(userId, "auth"));
  console.log(`🛑 [${userId}] Session stopped${deleteAuth ? " & auth deleted" : ""}`);
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
