// lib/broadcast.js
const fs = require('fs');
const path = require('path');
const {
  downloadMediaMessage,
  // prepareWAMessageMedia, // (optional) we won't use pre-upload to avoid blank media
} = require('@whiskeysockets/baileys');

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

// === Pace: 5 msgs every 5 seconds (ban-safe) ===
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 5000; // <-- fixed typo

// 30-minute reply window for picking a category
const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000;
const DASHBOARD_URL = "https://whats-broadcast-hub.lovable.app";

/* --------------------------- branding (HARD-LOCKED) --------------------- */

const FOOTER = '— Sent automatically via whats-broadcast-hub.lovable.app | 🔥 Free trial available 🔥';

function withFooter(raw) {
  const text = (raw || '').trim();
  const already = text.toLowerCase().includes('sent automatically via whats-broadcast-hub');
  if (already) return text;
  return text.length > 0 ? `${text}\n\n${FOOTER}` : `${FOOTER}`;
}

/* --------------------------- persistence -------------------------------- */

function mirrorToDisk(username, USERS) {
  const u = USERS[username];
  if (!u) return;
  try {
    const p = getUserPaths(username);
    writeJSON(p.categories, u.categories || {});
    writeJSON(p.groups, u.allGroups || {});
  } catch (e) {
    console.warn(`[${username}] disk mirror failed: ${e?.message || e}`);
  }
}

function persistNow(username, USERS) {
  const u = USERS[username];
  if (!u) return;
  try {
    saveUserState(username, u.categories || {}, u.allGroups || {});
  } catch (e) {
    console.warn(`[${username}] supabase save failed: ${e?.message || e}`);
  }
  mirrorToDisk(username, USERS);
}

/* --------------------------- helpers ----------------------------------- */

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

