// routes/quick-actions.js
const express = require("express");
const fs = require("fs-extra");
const {
  readJSON,
  writeJSON,
  getUserPaths
} = require("../lib/utils");
const { saveUserState } = require("../lib/state");

module.exports = (USERS) => {
  const router = express.Router();

  /* ----------------------- helpers ----------------------- */

  /**
   * Normalize an incoming list of names/JIDs/objects to JIDs using the user's group map.
   * Accepts: ["Group Name", "1203...@g.us", { id: "1203...@g.us" }]
   * Returns: Array<"1203...@g.us"> (unique, valid only)
   */
  function normalizeListToJids(list, allGroups) {
    if (!Array.isArray(list)) return [];

    const norm = (s) =>
      (s || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    // Build fast lookup maps
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

      // Already a JID string
      if (typeof entry === "string" && entry.endsWith("@g.us")) {
        out.push(entry);
        continue;
      }
      // Object with id
      if (entry && typeof entry === "object" && entry.id && entry.id.endsWith("@g.us")) {
        out.push(entry.id);
        continue;
      }
      // Name → JID (exact first, then normalized)
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        const exact = byExactName.get(trimmed);
        if (exact) { out.push(exact); continue; }
        const maybe = byNormName.get(norm(trimmed));
        if (maybe) { out.push(maybe); continue; }
      }
    }

    // De-dupe + keep only valid JIDs
    return Array.from(new Set(out)).filter((j) => typeof j === "string" && j.endsWith("@g.us"));
  }

  /**
   * Load in-memory or disk state for a user.
   */
  async function loadUserMaps(username) {
    const u = USERS[username];
    const paths = getUserPaths(username);

    let categories = {};
    let allGroups = {};

    if (u?.socketActive) {
      categories = u.categories || {};
      allGroups = u.allGroups || {};
    } else {
      categories = await fs.readJson(paths.categories).catch(() => ({}));
      allGroups = await fs.readJson(paths.groups).catch(() => ({}));
    }
    return { categories, allGroups, paths, u };
  }

  /* ---------------------- GET: groups ---------------------- */
  // ✅ GET /quick-actions/groups?username=user_xyz
  router.get("/groups", async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "Missing username" });

    try {
      const { categories, allGroups } = await loadUserMaps(username);

      const categoryNames = Object.keys(categories || {});
      const groups = Object.entries(allGroups || {}).map(([jid, g]) => {
        const name = g.name || g.subject || jid;
        const foundCat = categoryNames.find((cat) => (categories[cat] || []).includes(jid)) || null;
        // expose announce/botIsAdmin if available (harmless if absent)
        const announce = !!g.announce;
        const botIsAdmin = !!g.botIsAdmin;
        return { name, jid, category: foundCat, announce, botIsAdmin };
      });

      // Backward-compatible: also provide just the names (UI can ignore)
      const groupNames = groups.map((x) => x.name);

      res.json({ groups, groupNames, categories });
    } catch (err) {
      console.error(`[${username}] Error in /quick-actions/groups:`, err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /* --------------------- POST: update-groups --------------------- */
  // ✅ POST /quick-actions/update-groups
  // body: { username, category, groups: Array<string|{id:string}> }
  router.post("/update-groups", async (req, res) => {
    const { username, category, groups } = req.body || {};

    if (!username || !category || !Array.isArray(groups)) {
      return res.status(400).json({ error: "Missing or invalid parameters" });
    }

    try {
      const { categories, allGroups, paths, u } = await loadUserMaps(username);

      // normalize to JIDs to avoid category poisoning
      const normalized = normalizeListToJids(groups, allGroups);

      // if nothing resolved, don't wipe the category by accident
      if (!normalized.length) {
        return res.status(400).json({ error: "None of the provided groups matched known JIDs" });
      }

      // Save into category (overwrite category contents with normalized unique JIDs)
      categories[category] = Array.from(new Set(normalized));

      // Persist to disk
      writeJSON(paths.categories, categories);
      // Keep group mirror fresh too (in case allGroups was only in memory)
      if (allGroups && Object.keys(allGroups).length) {
        writeJSON(paths.groups, allGroups);
      }

      // Mirror to memory
      if (u) {
        u.categories = categories;
        u.allGroups = allGroups;
      }

      // Persist to Supabase (authoritative, debounced)
      try { saveUserState(username, categories, allGroups || {}); } catch {}

      return res.status(200).json({ success: true, updated: categories[category] });
    } catch (err) {
      console.error(`[${username}] Error in /quick-actions/update-groups:`, err.message);
      return res.status(500).json({ error: "Failed to update groups" });
    }
  });

  return router;
};
