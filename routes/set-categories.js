const express = require('express');
const router = express.Router();

module.exports = (USERS) => {
  router.post('/:username', async (req, res) => {
    const { username } = req.params;
    const user = USERS[username];

    if (!user) return res.status(404).json({ error: 'User not found' });

    const categoryMap = req.body.categories || {}; // { "Shoes": ["Group A", "Group B"], ... }

    user.categories = categoryMap;

    // ✅ Create a message summary
    const summaryLines = [];
    for (const [category, groupList] of Object.entries(categoryMap)) {
      summaryLines.push(`📦 *${category}*:\n${groupList.map(g => `- ${g}`).join('\n')}`);
    }
    const summary = `✅ Categories updated:\n\n${summaryLines.join('\n\n')}`;

    try {
      await user.sock.sendMessage(user.sock.user.id, { text: summary });
    } catch (err) {
      console.warn(`[${username}] Failed to send summary message:`, err.message);
    }

    return res.json({ ok: true });
  });

  return router;
};
