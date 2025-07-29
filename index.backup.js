// index.js — Fully Fixed Version

const fs = require('fs');
const path = require('path');
const P = require('pino');
const express = require('express');
const cors = require('cors');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 10000;
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 5000;
const DEFAULT_CATEGORIES = ['Shoes', 'Tech', 'Clothing'];
const CATEGORY_KEYWORDS = {
  Shoes: ['shoe', 'sneaker', 'crep', 'yeezy', 'jordan', 'footwear', 'nike', 'adidas', 'sb', 'dunk'],
  Tech: ['tech', 'dev', 'coding', 'engineer', 'ai', 'crypto', 'blockchain', 'startup', 'hack', 'js', 'python'],
  Clothing: ['clothing', 'threads', 'garms', 'fashion', 'streetwear', 'hoodie', 'tees', 'fit', 'wear']
};

const USERS = {};
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function userBase(username) { return path.join(__dirname, 'users', username); }
function writeJSON(file, data) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file)); } catch { return fallback; } }
function normaliseJid(jid) { return jidNormalizedUser(jid); }
function generateUsername() { return `user_${Math.random().toString(16).slice(2, 10)}`; }

function categoriseGroupName(name) {
  const n = name.toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(k => n.includes(k))) return cat;
  }
  return null;
}

async function autoScanAndCategorise(sock, username) {
  const metaMap = await sock.groupFetchAllParticipating();
  const groups = Object.values(metaMap || {});
  const base = userBase(username);
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

function buildCategoryPrompt(username) {
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

async function sendInBatches(sock, username, from, jids, messageContent) {
  let sent = 0;
  while (sent < jids.length) {
    const batch = jids.slice(sent, sent + BATCH_SIZE);
    const names = batch.map(j => USERS[username].allGroups[j]?.name || j);

    for (const jid of batch) {
      try { await sock.sendMessage(jid, messageContent); }
      catch (e) { console.error(`[${username}] Failed sending to ${jid}`, e); }
    }

    await sock.sendMessage(from, {
      text: `Sent to:\n${names.map(n => `- ${n}`).join('\n')}\n\n${sent + batch.length < jids.length ? `Waiting ${BATCH_DELAY_MS / 1000}s for next batch…` : '✅ Done'}`
    });

    sent += batch.length;
    if (sent < jids.length) await new Promise(res => setTimeout(res, BATCH_DELAY_MS));
  }
}

async function startUserSession(username) {
  if (USERS[username]?.sock) return USERS[username];

  const base = userBase(username);
  ensureDir(base);
  const logger = P({ level: 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(path.join(base, 'auth_info'));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: ['Chrome (Linux)', 'Chrome', '127.0.0.1']
  });

  USERS[username] = {
    sock,
    qr: null,
    categories: readJSON(path.join(base, 'categories.json'), DEFAULT_CATEGORIES.reduce((acc, c) => ({ ...acc, [c]: [] }), {})),
    allGroups: readJSON(path.join(base, 'all_groups.json'), {}),
    pendingImage: null,
    lastPromptChat: null
  };

  sock.ev.process(async (events) => {
    if (events['creds.update']) await saveCreds();

    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update'];
      if (qr) USERS[username].qr = qr;

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = (reason !== DisconnectReason.loggedOut);
        if (shouldReconnect) setTimeout(() => startUserSession(username), 3000);
        else console.log(`[${username}] Session ended`);
      } else if (connection === 'open') {
        await autoScanAndCategorise(sock, username);
        await sock.sendMessage(sock.user.id, { text: '✅ WhatsApp connected.\n\nSend an image to begin.\nType /help for commands.' });
      }
    }

    if (events['messages.upsert']) {
      for (const msg of events['messages.upsert'].messages) {
        if (msg.key.fromMe) continue;
        try { await handleMessage(username, msg); } catch (err) { console.error(`[${username}] Msg error`, err); }
      }
    }
  });

  return USERS[username];
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

async function handleMessage(username, msg) {
  const u = USERS[username];
  const sock = u.sock;
  const m = msg.message;
  const from = normaliseJid(msg.key.remoteJid);
  if (from.endsWith('@g.us') || !m) return;

  const body = getMessageText(m).trim();

  if (body === '/stop') {
    u.pendingImage = null;
    return await sock.sendMessage(from, { text: `🛑 Broadcast cancelled.` });
  }

  if (body === '/help') {
    return await sock.sendMessage(from, {
      text: `Commands:\n/help - Show this help\n/rescan - Re-scan your WhatsApp groups\n/cats - View group categories\n/addcategory [Name] - Add new category\n/stop - Cancel current image broadcast`
    });
  }

  if (body === '/rescan') {
    await autoScanAndCategorise(sock, username);
    return await sock.sendMessage(from, { text: '✅ Groups rescanned.' });
  }

  if (body === '/cats') {
    const { text } = buildCategoryPrompt(username);
    return await sock.sendMessage(from, { text });
  }

  if (body.startsWith('/addcategory ')) {
    const name = body.slice(13).trim();
    if (!name || name.includes(' ')) return await sock.sendMessage(from, { text: '❌ Invalid name (no spaces).' });
    if (u.categories[name]) return await sock.sendMessage(from, { text: '❗ Already exists.' });
    u.categories[name] = [];
    writeJSON(path.join(userBase(username), 'categories.json'), u.categories);
    return await sock.sendMessage(from, { text: `✅ Category "${name}" added.` });
  }

  const num = extractNumericChoice(m);
  if (num && u.pendingImage && u.lastPromptChat === from) {
    const { mapping } = buildCategoryPrompt(username);
    const picked = mapping[parseInt(num, 10)];
    if (!picked) return await sock.sendMessage(from, { text: '❌ Invalid choice.' });

    const jids = picked === '__ALL__' ? Object.keys(u.allGroups) : u.categories[picked];
    if (!jids.length) return await sock.sendMessage(from, { text: 'No groups to send to.' });

    await sock.sendMessage(from, { text: `📤 Sending to ${jids.length} group(s)…` });
    await sendInBatches(sock, username, from, jids, {
      image: u.pendingImage.buffer,
      caption: u.pendingImage.caption || ''
    });

    u.pendingImage = null;
    u.lastPromptChat = null;
    return;
  }

  if (m.imageMessage) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    const caption = m.imageMessage.caption || '';
    u.pendingImage = { buffer, caption };
    u.lastPromptChat = from;
    const { text } = buildCategoryPrompt(username);
    return await sock.sendMessage(from, { text });
  }
}

// EXPRESS API
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://whats-broadcast-hub.lovable.app");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.post('/create-user', async (req, res) => {
  try {
    let { username } = req.body || {};
    if (!username) {
      username = generateUsername();
      console.log(`[server] New user: ${username}`);
    }
    await startUserSession(username);
    res.json({ ok: true, username });
  } catch (err) {
    console.error('/create-user failed', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/get-qr/:username', (req, res) => {
  const { username } = req.params;
  const u = USERS[username];
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ qr: u.qr });
});

app.listen(PORT, () => console.log(`✅ Bot server running on port ${PORT}`));
