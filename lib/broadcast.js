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

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 5000;                    // pace batches to be ban-safe
const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000;  // 30 mins to pick a category
const DASHBOARD_URL = "https://whats-broadcast-hub.lovable.app";

const FOOTER = '— Sent automatically via whats-broadcast-hub.lovable.app | 🔥 Free trial available 🔥';
const MAX_NAMES_PER_CATEGORY = 30;

/* --------------------------- small utilities ----------------------------- */

function USERSG() { return global.USERS || (global.USERS = {}); }

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

function rssMB() {
  try { return process.memoryUsage().rss / 1048576; } catch { return 0; }
}

async function guardMemory512() {
  const mb = rssMB();
  if (mb > 440) await sleep(1000);
  else if (mb > 400) await sleep(300);
}

/* ---------- unwrap helpers for ephemeral / viewOnce wrappers ------------- */

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

function hasImage(msg) {
  const m = getContent(msg);
  return !!m.imageMessage;
}

function extractNumericChoice(msg) {
  const txt = getMessageText(msg);
  return txt && /^\d+$/.test(txt.trim()) ? txt.trim() : null;
}

/* --------------------------- persistence -------------------------------- */

function mirrorToDisk(username) {
  const USERS = USERSG();
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

function persistNow(username) {
  const USERS = USERSG();
  const u = USERS[username];
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
  const USERS = USERSG();
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

async function autoScanAndCategorise(username, sock) {
  const USERS = USERSG();
  const u = USERS[username] || (USERS[username] = {});
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
  const USERS = USERSG();
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

/* ----------------------------- batching --------------------------------- */

async function sendInBatches(sock, username, from, jids, messageContent) {
  const USERS = USERSG();
  const total = jids.length;
  let sent = 0;

  const safeSend = sock.safeSend ? sock.safeSend.bind(sock) : sock.sendMessage.bind(sock);

  let baseCaption = messageContent.caption || '';
  let imagePath = null;
  let imageBuffer = null;

  if (messageContent.image?.url) {
    imagePath = messageContent.image.url;

    if (!fs.existsSync(imagePath)) throw new Error(`Image file missing before send: ${imagePath}`);
    imageBuffer = fs.readFileSync(imagePath);

    try {
      const stat = fs.statSync(imagePath);
      console.log(`[${username}] media present=true size=${stat.size}B — using raw bytes`);
    } catch (e) {
      console.log(`[${username}] media stat error: ${e.message}`);
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

    await sendSys(username, sock, from, {
      text: `✅ Sent to:\n${groupNames.map(n => `- ${n}`).join('\n')}\n\n${
        sent + batch.length < total ? '⏳ Sending next batch…' : '🎉 All messages sent!'
      }`,
    });

    sent += batch.length;
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
  const chatJid = normaliseJid(msg?.key?.remoteJid || '');
  const fromMe = !!msg?.key?.fromMe;

  const selfJid = normaliseJid(sock?.user?.id || '');
  const isSelfChat = chatJid === selfJid;

  // DEBUG: show envelope we received
  try {
    const kinds = msg?.message ? Object.keys(msg.message) : [];
    console.log(
      `[${username}] rx: chat=${chatJid} self=${isSelfChat} fromMe=${fromMe} kinds=${kinds.join('|')}`
    );
  } catch {}

  // 1) Ignore groups entirely
  if (chatJid.endsWith('@g.us')) {
    console.log(`[${username}] skip: group message`);
    return;
  }
  // 2) Ignore messages without socket
  if (!sock) {
    console.log(`[${username}] skip: no sock`);
    return;
  }
  // 3) Ignore our own messages unless it's our self chat (we control via self DM)
  if (fromMe && !isSelfChat) {
    console.log(`[${username}] skip: fromMe in non-self chat`);
    return;
  }

  // 4) Anti-echo: ignore our own system messages (IDs we sent via sendSys)
  if (u.ignoreIds && msg.key?.id && u.ignoreIds.has(msg.key.id)) {
    u.ignoreIds.delete(msg.key.id);
    console.log(`[${username}] skip: anti-echo ${msg.key.id}`);
    return;
  }

  // 5) Owner — pin to self chat if that's where we are
  if (!u.ownerJid) {
    u.ownerJid = isSelfChat ? selfJid : chatJid;
    u.mode = u.mode || 'media';
    console.log(`[${username}] ownerJid set to ${u.ownerJid}`);
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
  if (chatJid !== u.ownerJid) {
    console.log(`[${username}] skip: chatJid != ownerJid (${chatJid} != ${u.ownerJid})`);
    return;
  }

  // 6) Block while connecting/reconnecting
  if (u.connecting) {
    await sendSys(username, sock, chatJid, { text: 'Reconnecting… try again in a few seconds.' });
    return;
  }

  // 7) Robust content
  const content = getContent(msg);
  const body = getMessageText(msg).trim();
  const image = !!content?.imageMessage;

  console.log(`[${username}] decoded: mode=${u.mode || 'media'} body="${body}" image=${image}`);

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
    return await sendSys(username, sock, chatJid, {
      text: u.mode === 'text'
        ? `✍️ Type the message you want to broadcast, then press Send.`
        : `🖼️ Send an image to start a broadcast.\n(/text to switch to text mode)`
    });
  }
  if (body === '/text') {
    u.mode = 'text';
    u.awaitingPayload = 'text';
    return await sendSys(username, sock, chatJid, { text: `✍️ Type the message you want to broadcast and press Send.` });
  }
  if (body === '/media') {
    u.mode = 'media';
    u.awaitingPayload = null;
    return await sendSys(username, sock, chatJid, { text: `🖼️ Send an image to start a broadcast.\n(/text to switch)` });
  }

  /* ----------------------------- utilities ----------------------------- */

  if (body === '/rescan' || body === '/syncgroups') {
    await autoScanAndCategorise(username, sock);
    return await sendSys(username, sock, chatJid, { text: '✅ Rescanned and categorised groups.' });
  }

  if (body === '/cats') {
    if (u.mode === 'text' && !u.pendingText) {
      return await sendSys(username, sock, chatJid, { text: `✍️ First, type the message you want to broadcast and press Send. Then I'll show categories.` });
    }
    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    u.lastPromptChat = chatJid;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(username, sock, chatJid);
    }, INTERACTION_TIMEOUT_MS);
    console.log(`[${username}] prompt: showing category list to ${chatJid}`);
    return await sendSys(username, sock, chatJid, { text });
  }

  if (body === '/stop') {
    u.pendingImage = null;
    u.pendingText = null;
    u.awaitingPayload = null;
    u.lastPromptChat = null;
    u.awaitingCategory = false;
    if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
    return await sendSys(username, sock, chatJid, { text: `🛑 Broadcast cancelled.` });
  }

  if (body === '/help') {
    return await sendSys(username, sock, chatJid, {
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
    return await sendSys(username, sock, chatJid, { text: `✅ Category *${newCat}* added.` });
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
      return await sendSys(username, sock, chatJid, { text: `❌ Group "${groupName}" not found in your WhatsApp groups.` });
    }

    if (!cats[category]) cats[category] = [];

    if (op === 'add') {
      if (!cats[category].includes(jid)) cats[category].push(jid);
      persistNow(username);
      return await sendSys(username, sock, chatJid, { text: `✅ Added "${groups[jid]?.name || groupName}" to *${category}*.` });
    } else {
      cats[category] = (cats[category] || []).filter(id => id !== jid);
      persistNow(username);
      return await sendSys(username, sock, chatJid, { text: `✅ Removed "${groups[jid]?.name || groupName}" from *${category}*.` });
    }
  }

  /* -------------------- numeric choice (awaiting) ----------------------- */

  const selection = extractNumericChoice(msg);
  if (selection && u.lastPromptChat === chatJid && u.awaitingCategory && (u.pendingImage || u.pendingText)) {
    const { mapping, totalOptions } = buildCategoryPrompt(username);
    const number = parseInt(selection, 10);

    if (!Number.isInteger(number) || number < 1 || number > totalOptions) {
      await sendSys(username, sock, chatJid, { text: '❌ Invalid category number. Please try again.' });
      return;
    }

    const chosen = mapping[number];
    if (!chosen) {
      await sendSys(username, sock, chatJid, { text: '❌ Invalid selection. Please try again.' });
      return;
    }

    const rawList = chosen === '__ALL__'
      ? Object.keys(groups || {})
      : (cats[chosen] || []);
    const jids = normalizeCategoryToJids(rawList, groups || {}).filter(Boolean);

    if (!jids.length) {
      return await sendSys(username, sock, chatJid, { text: 'No valid groups in that category.' });
    }

    // --- broadcast mutex ---
    if (u.broadcasting) {
      return await sendSys(username, sock, chatJid, { text: '⏳ A broadcast is already running. Please wait.' });
    }
    u.broadcasting = true;

    try {
      if (u.mode === 'text' && u.pendingText) {
        await sendSys(username, sock, chatJid, { text: `Broadcasting *text* to ${jids.length} group(s)…` });
        await sendInBatches(sock, username, chatJid, jids, { text: u.pendingText });

        await sendSys(username, sock, chatJid, { text: `✍️ Done. Send another message to broadcast, or /stop to cancel.` });

        u.pendingText = null;
        u.awaitingPayload = 'text';
        u.lastPromptChat = null;
        return;
      }

      if (u.pendingImage) {
        const imagePath = u.pendingImage?.filePath || u.pendingImage?.image?.url;
        if (!imagePath || !fs.existsSync(imagePath)) {
          return await sendSys(username, sock, chatJid, { text: '⚠️ Could not find saved image. Please resend it.' });
        }
        await sendSys(username, sock, chatJid, { text: `Broadcasting *image* to ${jids.length} group(s)…` });

        await sendInBatches(
          sock,
          username,
          chatJid,
          jids,
          { image: { url: imagePath }, caption: u.pendingImage.caption || '' }
        );

        if (u.mode === 'text') {
          await sendSys(username, sock, chatJid, { text: `✍️ Done. Send another message to broadcast, or /stop to cancel.` });
          u.awaitingPayload = 'text';
        } else {
          await sendSys(username, sock, chatJid, { text: `🖼️ Done. Send another image to broadcast, or /text to switch to text mode.` });
          u.awaitingPayload = null;
        }

        u.pendingImage = null;
        u.lastPromptChat = null;
        return;
      }

      return await sendSys(username, sock, chatJid, { text: 'Nothing pending to send. Use /text then type a message, or send an image.' });
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
    console.log(`[${username}] text-capture: awaiting=${u.awaitingPayload} isCmd=${isCommand} bodyLen=${body.length}`);
    if ((u.awaitingPayload === 'text' || (!u.pendingText && !isCommand)) && body && !isCommand) {
      u.pendingText = body;
      u.awaitingPayload = null;
      u.pendingImage = null;
      u.lastPromptChat = chatJid;

      const { text } = buildCategoryPrompt(username);
      u.awaitingCategory = true;
      if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
      u.categoryTimeout = setTimeout(() => {
        notifyAndResetOnTimeout(username, sock, chatJid);
      }, INTERACTION_TIMEOUT_MS);

      console.log(`[${username}] prompt: showing category list to ${chatJid}`);
      await sendSys(username, sock, chatJid, { text });
      return;
    }

    if (u.awaitingCategory && !selection) return;
  }

  // MEDIA MODE: accept image, then show categories
  if (u.mode === 'media' && hasImage(msg)) {
    console.log(`[${username}] media-capture: entering (hasImage=true)`);
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: sock.logger,
      reuploadRequest: sock.sendMessage
    });

    if (!buffer?.length) {
      await sendSys(username, sock, chatJid, { text: '❌ Failed to download image.' });
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
      await sendSys(username, sock, chatJid, { text: `❌ Failed to save image buffer: ${e.message}` });
      return;
    }

    u.pendingText = null;
    u.pendingImage = { filePath: imagePath, caption };
    u.awaitingPayload = null;
    u.lastPromptChat = chatJid;

    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => {
      notifyAndResetOnTimeout(username, sock, chatJid);
    }, INTERACTION_TIMEOUT_MS);

    console.log(`[${username}] prompt: showing category list to ${chatJid}`);
    await sendSys(username, sock, chatJid, { text });
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
  const USERS = USERSG();
  const u = USERS[username];
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
  categoriseGroupName
};
