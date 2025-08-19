const { normaliseImage } = require('./media-normalise');

const BATCH_DELAY_MS = 300;

/**
 * Sends USERS[username].lastMedia (Buffer) to given group JIDs.
 */
async function sendImageBatch({ sock, USERS, username, jids, captionOverride }) {
  const u = USERS[username];
  if (!u?.lastMedia || u.lastMedia.kind !== 'image') {
    throw new Error('No pending image to broadcast');
  }

  const { buffer, mimetype } = await normaliseImage(u.lastMedia.buffer);
  const caption = captionOverride ?? u.lastMedia.caption ?? '';

  for (const jid of jids) {
    try {
      await sock.sendMessage(jid, { image: buffer, mimetype, caption });
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    } catch (e) {
      console.error(`[${username}] ❌ Failed to send to ${jid}: ${e?.message || e}`);
    }
  }

  delete u.lastMedia; // clear after sending
}

/** Prevent overlapping broadcasts per user */
async function guardedBroadcast({ sock, USERS, username, jids, captionOverride }) {
  const u = USERS[username] || (USERS[username] = {});
  if (u.isBroadcasting) {
    console.warn(`[${username}] Broadcast already in progress`);
    return;
  }
  u.isBroadcasting = true;
  try {
    await sendImageBatch({ sock, USERS, username, jids, captionOverride });
  } finally {
    u.isBroadcasting = false;
  }
}

module.exports = { guardedBroadcast, sendImageBatch };
