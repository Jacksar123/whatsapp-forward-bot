// lib/broadcast.js — Self-Chat Only + Chat Commands + Per-Phone Isolation (2025-09-22)

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

/* ----------------------------- constants -------------------------------- */

const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const FOOTER = '— Sent automatically via whats-broadcast-hub.lovable.app';
const MAX_NAMES_PER_CATEGORY = 30;

// Broadcast pacing
const BATCH_SIZE = 5;
const SMALL_DELAY_MS = 10000;
const SEND_MAX_RETRIES = 3;
const SEND_TIMEOUT_MS = 45_000;
const WARM_DELAY_MS = 2000;

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
  const send = sock.safeSend ? sock.safeSend.bind(sock) : sock.sendMessage.bind(sock);
  try {
    const res = await send(jid, content);
    console.log(`[${username}] sendSys success to ${jid}`);
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
/**
 * If the stored ownerJid differs from current device selfBare,
 * wipe categories/groups so you never inherit garbage from another phone.
 */
function ensureOwnerConsistency(username, selfBare) {
  const u = USERSG()[username] || (USERSG()[username] = {});
  if (u.ownerJid && bareJid(u.ownerJid) === bareJid(selfBare)) return false;

  const p = getUserPaths(username);
  u.ownerJid = selfBare;
  u.categories = {};
  u.allGroups = {};
  try {
    // hard reset disk so stale Shoe 1/9, etc, are gone
    if (fs.existsSync(p.categories)) fs.unlinkSync(p.categories);
    if (fs.existsSync(p.groups)) fs.unlinkSync(p.groups);
  } catch {}
  persistNow(username);
  console.log(`[${username}] ⚠️ Owner changed -> state reset for phone isolation (${selfBare})`);
  return true;
}

/* -------------------------- scan & categorise --------------------------- */

async function autoScanAndCategorise(username, sock) {
  const u = USERSG()[username] || (USERSG()[username] = {});
  try {
    console.log(`[${username}] Starting group scan...`);
    const metaMap = await sock.groupFetchAllParticipating();
    const groups = Object.values(metaMap || {});
    const p = getUserPaths(username);

    // load existing if present
    const existingCats = Object.keys(u.categories || {}).length
      ? (u.categories || {})
      : readJSON(p.categories, {});
    const allGroups = Object.keys(u.allGroups || {}).length
      ? (u.allGroups || {})
      : readJSON(p.groups, {});

    let newGroups = 0;
    for (const g of groups) {
      const name = g.subject || g.name || g.id;
      if (!allGroups[g.id]) newGroups++;
      allGroups[g.id] = { id: g.id, name };

      // only auto-place never-before-seen groups
      const already = Object.values(existingCats).some(list => (list || []).includes(g.id));
      if (!already) {
        const guess = categoriseGroupName(name);
        if (guess) (existingCats[guess] ||= []).push(g.id);
      }
    }

    u.allGroups = allGroups;
    u.categories = existingCats;
    const stats = cleanCategories(username);
    console.log(`[${username}] cleanCategories: kept=${stats.kept} fixed=${stats.fixed} dropped=${stats.dropped}`);

    persistNow(username);
    console.log(`[${username}] ✅ Auto-scan complete. Groups: ${Object.keys(allGroups).length} (${newGroups} new)`);
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
      dropped++;
      return false;
    });
    if (cleanedList.length !== originalLength) { u.categories[catName] = cleanedList; fixed++; }
  }
  persistNow(username);
  return { kept, fixed, dropped };
}

/* ----------------------- group name -> JID resolution ------------------- */

