// routes/get-categories.js
const express = require("express");
const fs = require("fs-extra");
const { readJSON, getUserPaths } = require("../lib/utils");

module.exports = (USERS) => {
  const router = express.Router();

  // GET /get-categories/:username
  router.get("/:username", async (req, res) => {
    const { username } = req.params;
    if (!username) return res.status(400).json({ error: "Missing username" });

    try {
      const u = USERS[username];
      const paths = getUserPaths(username);

      // Use the REAL flag your runtime sets
      const online = !!u?.socketActive;

      const categories = online
        ? (u?.categories || {})
        : await fs.readJson(paths.categories).catch(() => ({}));

      const allGroups = online
        ? (u?.allGroups || {})
        : await fs.readJson(paths.groups).catch(() => ({}));

      // Multi-category mapping for each group
      const groups = Object.entries(allGroups).map(([jid, g]) => {
        const name = g.name || g.subject || jid;
        const inCategories = Object.keys(categories || {}).filter(
          (cat) => (categories[cat] || []).includes(jid)
        );
        return { name, jid, categories: inCategories }; // array, not single
      });

      return res.json({
        categories: Object.keys(categories || {}),
        groups,                      // [{ name, jid, categories: [...] }]
        mapping: categories || {},   // keep the canonical mapping too
      });
    } catch (err) {
      console.error(`[${req.params.username}] Error in get-categories:`, err.message);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
