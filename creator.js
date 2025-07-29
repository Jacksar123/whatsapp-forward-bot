const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3001;
const USERS = {};
const DEFAULT_CATEGORIES = ['Shoes', 'Tech', 'Clothing'];
const CATEGORY_KEYWORDS = {
  Shoes: ['shoe', 'sneaker', 'crep', 'yeezy', 'jordan', 'footwear', 'nike', 'adidas', 'sb', 'dunk'],
  Tech: ['tech', 'dev', 'coding', 'engineer', 'ai', 'crypto', 'blockchain', 'startup', 'hack', 'js', 'python'],
  Clothing: ['clothing', 'threads', 'garms', 'fashion', 'streetwear', 'hoodie', 'tees', 'fit', 'wear']
};

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function userBase(username) { return path.join(__dirname, 'users', username); }
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJSON(file, data) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function jidNorm(j) { return jidNormalizedUser(j); }
function generateUsername() { return `user_${Math.random().toString(16).slice(2, 10)}`; }

async function wipeAuth(username) {
  try {
    const dir = path.join(userBase(username), 'auth_info');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[${username}] wiped auth_info`);
  } catch (err) {
    console.error(`[${username}] wipeAuth failed`, err);
  }
}

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
  console.log(`[${username}] Categories:`, Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.length])));
}

async function startUserSession(username) {
  if (USERS[username]?.sock?.user) return USERS[username];
  if (USERS[username]?.sock) {
    try { await USERS[username].sock.logout(); } catch {}
    try { USERS[username].sock.end(); } catch {}
  }

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
    if (events['creds.update']) {
      console.log(`[${username}] 🔄 Credentials updated`);
      await saveCreds();
    }

    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update'];
      if (qr) {
        USERS[username].qr = qr;
        console.log(`🟨 QR generated for ${username}`);
      }

      if (connection === 'close') {
        console.log(`❌ Connection closed for ${username}`);
        const status = lastDisconnect?.error?.output?.statusCode;
        const msg = lastDisconnect?.error?.message;
        if (lastDisconnect?.error) {
          console.error(`❌ Disconnect reason (${username}):`, lastDisconnect.error);
        }

        if (status === 408 || (msg && msg.includes('QR refs attempts ended'))) {
          console.log(`[${username}] QR expired, wiping session and restarting...`);
          await wipeAuth(username);
          setTimeout(() => startUserSession(username), 1000);
          return;
        }
        if (status !== DisconnectReason.loggedOut) {
          console.log(`[${username}] Unexpected disconnect, restarting session...`);
          setTimeout(() => startUserSession(username), 2000);
        } else {
          console.log(`[${username}] Logged out manually`);
        }
      }

      if (connection === 'open') {
        console.log(`✅ Connection opened for ${username}`);
        USERS[username].qr = null;
        await autoScanAndCategorise(sock, username);
      } else {
        console.log(`ℹ️ Connection update for ${username}:`, events['connection.update']);
      }
    }

    if (events['messages.upsert']) {
      for (const msg of events['messages.upsert'].messages) {
        try {
          await handleMessage(username, msg);
        } catch (e) {
          console.error(`[${username}] msg error`, e);
        }
      }
    }
  });

  console.log(`🟢 Baileys socket created for ${username}`);
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

function buildCategoryPrompt(username) {
  const { categories, allGroups } = USERS[username];
  const lines = [];
  let idx = 1;
  const mapping = {};

  for (const cat of DEFAULT_CATEGORIES) {
    const jids = categories[cat] || [];
    const names = jids.map(j => allGroups[j]?.name || j);
    mapping[idx] = cat;
    lines.push(`*${idx}. ${cat}* (${jids.length} groups)`);
    if (names.length) lines.push('  - ' + names.join('\n  - '));
    idx++;
  }

  lines.push(`*${idx}. Send to ALL*`);
  mapping[idx] = '__ALL__';
  return { text: `Choose a category to broadcast to:\n\n${lines.join('\n')}\n\nReply with the number (e.g., 1, 2, 3, or ${idx}).`, mapping };
}

async function sendInBatches(sock, username, from, jids, content) {
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 5000;
  let sent = 0;
  while (sent < jids.length) {
    const batch = jids.slice(sent, sent + BATCH_SIZE);
    for (const jid of batch) {
      try { await sock.sendMessage(jid, content); } catch (e) { console.error(`[${username}] send fail -> ${jid}`, e); }
    }
    sent += batch.length;
    if (sent < jids.length) await new Promise(res => setTimeout(res, BATCH_DELAY_MS));
  }
}

async function handleMessage(username, msg) {
  const u = USERS[username];
  if (!u) return;
  const sock = u.sock;
  const m = msg.message;
  const from = jidNorm(msg.key.remoteJid);
  if (from.endsWith('@g.us') || !m) return;

  const selection = extractNumericChoice(m);
  if (selection && u.pendingImage && u.lastPromptChat === from) {
    const { mapping } = buildCategoryPrompt(username);
    const number = parseInt(selection, 10);
    const chosen = mapping[number];
    if (!chosen) return sock.sendMessage(from, { text: 'Invalid choice. Try again.' });

    const jids = chosen === '__ALL__' ? Object.keys(u.allGroups) : (u.categories[chosen] || []);
    if (!jids.length) return sock.sendMessage(from, { text: 'No groups in that category.' });

    await sock.sendMessage(from, { text: `Broadcasting to ${jids.length} group${jids.length === 1 ? '' : 's'}…` });
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
    const { text } = buildCategoryPrompt(username);
    u.lastPromptChat = from;
    await sock.sendMessage(from, { text });
    return;
  }

  const body = getMessageText(m).trim().toLowerCase();
  if (body === '/rescan') {
    await autoScanAndCategorise(sock, username);
    return sock.sendMessage(from, { text: 'Rescanned & auto-categorised groups.' });
  }
  if (body === '/cats' || body === '/categories') {
    const { text } = buildCategoryPrompt(username);
    return sock.sendMessage(from, { text });
  }
  if (body === '/help') {
    return sock.sendMessage(from, {
      text: `Commands:\n/help - this help\n/rescan - rescan & auto-categorise groups\n/cats - show the category prompt again`
    });
  }
}

const app = express();
app.use(express.json());

const corsOptions = {
  origin: ['https://whats-broadcast-hub.lovable.app', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.post('/create-user', async (req, res) => {
  try {
    let { username } = req.body || {};
    if (!username) {
      username = generateUsername();
      console.log(`[server] auto username -> ${username}`);
    }
    await startUserSession(username);
    res.json({ ok: true, username });
  } catch (e) {
    console.error('create-user error', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/get-qr', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username required' });
  const u = USERS[username];
  if (!u) return res.status(404).json({ error: 'user not found' });
  res.json({ qr: u.qr });
});

app.get('/get-qr/:username', (req, res) => {
  const { username } = req.params;
  const u = USERS[username];
  if (!u) return res.status(404).json({ error: 'user not found' });
  res.json({ qr: u.qr });
});

app.listen(PORT, () => {
  console.log(`✅ creator.js running on port ${PORT}`);
});