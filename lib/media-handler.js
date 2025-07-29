const fs = require("fs-extra");
const path = require("path");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");

function listenForMedia(sock, userId) {
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || msg.key.fromMe) return;

    const mediaType = Object.keys(msg.message).find((k) =>
      ["imageMessage"].includes(k)
    );
    if (!mediaType) return;

    console.log(`📥 [${userId}] Received media from ${msg.key.remoteJid}`);

    const buffer = await downloadMediaMessage(msg, "buffer", {}, {
      logger: console,
      reuploadRequest: sock.updateMediaMessage
    });

    const timestamp = Date.now();
    const mediaDir = path.join("users", userId, "received_media");
    const mediaPath = path.join(mediaDir, `image_${timestamp}.jpg`);

    fs.ensureDirSync(mediaDir);
    fs.writeFileSync(mediaPath, buffer);

    console.log(`✅ [${userId}] Media saved: ${mediaPath}`);
  });
}

module.exports = { listenForMedia };
