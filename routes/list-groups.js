// routes/list-groups.js
const express = require('express');

module.exports = (USERS) => {
  const router = express.Router();

  router.get('/:username', async (req, res) => {
    try {
      const { username } = req.params;
      const u = USERS[username];
      if (!u || !u.sock || !u.socketActive) {
        return res.status(400).json({ error: 'User socket not connected' });
        }
      const metaMap = await u.sock.groupFetchAllParticipating();
      const rows = Object.values(metaMap || {})
        .map(g => ({
          jid: g.id,
          subject: g.subject || g.name || g.id,
          announce: !!g.announce,
          size: (g.participants || []).length
        }))
        .sort((a,b) => a.subject.localeCompare(b.subject));
      return res.json({ ok: true, username, count: rows.length, groups: rows });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return router;
};
