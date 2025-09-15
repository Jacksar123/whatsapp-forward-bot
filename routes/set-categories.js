// routes/set-categories.js
const express = require("express");
const { readJSON, writeJSON, getUserPaths } = require("../lib/utils");
const { saveUserState } = require("../lib/state");

const router = express.Router();

function normalizeListToJids(list, allGroups) {
  if (!Array.isArray(list)) return [];
  const byExactName = new Map(
    Object.values(allGroups || {}).map(g => [ (g.name || g.subject || g.id || "").trim(), g.id ])
  );
  const norm = s => (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const byNormName = new Map(
    Object.values(allGroups || {}).map(g => [ norm(g.name || g.subject || g.id || ""), g.id ])
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
  return Array.from(new Set(out)).filter(j => typeof j === "string" && j.endsWith("@g.us"));
}

module.exports = (USERS) => {
  router.post("/:username", async (req, res) => {
    const { username } = req.params;
    if (!username) return res.status(400).json({ error: "Missing username" });

    const incoming = req.body?.categories;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return res.status(400).json({ error: "Invalid 'categories' payload. Expected object." });
    }

    const u = USERS[username];
    const paths = getUserPaths(username);
    const allGroups = (u?.allGroups && Object.keys(u.allGroups).length)
      ? u.allGroups
      : readJSON(paths.groups, {});

    // Normalize every category list to JIDs
    const normalized = {};
    for (const [cat, list] of Object.entries(incoming)) {
      normalized[cat] = normalizeListToJids(list || [], allGroups);
    }

    // Update memory/disk/cloud
    if (u) u.categories = normalized;
    try {
      writeJSON(paths.categories, normalized);
      if (allGroups && Object.keys(allGroups).length) writeJSON(paths.groups, allGroups);
      console.log(`[${username}] ✅ categories.json overwritten (normalized to JIDs)`);
    } catch (err) {
      console.error(`[${username}] ❌ Failed to write categories.json:`, err.message);
      return res.status(500).json({ error: "Failed to save categories to disk" });
    }

    try { saveUserState(username, normalized, allGroups || {}); } catch (err) {
      console.warn(`[${username}] ⚠️ saveUserState threw synchronously: ${err.message}`);
    }

    return res.json({ ok: true, categories: normalized });
  });

  return router;
};
