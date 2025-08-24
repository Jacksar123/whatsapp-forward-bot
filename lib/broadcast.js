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

/* ----------------------------- constants -------------------------------- */

// Sending pace (tuned for stability on big lists)
const BATCH_SIZE = 5;                 // 5 groups per batch
const PARALLEL_PER_SLICE = 1;         // send 1 at a time inside the batch
const PER_SEND_DELAY_MS = 100;        // tiny delay between sends (jitter control)
const BATCH_DELAY_MS = 5000;          // 5s between batches
const SEND_TIMEOUT_MS = 20000;        // 20s timeout per send
const SEND_MAX_RETRIES = 4;           // retry a few times per group
const SEND_BACKOFF_MS = 1500;         // backoff base (exponential)
const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000;  // 30 mins to pick category
const DASHBOARD_URL = "https://whats-broadcast-hub.lovable.app";

const FOOTER = '— Sent automatically via whats-broadcast-hub.lovable.app | 🔥 Free trial available 🔥';
const MAX_NAMES_PER_CATEGORY = 30;

/* --------------------------- utilities ---------------------------------- */

function USERSG() { return global.USERS || (global.USERS = {}); }

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
  if (mb > 440) await sleep(1000);
  else if (mb > 400) await sleep(300);
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

/* --------------------------- auto scan/categorise ------------------------ */
/**
 * Signature matches index.js usage: autoScanAndCategorise(username, sock)
 */
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
 * WhatsApp may show "Waiting for this message" briefly while media keys propagate.
 * This helper retries the download and uses updateMediaMessage to re-request keys.
 */
async function safeDownloadMedia(msg, sock, retries = 7, delay = 2500) {
  for (let i = 0; i < retries; i++) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: sock.logger,
          // IMPORTANT: use updateMediaMessage, not sendMessage
          reuploadRequest: sock.updateMediaMessage.bind(sock),
        }
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

/**
 * Robust sender with per-send timeout, retry, and exponential backoff.
 */
async function sendToOneWithRetry(sock, jid, payload) {
  let attempt = 0;
  while (attempt <= SEND_MAX_RETRIES) {
    try {
      const send = sock.safeSend ? sock.safeSend.bind(sock) : sock.sendMessage.bind(sock);
      const p = send(jid, payload);

      // hard timeout per send
      const result = await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('SEND_TIMEOUT')), SEND_TIMEOUT_MS))
      ]);

      return result;
    } catch (err) {
      const msg = String(err?.message || err);
      const retryable =
        /timed out|rate|temporar|retry|disconnect|socket|stream|closed|too many|econn|network/i.test(msg);
      attempt++;
      if (!retryable || attempt > SEND_MAX_RETRIES) {
        throw err;
      }
      const wait = SEND_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400);
      console.warn(`[send] retry ${attempt} for ${jid} after ${wait}ms: ${msg}`);
      await sleep(wait);
    }
  }
}

