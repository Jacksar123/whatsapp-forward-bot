const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const {
  ensureDir,
  readJSON,
  writeJSON,
  normaliseJid,
  categoriseGroupName,
  sleep,
  getUserPaths
} = require('./utils');

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 5000;

// 30-minute reply window for picking a category
const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000;
// Where to send users to reconnect
const DASHBOARD_URL = "https://whats-broadcast-hub.lovable.app";

/* --------------------------- helpers ----------------------------------- */

async function notifyAndResetOnTimeout(sock, username, ownerJid, USERS) {
  try {
    await sock.sendMessage(ownerJid, {
      text:
        `⏱️ Your category selection timed out (30 minutes).\n\n` +
        `Please reconnect on your dashboard:\n${DASHBOARD_URL}\n\n` +
        `If a QR is shown, scan it to resume.`
    });
  } catch (e) {
    console.error(`[${username}] notifyAndResetOnTimeout error:`, e?.message || e);
  }
  if (USERS[username]?.categoryTimeout) {
    clearTimeout(USERS[username].categoryTimeout);
    USERS[username].categoryTimeout = null;
  }
  USERS[username].awaitingCategory = false;
}

/* ------------------------ scan & categorise ----------------------------- */

async function autoScanAndCategorise(sock, username, USERS) {
  const metaMap = await sock.groupFetchAllParticipating();
  const groups = Object.values(metaMap || {});
  const paths = getUserPaths(username);

  const allGroups = {};
  // ✅ Load existing categories so we don't wipe custom ones
  const categories = readJSON(paths.categories, {});

  for (const g of groups) {
    const name = g.subject || g.name || g.id;
    const jid = g.id;
    allGroups[jid] = { id: jid, name };

    // Non-destructive guess-add
    const guess = categoriseGroupName(name);
    if (guess) {
      if (!categories[guess]) categories[guess] = [];
      if (!categories[guess].includes(jid)) categories[guess].push(jid);
    }
  }

  // Persist both
  writeJSON(paths.groups, allGroups);
  writeJSON(paths.categories, categories);

  USERS[username].allGroups = allGroups;
  USERS[username].categories = categories;

  console.log(`[${username}] ✅ Auto-scan complete. Groups: ${groups.length}`);
}

/* ------------------------- category prompt ------------------------------ */

function buildCategoryPrompt(username, USERS) {
  const { categories = {}, allGroups = {} } = USERS[username] || {};
  const catNames = Object.keys(categories).sort((a, b) => a.localeCompare(b));

  const lines = [];
  const mapping = {};
  let idx = 1;

  for (const cat of catNames) {
    const jids = (categories[cat] || []).filter(Boolean);
    const names = jids.map(j => allGroups[j]?.name || j);
    mapping[idx] = cat;
    lines.push(`*${idx}. ${cat}* (${jids.length} groups)`);
    if (names.length) {
      lines.push('  - ' + names.join('\n  - '));
    }
    idx++;
  }

  // ALL option
  mapping[idx] = '__ALL__';
  lines.push(`*${idx}. Send to ALL*`);

  return {
    text: `Choose a category to broadcast to:\n\n${lines.join('\n')}\n\nReply with the number.`,
    mapping,
    totalOptions: idx
  };
}

/* ---------------------------- broadcast --------------------------------- */

async function sendInBatches(sock, username, from, jids, messageContent, USERS) {
  const total = jids.length;
  let sent = 0;

  while (sent < total) {
    const batch = jids.slice(sent, sent + BATCH_SIZE);
    const groupNames = batch.map(jid => USERS[username].allGroups[jid]?.name || jid);

    for (const jid of batch) {
      try {
        if (!jid) {
          console.warn(`[${username}] Skipping invalid JID in batch: ${jid}`);
          continue;
        }
        await sock.sendMessage(jid, messageContent);
        console.log(`[${username}] ✅ Sent to ${jid}`);
      } catch (error) {
        console.error(`[${username}] ❌ Failed to send to ${jid}:`, error.message || error);
      }
    }

    await sock.sendMessage(from, {
      text: `✅ Sent to:\n${groupNames.map(n => `- ${n}`).join('\n')}\n\n${
        sent + batch.length < total ? '⏳ Sending next batch…' : '🎉 All messages sent!'
      }`,
    });

    sent += batch.length;
    if (sent < total) await sleep(BATCH_DELAY_MS);
  }
}

/* --------------------------- msg parsing -------------------------------- */

function getMessageText(m) {
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  return '';
}

function extractNumericChoice(m) {
  const txt = getMessageText(m);
  return txt && /^\d+$/.test(txt.trim()) ? txt.trim() : null;
}

/* --------------------------- main handler ------------------------------- */

