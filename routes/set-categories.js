// routes/set-categories.js
const express = require("express");
const { readJSON, writeJSON, getUserPaths } = require("../lib/utils");
const { saveUserState } = require("../lib/state");

const router = express.Router();

/**
 * Normalize an incoming list of names/JIDs to JIDs using the user's group map.
 * - Accepts: ["Group Name", "12345@g.us", { id: "12345@g.us" }]
 * - Returns: ["12345@g.us", ...] (de-duped, valid only)
 */
function normalizeListToJids(list, allGroups) {
  if (!Array.isArray(list)) return [];

  // Build fast lookup maps
  const byExactName = new Map(
    Object.values(allGroups || {}).map(g => [
      (g.name || g.subject || g.id || "").trim(),
      g.id
    ])
  );

  const norm = s => (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const byNormName = new Map(
    Object.values(allGroups || {}).map(g => [
      norm(g.name || g.subject || g.id || ""),
      g.id
    ])
  );

  const out = [];

  for (const entry of list) {
    if (!entry) continue;

    // JID string already
    if (typeof entry === "string" && entry.endsWith("@g.us")) {
      out.push(entry);
      continue;
    }

    // Object with id
    if (entry && typeof entry === "object" && entry.id && entry.id.endsWith("@g.us")) {
      out.push(entry.id);
      continue;
    }

    // Name → JID (exact first)
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      const exact = byExactName.get(trimmed);
      if (exact) { out.push(exact); continue; }

      // Fallback: normalized unique match
      const maybe = byNormName.get(norm(trimmed));
      if (maybe) { out.push(maybe); continue; }
    }
  }

  // De‑dupe + keep only valid JIDs
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

    // Load group map (prefer in‑memory, fallback to disk)
    const user = USERS[username];
    const paths = getUserPaths(username);
    const allGroups = (user?.allGroups && Object.keys(user.allGroups).length)
      ? user.allGroups
      : readJSON(paths.groups, {});

    // Normalize each category list to JIDs
    const normalized = {};
    for (const [cat, list] of Object.entries(incoming)) {
      normalized[cat] = normalizeListToJids(list || [], allGroups);
    }

    // Update in‑memory (if online)
    if (user) {
      user.categories = normalized;
    }

    // Persist to disk (mirror / non‑authoritative)
    try {
      writeJSON(paths.categories, normalized);
      // Keep groups mirror fresh too (in case allGroups was in memory)
      if (allGroups && Object.keys(allGroups).length) {
        writeJSON(paths.groups, allGroups);
      }
      console.log(`[${username}] ✅ categories.json overwritten (normalized to JIDs)`);
    } catch (err) {
      console.error(`[${username}] ❌ Failed to write categories.json:`, err.message);
      return res.status(500).json({ error: "Failed to save categories to disk" });
    }

    // Persist to Supabase (authoritative, debounced)
    try {
      saveUserState(username, normalized, allGroups || {});
    } catch (err) {
      // Debounced saveUserState already logs; keep going
      console.warn(`[${username}] ⚠️ saveUserState threw synchronously: ${err.message}`);
    }

    // Optional: WhatsApp summary DM to self
    if (user?.sock) {
      try {
        const toName = (jid) => allGroups?.[jid]?.name || jid;
        const summaryLines = Object.entries(normalized).map(([cat, jids]) => {
          const groupLines = (jids.length ? jids.map(j => `- ${toName(j)}`).join("\n") : "_no groups_");
          return `📦 *${cat}*:\n${groupLines}`;
        });
        const summary = `✅ Categories updated (saved to cloud):\n\n${summaryLines.join("\n\n")}`;
        await user.sock.sendMessage(user.sock.user.id, { text: summary });
      } catch (err) {
        console.warn(`[${username}] ⚠️ Failed to send summary DM:`, err.message);
      }
    }

    return res.json({ ok: true, categories: normalized });
  });

  return router;
};
