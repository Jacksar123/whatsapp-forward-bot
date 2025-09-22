// lib/broadcast.js — AutoMode + Commands Fallback + Self-Chat Only + Authoritative Rescan
// Date: 2025-09-22

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

const { saveUserState } = require('./state');
const { normaliseImage } = require('./media-normalise');

/* ----------------------------- config ---------------------------------- */

const AUTO_MODE = true; // 🤖 Auto choose + send; commands still work as fallback

const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000; // 30m
const FOOTER = '— Sent automatically via whats-broadcast-hub.lovable.app';
const MAX_NAMES_PER_CATEGORY = 30;

const BATCH_SIZE = 5;
const SMALL_DELAY_MS = 10000;
const SEND_MAX_RETRIES = 3;
const SEND_TIMEOUT_MS = 45_000;
const WARM_DELAY_MS = 2000;

// Keyword map to infer categories from text/caption
const CATEGORY_KEYWORDS = {
  Shoes: ['shoe','sneaker','crep','yeezy','jordan','nike','adidas','dunk','sb','footwear'],
  Tech:  ['tech','dev','code','coding','engineer','ai','crypto','blockchain','startup','hack','js','python'],
  Clothing:['clothing','threads','garms','fashion','streetwear','hoodie','tee','t-shirt','fit','wear']
};

/* --------------------------- helpers / state ---------------------------- */

function USERSG() { return global.USERS || (global.USERS = {}); }

function cancelFlag(u){ if(!u._cancel) u._cancel={requested:false,at:0}; return u._cancel; }
function isCancelled(u){ return !!(u._cancel && u._cancel.requested); }
function requestCancel(u){ const c=cancelFlag(u); c.requested=true; c.at=Date.now(); }
function clearCancel(u){ const c=cancelFlag(u); c.requested=false; c.at=0; }

function bareJid(j) { return String(j || '').replace(/:[^@]+(?=@)/, ''); }

function withFooter(raw) {
  const text = (raw || '').trim();
  if (text.toLowerCase().includes('sent automatically via whats-broadcast-hub')) return text;
  return text.length ? `${text}\n\n${FOOTER}` : FOOTER;
}

function normalizeStr(s=''){
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g,' ')
    .trim();
}

function similarity(a,b){
  a = normalizeStr(a); b = normalizeStr(b);
  if (a === b) return 1;
  const ta = new Set(a.split(/\s+/)), tb = new Set(b.split(/\s+/));
  const inter = [...ta].filter(t => tb.has(t)).length;
  return inter / Math.max(ta.size, tb.size);
}

/* ----------------------------- persistence ------------------------------ */

function mirrorToDisk(username) {
  const u = USERSG()[username];
  if (!u) return;
  const p = getUserPaths(username);
  try {
    writeJSON(p.categories, u.categories || {});
    writeJSON(p.groups, u.allGroups || {});
    console.log('[persist] Disk mirror saved for', username);
  } catch {}
}

function persistNow(username) {
  const u = USERSG()[username];
  if (!u) return;
  try { saveUserState(username, u.categories || {}, u.allGroups || {}); } catch {}
  mirrorToDisk(username);
}

/* -------------------------- system safe send ---------------------------- */

async function sendSys(username, sock, jid, content) {
  const to = normaliseJid(jid); // avoid weird @s.whatsapp.net@s.whatsapp.net
  const send = sock.safeSend ? sock.safeSend.bind(sock) : sock.sendMessage.bind(sock);
  try {
    const res = await send(to, content);
    console.log(`[${username}] sendSys success to ${to}`);
    return res;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/SOCKET_NOT_OPEN|Connection Closed|stream closed/i.test(msg)) return null;
    console.warn(`[sendSys] Failed to send system message: ${msg}`);
    throw e;
  }
}

/* ----------------------------- unwrap msg ------------------------------- */

function unwrapMessageLayer(m) {
  if (!m) return m;
  if (m.ephemeralMessage?.message) return m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) return m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) return m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage?.message) return m.documentWithCaptionMessage.message;
  return m;
}
function getContent(msg) {
  let c = msg?.message || {};
  for (let i = 0; i < 5; i++) {
    const next = unwrapMessageLayer(c);
    if (!next || next === c) break;
    c = next;
  }
  return c || {};
}
function getMessageText(msg) {
  const m = getContent(msg);
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  return '';
}
function hasImage(msg) { return !!getContent(msg)?.imageMessage; }

