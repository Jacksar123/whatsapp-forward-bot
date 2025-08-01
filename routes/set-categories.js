const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

module.exports = (USERS) => {
  router.post('/:username', async (req, res) => {
    const { username } = req.params;
    const user = USERS[username];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const incoming = req.body.categories || {}; // { "Tech": ["Group A", "Group B"] }

    // ✅ Overwrite all previous category data
    user.categories = incoming;

    // ✅ Persist to file
    const filePath = path.join(__dirname, `../users/${username}/categories.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(incoming, null, 2));
      console.log(`[${username}] categories.json overwritten.`);
    } catch (err) {
      console.error(`[${username}] Failed to write categories.json:`, err.message);
      return res.status(500).json({ error: 'Failed to save categories' });
    }

    // ✅ WhatsApp summary
    const summaryLines = [];
    for (const [cat, groupList] of Object.entries(incoming)) {
      const lines = groupList.length ? groupList.map(g => `- ${g}`).join('\n') : '_no groups_';
      summaryLines.push(`📦 *${cat}*:\n${lines}`);
    }

    const summary = `✅ Categories updated (multi-category allowed):\n\n${summaryLines.join('\n\n')}`;

    try {
      await user.sock.sendMessage(user.sock.user.id, { text: summary });
    } catch (err) {
      console.warn(`[${username}] Failed to send summary message:`, err.message);
    }

    return res.json({ ok: true });
  });

  return router;
};
