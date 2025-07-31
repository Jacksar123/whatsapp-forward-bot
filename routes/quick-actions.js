// routes/quick-actions.js
const fs = require("fs");
const path = require("path");
const express = require("express");
const router = express.Router();

// POST /quick-actions/update-groups
router.post("/update-groups", (req, res) => {
  const { username, category, groups } = req.body;

  if (!username || !category || !Array.isArray(groups)) {
    return res.status(400).json({ error: "Missing or invalid parameters" });
  }

  const filePath = path.join(__dirname, `../users/${username}/groupData.json`);
  let groupData = {};

  try {
    if (fs.existsSync(filePath)) {
      groupData = JSON.parse(fs.readFileSync(filePath));
    }

    if (!groupData[category]) {
      groupData[category] = [];
    }

    const uniqueGroups = new Set([...groupData[category], ...groups]);
    groupData[category] = Array.from(uniqueGroups);

    fs.writeFileSync(filePath, JSON.stringify(groupData, null, 2));
    return res.status(200).json({ success: true, updated: groupData[category] });

  } catch (err) {
    console.error("Error updating groups:", err);
    return res.status(500).json({ error: "Failed to update groups" });
  }
});

// GET /quick-actions/groups?username=user_xyz
router.get("/groups", (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: "Missing username" });

  const groupsPath = path.join(__dirname, `../users/${username}/all_groups.json`);
  const dataPath = path.join(__dirname, `../users/${username}/groupData.json`);

  try {
    if (!fs.existsSync(groupsPath)) return res.json({ groups: [], categories: {} });

    const allGroupsRaw = JSON.parse(fs.readFileSync(groupsPath));
    const groupNames = Object.values(allGroupsRaw)
      .map(g => g.name || g.subject)
      .filter(Boolean);

    let categories = {};
    if (fs.existsSync(dataPath)) {
      categories = JSON.parse(fs.readFileSync(dataPath));
    }

    res.json({
      groups: groupNames,
      categories // { "Shoes": [...], "Tech": [...] }
    });

  } catch (err) {
    console.error("Error reading group data:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
