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

// Pacing: no batch throttle; tiny fixed per-send delay to avoid hammering.
const BATCH_SIZE = 6;                 // groups per batch
const PARALLEL_PER_SLICE = 1;         // keep serialized
const PER_SEND_DELAY_MS = 200;        // short inter-send delay
const BATCH_DELAY_MS = 0;             // no rest between batches

// Reliability: keep retries+hard timeout so we never hang
const SEND_MAX_RETRIES = 3;           // retries per group on failure
const SEND_BACKOFF_MS = 600;          // base backoff (exponential, short)
const SEND_TIMEOUT_MS = 20000;        // hard timeout per send

const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000; // 30 mins to pick a category
const DASHBOARD_URL = "https://whats-broadcast-hub.lovable.app";

const FOOTER = '— Sent automatically via whats-broadcast-hub.lovable.app | 🔥 Free trial available 🔥';
const MAX_NAMES_PER_CATEGORY = 30;

/* --------------------------- adaptive pacing (disabled) ------------------ */
// We’ll still store pacing in u, but we won’t increase sleep. Keep simple.
const DEFAULT_PACING = { batchSize: BATCH_SIZE, parallel: PARALLEL_PER_SLICE, perSendDelay: PER_SEND_DELAY_MS, batchDelay: BATCH_DELAY_MS, lastAdjustAt: 0 };
function pacingFor(u) { if (!u.pacing) u.pacing = { ...DEFAULT_PACING }; return u.pacing; }
function adjustPacing(){ /* no-op: throttling removed on purpose */ }

/* --------------------------- utilities ---------------------------------- */

function USERSG() { return global.USERS || (global.USERS = {}); }

/** Cancel-token helpers (for /stop) */
function cancelFlag(u){ if(!u._cancel) u._cancel={requested:false,at:0}; return u._cancel; }
function isCancelled(u){ return !!(u._cancel && u._cancel.requested); }
function requestCancel(u){ const c=cancelFlag(u); c.requested=true; c.at=Date.now(); }
function clearCancel(u){ const c=cancelFlag(u); c.requested=false; c.at=0; }

/** Strip the device suffix (e.g., ":96") before "@domain". */
function bareJid(j) {
  const s = String(j || '');
  return s.replace(/:[^@]+(?=@)/, '');
}

function withFooter(raw) {
  const text = (raw || '').trim();
  const already = text.toLowerCase().includes('sent automatically via whats-broadcast-hub');
  if (already) return text;
  return text.length ? `${text}\n\n${FOOTER}` : `${FOOTER}`;
}

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rssMB() { try { return process.memoryUsage().rss / 1048576; } catch { return 0; } }

async function guardMemory512() {
  const mb = rssMB();
  if (mb > 440) await sleep(500);
  else if (mb > 400) await sleep(150);
}

/** Hard timeout wrapper: ensures any hung send is failed and the loop continues. */
function withTimeout(promise, ms, tag = 'op') {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`TIMEOUT:${tag}:${ms}ms`)), ms)
    ),
  ]);
}

/* ---------------- message unwrap helpers ---------------- */

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

function extractNumericChoice(msg) {
  const txt = getMessageText(msg);
  return txt && /^\d+$/.test(txt.trim()) ? txt.trim() : null;
}

/* --------------------------- persistence -------------------------------- */

function mirrorToDisk(username) {
  const u = USERSG()[username];
  if (!u) return;
  try {
    const p = getUserPaths(username);
    writeJSON(p.categories, u.categories || {});
    writeJSON(p.groups, u.allGroups || {});
  } catch (e) {
    console.warn(`[${username}] disk mirror failed: ${e?.message || e}`);
  }
}

function persistNow(username) {
  const u = USERSG()[username];
  if (!u) return;
  try {
    saveUserState(username, u.categories || {}, u.allGroups || {});
  } catch (e) {
    console.warn(`[${username}] supabase save failed: ${e?.message || e}`);
  }
  mirrorToDisk(username);
}

/* ---------------------- system send (anti-echo) ------------------------- */

