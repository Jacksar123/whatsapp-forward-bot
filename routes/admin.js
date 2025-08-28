// routes/admin.js
const express = require("express");
const fs = require("fs-extra");
const path = require("path");
const { getUserPaths } = require("../lib/utils");

module.exports = (USERS, startUserSession, endUserSession) => {
  const router = express.Router();

  /* ------------------------------ inspect ------------------------------ */

  // ✅ GET /admin/users — in-memory sessions
  router.get("/users", (_req, res) => {
    const data = Object.entries(USERS).map(([username, user]) => ({
      username,
      connected: !!user.socketActive,      // correct flag
      connecting: !!user.connecting,
      ended: !!user.ended,
      lastActive: user.lastActive ? new Date(user.lastActive).toISOString() : null,
    }));
    return res.json({ users: data });
  });

  // ✅ GET /admin/users/disk — users detected on disk
  router.get("/users/disk", async (_req, res) => {
    try {
      const usersRoot = path.join(__dirname, "..", "users");
      if (!(await fs.pathExists(usersRoot))) return res.json({ users: [] });
      const diskUsers = await fs.readdir(usersRoot);
      const details = await Promise.all(
        diskUsers.map(async (u) => {
          const up = getUserPaths(u);
          const hasAuth = await fs.pathExists(up.auth);
          const hasCats = await fs.pathExists(up.categories);
          const hasGroups = await fs.pathExists(up.groups);
          return { username: u, hasAuth, hasCategories: hasCats, hasGroups };
        })
      );
      return res.json({ users: details });
    } catch (e) {
      console.error("[admin] users/disk failed:", e.message);
      return res.status(500).json({ error: "Failed to enumerate disk users" });
    }
  });

  /* ---------------------------- lifecycle ------------------------------ */

  // ✅ POST /admin/end/:username — graceful shutdown
  router.post("/end/:username", async (req, res) => {
    const { username } = req.params;
    if (!USERS[username]) return res.status(404).json({ error: "User not found" });
    try {
      await endUserSession(username);
      return res.json({ ok: true, message: `Ended session for ${username}` });
    } catch (e) {
      console.error(`[admin] end ${username} failed:`, e.message);
      return res.status(500).json({ error: "Failed to end session" });
    }
  });

  // ✅ POST /admin/restart/:username — boot (or reboot) a session
  router.post("/restart/:username", async (req, res) => {
    const { username } = req.params;
    try {
      await startUserSession(username);
      return res.json({ ok: true, message: `Restarted session for ${username}` });
    } catch (err) {
      console.error(`[admin] Restart failed for ${username}:`, err.message);
      return res.status(500).json({ error: "Failed to restart session" });
    }
  });

  /* ------------------------------- nukes -------------------------------- */

  // ✅ POST /admin/nuke-auth/:username — wipe login only
  router.post("/nuke-auth/:username", async (req, res) => {
    const { username } = req.params;
    try {
      if (USERS[username]) {
        try { await endUserSession(username); } catch (e) {
          console.warn(`[admin] endUserSession warning for ${username}: ${e.message}`);
        }
      }
      const p = getUserPaths(username);
      await fs.remove(p.auth); // users/<username>/auth_info
      delete USERS[username];
      return res.json({ ok: true, message: `Auth nuked for ${username}` });
    } catch (e) {
      console.error(`[admin] nuke-auth ${username} failed:`, e.message);
      return res.status(500).json({ error: "Failed to nuke auth" });
    }
  });

  // ✅ POST /admin/nuke-user/:username — remove the entire user folder
  router.post("/nuke-user/:username", async (req, res) => {
    const { username } = req.params;
    try {
      if (USERS[username]) {
        try { await endUserSession(username); } catch (e) {
          console.warn(`[admin] endUserSession warning for ${username}: ${e.message}`);
        }
        delete USERS[username];
      }
      const usersRoot = path.join(__dirname, "..", "users", username);
      if (await fs.pathExists(usersRoot)) {
        await fs.remove(usersRoot);
      }
      return res.json({ ok: true, message: `User data removed for ${username}` });
    } catch (e) {
      console.error(`[admin] nuke-user ${username} failed:`, e.message);
      return res.status(500).json({ error: "Failed to remove user folder" });
    }
  });

  // ✅ POST /admin/nuke-all-auth — wipe auth for *all* users
  router.post("/nuke-all-auth", async (_req, res) => {
    const nuked = new Set();
    try {
      // 1) End memory sessions
      const memUsers = Object.keys(USERS);
      for (const username of memUsers) {
        try { await endUserSession(username); } catch (e) {
          console.warn(`[admin] endUserSession warning for ${username}: ${e.message}`);
        }
      }

      // 2) Remove all auth_info folders on disk
      const usersRoot = path.join(__dirname, "..", "users");
      if (await fs.pathExists(usersRoot)) {
        const diskUsers = await fs.readdir(usersRoot);
        for (const username of diskUsers) {
          try {
            const authPath = path.join(usersRoot, username, "auth_info");
            if (await fs.pathExists(authPath)) {
              await fs.remove(authPath);
              nuked.add(username);
              console.log(`[admin] nuked auth (disk) for ${username}`);
            }
          } catch (e) {
            console.warn(`[admin] nuke-all (disk) failed for ${username}: ${e.message}`);
          }
        }
      }

      // 3) Clear in-memory map
      for (const u of Object.keys(USERS)) delete USERS[u];

      return res.json({
        ok: true,
        message: `Auth nuked for ${nuked.size} user(s)`,
        users: Array.from(nuked),
      });
    } catch (e) {
      console.error(`[admin] nuke-all failed:`, e.message);
      return res.status(500).json({ error: "Failed to nuke all auth" });
    }
  });

  /* --------------------------- broadcast ctrl --------------------------- */

  // ✅ POST /admin/cancel/:username — request cancel for a running broadcast
  router.post("/cancel/:username", (req, res) => {
    const { username } = req.params;
    const u = USERS[username];
    if (!u) return res.status(404).json({ error: "User not found" });

    // mirror of the cancel flag used by broadcast.js
    if (!u._cancel) u._cancel = { requested: false, at: 0 };
    u._cancel.requested = true;
    u._cancel.at = Date.now();

    return res.json({ ok: true, message: `Cancel requested for ${username}` });
  });

  return router;
};