async function sendInBatches(sock, username, from, jids, messageContent) {
  const USERS = USERSG();
  const total = jids.length;
  let sent = 0;

  let baseCaption = messageContent.caption || '';
  let imagePath = null;
  let imageBuffer = null;

  if (messageContent.image?.url) {
    imagePath = messageContent.image.url;
    if (!fs.existsSync(imagePath)) throw new Error(`Image file missing before send: ${imagePath}`);
    imageBuffer = fs.readFileSync(imagePath);

    try {
      const stat = fs.statSync(imagePath);
      console.log(`[${username}] media present=true size=${stat.size}B — sending raw bytes`);
    } catch {}
  }

  while (sent < total) {
    await guardMemory512();
    const batch = jids.slice(sent, sent + BATCH_SIZE);
    const groupNames = batch.map(jid => USERS[username].allGroups[jid]?.name || jid);

    // modest sequential sending inside the batch
    let idx = 0;
    while (idx < batch.length) {
      const slice = batch.slice(idx, idx + PARALLEL_PER_SLICE);

      const slicePromises = slice.map(async (jid) => {
        try {
          if (messageContent.text !== undefined) {
            const text = withFooter(messageContent.text || '');
            await sendToOneWithRetry(sock, jid, { text });
          } else if (imageBuffer) {
            const caption = withFooter(baseCaption);
            await sendToOneWithRetry(sock, jid, {
              image: imageBuffer,
              caption,
              contextInfo: { forwardingScore: 2, isForwarded: true }
            });
          } else {
            console.warn(`[${username}] No valid messageContent for ${jid}`);
          }
          console.log(`[${username}] ✅ Sent to ${jid}`);
          await sleep(PER_SEND_DELAY_MS);
        } catch (error) {
          console.error(`[${username}] ❌ Failed to send to ${jid}:`, error?.message || error);
        }
      });

      // watchdog to prevent a permanent stall on a stuck send
      const sliceWatchdogMs = SEND_TIMEOUT_MS * (SEND_MAX_RETRIES + 1) + 4000;
      await Promise.race([
        Promise.all(slicePromises),
        (async () => { await sleep(sliceWatchdogMs); throw new Error('SLICE_WATCHDOG_EXPIRED'); })()
      ]).catch(err => console.warn(`[${username}] ⚠️ Slice watchdog: ${err.message}`));

      idx += slice.length;
      await guardMemory512();
    }

    await sendSys(username, sock, from, {
      text: `✅ Sent to:\n${groupNames.map(n => `- ${n}`).join('\n')}\n\n${
        sent + batch.length < total ? '⏳ Next batch in 5s…' : '🎉 All messages sent!'
      }`,
    });

    sent += batch.length;

    // cooldown every ~200 sends to avoid account limits
    if (sent < total && sent % 200 === 0) {
      await sendSys(username, sock, from, { text: '🧊 Cooling down for 90s to avoid limits…' });
      await sleep(90_000);
    }

    if (sent < total) await sleep(BATCH_DELAY_MS);
  }

  if (imagePath) { try { fs.unlinkSync(imagePath); } catch {} }
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

  // 1) Ignore groups entirely
  if (chatJid.endsWith('@g.us')) return;
  // 2) Ignore messages without socket
  if (!sock) return;

  // 3) Learn/lock owner on first interaction (self-DM supported)
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

  // 4) From here on, only handle messages in the owner chat (compare BARE JIDs)
  const ownerBare = bareJid(u.ownerJid);
  if (chatBare !== ownerBare) return;

  // 5) Anti-echo: ignore our own system messages (by id)
  if (u.ignoreIds && msg.key?.id && u.ignoreIds.has(msg.key.id)) {
    u.ignoreIds.delete(msg.key.id);
    return;
  }

  // 6) Block while connecting/reconnecting
  if (u.connecting) {
    await sendSys(username, sock, ownerBare, { text: 'Reconnecting… try again in a few seconds.' });
    return;
  }

  // 7) Get robust content & text
  const body = getMessageText(msg).trim();

  // Ensure categories/groups present (load from disk if empty)
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
    u.pendingImage = null;
    u.pendingText = null;
    u.awaitingPayload = null;
    u.lastPromptChat = null;
    u.awaitingCategory = false;
    if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
    return await sendSys(username, sock, ownerBare, { text: `🛑 Broadcast cancelled.` });
  }

  if (body === '/help') {
    return await sendSys(username, sock, ownerBare, {
      text:
        `Commands:\n` +
        `/help - Show this message\n` +
        `/rescan or /syncgroups - Rescan groups\n` +
        `/cats - Choose category\n` +
        `/stop - Cancel\n` +
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
      return await sendSys(username, sock, ownerBare, { text: `❌ Group "${groupName}" not found in your WhatsApp groups.` });
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

    // --- broadcast mutex ---
    if (u.broadcasting) {
      return await sendSys(username, sock, ownerBare, { text: '⏳ A broadcast is already running. Please wait.' });
    }
    u.broadcasting = true;

    try {
      if (u.mode === 'text' && u.pendingText) {
        await sendSys(username, sock, ownerBare, { text: `Broadcasting *text* to ${jids.length} group(s)…` });
        await sendInBatches(sock, username, ownerBare, jids, { text: u.pendingText });

        await sendSys(username, sock, ownerBare, {
          text:
            `✍️ Done.\n\n` +
            `• Send another message to broadcast, or\n` +
            `• /media to switch, /cats to choose again, /stop to cancel.`
        });

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
          await sendSys(username, sock, ownerBare, {
            text:
              `✍️ Done.\n\n` +
              `• Send another message to broadcast, or\n` +
              `• /media to switch, /cats to choose again, /stop to cancel.`
          });
          u.awaitingPayload = 'text';
        } else {
          await sendSys(username, sock, ownerBare, {
            text:
              `🖼️ Done.\n\n` +
              `• Send another image to broadcast, or\n` +
              `• /text to switch to text mode, /cats to choose again, /stop to cancel.`
          });
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

  // TEXT MODE: capture text first, then show categories
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

  // MEDIA MODE: accept image, then show categories
  if (u.mode === 'media' && hasImage(msg)) {
    // Download using retry helper (prevents "Waiting for this message" stalls)
    const buffer = await safeDownloadMedia(msg, sock, 7, 2500);

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
  autoScanAndCategorise,     // (username, sock)
  buildCategoryPrompt,       // (username) -> { text, mapping, totalOptions }
  sendInBatches,             // (sock, username, from, jids, messageContent)
  handleBroadcastMessage,    // (username, msg, sock)
  categoriseGroupName,
  safeDownloadMedia
};