async function sendSys(username, sock, jid, content) {
  const u = USERSG()[username] || (USERSG()[username] = {});
  if (!u.ignoreIds) u.ignoreIds = new Set();

  const send = sock.safeSend ? sock.safeSend.bind(sock) : sock.sendMessage.bind(sock);
  const res = await send(jid, content);
  try {
    const id = res?.key?.id;
    if (id) {
      u.ignoreIds.add(id);
      if (u.ignoreIds.size > 200) {
        const it = u.ignoreIds.values();
        for (let i = 0; i < 120; i++) {
          const v = it.next();
          if (v.done) break;
          u.ignoreIds.delete(v.value);
        }
      }
    }
  } catch {}
  return res;
}

/* ----------------------------- helpers ---------------------------------- */

function normalizeCategoryToJids(catList, allGroups) {
  if (!Array.isArray(catList)) return [];
  const byName = new Map(
    Object.values(allGroups || {}).map(g => [ (g.name || g.subject || g.id || '').trim(), g.id ])
  );
  const out = [];
  for (const entry of catList) {
    if (!entry) continue;
    if (typeof entry === 'string' && entry.endsWith('@g.us')) out.push(entry);
    else if (typeof entry === 'string') {
      const hit = byName.get(entry.trim());
      if (hit) out.push(hit);
    } else if (entry && typeof entry === 'object' && entry.id && entry.id.endsWith('@g.us')) {
      out.push(entry.id);
    }
  }
  return Array.from(new Set(out));
}

/* --------------------------- LIVE FLAGS + WARMUP ------------------------ */

/**
 * Live membership/admin/announce flags — for truthful diagnostics.
 * We DO NOT gate on these; we just surface accurate reasons if WA errors.
 */
async function getLiveGroupFlags(sock, jid) {
  try {
    const meta = await sock.groupMetadata(jid);
    const bot = String(sock?.user?.id || '').replace(/:[^@]+(?=@)/, '');
    const participants = (meta?.participants || []).map(p => String(p.id || p.jid || p));
    const iAmIn = participants.some(p => p.replace(/:[^@]+(?=@)/, '') === bot);
    const iAmAdmin = !!meta?.participants?.find(p => {
      const id = String(p.id || p.jid || p).replace(/:[^@]+(?=@)/, '');
      return id === bot && (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin);
    });
    return { ok: true, announce: !!meta?.announce, iAmIn, iAmAdmin, subject: meta?.subject || meta?.name || jid };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Pre-establish sessions for all participants of a group.
 * Reduces 'not-acceptable'/'No sessions' after fresh link.
 */
async function warmSessionsForGroup(sock, jid) {
  try {
    const meta = await sock.groupMetadata(jid).catch(() => null);
    const jids = (meta?.participants || [])
      .map(p => p.id || p.jid || p)
      .filter(Boolean);
    if (!jids.length) return 0;

    if (typeof sock.assertSessions === 'function') {
      await sock.assertSessions(jids, true);
    } else {
      const ks = sock?.authState?.keys;
      if (ks?.get) {
        await Promise.allSettled([
          ks.get('app-state-sync-key', ['']),
          ...jids.map(id => ks.get('sender-key-memory', [id]))
        ]);
      }
    }
    await sleep(200);
    return jids.length;
  } catch {
    return 0;
  }
}

/* --------------------------- auto scan/categorise ------------------------ */

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
    allGroups[g.id] = { id: g.id, name, subject: name, announce: !!g.announce, size: (g.participants || []).length };
    const already = Object.values(existingCats).some(list => (list || []).includes(g.id));
    if (!already) {
      const guess = categoriseGroupName(name);
      if (guess) {
        if (!existingCats[guess]) existingCats[guess] = [];
        existingCats[guess].push(g.id);
      }
    }
  }

  for (const c of Object.keys(existingCats)) {
    existingCats[c] = normalizeCategoryToJids(existingCats[c], allGroups);
  }

  u.allGroups = allGroups;
  u.categories = existingCats;

  persistNow(username);
  console.log(`[${username}] ✅ Auto-scan complete. Groups: ${Object.keys(allGroups).length}`);
}

