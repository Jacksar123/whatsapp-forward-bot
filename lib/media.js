// lib/media.js
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { normaliseImage } = require('./media-normalise');

/**
 * Capture an incoming image and store a safe, WA-acceptable version in memory.
 * This is used by any flow that broadcasts from memory instead of temp files.
 */
async function handleIncomingImage({ sock, USERS, username, msg, captionText }) {
  const u = USERS[username] || (USERS[username] = {});
  const raw = await downloadMediaMessage(msg, 'buffer', {});
  const { buffer, mimetype } = await normaliseImage(raw);

  u.lastMedia = {
    kind: 'image',
    buffer,
    mimetype,               // guaranteed jpeg/png/webp
    caption: captionText || ''
  };
}

module.exports = { handleIncomingImage };