/* ----------------------- per-phone isolation guard ---------------------- */

function ensureOwnerConsistency(username, selfBare) {
  const u = USERSG()[username] || (USERSG()[username] = {});
  if (u.ownerJid && bareJid(u.ownerJid) === bareJid(selfBare)) return false;

  const p = getUserPaths(username);
  u.ownerJid = selfBare;
  u.categories = {};
  u.allGroups = {};
  try {
    if (fs.existsSync(p.categories)) fs.unlinkSync(p.categories);
    if (fs.existsSync(p.groups)) fs.unlinkSync(p.groups);
  } catch {}
  persistNow(username);
  console.log(`[${username}] ⚠️ Owner changed -> state reset for phone isolation (${selfBare})`);
  return true;
}

/* -------------------------- scan & categorise --------------------------- */
/**
 * Authoritative rescan:
 * - Rebuilds allGroups STRICTLY from the live device (no merge).
 * - Filters categories to only include groups that exist now.
 * - Auto-categorises newly-seen groups.
 */
async function autoScanAndCategorise(username, sock) {
  const u = USERSG()[username] || (USERSG()[username] = {});
  try {
    console.log(`[${username}] Starting group scan...`);
    const metaMap = await sock.groupFetchAllParticipating();
    const groups = Object.values(metaMap || {});
    const p = getUserPaths(username);
    const currentSet = new Set(groups.map(g => g.id));

    // Load previous categories (if any)
    const previousCats = Object.keys(u.categories || {}).length
      ? (u.categories || {})
      : readJSON(p.categories, {});

    // Rebuild allGroups STRICTLY from live groups
    const fetchedAll = {};
    for (const g of groups) {
      fetchedAll[g.id] = { id: g.id, name: g.subject || g.name || g.id };
    }

    // Hard filter categories to only current device groups
    for (const k of Object.keys(previousCats)) {
      previousCats[k] = (previousCats[k] || []).filter(j => currentSet.has(j));
      if (!previousCats[k].length) delete previousCats[k];
    }

    // Auto-categorise only truly new groups (compared to previously known on disk/memory)
    const prevAll = Object.keys(u.allGroups || {}).length
      ? (u.allGroups || {})
      : readJSON(p.groups, {});
    const prevSet = new Set(Object.keys(prevAll));
    for (const [jid, g] of Object.entries(fetchedAll)) {
      if (!prevSet.has(jid)) {
        const guess = categoriseGroupName(g.name || '');
        if (guess) (previousCats[guess] ||= []).push(jid);
        console.log(`[${username}] Auto-categorized "${g.name}" as ${guess || 'none'}`);
      }
    }

    u.allGroups = fetchedAll;
    u.categories = previousCats;
    const report = cleanCategories(username); // also persists
    console.log(`[${username}] ✅ Auto-scan complete. Groups: ${Object.keys(fetchedAll).length} (kept=${report.kept}, fixed=${report.fixed}, dropped=${report.dropped})`);
  } catch (e) {
    console.error(`[${username}] Auto-scan failed: ${e.message}`);
    throw e;
  }
}

/* ----------------------------- clean categories ------------------------- */

function cleanCategories(username) {
  const u = USERSG()[username];
  if (!u || !u.categories || !u.allGroups) return { kept: 0, fixed: 0, dropped: 0 };

  let kept = 0, fixed = 0, dropped = 0;
  const validJids = new Set(Object.keys(u.allGroups));

  for (const [catName, jidList] of Object.entries(u.categories)) {
    if (!Array.isArray(jidList)) continue;
    const originalLength = jidList.length;
    const cleanedList = jidList.filter(jid => {
      if (validJids.has(jid)) { kept++; return true; }
      dropped++; return false;
    });
    if (cleanedList.length !== originalLength) { u.categories[catName] = cleanedList; fixed++; }
  }
  persistNow(username);
  return { kept, fixed, dropped };
}

/* ----------------------- smart name -> JID resolution ------------------- */