/* ------------------------------ prompts --------------------------------- */

function buildCategoryPrompt(username) {
  const { categories = {}, allGroups = {}, mode = 'media' } = USERSG()[username] || {};
  const catNames = Object.keys(categories).sort((a, b) => a.localeCompare(b));

  const lines = [];
  const mapping = {};
  let idx = 1;

  lines.push(`*Mode:* ${mode === 'text' ? 'Text' : 'Media'} — use /text or /media to switch.\n`);

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

  return {
    text: `Choose a category to broadcast to:\n\n${lines.join('\n')}\n\nReply with the number.`,
    mapping,
    totalOptions: idx
  };
}

/* --------------------------- media download (retry) --------------------- */
/**
 * Avoids "Waiting for this message" by retrying and using updateMediaMessage.
 */
async function safeDownloadMedia(msg, sock, retries = 8, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger: sock.logger, reuploadRequest: sock.updateMediaMessage.bind(sock) }
      );
      if (buffer?.length) return buffer;
    } catch (e) {
      console.warn(`[media] download attempt ${i + 1} failed: ${e.message}`);
    }
    if (i < retries - 1) await sleep(delay);
  }
  return null;
}

/* ----------------------------- batching --------------------------------- */

/** Single target sender with retries + HARD timeout so slices never hang. */
async function sendToOneWithRetry(sock, jid, payload) {
  let attempt = 0;
  while (attempt <= SEND_MAX_RETRIES) {
    try {
      const sendPromise = sock.safeSend ? sock.safeSend(jid, payload) : sock.sendMessage(jid, payload);
      const res = await withTimeout(sendPromise, SEND_TIMEOUT_MS, `send:${jid}`);
      return res;
    } catch (err) {
      const msg = String(err?.message || err);

      // Socket closed → surface; reconnect lives outside broadcaster
      if (/SOCKET_NOT_OPEN|Connection Closed/i.test(msg)) throw err;

      // 403/permission/membership — verify live flags for truthful reason
      if (/403|not allowed|not a group participant|not-authorized/i.test(msg)) {
        try {
          const live = await getLiveGroupFlags(sock, jid);
          const reason = live.ok
            ? (live.announce && !live.iAmAdmin ? 'announce-only (not admin)'
               : (!live.iAmIn ? 'not a member' : `403 (${msg})`))
            : `403 (${msg})`;
          const e = new Error(reason);
          e.permanent = true;
          throw e;
        } catch (e2) {
          const e = new Error(`403 (${msg})`);
          e.permanent = true;
          throw e;
        }
      }

      // First-run crypto issues → warm & retry
      if (/not-acceptable|No sessions/i.test(msg)) {
        await sleep(200); // tiny pause before caller tries warmup path
      }

      attempt++;
      if (attempt > SEND_MAX_RETRIES) throw err;

      // short exponential backoff (kept tiny)
      const wait = SEND_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
      console.warn(`[send] retry ${attempt} for ${jid} after ${wait}ms: ${msg}`);
      await sleep(wait);
    }
  }
}

/**
 * Fast batch sender:
 * - normalises image once
 * - warms sessions before each send
 * - no throttling pauses; minimal per-send delay
 * - truthful failure reasons (live flags on 403)
 * - respects /stop via cancel token
 */
