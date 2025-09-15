// routes/quick-actions.js
const express = require("express");
const fs = require("fs-extra");
const { readJSON, writeJSON, getUserPaths } = require("../lib/utils");
const { saveUserState } = require("../lib/state");

module.exports = (USERS) => {
  const router = express.Router();

  /* ----------------------- helpers ----------------------- */

  // Normalize an incoming list of names/JIDs/objects to JIDs using the user's group map.
  function normalizeListToJids(list, allGroups) {
    if (!Array.isArray(list)) return [];

    const norm = (s) =>
      (s || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const byExactName = new Map(
      Object.values(allGroups || {}).map((g) => [
        (g.name || g.subject || g.id || "").trim(),
        g.id,
      ])
    );
    const byNormName = new Map(
      Object.values(allGroups || {}).map((g) => [
        norm(g.name || g.subject || g.id || ""),
        g.id,
      ])
    );

    const out = [];
    for (const entry of list) {
      if (!entry) continue;
      if (typeof entry === "string" && entry.endsWith("@g.us")) { out.push(entry); continue; }
      if (entry && typeof entry === "object" && entry.id && entry.id.endsWith("@g.us")) { out.push(entry.id); continue; }
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        const exact = byExactName.get(trimmed); if (exact) { out.push(exact); continue; }
        const maybe = byNormName.get(norm(trimmed)); if (maybe) { out.push(maybe); continue; }
      }
    }
    return Array.from(new Set(out)).filter((j) => typeof j === "string" && j.endsWith("@g.us"));
  }

  async function loadUserMaps(username) {
    const u = USERS[username];
    const paths = getUserPaths(username);

    const online = !!u?.socketActive;
    const categories = online ? (u.categories || {}) : await fs.readJson(paths.categories).catch(() => ({}));
    const allGroups  = online ? (u.allGroups  || {}) : await fs.readJson(paths.groups).catch(() => ({}));

    return { categories, allGroups, paths, u, online };
  }

  /* ---------------------- GET: groups ---------------------- */
  // GET /quick-actions/groups?username=user_xyz
  router.get("/groups", async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "Missing username" });

    try {
      const { categories, allGroups } = await loadUserMaps(username);

      // Multi-cat array per group (don’t collapse to one)
      const groups = Object.entries(allGroups || {}).map(([jid, g]) => {
        const name = g.name || g.subject || jid;
        const inCategories = Object.keys(categories || {}).filter(
          (cat) => (categories[cat] || []).includes(jid)
        );
        const announce  = !!g.announce;      // optional decoration if you store it
        const botIsAdmin = !!g.botIsAdmin;   // optional decoration if you store it
        return { name, jid, categories: inCategories, announce, botIsAdmin };
      });

      res.json({ groups, categories });
    } catch (err) {
      console.error(`[${username}] Error in /quick-actions/groups:`, err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /* --------------------- POST: update-groups --------------------- */
  // POST /quick-actions/update-groups
  // body: { username, category, groups: Array<string|{id:string}> }
  router.post("/update-groups", async (req, res) => {
    const { username, category, groups } = req.body || {};
    if (!username || !category || !Array.isArray(groups)) {
      return res.status(400).json({ error: "Missing or invalid parameters" });
    }

    try {
      const { categories, allGroups, paths, u } = await loadUserMaps(username);
      const normalized = normalizeListToJids(groups, allGroups);
      if (!normalized.length) {
        return res.status(400).json({ error: "None of the provided groups matched known JIDs" });
      }

      categories[category] = Array.from(new Set(normalized));

      // Persist everywhere
      writeJSON(paths.categories, categories);
      if (allGroups && Object.keys(allGroups).length) writeJSON(paths.groups, allGroups);
      if (u) { u.categories = categories; u.allGroups = allGroups; }
      try { saveUserState(username, categories, allGroups || {}); } catch {}

      return res.status(200).json({ success: true, updated: categories[category] });
    } catch (err) {
      console.error(`[${username}] Error in /quick-actions/update-groups:`, err.message);
      return res.status(500).json({ error: "Failed to update groups" });
    }
  });

  return router;
};
