const { downloadMediaMessage } = require('@whiskeysockets/baileys');

/**
 * Call this when you receive an image from the user.
 * Stores the image in memory (no temp files).
 */
async function handleIncomingImage({ sock, USERS, username, msg, captionText }) {
  const u = USERS[username] || (USERS[username] = {});
  const buffer = await downloadMediaMessage(msg, 'buffer', {});
  u.lastMedia = {
    kind: 'image',
    buffer,
    mimetype: msg.message?.imageMessage?.mimetype || null,
    caption: captionText || ''
  };
}

module.exports = { handleIncomingImage };