async function notifyAndResetOnTimeout(sock, username, ownerJid, USERS) {
  try {
    await sendSys(USERS, username, sock, ownerJid, {
      text:
        `⏱️ Your category selection timed out (30 minutes).\n\n` +
        `Please reconnect on your dashboard:\n${DASHBOARD_URL}\n\n` +
        `If a QR is shown, scan it to resume.`
    });
  } catch (e) {
    console.error(`[${username}] notifyAndResetOnTimeout error:`, e?.message || e);
  }
  const u = USERS[username];
  if (!u) return;
  if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
  u.awaitingCategory = false;
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

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------------- memory guard ------------------------------------ */

function rssMB() {
  try { return process.memoryUsage().rss / 1048576; } catch { return 0; }
}

// brief pause when memory is high (prevents GC death spirals on small plans)
async function guardMemory512() {
  const mb = rssMB();
  if (mb > 440) {
    await sleep(1000);
  } else if (mb > 400) {
    await sleep(300);
  }
}

/* ---------------------- send-system wrapper (anti-echo) ----------------- */
async function sendSys(USERS, username, sock, jid, content) {
  const u = USERS[username] || (USERS[username] = {});
  if (!u.ignoreIds) u.ignoreIds = new Set();

  const send = sock.safeSend ? sock.safeSend.bind(sock) : sock.sendMessage.bind(sock);
  const res = await send(jid, content);
  try {
    const id = res?.key?.id;
    if (id) {
      u.ignoreIds.add(id);
      if (u.ignoreIds.size > 200) {
        const it = u.ignoreIds.values();
        for (let i = 0; i < 120; i++) { const v = it.next(); if (v.done) break; u.ignoreIds.delete(v.value); }
      }
    }
  } catch {}
  return res;
}

/* ------------------------ scan & categorise ----------------------------- */
async function autoScanAndCategorise(sock, username, USERS) {
  const metaMap = await sock.groupFetchAllParticipating();
  const groups = Object.values(metaMap || {});
  const u = USERS[username] || (USERS[username] = {});
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

  persistNow(username, USERS);
  console.log(`[${username}] ✅ Auto-scan complete. Groups: ${Object.keys(allGroups).length}`);
}

/* ------------------------- category prompt ------------------------------ */

const MAX_NAMES_PER_CATEGORY = 30;

function buildCategoryPrompt(username, USERS) {
  const { categories = {}, allGroups = {}, mode = 'media' } = USERS[username] || {};
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

/* ---------------------------- broadcast --------------------------------- */

/**
 * Sends TEXT or IMAGE to many JIDs in paced batches.
 * For IMAGES: we send actual image BYTES per recipient (no pre-upload),
 * which eliminates the "blank image" issue.
 */
async function sendInBatches(sock, username, from, jids, messageContent, USERS) {
  const total = jids.length;
  let sent = 0;

  const safeSend = sock.safeSend ? sock.safeSend.bind(sock) : sock.sendMessage.bind(sock);

  let baseCaption = messageContent.caption || '';
  let imagePath = null;
  let imageBuffer = null;

  if (messageContent.image?.url) {
    imagePath = messageContent.image.url;

    // Ensure file exists and load bytes ONCE
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file missing before send: ${imagePath}`);
    }
    imageBuffer = fs.readFileSync(imagePath); // <-- bytes we’ll reuse for every group

    // Debug
    try {
      const stat = fs.statSync(imagePath);
      console.log(`[${username}] media file present=true size=${stat.size}B using raw bytes broadcast`);
    } catch (e) {
      console.log(`[${username}] media file stat error: ${e.message}`);
    }
  }

  while (sent < total) {
    await guardMemory512();

    const batch = jids.slice(sent, sent + BATCH_SIZE);
    const groupNames = batch.map(jid => USERS[username].allGroups[jid]?.name || jid);

    const mb = rssMB();
    const maxParallel = mb > 440 ? 3 : 5;

    let idx = 0;
    while (idx < batch.length) {
      const slice = batch.slice(idx, idx + maxParallel);

      await Promise.all(slice.map(async (jid) => {
        try {
          if (messageContent.text !== undefined) {
            const text = withFooter(messageContent.text || '');
            await safeSend(jid, { text });
          } else if (imageBuffer) {
            const caption = withFooter(baseCaption);
            // ✅ Send actual bytes. This avoids the “blank image” issue entirely.
            await safeSend(jid, {
              image: imageBuffer,
              caption,
              contextInfo: { forwardingScore: 2, isForwarded: true }
            });
          } else {
            console.warn(`[${username}] No valid messageContent for ${jid}`);
          }
          console.log(`[${username}] ✅ Sent to ${jid}`);
        } catch (error) {
          console.error(`[${username}] ❌ Failed to send to ${jid}:`, error?.message || error);
        }
      }));

      idx += slice.length;
      await guardMemory512();
    }

    await sendSys(USERS, username, sock, from, {
      text: `✅ Sent to:\n${groupNames.map(n => `- ${n}`).join('\n')}\n\n${
        sent + batch.length < total ? '⏳ Sending next batch…' : '🎉 All messages sent!'
      }`,
    });

    sent += batch.length;
    if (sent < total) await sleep(BATCH_DELAY_MS);
  }

  // Cleanup on disk (keep file until all sends complete)
  if (imagePath) {
    try { fs.unlinkSync(imagePath); } catch {}
  }
}

/* --------------------------- command parsing ---------------------------- */

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

/* --------------------------- main handler ------------------------------- */

async function handleBroadcastMessage(username, msg, USERS) {
  const u = USERS[username] || (USERS[username] = {});
  const sock = u?.sock;
  const m = msg.message;
  const from = normaliseJid(msg.key.remoteJid);
  if (from.endsWith('@g.us') || !m || !sock) return;

  // De-dupe
  if (u.lastMsgId === msg.key?.id) return;
  u.lastMsgId = msg.key?.id;

  // Ignore our own system DMs by id
  if (u.ignoreIds && msg.key?.id && u.ignoreIds.has(msg.key.id)) {
    u.ignoreIds.delete(msg.key.id);
    return;
  }

  if (!u.mode) u.mode = 'media';

  const body = getMessageText(m).trim();
  const p = getUserPaths(username);

  // Disk fallback
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

  /* ------------ mode commands ------------- */
  if (/^\/mode\s+(text|media)$/i.test(body)) {
    u.mode = body.toLowerCase().includes('text') ? 'text' : 'media';
    u.awaitingPayload = u.mode === 'text' ? 'text' : null; // arm asking for text next
    return await sendSys(USERS, username, sock, from, {
      text: u.mode === 'text'
        ? `✍️ Type the message you want to broadcast, then press Send.`
        : `🖼️ Send an image to start a broadcast.\n(/text to switch to text mode)`
    });
  }
  if (body === '/text') {
    u.mode = 'text';
    u.awaitingPayload = 'text';
    return await sendSys(USERS, username, sock, from, {
      text: `✍️ Type the message you want to broadcast and press Send.`
    });
  }
  if (body === '/media') {
    u.mode = 'media';
    u.awaitingPayload = null;
    return await sendSys(USERS, username, sock, from, {
      text: `🖼️ Send an image to start a broadcast.\n(/text to switch)`
    });
  }

  /* ------------ utility commands ------------- */

  if (body === '/rescan' || body === '/syncgroups') {
    await autoScanAndCategorise(sock, username, USERS);
    return await sendSys(USERS, username, sock, from, { text: '✅ Rescanned and categorised groups.' });
  }

  if (body === '/cats') {
    // In text mode, don't show categories until we have the text
    if (u.mode === 'text' && !u.pendingText) {
      return await sendSys(USERS, username, sock, from, {
        text: `✍️ First, type the message you want to broadcast and press Send. Then I'll show categories.`
      });
    }
    const { text } = buildCategoryPrompt(username, USERS);
    u.awaitingCategory = true;
    u.lastPromptChat = from;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(sock, username, from, USERS);
    }, INTERACTION_TIMEOUT_MS);
    return await sendSys(USERS, username, sock, from, { text });
  }

  if (body === '/stop') {
    u.pendingImage = null;
    u.pendingText = null;
    u.awaitingPayload = null;
    u.lastPromptChat = null;
    u.awaitingCategory = false;
    if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
    return await sendSys(USERS, username, sock, from, { text: `🛑 Broadcast cancelled.` });
  }

  if (body === '/help') {
    return await sendSys(USERS, username, sock, from, {
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
    persistNow(username, USERS);
    return await sendSys(USERS, username, sock, from, { text: `✅ Category *${newCat}* added.` });
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
      return await sendSys(USERS, username, sock, from, { text: `❌ Group "${groupName}" not found in your WhatsApp groups.` });
    }

    if (!cats[category]) cats[category] = [];

    if (op === 'add') {
      if (!cats[category].includes(jid)) cats[category].push(jid);
      persistNow(username, USERS);
      return await sendSys(USERS, username, sock, from, { text: `✅ Added "${groups[jid]?.name || groupName}" to *${category}*.` });
    } else {
      cats[category] = (cats[category] || []).filter(id => id !== jid);
      persistNow(username, USERS);
      return await sendSys(USERS, username, sock, from, { text: `✅ Removed "${groups[jid]?.name || groupName}" from *${category}*.` });
    }
  }

  /* --------- numeric choice while awaiting --------- */

  const selection = extractNumericChoice(m);
  if (selection && u.lastPromptChat === from && u.awaitingCategory && (u.pendingImage || u.pendingText)) {
    const { mapping, totalOptions } = buildCategoryPrompt(username, USERS);
    const number = parseInt(selection, 10);

    if (!Number.isInteger(number) || number < 1 || number > totalOptions) {
      await sendSys(USERS, username, sock, from, { text: '❌ Invalid category number. Please try again.' });
      return;
    }

    const chosen = mapping[number];
    if (!chosen) {
      await sendSys(USERS, username, sock, from, { text: '❌ Invalid selection. Please try again.' });
      return;
    }

    const rawList = chosen === '__ALL__'
      ? Object.keys(groups)
      : (cats[chosen] || []);
    const jids = normalizeCategoryToJids(rawList, groups).filter(Boolean);

    if (!jids.length) {
      return await sendSys(USERS, username, sock, from, { text: 'No valid groups in that category.' });
    }

    // Decide content based on mode + pending payload
    if (u.mode === 'text' && u.pendingText) {
      await sendSys(USERS, username, sock, from, { text: `Broadcasting *text* to ${jids.length} group(s)…` });
      await sendInBatches(sock, username, from, jids, { text: u.pendingText }, USERS);

      // Post-broadcast nudge for next text
      await sendSys(USERS, username, sock, from, {
        text: `✍️ Done. Send another message to broadcast, or /stop to cancel.`
      });

      // Reset & re-arm text payload flow
      u.pendingText = null;
      u.awaitingPayload = 'text';
      u.lastPromptChat = null;
      return;
    }

    if (u.pendingImage) {
      const imagePath = u.pendingImage?.filePath;
      if (!imagePath || !fs.existsSync(imagePath)) {
        return await sendSys(USERS, username, sock, from, { text: '⚠️ Could not find saved image. Please resend it.' });
      }
      await sendSys(USERS, username, sock, from, { text: `Broadcasting *image* to ${jids.length} group(s)…` });

      await sendInBatches(
        sock,
        username,
        from,
        jids,
        {
          image: { url: imagePath },
          caption: u.pendingImage.caption || ''
        },
        USERS
      );

      // Post-broadcast nudge
      if (u.mode === 'text') {
        await sendSys(USERS, username, sock, from, {
          text: `✍️ Done. Send another message to broadcast, or /stop to cancel.`
        });
        u.awaitingPayload = 'text';
      } else {
        await sendSys(USERS, username, sock, from, {
          text: `🖼️ Done. Send another image to broadcast, or /text to switch to text mode.`
        });
        u.awaitingPayload = null; // media waits for next image
      }

      // Cleanup & reset (file cleanup is done in sendInBatches after all sends)
      u.pendingImage = null;
      u.lastPromptChat = null;
      return;
    }

    // Fallback: nothing pending
    return await sendSys(USERS, username, sock, from, { text: 'Nothing pending to send. Use /text then type a message, or send an image.' });
  }

  /* -------------- content capture -------------- */

  // TEXT MODE: require the user to provide the text payload first
  if (u.mode === 'text') {
    if (u.awaitingPayload === 'text' && body && !body.startsWith('/')) {
      u.pendingText = body;
      u.awaitingPayload = null; // we have the message now
      u.pendingImage = null;
      u.lastPromptChat = from;

      const { text } = buildCategoryPrompt(username, USERS);
      u.awaitingCategory = true;
      if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
      u.categoryTimeout = setTimeout(() => {
        notifyAndResetOnTimeout(sock, username, from, USERS);
      }, INTERACTION_TIMEOUT_MS);

      await sendSys(USERS, username, sock, from, { text });
      return;
    }

    // If we already asked for a category, ignore non-numeric chatter
    if (u.awaitingCategory && !selection) return;
  }

  // MEDIA MODE: capture an image, then prompt for category
  if (m.imageMessage && u.mode === 'media') {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: sock.logger,
      reuploadRequest: sock.sendMessage
    });

    const caption = m.imageMessage.caption || '';
    const timestamp = Date.now();
    const userPaths = getUserPaths(username);
    ensureDir(userPaths.tmp);
    const imagePath = path.join(userPaths.tmp, `image_${timestamp}`); // no forced .jpg
    fs.writeFileSync(imagePath, buffer);

    try { buffer.fill(0); } catch {}
    u.pendingText = null;
    u.pendingImage = { filePath: imagePath, caption };
    u.awaitingPayload = null;
    u.lastPromptChat = from;

    const { text } = buildCategoryPrompt(username, USERS);
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(sock, username, from, USERS);
    }, INTERACTION_TIMEOUT_MS);

    await sendSys(USERS, username, sock, from, { text });
    return;
  }

  // else: ignore
}

module.exports = {
  autoScanAndCategorise,
  buildCategoryPrompt,
  sendInBatches,
  handleBroadcastMessage,
  categoriseGroupName
};
