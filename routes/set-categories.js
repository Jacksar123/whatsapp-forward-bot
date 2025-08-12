const express = require("express");
const { writeJSON, getUserPaths } = require("../lib/utils");

const router = express.Router();

module.exports = (USERS) => {
  router.post("/:username", async (req, res) => {
    const { username } = req.params;
    if (!username) return res.status(400).json({ error: "Missing username" });

    const user = USERS[username];
    const incoming = req.body.categories || {}; // e.g. { "Tech": ["Group A", "Group B"] }

    const paths = getUserPaths(username);

    // ✅ Save to memory (if online)
    if (user) user.categories = incoming;

    // ✅ Persist to disk
    try {
      writeJSON(paths.categories, incoming);
      console.log(`[${username}] ✅ categories.json overwritten`);
    } catch (err) {
      console.error(`[${username}] ❌ Failed to write categories.json:`, err.message);
      return res.status(500).json({ error: "Failed to save categories" });
    }

    // ✅ Optional: send WhatsApp summary
    if (user?.sock) {
      try {
        const summaryLines = Object.entries(incoming).map(([cat, list]) => {
          const groupLines = list.length ? list.map((g) => `- ${g}`).join("\n") : "_no groups_";
          return `📦 *${cat}*:\n${groupLines}`;
        });

        const summary = `✅ Categories updated:\n\n${summaryLines.join("\n\n")}`;

        await user.sock.sendMessage(user.sock.user.id, { text: summary });
      } catch (err) {
        console.warn(`[${username}] ⚠️ Failed to send summary:`, err.message);
      }
    }

    return res.json({ ok: true });
  });

  return router;
};
