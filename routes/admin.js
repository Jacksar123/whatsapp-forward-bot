// routes/admin.js
const express = require("express");
const fs = require("fs-extra");
const { getUserPaths } = require("../lib/utils");

module.exports = (USERS, startUserSession, endUserSession) => {
  const router = express.Router();

  // ✅ GET /admin/users
  router.get("/users", (req, res) => {
    const data = Object.entries(USERS).map(([username, user]) => ({
      username,
      connected: !!user.connected,
      ended: !!user.ended,
      lastActive: user.lastActive ? new Date(user.lastActive).toISOString() : null,
    }));
    return res.json({ users: data });
  });

  // ✅ POST /admin/end/:username
  router.post("/end/:username", (req, res) => {
    const { username } = req.params;
    if (!USERS[username]) return res.status(404).json({ error: "User not found" });
    endUserSession(username);
    return res.json({ ok: true, message: `Ended session for ${username}` });
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

  // ✅ POST /admin/nuke-auth/:username  (fix 408 QR loops / poisoned sessions)
  router.post("/nuke-auth/:username", async (req, res) => {
    const { username } = req.params;
    try {
      const p = getUserPaths(username);
      await fs.remove(p.auth); // delete auth_info/*
      if (USERS[username]?.sock?.ws?.close) {
        USERS[username].sock.ws.close();
      }
      delete USERS[username];
      return res.json({ ok: true, message: `Auth nuked for ${username}` });
    } catch (e) {
      console.error(`[admin] nuke-auth ${username} failed:`, e.message);
      return res.status(500).json({ error: "Failed to nuke auth" });
    }
  });

  return router;
};
