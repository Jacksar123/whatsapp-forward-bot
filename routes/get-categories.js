module.exports = (USERS) => {
  const express = require('express');
  const router = express.Router();

  // GET /get-categories/:username
  router.get('/:username', (req, res) => {
    const { username } = req.params;
    const u = USERS[username];

    if (!u || !u.categories || !u.allGroups) {
      return res.status(404).json({ error: 'User not found or not connected' });
    }

    const categories = Object.keys(u.categories || {});
    const groups = [];

    for (const [jid, group] of Object.entries(u.allGroups)) {
      const foundCat = categories.find(cat => (u.categories[cat] || []).includes(jid));
      groups.push({ name: group.name || group.subject || jid, category: foundCat || null });
    }

    res.json({ categories, groups });
  });

  return router;
};
