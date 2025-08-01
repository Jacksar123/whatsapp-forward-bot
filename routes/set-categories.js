const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

module.exports = (USERS) => {
  router.post('/:username', async (req, res) => {
    const { username } = req.params;
    const user = USERS[username];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const incoming = req.body.categories || {}; // New category assignments
    const existing = user.categories || {};

    // ✅ Merge: preserve all existing categories unless explicitly removed
    const merged = { ...existing, ...incoming };

    // ✅ Ensure no category is deleted — even if empty now
    for (const cat of Object.keys(existing)) {
      if (!(cat in incoming)) {
        merged[cat] = existing[cat]; // Keep old groups if frontend didn't include this cat
      }
    }

    user.categories = merged;

    // ✅ Persist to disk
    const filePath = path.join(__dirname, `../users/${username}/categories.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
      console.log(`[${username}] categories.json updated via /set-categories`);
    } catch (err) {
      console.error(`[${username}] Failed to write categories.json:`, err.message);
      return res.status(500).json({ error: 'Failed to save categories' });
    }

    // ✅ WhatsApp summary message
    const summaryLines = [];
    for (const [category, groupList] of Object.entries(merged)) {
      const groups = groupList.length ? groupList.map(g => `- ${g}`).join('\n') : '_no groups_';
      summaryLines.push(`📦 *${category}*:\n${groups}`);
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