function resolveToJids(username, inputs) {
  const u = USERSG()[username] || {};
  const all = u.allGroups || {};
  const byExact = new Map(Object.values(all).map(g => [(g.name || g.id || '').trim(), g.id]));
  const byNorm  = new Map(Object.values(all).map(g => [normalizeStr(g.name || g.id || ''), g.id]));

  const out = [];
  for (const entry of inputs) {
    if (!entry) continue;
    if (typeof entry === 'string' && entry.endsWith('@g.us')) { out.push(entry); continue; }
    const s = String(entry).trim();
    const ex = byExact.get(s); if (ex) { out.push(ex); continue; }
    const nx = byNorm.get(normalizeStr(s)); if (nx) { out.push(nx); continue; }
  }
  // unique, valid group jids
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
      const groupName = u.allGroups?.[jid]?.name || jid;
      try {
        if (messageContent.text !== undefined) {
          await sendToOneWithRetry(sock, jid, { text: withFooter(messageContent.text) });
        } else {
          if (!fs.existsSync(messageContent.image.url)) return { success:false, jid, groupName, skipped:true, error:'File not found' };
          const raw = fs.readFileSync(messageContent.image.url);
          let buf = raw, mime;
          try { const { buffer, mimetype } = await normaliseImage(raw); buf = buffer; mime = mimetype; } catch {}
          const payload = { image: buf, caption: withFooter(messageContent.caption || '') };
          if (mime) payload.mimetype = mime;
          await sendToOneWithRetry(sock, jid, payload);
        }
        return { success:true, jid, groupName };
      } catch (e) {
        return { success:false, jid, groupName, error:String(e?.message||e) };
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

/* --------------------------- command handling --------------------------- */

function extractNumericChoice(text) {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
}

function parseArgs(str) {
  // naive split, allow quotes later if you want — for now split by space
  return String(str || '').trim().split(/\s+/).filter(Boolean);
}

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

  // Per-phone isolation: if owner changed (different phone/number), reset state
  ensureOwnerConsistency(username, selfBare);

  // Basic system echo ignore
  if (fromMe) {
    if (!body || [
      '✅ Connected!', 'Text mode activated', 'Media mode activated',
      'Scanning groups', 'Choose a category', 'Bot Status:',
      'Broadcasting', 'Broadcast Complete', 'Done. Send another',
      'Image saved', 'Cancelled', 'timed out', 'No groups found',
      'Invalid category'
    ].some(t => body.includes(t))) return;
  }

  // ensure maps loaded (after isolation)
  const p = getUserPaths(username);
  if (!u.categories || !Object.keys(u.categories).length) u.categories = readJSON(p.categories, {});
  if (!u.allGroups  || !Object.keys(u.allGroups).length)  u.allGroups  = readJSON(p.groups, {});
  if (!u.mode) u.mode = 'media';

  /* ---------------------- commands: utility/help ---------------------- */

  if (body === '/help') {
    const help = [
      '✅ *Commands*',
      '• /help — show this help',
      '• /rescan — refresh your groups & auto-categorise new ones',
      '• /cats — show categories & pick where to send',
      '• /text — switch to text mode',
      '• /media — switch to image mode',
      '• /addcategory <Name> — create an empty category (no spaces recommended)',
      '• /addgroup <Category> <GroupName|JID> — add a group to a category',
      '• /delgroup <Category> <GroupName|JID> — remove group from a category',
      '• /listcats — list categories with counts',
      '• /resetcats — wipe all categories for this phone',
      '• /stop — cancel current/next broadcast',
      '',
      '*Usage*:',
      '1) /media then send an image (or /text then type your message)',
      '2) Bot shows categories → reply with the number',
      '3) Broadcast runs in batches with progress updates'
    ].join('\n');
    return await sendSys(username, sock, selfBare + '@s.whatsapp.net', { text: help });
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

  if (body.startsWith('/addgroup ')) {
    const args = parseArgs(body.slice(9));
    const category = args.shift();
    const groupRaw = args.join(' ');
    if (!category || !groupRaw) {
      return await sendSys(username, sock, chatJid, { text: '❌ Usage: /addgroup <Category> <GroupName|JID>' });
    }
    if (!u.categories?.[category]) return await sendSys(username, sock, chatJid, { text: `❌ Category "${category}" does not exist.` });

    const jids = resolveToJids(username, [groupRaw]);
    if (!jids.length) return await sendSys(username, sock, chatJid, { text: `❌ Could not find a group matching "${groupRaw}".` });

    const set = new Set(u.categories[category] || []);
    jids.forEach(j => set.add(j));
    u.categories[category] = Array.from(set);
    persistNow(username);
    const names = jids.map(j => u.allGroups?.[j]?.name || j);
    return await sendSys(username, sock, chatJid, { text: `✅ Added to *${category}*: \n- ${names.join('\n- ')}` });
  }

  if (body.startsWith('/delgroup ')) {
    const args = parseArgs(body.slice(9));
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

  if (body === '/resetcats') {
    u.categories = {};
    persistNow(username);
    return await sendSys(username, sock, chatJid, { text: '🧹 Categories reset for this phone.' });
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

  /* ----------- category selection (numbers) has priority ---------------- */

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
      await sendSys(username, sock, chatJid, { text: `Broadcasting *text* to ${jids.length} group(s) in batches of ${BATCH_SIZE}...` });
      await sendInBatches(sock, username, chatJid, jids, { text: u.pendingText });
      await sendSys(username, sock, chatJid, { text: `✏️ Done. Send another message, or /media to switch.` });
      u.pendingText = null;
      u.awaitingPayload = 'text';
    } else if (u.pendingImage) {
      const imagePath = u.pendingImage?.filePath;
      if (!imagePath || !fs.existsSync(imagePath)) {
        await sendSys(username, sock, chatJid, { text: '⚠️ Could not find saved image. Please resend it.' });
      } else {
        await sendSys(username, sock, chatJid, { text: `Broadcasting *image* to ${jids.length} group(s) in batches of ${BATCH_SIZE}...` });
        await sendInBatches(sock, username, chatJid, jids, { image: { url: imagePath }, caption: u.pendingImage.caption || '' });
        await sendSys(username, sock, chatJid, { text: `🖼️ Done. Send another image, or /text to switch.` });
        try { fs.unlinkSync(imagePath); } catch {}
      }
      u.pendingImage = null;
      u.awaitingPayload = null;
    }

    u.lastPromptChat = null;
    u.awaitingCategory = false;
    return;
  }

  /* ----------- capture content (when not awaiting category) ------------- */

  if (u.mode === 'text' && body && !body.startsWith('/' ) && !u.awaitingCategory) {
    u.pendingText = body;
    u.awaitingPayload = null;
    u.pendingImage = null;
    u.lastPromptChat = chatJid;
    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => notifyAndResetOnTimeout(username, sock, chatJid), INTERACTION_TIMEOUT_MS);
    return await sendSys(username, sock, chatJid, { text });
  }

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

    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => notifyAndResetOnTimeout(username, sock, chatJid), INTERACTION_TIMEOUT_MS);
    return await sendSys(username, sock, chatJid, { text: `✅ Image saved!\n\n${text}` });
  }

  // gentle nudge
  if (body && !body.startsWith('/')) {
    if (u.mode === 'text' && !u.awaitingCategory) {
      u.pendingText = body;
      u.lastPromptChat = chatJid;
      const { text } = buildCategoryPrompt(username);
      u.awaitingCategory = true;
      if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
      u.categoryTimeout = setTimeout(() => notifyAndResetOnTimeout(username, sock, chatJid), INTERACTION_TIMEOUT_MS);
      return await sendSys(username, sock, chatJid, { text });
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
