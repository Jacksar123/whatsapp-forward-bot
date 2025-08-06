const fs = require("fs").promises;
const path = require("path");
const express = require("express");

module.exports = (USERS) => {
  const router = express.Router();

  // GET /get-categories/:username
  router.get("/:username", async (req, res) => {
    const { username } = req.params;

    if (!username) return res.status(400).json({ error: "Missing username" });

    let user = USERS[username];
    let categories = {};
    let allGroups = {};

    try {
      if (user && user.sock && user.connected) {
        categories = user.categories || {};
        allGroups = user.allGroups || {};
      } else {
        // Load from disk if user not connected
        const basePath = path.join(__dirname, `../users/${username}`);
        const catPath = path.join(basePath, "categories.json");
        const groupsPath = path.join(basePath, "all_groups.json");

        try {
          const catData = await fs.readFile(catPath, "utf-8");
          categories = JSON.parse(catData);
        } catch (_) {}

        try {
          const groupsData = await fs.readFile(groupsPath, "utf-8");
          allGroups = JSON.parse(groupsData);
        } catch (_) {}
      }

      const categoryNames = Object.keys(categories);
      const groups = [];

      for (const [jid, group] of Object.entries(allGroups)) {
        const foundCat = categoryNames.find((cat) =>
          (categories[cat] || []).includes(jid)
        );
        groups.push({
          name: group.name || group.subject || jid,
          category: foundCat || null,
        });
      }

      return res.json({ categories: categoryNames, groups });
    } catch (err) {
      console.error(`[${username}] Error in get-categories:`, err.message);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
