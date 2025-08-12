const express = require("express");
const fs = require("fs-extra");
const { readJSON, getUserPaths } = require("../lib/utils");

module.exports = (USERS) => {
  const router = express.Router();

  // ✅ GET /get-categories/:username
  router.get("/:username", async (req, res) => {
    const { username } = req.params;
    if (!username) return res.status(400).json({ error: "Missing username" });

    let categories = {};
    let allGroups = {};

    try {
      const user = USERS[username];
      const paths = getUserPaths(username);

      if (user?.connected) {
        categories = user.categories || {};
        allGroups = user.allGroups || {};
      } else {
        categories = await fs.readJson(paths.categories).catch(() => ({}));
        allGroups = await fs.readJson(paths.groups).catch(() => ({}));
      }

      const categoryNames = Object.keys(categories);
      const groups = Object.entries(allGroups).map(([jid, group]) => {
        const name = group.name || group.subject || jid;
        const foundCat = categoryNames.find(cat =>
          (categories[cat] || []).includes(jid)
        );
        return { name, category: foundCat || null };
      });

      return res.json({ categories: categoryNames, groups });
    } catch (err) {
      console.error(`[${username}] Error in get-categories:`, err.message);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
