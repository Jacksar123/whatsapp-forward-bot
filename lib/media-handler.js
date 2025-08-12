cp "media handler.js" "media handler.backup.$(date +%s).js" 2>/dev/null || true
cp lib/"media handler.js" lib/"media handler.backup.$(date +%s).js" 2>/dev/null || true

cat > "media handler.js" <<'EOF'
const fs = require("fs-extra");
const path = require("path");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { getUserPaths, ensureDir } = require("./lib/utils");

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
    const paths = getUserPaths(userId);
    const mediaDir = paths.media;
    const mediaPath = path.join(mediaDir, `image_${timestamp}.jpg`);

    ensureDir(mediaDir);
    fs.writeFileSync(mediaPath, buffer);

    console.log(`✅ [${userId}] Media saved: ${mediaPath}`);
  });
}

module.exports = { listenForMedia };
EOF
