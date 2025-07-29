const fs = require('fs');
const path = require('path');
const { downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 5000;
const DEFAULT_CATEGORIES = ['Shoes', 'Tech', 'Clothing'];
const CATEGORY_KEYWORDS = {
  Shoes: ['shoe', 'sneaker', 'crep', 'yeezy', 'jordan', 'footwear', 'nike', 'adidas', 'sb', 'dunk'],
  Tech: ['tech', 'dev', 'coding', 'engineer', 'ai', 'crypto', 'blockchain', 'startup', 'hack', 'js', 'python'],
  Clothing: ['clothing', 'threads', 'garms', 'fashion', 'streetwear', 'hoodie', 'tees', 'fit', 'wear']
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return fallback;
  }
}
function normaliseJid(jid) {
  return jidNormalizedUser(jid);
}
function categoriseGroupName(name) {
  const n = name.toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(k => n.includes(k))) return cat;
  }
  return null;
}

async function autoScanAndCategorise(sock, username, USERS) {
  const metaMap = await sock.groupFetchAllParticipating();
  const groups = Object.values(metaMap || {});
  const base = path.join(__dirname, 'users', username);
  const groupsPath = path.join(base, 'all_groups.json');
  const catPath = path.join(base, 'categories.json');

  const allGroups = {};
  const categories = DEFAULT_CATEGORIES.reduce((acc, c) => ({ ...acc, [c]: [] }), {});

  for (const g of groups) {
    const name = g.subject || g.name || g.id;
    const jid = g.id;
    allGroups[jid] = { id: jid, name };
    const guess = categoriseGroupName(name);
    if (guess && categories[guess]) categories[guess].push(jid);
  }

  writeJSON(groupsPath, allGroups);
  writeJSON(catPath, categories);
  USERS[username].allGroups = allGroups;
  USERS[username].categories = categories;
  console.log(`[${username}] Auto-scan complete. Groups: ${groups.length}`);
}

function buildCategoryPrompt(username, USERS) {
  const { categories, allGroups } = USERS[username];
  const lines = [];
  let idx = 1;
  const mapping = {};

  for (const cat of Object.keys(categories)) {
    const jids = categories[cat] || [];
    const names = jids.map(j => allGroups[j]?.name || j);
    mapping[idx] = cat;
    lines.push(`*${idx}. ${cat}* (${jids.length} groups)`);
    if (names.length) lines.push('  - ' + names.join('\n  - '));
    idx++;
  }

  lines.push(`*${idx}. Send to ALL*`);
  mapping[idx] = '__ALL__';

  return {
    text: `Choose a category to broadcast to:\n\n${lines.join('\n')}\n\nReply with the number (e.g., 1, 2, 3, or ${idx}).`,
    mapping
  };
}

async function sendInBatches(sock, username, from, jids, messageContent, USERS) {
  const total = jids.length;
  let sent = 0;

  while (sent < total) {
    const batch = jids.slice(sent, sent + BATCH_SIZE);
    const groupNames = batch.map(jid => USERS[username].allGroups[jid]?.name || jid);

    for (const jid of batch) {
      try {
        await sock.sendMessage(jid, messageContent);
        console.log(`[${username}] Sent to ${jid}`);
      } catch (error) {
        console.error(`[${username}] Failed to send to ${jid}:`, error.message || error);
      }
    }

    try {
      await sock.sendMessage(from, {
        text: `✅ Sent to:\n${groupNames.map(name => `- ${name}`).join('\n')}\n\n${sent + batch.length < total ? `⏳ Next batch in ${BATCH_DELAY_MS / 1000}s…` : '🎉 All messages sent!'}`,
      });
    } catch (notifyErr) {
      console.error(`[${username}] Failed to notify sender`, notifyErr.message || notifyErr);
    }

    sent += batch.length;
    if (sent < total) await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
  }
}

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

async function handleBroadcastMessage(username, msg, USERS) {
  const u = USERS[username];
  const sock = u.sock;
  const m = msg.message;
  const from = normaliseJid(msg.key.remoteJid);
  if (from.endsWith('@g.us') || !m) return;

  const body = getMessageText(m).trim();

  if (body === '/rescan' || body === '/syncgroups') {
    await autoScanAndCategorise(sock, username, USERS);
    return await sock.sendMessage(from, { text: '✅ Rescanned and categorised groups.' });
  }

  if (body === '/cats') {
    const { text } = buildCategoryPrompt(username, USERS);
    return await sock.sendMessage(from, { text });
  }

  if (body === '/stop') {
    if (!u.pendingImage) {
      return await sock.sendMessage(from, { text: `ℹ️ There's no active broadcast session.` });
    }
    u.pendingImage = null;
    u.lastPromptChat = null;
    return await sock.sendMessage(from, { text: `🛑 Broadcast cancelled.` });
  }

  const selection = extractNumericChoice(m);
  if (selection && u.pendingImage && u.lastPromptChat === from) {
    const { mapping } = buildCategoryPrompt(username, USERS);
    const number = parseInt(selection, 10);
    const chosen = mapping[number];

    if (!chosen) return await sock.sendMessage(from, { text: 'Invalid choice. Try again.' });
    const jids = chosen === '__ALL__' ? Object.keys(u.allGroups) : (u.categories[chosen] || []);
    if (!jids.length) return await sock.sendMessage(from, { text: 'No groups in that category.' });

    await sock.sendMessage(from, { text: `Broadcasting to ${jids.length} group${jids.length > 1 ? 's' : ''}…` });
    await sendInBatches(sock, username, from, jids, {
      image: u.pendingImage.buffer,
      caption: u.pendingImage.caption || ''
    }, USERS);

    u.pendingImage = null;
    u.lastPromptChat = null;
    return;
  }

  if (m.imageMessage) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    const caption = m.imageMessage.caption || '';
    u.pendingImage = { buffer, caption };
    const { text } = buildCategoryPrompt(username, USERS);
    u.lastPromptChat = from;
    await sock.sendMessage(from, { text });
    return;
  }

  if (body === '/help') {
    return await sock.sendMessage(from, {
      text: `Commands:
/help - Show help
/rescan or /syncgroups - Rescan your groups
/cats - Show category prompt
/stop - Cancel an image broadcast in progress`
    });
  }
}

module.exports = {
  autoScanAndCategorise,
  buildCategoryPrompt,
  sendInBatches,
  handleBroadcastMessage,
  categoriseGroupName
};