async function sendInBatches(sock, username, from, jids, messageContent) {
  const USERS = USERSG();
  const u = USERS[username];
  const total = jids.length;

  // prepare media once
  let baseCaption = messageContent.caption || '';
  let imagePath = null;
  let imageBuffer = null;
  let imageMime = undefined;

  if (messageContent.image?.url) {
    imagePath = messageContent.image.url;
    if (!fs.existsSync(imagePath)) throw new Error(`Image file missing before send: ${imagePath}`);
    const raw = fs.readFileSync(imagePath);
    try {
      const { buffer: safeBuf, mimetype } = await normaliseImage(raw);
      imageBuffer = safeBuf; imageMime = mimetype;
    } catch { imageBuffer = raw; }
  }

  const stats = { sentOk: 0, failed: 0, timedOut: 0 };
  let sent = 0;
  let nextIndex = 0;

  const p = pacingFor(u);
  const startTime = Date.now();

  while (sent < total) {
    if (isCancelled(u)) {
      await sendSys(username, sock, from, { text: `🛑 Broadcast cancelled.` });
      break;
    }

    await guardMemory512();

    // build batch
    const batch = [];
    while (batch.length < p.batchSize && nextIndex < jids.length) {
      batch.push(jids[nextIndex++]);
    }
    if (!batch.length) break;

    const groupNames = batch.map(jid => USERS[username].allGroups[jid]?.name || jid);

    // serialized send inside batch
    for (const jid of batch) {
      if (isCancelled(u)) break;

      try {
        // WARM-UP first to avoid 'not-acceptable'
        await warmSessionsForGroup(sock, jid).catch(() => {});
        await sleep(120);

        if (messageContent.text !== undefined) {
          const text = withFooter(messageContent.text || '');
          await sendToOneWithRetry(sock, jid, { text });
        } else if (imageBuffer) {
          const payload = {
            image: imageBuffer,
            caption: withFooter(baseCaption),
            contextInfo: { forwardingScore: 2, isForwarded: true }
          };
          if (imageMime) payload.mimetype = imageMime;
          await sendToOneWithRetry(sock, jid, payload);
        } else {
          console.warn(`[${username}] No valid messageContent for ${jid}`);
        }
        stats.sentOk++;
        console.log(`[${username}] ✅ Sent to ${jid}`);
      } catch (error) {
        const msg = String(error?.message || error);
        stats.failed++;
        if (/TIMEOUT:send/i.test(msg)) stats.timedOut++;
        console.warn(`[${username}] ❌ Failed to send to ${jid}: ${msg}`);
      }

      await sleep(p.perSendDelay);
    }

    // brief user feedback per batch
    await sendSys(username, sock, from, {
      text: `✅ Sent to:\n${groupNames.map(n => `- ${n}`).join('\n')}\n\n${
        sent + batch.length < total ? `⏳ Next batch…` : '🎉 All messages sent!'
      }`,
    });

    sent += batch.length;

    // no adaptive slowdowns (explicitly removed)
    adjustPacing();

    if (sent < total && p.batchDelay) await sleep(p.batchDelay);
  }

  if (imagePath) { try { fs.unlinkSync(imagePath); } catch {} }

  clearCancel(u); // reset cancel flag after run ends

  console.log(`[${username}] 📊 run done: ok=${stats.sentOk} fail=${stats.failed} timeouts=${stats.timedOut} ` +
              `elapsed=${Math.round((Date.now()-startTime)/1000)}s`);
}

/* ------------------------ parsing admin commands ------------------------ */

function parseAddCategory(body) {
  const m = body.match(/^\/addcategory\s+(.{1,50})$/i);
  return m ? m[1].trim() : null;
}

function parseAddOrRemoveGroup(body) {
  const add = body.startsWith('/addgroup ');
  const rem = body.startsWith('/removegroup ');
  if (!add && !rem) return null;

  const withoutCmd = body.replace(/^\/(addgroup|removegroup)\s+/i, '');
  const parts = withoutCmd.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const category = parts.pop();
  const groupName = withoutCmd.slice(0, withoutCmd.length - category.length).trim();
  if (!groupName || !category) return null;

  return { op: add ? 'add' : 'remove', groupName, category };
}

/* ------------------------------ main handler ---------------------------- */

