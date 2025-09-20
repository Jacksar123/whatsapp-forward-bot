// lib/broadcast.js
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

const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes to pick a category
const FOOTER = '— Sent automatically via whats-broadcast-hub.lovable.app';
const MAX_NAMES_PER_CATEGORY = 30;

const SEND_MAX_RETRIES = 3;       // per target
const SEND_TIMEOUT_MS  = 20_000;  // hard timeout so a bad send can’t stall the loop
const SMALL_DELAY_MS   = 300;     // tiny delay between sends (keeps WA happy)

/* --------------------------- small helpers ------------------------------ */

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

/* ----------------------------- persistence ------------------------------ */

function mirrorToDisk(username) {
  const u = USERSG()[username];
  if (!u) return;
  const p = getUserPaths(username);
  try {
    writeJSON(p.categories, u.categories || {});
    writeJSON(p.groups, u.allGroups || {});
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
  const u = USERSG()[username] || (USERSG()[username] = {});
  if (!u.ignoreIds) u.ignoreIds = new Set();

  const send = sock.safeSend ? sock.safeSend.bind(sock) : sock.sendMessage.bind(sock);
  try {
    const res = await send(jid, content);
    const id = res?.key?.id;
    if (id) {
      u.ignoreIds.add(id);
      if (u.ignoreIds.size > 200) {
        const it = u.ignoreIds.values();
        for (let i = 0; i < 120; i++) { const v = it.next(); if (v.done) break; u.ignoreIds.delete(v.value); }
      }
    }
    return res;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/SOCKET_NOT_OPEN|Connection Closed|stream closed/i.test(msg)) return null; // socket died: ignore sys msgs
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

/* -------------------------- scan & categorise --------------------------- */

async function autoScanAndCategorise(username, sock) {
  const u = USERSG()[username] || (USERSG()[username] = {});
  const metaMap = await sock.groupFetchAllParticipating();
  const groups = Object.values(metaMap || {});
  const p = getUserPaths(username);

  const existingCats = Object.keys(u.categories || {}).length
    ? (u.categories || {})
    : readJSON(p.categories, {});
  const allGroups = Object.keys(u.allGroups || {}).length
    ? (u.allGroups || {})
    : readJSON(p.groups, {});

  for (const g of groups) {
    const name = g.subject || g.name || g.id;
    allGroups[g.id] = { id: g.id, name };
    const already = Object.values(existingCats).some(list => (list || []).includes(g.id));
    if (!already) {
      const guess = categoriseGroupName(name);
      if (guess) (existingCats[guess] ||= []).push(g.id);
    }
  }

  u.allGroups = allGroups;
  u.categories = existingCats;
  persistNow(username);
  console.log(`[${username}] ✅ Auto-scan complete. Groups: ${Object.keys(allGroups).length}`);
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

async function safeDownloadMedia(msg, sock, retries = 8, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const buffer = await downloadMediaMessage(
        msg, 'buffer', {},
        { logger: sock.logger, reuploadRequest: sock.updateMediaMessage.bind(sock) }
      );
      if (buffer?.length) return buffer;
    } catch {}
    if (i < retries - 1) await sleep(delay);
  }
  return null;
}

/* ------------------------------ warm-up -------------------------------- */

async function warmSessionsForGroup(sock, jid) {
  try {
    const meta = await Promise.race([
      sock.groupMetadata(jid),
      new Promise((_, r) => setTimeout(() => r(new Error('META_TIMEOUT')), 4000))
    ]);
    if (!meta || meta instanceof Error) return 0;
    const jids = (meta.participants || []).map(p => p.id || p.jid || p).filter(Boolean);
    if (typeof sock.assertSessions === 'function' && jids.length) {
      await Promise.race([
        sock.assertSessions(jids, true),
        new Promise((_, r) => setTimeout(() => r(new Error('ASSERT_TIMEOUT')), 4000))
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
      // hard timeout guard
      return await Promise.race([
        sendPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT:${jid}`)), SEND_TIMEOUT_MS))
      ]);
    } catch (err) {
      const msg = String(err?.message || err);

      // if socket died, surface it to stop the run (index handles reconnect)
      if (/SOCKET_NOT_OPEN|Connection Closed|stream closed/i.test(msg)) throw err;

      // first not-acceptable / No sessions → warm once
      if (/not-acceptable|No sessions/i.test(msg) && !warmed) {
        warmed = true;
        await warmSessionsForGroup(sock, jid).catch(()=>{});
        await sleep(300);
        continue; // retry same attempt number
      }

      attempt++;
      if (attempt > SEND_MAX_RETRIES) throw err;

      const backoff = 600 * attempt + Math.floor(Math.random() * 250);
      console.warn(`[send] retry ${attempt} for ${jid} after ${backoff}ms: ${msg}`);
      await sleep(backoff);
    }
  }
}

/* ------------------------------ batch send ------------------------------ */

async function sendInBatches(sock, username, from, jids, messageContent) {
  const u = USERSG()[username];
  let sent = 0;

  for (const jid of jids) {
    if (isCancelled(u)) break;

    // stop cleanly if socket closed mid-run
    if (!u?.socketActive) {
      await sendSys(username, sock, from, { text: '⚠️ Socket closed during broadcast. Stopping.' }).catch(()=>{});
      break;
    }

    try {
      if (messageContent.text !== undefined) {
        await sendToOneWithRetry(sock, jid, { text: withFooter(messageContent.text) });
      } else if (messageContent.image?.url) {
        const raw = fs.readFileSync(messageContent.image.url);
        let buf = raw, mime;
        try { const { buffer, mimetype } = await normaliseImage(raw); buf = buffer; mime = mimetype; } catch {}
        const payload = { image: buf, caption: withFooter(messageContent.caption || '') };
        if (mime) payload.mimetype = mime;
        await sendToOneWithRetry(sock, jid, payload);
      } else {
        console.warn(`[${username}] No valid messageContent for ${jid}`);
      }
      console.log(`[${username}] ✅ Sent to ${jid}`);
      sent++;
    } catch (e) {
      console.warn(`[${username}] ❌ Failed to send to ${jid}: ${e?.message || e}`);
      // if socket died, stop loop; reconnect will be handled by index
      if (/SOCKET_NOT_OPEN|Connection Closed|stream closed/i.test(String(e?.message || e))) break;
    }

    await sleep(SMALL_DELAY_MS);
  }

  await sendSys(username, sock, from, { text: `🎉 Broadcast finished. Sent to ${sent}/${jids.length}.` }).catch(()=>{});
  clearCancel(u);
}

/* --------------------------- command handling --------------------------- */

function extractNumericChoice(text) {
  return text && /^\d+$/.test(text.trim()) ? parseInt(text.trim(), 10) : null;
}

async function handleBroadcastMessage(username, msg, sock) {
  const USERS = USERSG();
  const u = USERS[username] || (USERS[username] = {});
  const chatJid = normaliseJid(msg.key.remoteJid);

  // ignore groups; this bot is DM-driven
  if (chatJid.endsWith('@g.us')) return;

  const selfBare = bareJid(sock?.user?.id || '');
  const chatBare = bareJid(chatJid);

  // lock owner on first message; greet
  if (!u.ownerJid) {
    u.ownerJid = chatBare === selfBare ? selfBare : chatJid;
    u.mode = u.mode || 'media';
    await sendSys(username, sock, u.ownerJid, {
      text:
        `✅ Connected.\n\n` +
        `Commands:\n` +
        `• /text — switch to text mode\n` +
        `• /media — switch to image mode\n` +
        `• /cats — pick a category to send to\n` +
        `• /rescan — refresh your groups\n\n` +
        `Now send a message (in /text) or an image (in /media) to broadcast.`
    });
  }

  const ownerBare = bareJid(u.ownerJid);
  if (chatBare !== ownerBare) return;

  // anti-echo
  if (u.ignoreIds && msg.key?.id && u.ignoreIds.has(msg.key.id)) {
    u.ignoreIds.delete(msg.key.id);
    return;
  }

  const body = getMessageText(msg).trim();

  // ensure maps loaded
  const p = getUserPaths(username);
  if (!u.categories || !Object.keys(u.categories).length) u.categories = readJSON(p.categories, {});
  if (!u.allGroups  || !Object.keys(u.allGroups).length)  u.allGroups  = readJSON(p.groups, {});

  /* ----------- commands ----------- */

  if (body === '/rescan' || body === '/syncgroups') {
    await autoScanAndCategorise(username, sock);
    return await sendSys(username, sock, ownerBare, { text: '✅ Rescanned and categorised groups.' });
  }

  if (body === '/text') {
    u.mode = 'text';
    u.pendingImage = null;
    u.awaitingPayload = 'text';
    return await sendSys(username, sock, ownerBare, { text: `✍️ Type the message you want to broadcast and press Send.` });
  }

  if (body === '/media') {
    u.mode = 'media';
    u.pendingText = null;
    u.awaitingPayload = null;
    return await sendSys(username, sock, ownerBare, { text: `🖼️ Send an image to start a broadcast. (/text to switch)` });
  }

  if (body === '/cats') {
    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    u.lastPromptChat = ownerBare;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(username, sock, ownerBare);
    }, INTERACTION_TIMEOUT_MS);
    return await sendSys(username, sock, ownerBare, { text });
  }

  if (body === '/stop') {
    requestCancel(u);
    u.pendingText = null;
    u.pendingImage = null;
    u.awaitingPayload = null;
    u.lastPromptChat = null;
    u.awaitingCategory = false;
    if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
    return await sendSys(username, sock, ownerBare, { text: `🛑 Broadcast cancellation requested. Finishing current send safely…` });
  }

  /* ----------- capture content ----------- */

  // TEXT MODE: capture body as pending text
  if (u.mode === 'text' && body && !body.startsWith('/')) {
    u.pendingText = body;
    u.awaitingPayload = null;
    u.pendingImage = null;
    u.lastPromptChat = ownerBare;

    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(username, sock, ownerBare);
    }, INTERACTION_TIMEOUT_MS);

    return await sendSys(username, sock, ownerBare, { text });
  }

  // MEDIA MODE: save image to temp & prompt
  if (u.mode === 'media' && hasImage(msg)) {
    const buffer = await safeDownloadMedia(msg, sock, 8, 3000);
    if (!buffer?.length) {
      return await sendSys(username, sock, ownerBare, { text: '❌ Failed to download image (media not ready).' });
    }

    const caption = getContent(msg)?.imageMessage?.caption || '';
    const up = getUserPaths(username);
    ensureDir(up.tmp);
    const filePath = path.join(up.tmp, `image_${Date.now()}`);

    try {
      fs.writeFileSync(filePath, buffer);
      try { buffer.fill(0); } catch {}
    } catch (e) {
      return await sendSys(username, sock, ownerBare, { text: `❌ Failed to save image: ${e.message}` });
    }

    u.pendingText = null;
    u.pendingImage = { filePath, caption };
    u.awaitingPayload = null;
    u.lastPromptChat = ownerBare;

    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(username, sock, ownerBare);
    }, INTERACTION_TIMEOUT_MS);

    return await sendSys(username, sock, ownerBare, { text });
  }

  /* ----------- numeric category selection ----------- */

  const maybeNum = extractNumericChoice(body);
  if (maybeNum && u.lastPromptChat === ownerBare && u.awaitingCategory && (u.pendingImage || u.pendingText)) {
    const { mapping, totalOptions } = buildCategoryPrompt(username);
    const n = parseInt(maybeNum, 10);
    if (!Number.isInteger(n) || n < 1 || n > totalOptions) {
      return await sendSys(username, sock, ownerBare, { text: '❌ Invalid category number. Try again.' });
    }

    const chosen = mapping[n];
    const rawList = chosen === '__ALL__'
      ? Object.keys(u.allGroups || {})
      : (u.categories[chosen] || []);
    const jids = (rawList || []).filter(Boolean);

    if (!jids.length) {
      return await sendSys(username, sock, ownerBare, { text: 'No valid groups in that category.' });
    }

    // run
    if (u.mode === 'text' && u.pendingText) {
      await sendSys(username, sock, ownerBare, { text: `Broadcasting *text* to ${jids.length} group(s)…` });
      await sendInBatches(sock, username, ownerBare, jids, { text: u.pendingText });
      await sendSys(username, sock, ownerBare, { text: `✍️ Done. Send another message, or /media to switch.` });
      u.pendingText = null;
      u.awaitingPayload = 'text';
    } else if (u.pendingImage) {
      const imagePath = u.pendingImage?.filePath;
      if (!imagePath || !fs.existsSync(imagePath)) {
        await sendSys(username, sock, ownerBare, { text: '⚠️ Could not find saved image. Please resend it.' });
      } else {
        await sendSys(username, sock, ownerBare, { text: `Broadcasting *image* to ${jids.length} group(s)…` });
        await sendInBatches(
          sock, username, ownerBare, jids,
          { image: { url: imagePath }, caption: u.pendingImage.caption || '' }
        );
        await sendSys(username, sock, ownerBare, { text: `🖼️ Done. Send another image, or /text to switch.` });
      }
      u.pendingImage = null;
      u.awaitingPayload = null;
    }

    u.lastPromptChat = null;
    u.awaitingCategory = false;
  }
}

/* ------------------------- timeout helper ------------------------------- */

async function notifyAndResetOnTimeout(username, sock, ownerJid) {
  try {
    await sendSys(username, sock, ownerJid, {
      text:
        `⏱️ Your category selection timed out (30 minutes).\n` +
        `Send /cats again whenever you’re ready.`
    });
  } catch {}
  const u = USERSG()[username];
  if (!u) return;
  if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
  u.awaitingCategory = false;
}

/* ------------------------------- exports -------------------------------- */

module.exports = {
  autoScanAndCategorise,
  buildCategoryPrompt,
  sendInBatches,
  handleBroadcastMessage,
  categoriseGroupName
};