async function handleBroadcastMessage(username, msg, USERS) {
  const u = USERS[username];
  const sock = u?.sock;
  const m = msg.message;
  const from = normaliseJid(msg.key.remoteJid);
  if (from.endsWith('@g.us') || !m || !sock) return;

  const body = getMessageText(m).trim();
  const paths = getUserPaths(username);

  // Always refresh from disk (keeps categories persistent)
  u.categories = readJSON(paths.categories, u.categories || {});
  u.allGroups = readJSON(paths.groups, u.allGroups || {});
  const cats = u.categories;
  const groups = u.allGroups;

  /* ------------ commands ------------- */

  if (body === '/rescan' || body === '/syncgroups') {
    await autoScanAndCategorise(sock, username, USERS);
    return await sock.sendMessage(from, { text: '✅ Rescanned and categorised groups.' });
  }

  if (body === '/cats') {
    const { text } = buildCategoryPrompt(username, USERS);
    // Set 30-min waiting window
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(sock, username, from, USERS);
    }, INTERACTION_TIMEOUT_MS);

    return await sock.sendMessage(from, { text });
  }

  if (body === '/stop') {
    u.pendingImage = null;
    u.lastPromptChat = null;
    u.awaitingCategory = false;
    if (u.categoryTimeout) {
      clearTimeout(u.categoryTimeout);
      u.categoryTimeout = null;
    }
    return await sock.sendMessage(from, { text: `🛑 Broadcast cancelled.` });
  }

  if (body === '/help') {
    return await sock.sendMessage(from, {
      text: `Commands:\n` +
            `/help - Show this message\n` +
            `/rescan or /syncgroups - Rescan groups\n` +
            `/cats - Choose category\n` +
            `/stop - Cancel\n` +
            `/addcategory [category]\n` +
            `/addgroup [group name] [category]\n` +
            `/removegroup [group name] [category]`
    });
  }

  /* --------- numeric choice while awaiting --------- */

  const selection = extractNumericChoice(m);
  if (selection && u.pendingImage && u.lastPromptChat === from && u.awaitingCategory) {
    const { mapping, totalOptions } = buildCategoryPrompt(username, USERS);
    const number = parseInt(selection, 10);

    // Robust validation & feedback
    if (!Number.isInteger(number) || number < 1 || number > totalOptions) {
      await sock.sendMessage(from, { text: '❌ Invalid category number. Please try again.' });
      return;
    }

    const chosen = mapping[number];
    if (!chosen) {
      await sock.sendMessage(from, { text: '❌ Invalid selection. Please try again.' });
      return;
    }

    // Clear the timer & awaiting state now that we have a valid selection
    u.awaitingCategory = false;
    if (u.categoryTimeout) {
      clearTimeout(u.categoryTimeout);
      u.categoryTimeout = null;
    }

    const rawList = chosen === '__ALL__'
      ? Object.keys(groups)
      : (cats[chosen] || []);

    // Ensure everything is a JID
    const jids = rawList
      .map(entry => entry.endsWith('@g.us') ? entry : (Object.values(groups).find(g => g.name === entry)?.id || null))
      .filter(Boolean);

    if (!jids.length) {
      return await sock.sendMessage(from, { text: 'No valid groups in that category.' });
    }

    const imagePath = u.pendingImage?.filePath;
    if (!imagePath || !fs.existsSync(imagePath)) {
      return await sock.sendMessage(from, { text: '⚠️ Could not find saved image. Please resend it.' });
    }

    const imageBuffer = fs.readFileSync(imagePath);
    await sock.sendMessage(from, { text: `Broadcasting to ${jids.length} group(s)…` });

    await sendInBatches(sock, username, from, jids, {
      image: imageBuffer,
      mimetype: 'image/jpeg',
      caption: u.pendingImage.caption || ''
    }, USERS);

    u.pendingImage = null;
    u.lastPromptChat = null;
    return;
  }

  /* -------------- image -> start flow -------------- */

  if (m.imageMessage) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: sock.logger,
      reuploadRequest: sock.sendMessage
    });

    const caption = m.imageMessage.caption || '';
    const timestamp = Date.now();
    const imagePath = path.join(getUserPaths(username).tmp, `image_${timestamp}.jpg`);
    ensureDir(getUserPaths(username).tmp);
    fs.writeFileSync(imagePath, buffer);

    u.pendingImage = { filePath: imagePath, caption };
    u.lastPromptChat = from;

    const { text } = buildCategoryPrompt(username, USERS);

    // Start 30-min window right when we prompt
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(sock, username, from, USERS);
    }, INTERACTION_TIMEOUT_MS);

    await sock.sendMessage(from, { text });
    return;
  }

  // If none matched: do nothing (keeps bot quiet on unknown text)
}

module.exports = {
  autoScanAndCategorise,
  buildCategoryPrompt,
  sendInBatches,
  handleBroadcastMessage,
  categoriseGroupName
};