async function handleBroadcastMessage(username, msg, sock) {
  const USERS = USERSG();
  const u = USERS[username] || (USERS[username] = {});
  const chatJid = normaliseJid(msg.key.remoteJid);

  const selfBare = bareJid(sock?.user?.id || '');
  const chatBare = bareJid(chatJid);

  if (chatJid.endsWith('@g.us')) return; // ignore groups
  if (!sock) return;

  // First interaction → lock owner + greet
  if (!u.ownerJid) {
    u.ownerJid = chatBare === selfBare ? selfBare : chatJid;
    u.mode = u.mode || 'media';
    if (!u.greeted) {
      u.greeted = true;
      await sendSys(username, sock, u.ownerJid, {
        text:
          `✅ Connected.\n\n` +
          `Use:\n` +
          `• /text — switch to text mode\n` +
          `• /media — switch to image mode\n` +
          `• /cats — pick a category to send to\n` +
          `• /rescan — refresh your groups\n\n` +
          `Now send a message (in /text) or an image (in /media) to broadcast.`
      });
    }
  }

  const ownerBare = bareJid(u.ownerJid);
  if (chatBare !== ownerBare) return;

  // Anti-echo for our system messages
  if (u.ignoreIds && msg.key?.id && u.ignoreIds.has(msg.key.id)) {
    u.ignoreIds.delete(msg.key.id);
    return;
  }

  if (u.connecting) {
    await sendSys(username, sock, ownerBare, { text: 'Reconnecting… try again in a few seconds.' });
    return;
  }

  const body = getMessageText(msg).trim();

  // Ensure cats/groups are loaded & normalized
  const p = getUserPaths(username);
  if (!u.categories || !Object.keys(u.categories).length) {
    u.categories = readJSON(p.categories, u.categories || {});
  }
  if (!u.allGroups || !Object.keys(u.allGroups).length) {
    u.allGroups = readJSON(p.groups, u.allGroups || {});
  }
  for (const c of Object.keys(u.categories || {})) {
    u.categories[c] = normalizeCategoryToJids(u.categories[c], u.allGroups);
  }

  const cats = u.categories;
  const groups = u.allGroups;

  /* -------------------------- mode switching --------------------------- */

  if (/^\/mode\s+(text|media)$/i.test(body)) {
    u.mode = body.toLowerCase().includes('text') ? 'text' : 'media';
    u.awaitingPayload = u.mode === 'text' ? 'text' : null;
    return await sendSys(username, sock, ownerBare, {
      text: u.mode === 'text'
        ? `✍️ Type the message you want to broadcast, then press Send.`
        : `🖼️ Send an image to start a broadcast.\n(/text to switch to text mode)`
    });
  }
  if (body === '/text') {
    u.mode = 'text';
    u.awaitingPayload = 'text';
    return await sendSys(username, sock, ownerBare, { text: `✍️ Type the message you want to broadcast and press Send.` });
  }
  if (body === '/media') {
    u.mode = 'media';
    u.awaitingPayload = null;
    return await sendSys(username, sock, ownerBare, { text: `🖼️ Send an image to start a broadcast.\n(/text to switch)` });
  }

  /* ----------------------------- utilities ----------------------------- */

  if (body === '/rescan' || body === '/syncgroups') {
    await autoScanAndCategorise(username, sock);
    return await sendSys(username, sock, ownerBare, { text: '✅ Rescanned and categorised groups.' });
  }

  // NEW: show the contents of a category
  if (body.startsWith('/show ')) {
    const cat = body.slice(6).trim();
    if (!cats[cat] || !(cats[cat] || []).length) {
      return await sendSys(username, sock, ownerBare, { text: `ℹ️ *${cat}* has no groups.` });
    }
    const names = (cats[cat] || []).map(j => groups[j]?.name || j);
    const chunk = (arr, n=60) => arr.length>n ? arr.slice(0,n).concat([`... (+${arr.length-n} more)`]) : arr;
    const shown = chunk(names, 60);
    return await sendSys(username, sock, ownerBare, {
      text: `📦 *${cat}* (${names.length})\n` + shown.map(n => `- ${n}`).join('\n')
    });
  }

  if (body === '/cats') {
    if (u.mode === 'text' && !u.pendingText) {
      return await sendSys(username, sock, ownerBare, { text: `✍️ First, type the message you want to broadcast and press Send. Then I'll show categories.` });
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

  if (body === '/stop') {
    // request cancel on any in-flight run; the loop will exit safely
    requestCancel(u);
    u.pendingImage = null;
    u.pendingText = null;
    u.awaitingPayload = null;
    u.lastPromptChat = null;
    u.awaitingCategory = false;
    if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
    return await sendSys(username, sock, ownerBare, { text: `🛑 Broadcast cancellation requested. Finishing current send safely…` });
  }

  if (body === '/help') {
    return await sendSys(username, sock, ownerBare, {
      text:
        `Commands:\n` +
        `/help - Show this message\n` +
        `/rescan or /syncgroups - Rescan groups\n` +
        `/cats - Choose category\n` +
        `/show <category> - List groups in a category\n` +
        `/stop - Cancel an active broadcast\n` +
        `/text - Switch to Text mode (send messages)\n` +
        `/media - Switch to Media Mode (send images)\n` +
        `/addcategory [category]\n` +
        `/addgroup [group name] [category]\n` +
        `/removegroup [group name] [category]`
    });
  }

  // /addcategory
  const newCat = parseAddCategory(body);
  if (newCat) {
    if (!cats[newCat]) cats[newCat] = [];
    persistNow(username);
    return await sendSys(username, sock, ownerBare, { text: `✅ Category *${newCat}* added.` });
  }

  // /addgroup or /removegroup
  const grpCmd = parseAddOrRemoveGroup(body);
  if (grpCmd) {
    const { op, groupName, category } = grpCmd;

    const target = norm(groupName);
    let jid = null;

    // exact normalized match first
    for (const j of Object.keys(groups)) {
      if (norm(groups[j]?.name) === target) { jid = j; break; }
    }
    // fallback: includes (unique)
    if (!jid) {
      const candidates = Object.keys(groups).filter(j =>
        norm(groups[j]?.name).includes(target)
      );
      if (candidates.length === 1) jid = candidates[0];
    }

    if (!jid) {
      // Suggest close matches (up to 8)
      const candidates = Object.values(groups || {})
        .map(g => g?.name || '')
        .filter(Boolean)
        .map(n => [n, norm(n)])
        .filter(([raw, nn]) => nn.includes(target) || target.includes(nn))
        .slice(0, 8)
        .map(([raw]) => raw);

      const hint = candidates.length
        ? `\n\nDid you mean:\n` + candidates.map(x => `- ${x}`).join('\n')
        : '';
      return await sendSys(username, sock, ownerBare, {
        text: `❌ Group "${groupName}" not found in your WhatsApp groups.${hint}\n\nTip: Use /show <category> to list items.`
      });
    }

    if (!cats[category]) cats[category] = [];

    if (op === 'add') {
      if (!cats[category].includes(jid)) cats[category].push(jid);
      persistNow(username);
      return await sendSys(username, sock, ownerBare, { text: `✅ Added "${groups[jid]?.name || groupName}" to *${category}*.` });
    } else {
      cats[category] = (cats[category] || []).filter(id => id !== jid);
      persistNow(username);
      return await sendSys(username, sock, ownerBare, { text: `✅ Removed "${groups[jid]?.name || groupName}" from *${category}*.` });
    }
  }

  /* -------------------- numeric choice (awaiting) ----------------------- */

  const selection = extractNumericChoice(msg);
  if (selection && u.lastPromptChat === ownerBare && u.awaitingCategory && (u.pendingImage || u.pendingText)) {
    const { mapping, totalOptions } = buildCategoryPrompt(username);
    const number = parseInt(selection, 10);

    if (!Number.isInteger(number) || number < 1 || number > totalOptions) {
      await sendSys(username, sock, ownerBare, { text: '❌ Invalid category number. Please try again.' });
      return;
    }

    const chosen = mapping[number];
    if (!chosen) {
      await sendSys(username, sock, ownerBare, { text: '❌ Invalid selection. Please try again.' });
      return;
    }

    const rawList = chosen === '__ALL__'
      ? Object.keys(groups || {})
      : (cats[chosen] || []);
    const jids = normalizeCategoryToJids(rawList, groups || {}).filter(Boolean);

    if (!jids.length) {
      return await sendSys(username, sock, ownerBare, { text: 'No valid groups in that category.' });
    }

    if (u.broadcasting) {
      return await sendSys(username, sock, ownerBare, { text: '⏳ A broadcast is already running. Please wait.' });
    }
    u.broadcasting = true;

    try {
      if (u.mode === 'text' && u.pendingText) {
        await sendSys(username, sock, ownerBare, { text: `Broadcasting *text* to ${jids.length} group(s)…` });
        await sendInBatches(sock, username, ownerBare, jids, { text: u.pendingText });
        await sendSys(username, sock, ownerBare, { text: `✍️ Done. Send another message to broadcast, or /stop to cancel.` });
        u.pendingText = null;
        u.awaitingPayload = 'text';
        u.lastPromptChat = null;
        return;
      }

      if (u.pendingImage) {
        const imagePath = u.pendingImage?.filePath || u.pendingImage?.image?.url;
        if (!imagePath || !fs.existsSync(imagePath)) {
          return await sendSys(username, sock, ownerBare, { text: '⚠️ Could not find saved image. Please resend it.' });
        }
        await sendSys(username, sock, ownerBare, { text: `Broadcasting *image* to ${jids.length} group(s)…` });

        await sendInBatches(
          sock,
          username,
          ownerBare,
          jids,
          { image: { url: imagePath }, caption: u.pendingImage.caption || '' }
        );

        if (u.mode === 'text') {
          await sendSys(username, sock, ownerBare, { text: `✍️ Done. Send another message to broadcast, or /stop to cancel.` });
          u.awaitingPayload = 'text';
        } else {
          await sendSys(username, sock, ownerBare, { text: `🖼️ Done. Send another image to broadcast, or /text to switch to text mode.` });
          u.awaitingPayload = null;
        }

        u.pendingImage = null;
        u.lastPromptChat = null;
        return;
      }

      return await sendSys(username, sock, ownerBare, { text: 'Nothing pending to send. Use /text then type a message, or send an image.' });
    } finally {
      u.broadcasting = false;
      if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
      u.awaitingCategory = false;
    }
  }

  /* ----------------------- content capture flow ------------------------- */

  // TEXT MODE: capture text then show categories
  if (u.mode === 'text') {
    const isCommand = body.startsWith('/');
    if ((u.awaitingPayload === 'text' || (!u.pendingText && !isCommand)) && body && !isCommand) {
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

      await sendSys(username, sock, ownerBare, { text });
      return;
    }

    if (u.awaitingCategory && !selection) return;
  }

  // MEDIA MODE: accept image then show categories
  if (u.mode === 'media' && hasImage(msg)) {
    const buffer = await safeDownloadMedia(msg, sock, 8, 3000);

    if (!buffer?.length) {
      await sendSys(username, sock, ownerBare, { text: '❌ Failed to download image (media not ready).' });
      return;
    }

    const caption = getContent(msg)?.imageMessage?.caption || '';
    const timestamp = Date.now();
    const up = getUserPaths(username);

    ensureDir(up.tmp);
    const imagePath = path.join(up.tmp, `image_${timestamp}`);

    try {
      fs.writeFileSync(imagePath, buffer);
      try { buffer.fill(0); } catch {}
    } catch (e) {
      await sendSys(username, sock, ownerBare, { text: `❌ Failed to save image buffer: ${e.message}` });
      return;
    }

    u.pendingText = null;
    u.pendingImage = { filePath: imagePath, caption };
    u.awaitingPayload = null;
    u.lastPromptChat = ownerBare;

    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(username, sock, ownerBare);
    }, INTERACTION_TIMEOUT_MS);

    await sendSys(username, sock, ownerBare, { text });
    return;
  }

  // nothing actionable
}

/* ------------------------ timeout/reset helper -------------------------- */

async function notifyAndResetOnTimeout(username, sock, ownerJid) {
  try {
    await sendSys(username, sock, ownerJid, {
      text:
        `⏱️ Your category selection timed out (30 minutes).\n\n` +
        `Please reconnect on your dashboard:\n${DASHBOARD_URL}\n\n` +
        `If a QR is shown, scan it to resume.`
    });
  } catch (e) {
    console.error(`[${username}] notifyAndResetOnTimeout error:`, e?.message || e);
  }
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
