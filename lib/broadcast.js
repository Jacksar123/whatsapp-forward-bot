// lib/broadcast.js - Complete WhatsApp broadcast system (fixed participant detection)
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

// More conservative sending to avoid WhatsApp rate limits
const SEND_MAX_RETRIES = 5;       
const SEND_TIMEOUT_MS = 45_000;   // 45 second timeout
const SMALL_DELAY_MS = 3000;      // 3 seconds between sends
const WARM_DELAY_MS = 2000;       // 2 seconds after session warming

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

/* -------------------------- scan & categorise --------------------------- */

async function autoScanAndCategorise(username, sock) {
  const u = USERSG()[username] || (USERSG()[username] = {});
  
  try {
    console.log(`[${username}] Starting group scan...`);
    const metaMap = await sock.groupFetchAllParticipating();
    const groups = Object.values(metaMap || {});
    const p = getUserPaths(username);

    const existingCats = Object.keys(u.categories || {}).length
      ? (u.categories || {})
      : readJSON(p.categories, {});
    const allGroups = Object.keys(u.allGroups || {}).length
      ? (u.allGroups || {})
      : readJSON(p.groups, {});

    let newGroups = 0;
    for (const g of groups) {
      const name = g.subject || g.name || g.id;
      if (!allGroups[g.id]) {
        newGroups++;
      }
      allGroups[g.id] = { id: g.id, name };
      
      // Auto-categorize only new groups
      const already = Object.values(existingCats).some(list => (list || []).includes(g.id));
      if (!already) {
        const guess = categoriseGroupName(name);
        if (guess) {
          (existingCats[guess] ||= []).push(g.id);
          console.log(`[${username}] Auto-categorized "${name}" as ${guess}`);
        }
      }
    }

    u.allGroups = allGroups;
    u.categories = existingCats;
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
  if (!u || !u.categories || !u.allGroups) {
    return { kept: 0, fixed: 0, dropped: 0 };
  }

  let kept = 0, fixed = 0, dropped = 0;
  const validJids = new Set(Object.keys(u.allGroups));
  
  for (const [catName, jidList] of Object.entries(u.categories)) {
    if (!Array.isArray(jidList)) continue;
    
    const originalLength = jidList.length;
    const cleanedList = jidList.filter(jid => {
      if (validJids.has(jid)) {
        kept++;
        return true;
      } else {
        dropped++;
        console.log(`[${username}] Removing stale JID ${jid} from category ${catName}`);
        return false;
      }
    });
    
    if (cleanedList.length !== originalLength) {
      u.categories[catName] = cleanedList;
      fixed++;
    }
  }
  
  persistNow(username);
  return { kept, fixed, dropped };
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
      console.log(`[media] Download attempt ${i + 1}/${retries}`);
      const buffer = await downloadMediaMessage(
        msg, 'buffer', {},
        { logger: sock.logger, reuploadRequest: sock.updateMediaMessage.bind(sock) }
      );
      if (buffer?.length) {
        console.log(`[media] Successfully downloaded ${buffer.length} bytes`);
        return buffer;
      }
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
    console.log(`[warm] Warming sessions for group ${jid}`);
    
    const meta = await Promise.race([
      sock.groupMetadata(jid),
      new Promise((_, r) => setTimeout(() => r(new Error('META_TIMEOUT')), 8000))
    ]);
    
    if (!meta || meta instanceof Error) {
      console.warn(`[warm] Could not get metadata for ${jid}: ${meta?.message || 'timeout'}`);
      return 0;
    }
    
    const jids = (meta.participants || []).map(p => p.id || p.jid || p).filter(Boolean);
    console.log(`[warm] Group ${jid}: ${jids.length} participants`);
    
    if (typeof sock.assertSessions === 'function' && jids.length) {
      await Promise.race([
        sock.assertSessions(jids, true),
        new Promise((_, r) => setTimeout(() => r(new Error('ASSERT_TIMEOUT')), 10000))
      ]);
      console.log(`[warm] Sessions warmed for ${jids.length} participants in ${jid}`);
      return jids.length;
    }
  } catch (e) {
    console.warn(`[warm] Failed to warm sessions for ${jid}: ${e.message}`);
  }
  return 0;
}

/* ----------------------- send with retry/timeout ------------------------ */