function resolveToJids(username, inputs) {
  const u = USERSG()[username] || {};
  const all = u.allGroups || {};

  const out = [];
  for (const rawIn of inputs) {
    if (!rawIn) continue;
    const raw = String(rawIn).trim();

    // direct JID
    if (raw.endsWith('@g.us')) { out.push(raw); continue; }

    // find best match by contains + token similarity
    let best = null, bestScore = 0;
    for (const g of Object.values(all)) {
      const name = g.name || g.id;
      if (!name) continue;

      let score = 0;
      const nName = normalizeStr(name);
      const nNeed = normalizeStr(raw);

      if (nName.includes(nNeed)) score = Math.max(score, nNeed.length / Math.max(1, nName.length));
      score = Math.max(score, similarity(name, raw));

      if (score > bestScore) { best = g.id; bestScore = score; }
    }

    // accept if reasonably confident
    if (best && bestScore >= 0.5) out.push(best);
  }

  // unique + only valid group ids
  return Array.from(new Set(out)).filter(j => typeof j === 'string' && j.endsWith('@g.us'));
}

/* ----------------------------- category UI ------------------------------ */

function buildCategoryPrompt(username) {
  const { categories = {}, allGroups = {}, mode = 'media' } = USERSG()[username] || {};
  const catNames = Object.keys(categories).sort((a,b) => a.localeCompare(b));

  const lines = [];
  const mapping = {};
  let idx = 1;

  lines.push(`*Mode:* ${mode === 'text' ? 'Text' : 'Media'}\n`);

  for (const cat of catNames) {
    const jids = (categories[cat] || []).filter(Boolean);
    const names = jids.map(j => allGroups[j]?.name || j);
    mapping[idx] = cat;
    const shown = names.slice(0, MAX_NAMES_PER_CATEGORY);
    const extra = Math.max(0, names.length - shown.length);
    lines.push(`*${idx}. ${cat}* (${jids.length} groups)`);
    if (shown.length) {
      lines.push('  - ' + shown.join('\n  - ') + (extra ? `\n  ... (+${extra} more)` : ''));
    }
    idx++;
  }

  mapping[idx] = '__ALL__';
  lines.push(`*${idx}. Send to ALL*`);

  return { text: `Choose a category:\n\n${lines.join('\n')}\n\nReply with the number.`, mapping, totalOptions: idx };
}

/* --------------------------- media download ----------------------------- */

async function safeDownloadMedia(msg, sock, retries = 8, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const buffer = await downloadMediaMessage(
        msg, 'buffer', {},
        { logger: sock.logger, reuploadRequest: sock.updateMediaMessage.bind(sock) }
      );
      if (buffer?.length) return buffer;
    } catch (e) {
      console.warn(`[media] Download attempt ${i + 1} failed: ${e.message}`);
    }
    if (i < retries - 1) await sleep(delay);
  }
  return null;
}

/* ------------------------------ warm-up -------------------------------- */

async function warmSessionsForGroup(sock, jid) {
  try {
    const meta = await Promise.race([
      sock.groupMetadata(jid),
      new Promise((_, r) => setTimeout(() => r(new Error('META_TIMEOUT')), 8000))
    ]);
    if (!meta || meta instanceof Error) return 0;
    const jids = (meta.participants || []).map(p => p.id || p.jid || p).filter(Boolean);
    if (typeof sock.assertSessions === 'function' && jids.length) {
      await Promise.race([
        sock.assertSessions(jids, true),
        new Promise((_, r) => setTimeout(() => r(new Error('ASSERT_TIMEOUT')), 10000))
      ]);
      return jids.length;
    }
  } catch {}
  return 0;
}

/* ----------------------- send with retry/timeout ------------------------ */

