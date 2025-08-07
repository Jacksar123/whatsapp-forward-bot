const express = require("express");
const fs = require("fs-extra");
const path = require("path");
const { readJSON, writeJSON, getUserPaths } = require("../lib/utils");

module.exports = (USERS) => {
  const router = express.Router();

  // ✅ GET /quick-actions/groups?username=user_xyz
  router.get("/groups", async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "Missing username" });

    const paths = getUserPaths(username);
    let allGroups = {};
    let categories = {};

    try {
      const user = USERS[username];

      if (user?.connected) {
        allGroups = user.allGroups || {};
        categories = user.categories || {};
      } else {
        allGroups = await fs.readJson(paths.groups).catch(() => ({}));
        categories = await fs.readJson(paths.categories).catch(() => ({}));
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

    const paths = getUserPaths(username);
    try {
      const groupData = readJSON(paths.categories);
      if (!groupData[category]) groupData[category] = [];

      const unique = new Set([...groupData[category], ...groups]);
      groupData[category] = Array.from(unique);

      writeJSON(paths.categories, groupData);

      if (USERS[username]) {
        USERS[username].categories = groupData;
        console.log(`[${username}] ✅ Updated in memory`);
      }

      return res.status(200).json({ success: true, updated: groupData[category] });
    } catch (err) {
      console.error(`[${username}] Error updating groups:`, err.message);
      return res.status(500).json({ error: "Failed to update groups" });
    }
  });

  return router;
};
