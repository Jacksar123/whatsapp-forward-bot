cp cleanup.js cleanup.backup.$(date +%s).js

cat > cleanup.js <<'EOF'
const fs = require("fs-extra");
const path = require("path");

const MEDIA_DIR = process.env.DATA_DIR || path.join(__dirname, "users");
const MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

async function cleanupOldMedia() {
  const users = await fs.pathExists(MEDIA_DIR) ? await fs.readdir(MEDIA_DIR) : [];
  for (const user of users) {
    const mediaPath = path.join(MEDIA_DIR, user, "received_media");
    if (!(await fs.pathExists(mediaPath))) continue;

    const files = await fs.readdir(mediaPath);
    const now = Date.now();

    for (const file of files) {
      const fullPath = path.join(mediaPath, file);
      try {
        const stats = await fs.stat(fullPath);
        const age = now - stats.mtimeMs;

        if (age > MAX_FILE_AGE_MS) {
          await fs.remove(fullPath);
          console.log(`🗑️ Deleted: ${fullPath}`);
        }
      } catch (err) {
        console.warn(`⚠️ Error reading or deleting ${fullPath}:`, err.message);
      }
    }
  }
}

module.exports = { cleanupOldMedia };
EOF