async function sendToOneWithRetry(sock, jid, payload) {
  let attempt = 0, warmed = false;
  while (attempt <= SEND_MAX_RETRIES) {
    try {
      const sendPromise = sock.safeSend ? sock.safeSend(jid, payload) : sock.sendMessage(jid, payload);
      const result = await Promise.race([
        sendPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT:${jid}`)), SEND_TIMEOUT_MS))
      ]);
      return result;
    } catch (err) {
      const msg = String(err?.message || err);
      if (/SOCKET_NOT_OPEN|Connection Closed|stream closed/i.test(msg)) throw err;

      if (/not-acceptable|forbidden|unauthorized|No sessions/i.test(msg) && !warmed) {
        warmed = true;
        const warmedCount = await warmSessionsForGroup(sock, jid).catch(() => 0);
        if (warmedCount > 0) { await sleep(WARM_DELAY_MS); continue; }
      }
      if (/rate|limit|too many|slow down/i.test(msg)) {
        await sleep(10000 + (attempt * 5000));
      }

      attempt++;
      if (attempt > SEND_MAX_RETRIES) throw err;

      const baseDelay = Math.min(2000 * Math.pow(2, attempt), 15000);
      const jitter = Math.floor(Math.random() * 2000);
      await sleep(baseDelay + jitter);
    }
  }
}

/* ------------------------------ batch send ------------------------------ */

async function sendInBatches(sock, username, from, jids, messageContent) {
  const u = USERSG()[username];
  let sent = 0, failed = 0, skipped = 0;
  const errors = [];
  const startTime = Date.now();

  if (!messageContent.text && !messageContent.image?.url) {
    await sendSys(username, sock, from, { text: 'Error: No valid content to broadcast' }).catch(()=>{});
    return;
  }

  for (let batchStart = 0; batchStart < jids.length; batchStart += BATCH_SIZE) {
    const batch = jids.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(jids.length / BATCH_SIZE);

    if (isCancelled(u)) {
      await sendSys(username, sock, from, { text: `🛑 Broadcast cancelled. Sent: ${sent}, Failed: ${failed}` }).catch(()=>{});
      break;
    }
    if (!u?.socketActive) {
      await sendSys(username, sock, from, { text: `⚠️ Connection lost. Sent: ${sent}, Failed: ${failed}` }).catch(()=>{});
      break;
    }

    const batchPromises = batch.map(async (jid) => {
      try {
        if (messageContent.text !== undefined) {
          await sendToOneWithRetry(sock, jid, { text: withFooter(messageContent.text) });
        } else {
          if (!fs.existsSync(messageContent.image.url)) return { success:false, jid, error:'File not found', skipped:true };
          const raw = fs.readFileSync(messageContent.image.url);
          let buf = raw, mime;
          try { const { buffer, mimetype } = await normaliseImage(raw); buf = buffer; mime = mimetype; } catch {}
          const payload = { image: buf, caption: withFooter(messageContent.caption || '') };
          if (mime) payload.mimetype = mime;
          await sendToOneWithRetry(sock, jid, payload);
        }
        return { success:true, jid };
      } catch (e) {
        return { success:false, jid, error:String(e?.message||e) };
      }
    });

    const results = await Promise.allSettled(batchPromises);
    results.forEach(r => {
      if (r.status === 'fulfilled') {
        if (r.value.success) sent++;
        else { r.value.skipped ? skipped++ : failed++; errors.push(r.value); }
      } else failed++;
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await sendSys(username, sock, from, { text: `Batch ${batchNum}/${totalBatches} (${elapsed}s)\n✅ Sent: ${sent} | ❌ Failed: ${failed} | ⭐ Skipped: ${skipped}` }).catch(()=>{});

    const hasFatal = errors.some(e => /SOCKET_NOT_OPEN|Connection Closed|stream closed/i.test(e.error));
    if (hasFatal) break;

    if (batchStart + BATCH_SIZE < jids.length) await sleep(SMALL_DELAY_MS);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const successRate = jids.length ? Math.round((sent/jids.length) * 100) : 0;
  const report = [
    `📊 Broadcast Complete (${totalTime}s):`,
    `✅ Sent: ${sent}`,
    `❌ Failed: ${failed}`,
    `⭐ Skipped: ${skipped}`,
    `📈 Success Rate: ${successRate}%`
  ];
  await sendSys(username, sock, from, { text: report.join('\n') }).catch(()=>{});
  clearCancel(u);
}

/* --------------------------- inference helper --------------------------- */

function pickCategoryFromText(text='') {
  const t = text.toLowerCase();
  let best = null, score = 0;
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    const s = kws.reduce((acc,kw)=> acc + (t.includes(kw) ? 1 : 0), 0);
    if (s > score) { score = s; best = cat; }
  }
  // require at least 2 keyword hits to be “confident”
  return score >= 2 ? best : null;
}

/* --------------------------- command handling --------------------------- */

function extractNumericChoice(text) {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
}
function parseArgs(str) { return String(str || '').trim().split(/\s+/).filter(Boolean); }

async function handleBroadcastMessage(username, msg, sock) {
  const USERS = USERSG();
  const u = USERS[username] || (USERS[username] = {});
  const chatJid = normaliseJid(msg.key.remoteJid);
  const fromMe = msg.key?.fromMe;
  const body = getMessageText(msg).trim();

  // ignore group chats entirely
  if (chatJid.endsWith('@g.us')) return;

  const selfBare = bareJid(sock?.user?.id || '');
  const chatBare = bareJid(chatJid);

  // STRICT SELF-CHAT: only react in your "You" chat
  if (fromMe && chatBare !== selfBare) return;

  // per-phone isolation (wipe state if phone changed)
  ensureOwnerConsistency(username, selfBare);

  // Ignore our own system echoes (and ignore any fromMe while awaiting category)
  if (fromMe) {
    const sysPhrases = [
      '✅ Connected!', 'Text mode activated', 'Media mode activated',
      'Scanning groups', 'Choose a category', 'Bot Status:',
      'Broadcasting', 'Broadcast Complete', 'Done. Send another',
      'Image saved', 'Cancelled', 'timed out', 'No groups found',
      'Invalid category', 'Error: No valid content',
      '🤖 Auto-picked', 'Sending to ALL',

      // command replies
      'Category "', 'Added to *', 'Removed from *',
      'Categories reset', 'Found ', 'Could not find a group',
      'does not exist.', 'Provide a category name',
      'Avoid spaces in category names', 'Usage: /addgroup', 'Usage: /delgroup',
      '*Categories:*', 'Hard reset', 'Fresh scan complete',
      'Your groups', 'Matches for'
    ];
    if (!body || sysPhrases.some(t => body.includes(t))) return;
    if (u.awaitingCategory) return; // never interpret our own prompt as input
  }

  // ensure maps loaded
  const p = getUserPaths(username);
  if (!u.categories || !Object.keys(u.categories).length) u.categories = readJSON(p.categories, {});
  if (!u.allGroups  || !Object.keys(u.allGroups).length)  u.allGroups  = readJSON(p.groups, {});
  if (!u.mode) u.mode = 'media';

  /* ---------------------- commands (fallback) ----------------------- */

  if (body === '/help') {
    const help = [
      '✅ *Commands*',
      '• /help — this help',
      '• /rescan — refresh groups (authoritative) & auto-categorise new ones',
      '• /cats — show categories & pick where to send',
      '• /text — switch to text mode',
      '• /media — switch to image mode',
      '• /addcategory <Name> — create a category (no spaces recommended)',
      '• /addgroup <Category> <GroupName|JID> — add group to category (fuzzy)',
      '• /delgroup <Category> <GroupName|JID> — remove group',
      '• /findgroup <text> — list matching groups with JIDs',
      '• /listcats — list categories with counts',
      '• /resetcats — wipe categories for this phone',
      '• /hardreset — wipe disk + memory and rescan',
      '• /stop — cancel an active/next broadcast',
      '',
      '*Auto Mode:* just send text or an image; I’ll infer the category and send. If unclear, I’ll use ALL.'
    ].join('\n');
    return await sendSys(username, sock, chatJid, { text: help });
  }

  if (body === '/rescan' || body === '/syncgroups') {
    await sendSys(username, sock, chatJid, { text: 'Scanning groups...' });
    await autoScanAndCategorise(username, sock);
    const groupCount = Object.keys(u.allGroups || {}).length;
    return await sendSys(username, sock, chatJid, { text: `✅ Found ${groupCount} groups (auto-categorised new ones).` });
  }

  if (body === '/listcats') {
    const lines = ['*Categories:*'];
    for (const [k, list] of Object.entries(u.categories || {})) {
      lines.push(`• ${k}: ${(list||[]).length}`);
    }
    if (lines.length === 1) lines.push('— none —');
    return await sendSys(username, sock, chatJid, { text: lines.join('\n') });
  }

  if (body === '/resetcats') {
    u.categories = {};
    persistNow(username);
    return await sendSys(username, sock, chatJid, { text: '🧹 Categories reset for this phone.' });
  }

  if (body === '/hardreset') {
    const pth = getUserPaths(username);
    u.categories = {};
    u.allGroups = {};
    try { if (fs.existsSync(pth.categories)) fs.unlinkSync(pth.categories); } catch {}
    try { if (fs.existsSync(pth.groups)) fs.unlinkSync(pth.groups); } catch {}
    persistNow(username);
    await sendSys(username, sock, chatJid, { text: '🧨 Hard reset done. Re-scanning groups...' });
    await autoScanAndCategorise(username, sock);
    const count = Object.keys(u.allGroups || {}).length;
    return await sendSys(username, sock, chatJid, { text: `✅ Fresh scan complete. Groups found: ${count}` });
  }

  if (body.startsWith('/addcategory ')) {
    const name = parseArgs(body.slice(12))[0];
    if (!name) return await sendSys(username, sock, chatJid, { text: '❌ Provide a category name.\nExample: /addcategory Shoes' });
    if (/\s/.test(name)) return await sendSys(username, sock, chatJid, { text: '❌ Avoid spaces in category names.' });
    if (!u.categories) u.categories = {};
    if (u.categories[name]) return await sendSys(username, sock, chatJid, { text: '❗ Category already exists.' });
    u.categories[name] = [];
    persistNow(username);
    return await sendSys(username, sock, chatJid, { text: `✅ Category "${name}" added.` });
  }

  if (body.startsWith('/findgroup ')) {
    const query = body.slice('/findgroup '.length).trim();
    if (!query) return await sendSys(username, sock, chatJid, { text: '❌ Usage: /findgroup <text>' });
    const all = u.allGroups || {};
    const needle = normalizeStr(query);
    const rows = [];
    for (const g of Object.values(all)) {
      const name = g.name || g.id;
      if (normalizeStr(name).includes(needle)) rows.push({ name, id: g.id });
    }
    if (!rows.length) return await sendSys(username, sock, chatJid, { text: `❌ No groups matching "${query}".` });
    const top = rows.slice(0, 20).map(r => `• ${r.name}\n  ${r.id}`).join('\n');
    const more = rows.length > 20 ? `\n...and ${rows.length - 20} more.` : '';
    return await sendSys(username, sock, chatJid, {
      text: `🔎 Matches for "${query}":\n${top}${more}\n\nTip: use the JID with /addgroup <Cat> <JID>`
    });
  }

  if (body.startsWith('/addgroup ')) {
    const args = body.slice(9).trim().split(/\s+/);
    const category = args.shift();
    const groupRaw = args.join(' ');
    if (!category || !groupRaw) {
      return await sendSys(username, sock, chatJid, { text: '❌ Usage: /addgroup <Category> <GroupName|JID>' });
    }
    if (!u.categories?.[category]) return await sendSys(username, sock, chatJid, { text: `❌ Category "${category}" does not exist.` });

    let jids = resolveToJids(username, [groupRaw]);

    if (!jids.length) {
      // show suggestions
      const all = u.allGroups || {};
      const rows = [];
      for (const g of Object.values(all)) {
        const name = g.name || g.id;
        if (normalizeStr(name).includes(normalizeStr(groupRaw))) rows.push({ name, id: g.id });
      }
      if (!rows.length) {
        return await sendSys(username, sock, chatJid, { text: `❌ Could not find a group matching "${groupRaw}". Try /findgroup ${groupRaw}` });
      }
      const top = rows.slice(0, 10).map(r => `• ${r.name}\n  ${r.id}`).join('\n');
      return await sendSys(username, sock, chatJid, {
        text: `❓ Multiple/unclear matches for "${groupRaw}". Reply with one JID using:\n/addgroup ${category} <JID>\n\nCandidates:\n${top}`
      });
    }

    const set = new Set(u.categories[category] || []);
    jids.forEach(j => set.add(j));
    u.categories[category] = Array.from(set);
    persistNow(username);

    const names = jids.map(j => u.allGroups?.[j]?.name || j);
    return await sendSys(username, sock, chatJid, { text: `✅ Added to *${category}*:\n- ${names.join('\n- ')}` });
  }

  if (body.startsWith('/delgroup ')) {
    const args = body.slice(9).trim().split(/\s+/);
    const category = args.shift();
    const groupRaw = args.join(' ');
    if (!category || !groupRaw) {
      return await sendSys(username, sock, chatJid, { text: '❌ Usage: /delgroup <Category> <GroupName|JID>' });
    }
    if (!u.categories?.[category]) return await sendSys(username, sock, chatJid, { text: `❌ Category "${category}" does not exist.` });

    const jids = resolveToJids(username, [groupRaw]);
    if (!jids.length) return await sendSys(username, sock, chatJid, { text: `❌ Could not resolve "${groupRaw}".` });

    const before = new Set(u.categories[category] || []);
    jids.forEach(j => before.delete(j));
    u.categories[category] = Array.from(before);
    persistNow(username);
    return await sendSys(username, sock, chatJid, { text: `✅ Removed from *${category}*.` });
  }

  if (body === '/stop' || body === '/cancel') {
    requestCancel(u);
    u.pendingText = null;
    u.pendingImage = null;
    u.awaitingPayload = null;
    u.lastPromptChat = null;
    u.awaitingCategory = false;
    if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
    return await sendSys(username, sock, chatJid, { text: `🛑 Cancelled. Any ongoing broadcast will finish safely.` });
  }

  if (body === '/text') {
    u.mode = 'text';
    u.pendingImage = null;
    u.awaitingPayload = 'text';
    return await sendSys(username, sock, chatJid, { text: `✏️ Text mode activated. Type your message and press Send.` });
  }

  if (body === '/media') {
    u.mode = 'media';
    u.pendingText = null;
    u.awaitingPayload = null;
    return await sendSys(username, sock, chatJid, { text: `🖼️ Media mode activated. Send an image to broadcast.` });
  }

  if (body === '/cats') {
    const groupCount = Object.keys(u.allGroups || {}).length;
    if (groupCount === 0) return await sendSys(username, sock, chatJid, { text: 'No groups found. Use /rescan first.' });

    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    u.lastPromptChat = chatJid;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => notifyAndResetOnTimeout(username, sock, chatJid), INTERACTION_TIMEOUT_MS);
    return await sendSys(username, sock, chatJid, { text });
  }

  /* --------------------- Auto Mode (primary path) --------------------- */

  // numeric choice only when awaiting category
  const maybeNum = extractNumericChoice(body);
  if (maybeNum && u.lastPromptChat === chatJid && u.awaitingCategory && (u.pendingImage || u.pendingText)) {
    const { mapping, totalOptions } = buildCategoryPrompt(username);
    const n = parseInt(maybeNum, 10);
    if (!Number.isInteger(n) || n < 1 || n > totalOptions) {
      return await sendSys(username, sock, chatJid, { text: '❌ Invalid category number. Try again.' });
    }
    const chosen = mapping[n];
    const rawList = chosen === '__ALL__' ? Object.keys(u.allGroups || {}) : (u.categories[chosen] || []);
    const jids = (rawList || []).filter(Boolean);
    if (!jids.length) return await sendSys(username, sock, chatJid, { text: 'No valid groups in that category.' });

    if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }

    if (u.mode === 'text' && u.pendingText) {
      await sendSys(username, sock, chatJid, { text: `Broadcasting *text* to ${jids.length} group(s)...` });
      await sendInBatches(sock, username, chatJid, jids, { text: u.pendingText });
      await sendSys(username, sock, chatJid, { text: `✏️ Done. Send another, or /media to switch.` });
      u.pendingText = null; u.awaitingPayload = 'text';
    } else if (u.pendingImage) {
      const imagePath = u.pendingImage?.filePath;
      const caption = u.pendingImage?.caption || '';
      if (!imagePath || !fs.existsSync(imagePath)) {
        await sendSys(username, sock, chatJid, { text: '⚠️ Could not find saved image. Please resend it.' });
      } else {
        await sendSys(username, sock, chatJid, { text: `Broadcasting *image* to ${jids.length} group(s)...` });
        await sendInBatches(sock, username, chatJid, jids, { image: { url: imagePath }, caption });
        try { fs.unlinkSync(imagePath); } catch {}
      }
      u.pendingImage = null; u.awaitingPayload = null;
    }

    u.lastPromptChat = null; u.awaitingCategory = false;
    return;
  }

  // TEXT capture
  if (u.mode === 'text' && body && !body.startsWith('/' ) && !u.awaitingCategory) {
    u.pendingText = body;
    u.awaitingPayload = null;
    u.pendingImage = null;
    u.lastPromptChat = chatJid;

    if (AUTO_MODE) {
      const inferred = pickCategoryFromText(u.pendingText);
      if (inferred && u.categories?.[inferred]?.length) {
        const jids = (u.categories[inferred] || []).filter(Boolean);
        await sendSys(username, sock, chatJid, { text: `🤖 Auto-picked *${inferred}* (${jids.length} groups). Broadcasting...` });
        await sendInBatches(sock, username, chatJid, jids, { text: u.pendingText });
        u.pendingText = null; u.awaitingCategory = false; u.lastPromptChat = null;
        return;
      }
      // fallback: ALL
      const allJids = Object.keys(u.allGroups || {});
      if (allJids.length) {
        await sendSys(username, sock, chatJid, { text: `🤖 No clear category found. Sending to ALL (${allJids.length})...` });
        await sendInBatches(sock, username, chatJid, allJids, { text: u.pendingText });
        u.pendingText = null; u.awaitingCategory = false; u.lastPromptChat = null;
        return;
      }
      return await sendSys(username, sock, chatJid, { text: '⚠️ No groups found. Use /rescan first.' });
    }

    // non-auto fallback: prompt picker
    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => notifyAndResetOnTimeout(username, sock, chatJid), INTERACTION_TIMEOUT_MS);
    return await sendSys(username, sock, chatJid, { text });
  }

  // MEDIA capture
  if (u.mode === 'media' && hasImage(msg) && !u.awaitingCategory) {
    await sendSys(username, sock, chatJid, { text: '⬇️ Downloading image...' });
    const buffer = await safeDownloadMedia(msg, sock, 8, 3000);
    if (!buffer?.length) return await sendSys(username, sock, chatJid, { text: '❌ Failed to download image. Try again.' });

    const caption = getContent(msg)?.imageMessage?.caption || '';
    const up = getUserPaths(username);
    ensureDir(up.tmp);
    const filePath = path.join(up.tmp, `image_${Date.now()}.jpg`);
    try { fs.writeFileSync(filePath, buffer); try { buffer.fill(0); } catch {} } catch (e) {
      return await sendSys(username, sock, chatJid, { text: `❌ Failed to save image: ${e.message}` });
    }

    u.pendingText = null;
    u.pendingImage = { filePath, caption };
    u.awaitingPayload = null;
    u.lastPromptChat = chatJid;

    if (AUTO_MODE) {
      const inferred = pickCategoryFromText(caption);
      if (inferred && u.categories?.[inferred]?.length) {
        const jids = (u.categories[inferred] || []).filter(Boolean);
        await sendSys(username, sock, chatJid, { text: `🤖 Auto-picked *${inferred}* (${jids.length} groups). Broadcasting...` });
        await sendInBatches(sock, username, chatJid, jids, { image: { url: filePath }, caption });
        try { fs.unlinkSync(filePath); } catch {}
        u.pendingImage = null; u.awaitingCategory = false; u.lastPromptChat = null;
        return;
      }
      // fallback: ALL
      const allJids = Object.keys(u.allGroups || {});
      if (allJids.length) {
        await sendSys(username, sock, chatJid, { text: `🤖 No clear category found. Sending to ALL (${allJids.length})...` });
        await sendInBatches(sock, username, chatJid, allJids, { image: { url: filePath }, caption });
        try { fs.unlinkSync(filePath); } catch {}
        u.pendingImage = null; u.awaitingCategory = false; u.lastPromptChat = null;
        return;
      }
      return await sendSys(username, sock, chatJid, { text: '⚠️ No groups found. Use /rescan first.' });
    }

    // non-auto fallback: prompt picker
    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => notifyAndResetOnTimeout(username, sock, chatJid), INTERACTION_TIMEOUT_MS);
    return await sendSys(username, sock, chatJid, { text: `✅ Image saved!\n\n${text}` });
  }

  // nudge
  if (body && !body.startsWith('/')) {
    if (u.mode === 'text' && !u.awaitingCategory) {
      // handled above already
      return;
    } else if (u.awaitingCategory) {
      return await sendSys(username, sock, chatJid, { text: `❌ Invalid category number. Reply with a number (1, 2, 3, …).` });
    } else {
      return await sendSys(username, sock, chatJid, { text: `🖼️ Media mode active. Send an image to broadcast, or /text to switch.\n\nTry /help` });
    }
  }
}

/* ------------------------- timeout helper ------------------------------- */

async function notifyAndResetOnTimeout(username, sock, ownerJid) {
  try {
    await sendSys(username, sock, ownerJid, { text: `⏱️ Category selection timed out (30m). Send /cats to restart.` });
  } catch {}
  const u = USERSG()[username];
  if (!u) return;
  if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
  u.awaitingCategory = false;
  u.lastPromptChat = null;
}

/* ------------------------------- exports -------------------------------- */

module.exports = {
  autoScanAndCategorise,
  buildCategoryPrompt,
  sendInBatches,
  handleBroadcastMessage,
  categoriseGroupName,
  cleanCategories
};
