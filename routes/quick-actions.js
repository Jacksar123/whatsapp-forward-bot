const fs = require("fs").promises;
const path = require("path");
const express = require("express");

module.exports = (USERS) => {
  const router = express.Router();

  // ✅ GET /quick-actions/groups?username=user_xyz
  router.get("/groups", async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "Missing username" });

    const userPath = path.join(__dirname, `../users/${username}`);
    const groupsPath = path.join(userPath, "all_groups.json");
    const categoriesPath = path.join(userPath, "categories.json");

    try {
      let allGroups = {};
      let categories = {};

      // Try loading from memory first
      const user = USERS[username];
      if (user && user.sock && user.connected) {
        allGroups = user.allGroups || {};
        categories = user.categories || {};
      } else {
        // If not connected, load from disk
        try {
          const groupsData = await fs.readFile(groupsPath, "utf-8");
          allGroups = JSON.parse(groupsData);
        } catch (_) {}

        try {
          const catData = await fs.readFile(categoriesPath, "utf-8");
          categories = JSON.parse(catData);
        } catch (_) {}
      }

      const groupNames = Object.values(allGroups)
        .map((g) => g.name || g.subject)
        .filter(Boolean);

      res.json({ groups: groupNames, categories });
    } catch (err) {
      console.error(`[${username}] Error in /quick-actions/groups:`, err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ✅ POST /quick-actions/update-groups
  router.post("/update-groups", async (req, res) => {
    const { username, category, groups } = req.body;

    if (!username || !category || !Array.isArray(groups)) {
      return res.status(400).json({ error: "Missing or invalid parameters" });
    }

    const filePath = path.join(__dirname, `../users/${username}/categories.json`);

    try {
      let groupData = {};

      try {
        const existing = await fs.readFile(filePath, "utf-8");
        groupData = JSON.parse(existing);
      } catch (_) {}

      if (!groupData[category]) groupData[category] = [];

      const unique = new Set([...groupData[category], ...groups]);
      groupData[category] = Array.from(unique);

      await fs.writeFile(filePath, JSON.stringify(groupData, null, 2));

      if (USERS[username]) {
        USERS[username].categories = groupData;
        console.log(`[${username}] Synced updated categories to memory.`);
      }

      return res.status(200).json({ success: true, updated: groupData[category] });
    } catch (err) {
      console.error(`[${username}] Error updating groups:`, err.message);
      return res.status(500).json({ error: "Failed to update groups" });
    }
  });

  return router;
};
