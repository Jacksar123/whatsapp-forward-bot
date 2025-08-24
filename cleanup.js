// cleanup.js
const fs = require("fs-extra");
const path = require("path");

// Use persistent disk if provided (Render -> DATA_DIR=/var/data/whats-broadcast-hub)
const MEDIA_ROOT = process.env.DATA_DIR || path.join(__dirname, "users");
const MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

async function deleteOldFiles(dir) {
  if (!(await fs.pathExists(dir))) return;
  const files = await fs.readdir(dir);
  const now = Date.now();

  for (const file of files) {
    const fullPath = path.join(dir, file);
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

async function cleanupOldMedia() {
  try {
    if (!(await fs.pathExists(MEDIA_ROOT))) return;

    const users = await fs.readdir(MEDIA_ROOT);

    for (const user of users) {
      const receivedPath = path.join(MEDIA_ROOT, user, "received_media");
      const tmpPath = path.join(MEDIA_ROOT, user, "tmp"); // ✅ also purge tmp
      await deleteOldFiles(receivedPath);
      await deleteOldFiles(tmpPath);
    }
  } catch (err) {
    console.error(`cleanupOldMedia failed:`, err.message);
  }
}

module.exports = { cleanupOldMedia };