async function sendToOneWithRetry(sock, jid, payload) {
  let attempt = 0, warmed = false;

  while (attempt <= SEND_MAX_RETRIES) {
    try {
      console.log(`[send] Attempting to send to ${jid} (attempt ${attempt + 1}/${SEND_MAX_RETRIES + 1})`);
      
      const sendPromise = sock.safeSend ? sock.safeSend(jid, payload) : sock.sendMessage(jid, payload);
      const result = await Promise.race([
        sendPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT:${jid}`)), SEND_TIMEOUT_MS))
      ]);
      
      console.log(`[send] ✅ Successfully sent to ${jid}`);
      return result;
      
    } catch (err) {
      const msg = String(err?.message || err);
      console.log(`[send] ❌ Attempt ${attempt + 1} failed for ${jid}: ${msg}`);

      // Socket died - surface it to stop the run
      if (/SOCKET_NOT_OPEN|Connection Closed|stream closed/i.test(msg)) {
        console.error(`[send] Socket closed, aborting send attempts`);
        throw err;
      }

      // Handle WhatsApp-specific errors
      if (/not-acceptable|forbidden|unauthorized|No sessions/i.test(msg)) {
        // Try warming sessions once
        if (!warmed) {
          warmed = true;
          console.log(`[send] Warming sessions for ${jid}...`);
          const warmedCount = await warmSessionsForGroup(sock, jid).catch(e => {
            console.warn(`[send] Session warming failed: ${e.message}`);
            return 0;
          });
          
          if (warmedCount > 0) {
            console.log(`[send] Warmed ${warmedCount} sessions, waiting before retry...`);
            await sleep(WARM_DELAY_MS);
            continue; // Don't increment attempt counter
          }
        }
      }

      // Handle rate limiting
      if (/rate|limit|too many|slow down/i.test(msg)) {
        const rateLimitDelay = 10000 + (attempt * 5000);
        console.warn(`[send] Rate limit detected, waiting ${rateLimitDelay}ms`);
        await sleep(rateLimitDelay);
      }

      attempt++;
      if (attempt > SEND_MAX_RETRIES) {
        console.error(`[send] Max retries (${SEND_MAX_RETRIES}) exceeded for ${jid}`);
        throw err;
      }

      // Progressive backoff with jitter
      const baseDelay = Math.min(2000 * Math.pow(2, attempt), 15000);
      const jitter = Math.floor(Math.random() * 2000);
      const backoff = baseDelay + jitter;
      
      console.warn(`[send] Retry ${attempt} for ${jid} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

/* ------------------------------ batch send ------------------------------ */

async function sendInBatches(sock, username, from, jids, messageContent) {
  const u = USERSG()[username];
  let sent = 0, failed = 0, skipped = 0;
  const errors = [];
  const startTime = Date.now();

  console.log(`[batch] Starting broadcast to ${jids.length} groups for user ${username}`);

  // Pre-validate message content
  if (!messageContent.text && !messageContent.image?.url) {
    await sendSys(username, sock, from, { text: 'Error: No valid content to broadcast' }).catch(()=>{});
    return;
  }

  for (let i = 0; i < jids.length; i++) {
    const jid = jids[i];
    const groupName = u.allGroups?.[jid]?.name || jid;
    
    // Check for cancellation
    if (isCancelled(u)) {
      console.log(`[batch] Broadcast cancelled by user at ${i}/${jids.length}`);
      await sendSys(username, sock, from, { 
        text: `🛑 Broadcast cancelled. Sent: ${sent}, Failed: ${failed}` 
      }).catch(()=>{});
      break;
    }

    // Check socket health
    if (!u?.socketActive) {
      console.error(`[batch] Socket not active, stopping broadcast`);
      await sendSys(username, sock, from, { 
        text: `⚠️ Connection lost during broadcast. Sent: ${sent}, Failed: ${failed}` 
      }).catch(()=>{});
      break;
    }

    try {
      console.log(`[batch] Sending to "${groupName}" (${i + 1}/${jids.length})`);
      
      if (messageContent.text !== undefined) {
        await sendToOneWithRetry(sock, jid, { text: withFooter(messageContent.text) });
      } else if (messageContent.image?.url) {
        if (!fs.existsSync(messageContent.image.url)) {
          console.error(`[batch] Image file not found: ${messageContent.image.url}`);
          skipped++;
          continue;
        }
        
        const raw = fs.readFileSync(messageContent.image.url);
        let buf = raw, mime;
        
        try { 
          const { buffer, mimetype } = await normaliseImage(raw); 
          buf = buffer; 
          mime = mimetype; 
          console.log(`[batch] Image normalized: ${raw.length} -> ${buffer.length} bytes, ${mimetype}`);
        } catch (e) {
          console.warn(`[batch] Image normalization failed for ${jid}, using raw: ${e.message}`);
        }
        
        const payload = { image: buf, caption: withFooter(messageContent.caption || '') };
        if (mime) payload.mimetype = mime;
        await sendToOneWithRetry(sock, jid, payload);
      }
      
      sent++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[batch] ✅ ${sent}/${jids.length} sent (${elapsed}s elapsed)`);
      
    } catch (e) {
      failed++;
      const errorMsg = String(e?.message || e);
      errors.push({ jid, groupName, error: errorMsg });
      console.warn(`[batch] ❌ Failed "${groupName}": ${errorMsg}`);
      
      // Stop if socket died
      if (/SOCKET_NOT_OPEN|Connection Closed|stream closed/i.test(errorMsg)) {
        console.error(`[batch] Socket died, stopping broadcast`);
        break;
      }
    }

    // Rate limiting delay between sends
    if (i < jids.length - 1) {
      await sleep(SMALL_DELAY_MS);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const successRate = jids.length ? Math.round((sent/jids.length) * 100) : 0;

  // Send detailed completion report
  const report = [
    `📊 Broadcast Complete (${totalTime}s):`,
    `✅ Sent: ${sent}`,
    `❌ Failed: ${failed}`,
    `⏭️ Skipped: ${skipped}`,
    `📈 Success Rate: ${successRate}%`
  ];

  if (errors.length > 0 && errors.length <= 3) {
    report.push(`\nRecent errors:`);
    errors.slice(-3).forEach(({groupName, error}) => {
      const shortError = error.includes(':') ? error.split(':')[0] : error.substring(0, 30);
      report.push(`• ${groupName}: ${shortError}`);
    });
  } else if (errors.length > 3) {
    report.push(`\n${errors.length} groups failed (check server logs)`);
  }

  await sendSys(username, sock, from, { text: report.join('\n') }).catch(()=>{});
  clearCancel(u);
}

/* --------------------------- command handling --------------------------- */

function extractNumericChoice(text) {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
}

async function handleBroadcastMessage(username, msg, sock) {
  const USERS = USERSG();
  const u = USERS[username] || (USERS[username] = {});
  const chatJid = normaliseJid(msg.key.remoteJid);

  // DEBUG: Enhanced logging
  const body = getMessageText(msg).trim();
  const fromMe = msg.key?.fromMe;
  console.log(`[msg] ${username}: chat=${chatJid} fromMe=${fromMe} body="${body.substring(0, 30)}${body.length > 30 ? '...' : ''}"`);

  // ignore groups; this bot is DM-driven
  if (chatJid.endsWith('@g.us')) {
    console.log(`[msg] ${username}: Ignoring group message`);
    return;
  }

  const selfBare = bareJid(sock?.user?.id || '');
  const chatBare = bareJid(chatJid);

  // lock owner on first message; greet
  if (!u.ownerJid) {
    u.ownerJid = chatBare === selfBare ? selfBare : chatJid;
    u.mode = u.mode || 'media';
    console.log(`[msg] ${username}: Set owner to ${u.ownerJid}`);
    
    await sendSys(username, sock, u.ownerJid, {
      text:
        `✅ WhatsApp Bot Connected!\n\n` +
        `Commands:\n` +
        `• /text — switch to text mode\n` +
        `• /media — switch to image mode\n` +
        `• /cats — pick categories to broadcast to\n` +
        `• /rescan — refresh group list\n` +
        `• /test — test bot functionality\n\n` +
        `Current mode: ${u.mode}\n` +
        `Send a message or image to start broadcasting.`
    });
    return;
  }

  const ownerBare = bareJid(u.ownerJid);
  if (chatBare !== ownerBare) {
    console.log(`[msg] ${username}: Message not from owner (${chatBare} vs ${ownerBare})`);
    return;
  }

  // anti-echo
  if (u.ignoreIds && msg.key?.id && u.ignoreIds.has(msg.key.id)) {
    console.log(`[msg] ${username}: Ignoring echo message`);
    u.ignoreIds.delete(msg.key.id);
    return;
  }

  // ensure maps loaded
  const p = getUserPaths(username);
  if (!u.categories || !Object.keys(u.categories).length) u.categories = readJSON(p.categories, {});
  if (!u.allGroups  || !Object.keys(u.allGroups).length)  u.allGroups  = readJSON(p.groups, {});

  console.log(`[msg] ${username}: Processing command/message: "${body}"`);

  /* ----------- commands ----------- */

  if (body === '/rescan' || body === '/syncgroups') {
    await sendSys(username, sock, ownerBare, { text: 'Scanning groups...' });
    await autoScanAndCategorise(username, sock);
    const groupCount = Object.keys(u.allGroups || {}).length;
    return await sendSys(username, sock, ownerBare, { text: `✅ Found ${groupCount} groups and auto-categorized them.` });
  }

  if (body === '/text') {
    u.mode = 'text';
    u.pendingImage = null;
    u.awaitingPayload = 'text';
    return await sendSys(username, sock, ownerBare, { text: `✍️ Text mode activated. Type your message and press Send.` });
  }

  if (body === '/media') {
    u.mode = 'media';
    u.pendingText = null;
    u.awaitingPayload = null;
    return await sendSys(username, sock, ownerBare, { text: `🖼️ Media mode activated. Send an image to broadcast.` });
  }

  if (body === '/cats') {
    const groupCount = Object.keys(u.allGroups || {}).length;
    if (groupCount === 0) {
      return await sendSys(username, sock, ownerBare, { text: 'No groups found. Use /rescan to refresh your group list first.' });
    }
    
    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    u.lastPromptChat = ownerBare;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(username, sock, ownerBare);
    }, INTERACTION_TIMEOUT_MS);
    return await sendSys(username, sock, ownerBare, { text });
  }

  if (body === '/test') {
    const groupCount = Object.keys(u.allGroups || {}).length;
    const catCount = Object.keys(u.categories || {}).length;
    return await sendSys(username, sock, ownerBare, { 
      text: `🧪 Bot Status:\n` +
            `• Connected: ✅\n` +
            `• Groups found: ${groupCount}\n` +
            `• Categories: ${catCount}\n` +
            `• Mode: ${u.mode}\n` +
            `• Owner: ${ownerBare}\n\n` +
            `Bot is working correctly!`
    });
  }

  if (body === '/stop' || body === '/cancel') {
    requestCancel(u);
    u.pendingText = null;
    u.pendingImage = null;
    u.awaitingPayload = null;
    u.lastPromptChat = null;
    u.awaitingCategory = false;
    if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
    return await sendSys(username, sock, ownerBare, { text: `🛑 Cancelled. Any ongoing broadcast will finish safely.` });
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
    await sendSys(username, sock, ownerBare, { text: '⬇️ Downloading image...' });
    
    const buffer = await safeDownloadMedia(msg, sock, 8, 3000);
    if (!buffer?.length) {
      return await sendSys(username, sock, ownerBare, { text: '❌ Failed to download image. Please try again.' });
    }

    const caption = getContent(msg)?.imageMessage?.caption || '';
    const up = getUserPaths(username);
    ensureDir(up.tmp);
    const filePath = path.join(up.tmp, `image_${Date.now()}.jpg`);

    try {
      fs.writeFileSync(filePath, buffer);
      console.log(`[media] Saved image to ${filePath} (${buffer.length} bytes)`);
      
      // Clear buffer from memory for security
      try { buffer.fill(0); } catch {}
    } catch (e) {
      console.error(`[media] Failed to save image: ${e.message}`);
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

    return await sendSys(username, sock, ownerBare, { text: `✅ Image saved!\n\n${text}` });
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

    // Clear timeout
    if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }

    // run broadcast
    if (u.mode === 'text' && u.pendingText) {
      await sendSys(username, sock, ownerBare, { text: `Broadcasting *text* to ${jids.length} group(s)...` });
      await sendInBatches(sock, username, ownerBare, jids, { text: u.pendingText });
      await sendSys(username, sock, ownerBare, { text: `✍️ Done. Send another message, or /media to switch.` });
      u.pendingText = null;
      u.awaitingPayload = 'text';
    } else if (u.pendingImage) {
      const imagePath = u.pendingImage?.filePath;
      if (!imagePath || !fs.existsSync(imagePath)) {
        await sendSys(username, sock, ownerBare, { text: '⚠️ Could not find saved image. Please resend it.' });
      } else {
        await sendSys(username, sock, ownerBare, { text: `Broadcasting *image* to ${jids.length} group(s)...` });
        await sendInBatches(
          sock, username, ownerBare, jids,
          { image: { url: imagePath }, caption: u.pendingImage.caption || '' }
        );
        await sendSys(username, sock, ownerBare, { text: `🖼️ Done. Send another image, or /text to switch.` });
        // Clean up the temp file
        try { fs.unlinkSync(imagePath); } catch {}
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
        `Send /cats again whenever you're ready.`
    });
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