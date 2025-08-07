const express = require("express");
const { getUserPaths, readJSON } = require("../lib/utils");

module.exports = (USERS, startUserSession, endUserSession) => {
  const router = express.Router();

  // ✅ GET /admin/users
  router.get("/users", (req, res) => {
    const data = Object.entries(USERS).map(([username, user]) => ({
      username,
      connected: user.connected,
      ended: user.ended,
      lastActive: new Date(user.lastActive).toISOString()
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

  return router;
};
