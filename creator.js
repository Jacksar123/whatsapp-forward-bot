// creator.js
// Slim, auto-username, auto-QR-regenerating WhatsApp session server

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
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

const PORT = process.env.PORT || 3001; // run this on a different port if you also run index.js
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
  } catch(err) {
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
  // prevent multi-sockets
  const existing = USERS[username];
  if (existing?.sock?.user) {
    console.log(`[${username}] Already connected. Not starting a new session.`);
    return existing;
  }
  if (existing?.sock) {
    console.log(`[${username}] Cleaning up previous socket...`);
    try { await existing.sock.logout(); } catch {}
    try { existing.sock.end(); } catch {}
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
    if (events['creds.update']) await saveCreds();

    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update'];

      if (qr) {
        USERS[username].qr = qr;
        console.log(`[${username}] QR generated`);
      }

      if (connection === 'close') {
        const status = lastDisconnect?.error?.output?.statusCode;
        const msg = lastDisconnect?.error?.message;
        console.log(`[${username}] connection closed. Reason: ${status || 'unknown'}, Message: ${msg || 'none'}`);

        // QR expired -> regenerate automatically
        if (status === 408 || (msg && msg.includes('QR refs attempts ended'))) {
          await wipeAuth(username);
          setTimeout(() => startUserSession(username), 1000);
          return;
        }

        const shouldReconnect = status !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          setTimeout(() => startUserSession(username), 2000);
        } else {
          console.log(`[${username}] Logged out`);
        }
      }

      if (connection === 'open') {
        console.log(`[${username}] connected`);
        USERS[username].qr = null; // clear QR so frontend knows it's connected
        await autoScanAndCategorise(sock, username);
      }
    }

    if (events['messages.upsert']) {
      for (const msg of events['messages.upsert'].messages) {
        try { await handleMessage(username, msg); } catch (e) { console.error(`[${username}] msg error`, e); }
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

// ------------------- EXPRESS -------------------
const app = express();
app.use(express.json());
app.use(cors({ origin: '*' })); // adjust to your domain if needed

// Start session (username optional)
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

// Return QR string
app.get('/get-qr', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username required' });
  const u = USERS[username];
  if (!u) return res.status(404).json({ error: 'user not found' });
  res.json({ qr: u.qr });
});

// Render QR as PNG
app.get('/qr-image', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).send('missing username');
  const u = USERS[username];
  if (!u || !u.qr) return res.status(404).send('QR not available');
  try {
    res.setHeader('Content-Type', 'image/png');
    const buf = await QRCode.toBuffer(u.qr);
    res.send(buf);
  } catch (e) {
    console.error('qr-image error', e);
    res.status(500).send('render failed');
  }
});

// Simple auto-refresh QR page
app.get('/qr-page', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).send('missing username');

  const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>QR for ${username}</title>
  <style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:14px}</style>
</head>
<body>
  <h2>Scan this with WhatsApp</h2>
  <img id="qr" src="/qr-image?username=${username}&ts=${Date.now()}" width="320" height="320" onerror="document.getElementById('status').innerText='QR not ready (or connected). Retrying…'"/>
  <div id="status"></div>
  <script>
    setInterval(() => {
      const img = document.getElementById('qr');
      img.src = '/qr-image?username=${username}&ts=' + Date.now();
    }, 2000);
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Reset user programmatically (handy!)
app.post('/reset-user', async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    await wipeAuth(username);
    if (USERS[username]?.sock) {
      try { USERS[username].sock.end(); } catch {}
      delete USERS[username];
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('reset-user error', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ creator.js listening on :${PORT}`);
  console.log('POST /create-user  (body optional, auto-generates username)');
  console.log('GET  /get-qr?username=<user>');
  console.log('GET  /qr-page?username=<user>');
  console.log('POST /reset-user { "username": "<user>" }');
});
