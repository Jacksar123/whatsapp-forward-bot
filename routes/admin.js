// routes/admin.js
const express = require("express");
const fs = require("fs-extra");
const path = require("path");
const { getUserPaths } = require("../lib/utils");

module.exports = (USERS, startUserSession, endUserSession) => {
  const router = express.Router();

  // ✅ GET /admin/users
  router.get("/users", (req, res) => {
    const data = Object.entries(USERS).map(([username, user]) => ({
      username,
      connected: !!user.socketActive, // use socketActive, not user.connected
      ended: !!user.ended,
      lastActive: user.lastActive ? new Date(user.lastActive).toISOString() : null,
    }));
    return res.json({ users: data });
  });

  // ✅ POST /admin/end/:username
  router.post("/end/:username", async (req, res) => {
    const { username } = req.params;
    if (!USERS[username]) return res.status(404).json({ error: "User not found" });
    try {
      await endUserSession(username); // graceful shutdown
      return res.json({ ok: true, message: `Ended session for ${username}` });
    } catch (e) {
      console.error(`[admin] end ${username} failed:`, e.message);
      return res.status(500).json({ error: "Failed to end session" });
    }
  });

  // ✅ POST /admin/restart/:username
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

  // ✅ POST /admin/nuke-auth/:username  (fix 401/408 loops / poisoned sessions)
  router.post("/nuke-auth/:username", async (req, res) => {
    const { username } = req.params;
    try {
      // 1) Graceful shutdown first (drain listeners / close socket)
      if (USERS[username]) {
        try { await endUserSession(username); } catch (e) {
          console.warn(`[admin] endUserSession warning for ${username}: ${e.message}`);
        }
      }

      // 2) Remove auth folder on disk
      const p = getUserPaths(username);
      await fs.remove(p.auth); // delete users/<username>/auth_info

      // 3) Remove from memory map
      delete USERS[username];

      return res.json({ ok: true, message: `Auth nuked for ${username}` });
    } catch (e) {
      console.error(`[admin] nuke-auth ${username} failed:`, e.message);
      return res.status(500).json({ error: "Failed to nuke auth" });
    }
  });

  // ✅ POST /admin/nuke-all-auth  (wipe ALL users' auth_info + clear in-memory sessions)
  router.post("/nuke-all-auth", async (_req, res) => {
    const nuked = new Set();

    try {
      // 1) Gracefully end all active/in-memory sessions
      const memUsers = Object.keys(USERS);
      for (const username of memUsers) {
        try {
          await endUserSession(username);
        } catch (e) {
          console.warn(`[admin] endUserSession warning for ${username}: ${e.message}`);
        }
      }

      // 2) Remove all auth_info folders on disk (covers users not in memory)
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

      // 3) Clear the in-memory USERS map
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

  return router;
};
