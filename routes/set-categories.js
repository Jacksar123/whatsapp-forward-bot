const express = require("express");
const fs = require("fs").promises;
const path = require("path");

const router = express.Router();

module.exports = (USERS) => {
  router.post("/:username", async (req, res) => {
    const { username } = req.params;
    const user = USERS[username];

    if (!user && !username) {
      return res.status(404).json({ error: "User not found" });
    }

    const incoming = req.body.categories || {}; // { "Tech": ["Group A", "Group B"] }

    // ✅ Save to memory (if online)
    if (user) {
      user.categories = incoming;
    }

    // ✅ Persist to disk
    const filePath = path.join(__dirname, `../users/${username}/categories.json`);
    try {
      await fs.writeFile(filePath, JSON.stringify(incoming, null, 2));
      console.log(`[${username}] categories.json overwritten.`);
    } catch (err) {
      console.error(`[${username}] Failed to write categories.json:`, err.message);
      return res.status(500).json({ error: "Failed to save categories" });
    }

    // ✅ WhatsApp summary
    if (user && user.sock) {
      const summaryLines = [];

      for (const [cat, groupList] of Object.entries(incoming)) {
        const lines = groupList.length
          ? groupList.map((g) => `- ${g}`).join("\n")
          : "_no groups_";
        summaryLines.push(`📦 *${cat}*:\n${lines}`);
      }

      const summary = `✅ Categories updated:\n\n${summaryLines.join("\n\n")}`;

      try {
        await user.sock.sendMessage(user.sock.user.id, { text: summary });
      } catch (err) {
        console.warn(`[${username}] Failed to send summary:`, err.message);
      }
    }

    return res.json({ ok: true });
  });

  return router;
};
