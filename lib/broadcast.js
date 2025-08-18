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

/* ==========================================================================
   SPEED CONFIG (tuned for efficiency)
   --------------------------------------------------------------------------
   MAX_INFLIGHT: how many sends kept in-flight simultaneously (pipeline).
   TARGET_ACK_MS: target average ACK time per message before we auto-backoff.
   ADAPTIVE_BACKOFF_MS: short pause injected when we're going too fast.
   WAVE_SIZE / WAVE_PAUSE_MS: optional “waves” to avoid long-run throttling.
   Set WAVE_SIZE=0 to disable waves (default = off for fastest possible).
   ========================================================================== */
const MAX_INFLIGHT = parseInt(process.env.BROADCAST_CONCURRENCY || '10', 10); // 10~12 is fast
const TARGET_ACK_MS = parseInt(process.env.TARGET_ACK_MS || '1700', 10);      // back off if average ACK > 1.7s
const ADAPTIVE_BACKOFF_MS = parseInt(process.env.ADAPTIVE_BACKOFF_MS || '1200', 10);

const WAVE_SIZE = parseInt(process.env.BROADCAST_WAVE_SIZE || '0', 10);       // 0 = disabled (max speed)
const WAVE_PAUSE_MS = parseInt(process.env.BROADCAST_WAVE_PAUSE_MS || '60000', 10);

// Small jitter so we don’t look perfectly robotic
const MIN_JITTER_MS = 80;
const MAX_JITTER_MS = 220;
function _jitter() { return MIN_JITTER_MS + Math.floor(Math.random() * (MAX_JITTER_MS - MIN_JITTER_MS)); }
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* --------------------------- UX / TIMEOUTS / LINKS ---------------------- */
const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000;
const DASHBOARD_URL = "https://whats-broadcast-hub.lovable.app";

/* --------------------------- branding (HARD-LOCKED) --------------------- */
const FOOTER = '— Sent automatically via whats-broadcast-hub.lovable.app | 🔥 Free trial available 🔥';

function withFooter(raw) {
  const text = (raw || '').trim();
  const already = text.toLowerCase().includes('sent automatically via whats-broadcast-hub');
  if (already) return text; // don’t double-tag
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

/* ---------------------- send-system wrapper (anti-echo) ----------------- */
async function sendSys(USERS, username, sock, jid, content) {
  const u = USERS[username] || (USERS[username] = {});
  if (!u.ignoreIds) u.ignoreIds = new Set();

  const res = await (sock.safeSend ? sock.safeSend(jid, content) : sock.sendMessage(jid, content));
  try {
    const id = res?.key?.id;
    if (id) {
      u.ignoreIds.add(id);
      if (u.ignoreIds.size > 500) {
        const it = u.ignoreIds.values();
        for (let i = 0; i < 300; i++) { const v = it.next(); if (v.done) break; u.ignoreIds.delete(v.value); }
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

/* ----------------------- ultra-fast broadcaster ------------------------- */
/**
 * Prepares a single reusable payload (text or image), then sends to many
 * with a rolling in-flight pipeline. Tracks moving average ACK latency and
 * injects micro backoffs if we exceed TARGET_ACK_MS to avoid hard throttles.
 */

async function prepareReusable(sock, messageContent) {
  if (messageContent?.text !== undefined) {
    return { kind: 'text', text: messageContent.text };
  }
  if (messageContent?.image?.url) {
    const buf = fs.readFileSync(messageContent.image.url);
    const prepared = await sock.prepareWAMessageMedia({ image: buf }, { upload: sock.waUploadToServer });
    return {
      kind: 'image',
      image: prepared.image,
      caption: messageContent.caption || '',
      mimetype: 'image/jpeg'
    };
  }
  // Extend for video/doc as needed
  return { kind: 'unknown' };
}

function MovingAvg(size = 20) {
  const arr = [];
  return {
    push(v) { arr.push(v); if (arr.length > size) arr.shift(); },
    avg() { if (!arr.length) return 0; return arr.reduce((a,b)=>a+b,0) / arr.length; },
    size() { return arr.length; }
  };
}

async function sendPipeline({ sock, jids, reusable, caption, progressCb }) {
  let nextIndex = 0;
  let inflight = 0;
  let sent = 0;
  let failed = 0;
  const ackMA = MovingAvg(30);

  return await new Promise((resolve) => {
    const pump = () => {
      // Completed condition
      if (nextIndex >= jids.length && inflight === 0) {
        return resolve({ sent, failed });
      }
      // Fill pipeline
      while (inflight < MAX_INFLIGHT && nextIndex < jids.length) {
        const jid = jids[nextIndex++];
        inflight++;

        (async () => {
          const start = Date.now();
          try {
            await _sleep(_jitter());

            if (!sock?.safeSend) throw new Error('SOCKET_NOT_OPEN');

            let content;
            if (reusable.kind === 'text') {
              content = { text: withFooter(reusable.text || '') };
            } else if (reusable.kind === 'image') {
              content = {
                image: reusable.image,
                caption: withFooter(reusable.caption || caption || ''),
                contextInfo: { forwardingScore: 2, isForwarded: true }
              };
            } else {
              content = { text: withFooter(caption || ' ') };
            }

            await sock.safeSend(jid, content, {});
            sent++;
            if (progressCb && sent % 50 === 0) {
              try { progressCb({ sent, total: jids.length }); } catch {}
            }
          } catch (e) {
            failed++;
            // If socket died, stop quickly
            if (/SOCKET_NOT_OPEN|Connection Closed/.test(e?.message)) {
              nextIndex = jids.length; // drain queue
            }
          } finally {
            const ack = Date.now() - start;
            ackMA.push(ack);

            inflight--;

            // Adaptive micro-backoff: if average ACK too high, brief pause
            if (ackMA.size() >= 8 && ackMA.avg() > TARGET_ACK_MS) {
              // short pause lets WA catch up without nuking speed
              setTimeout(pump, ADAPTIVE_BACKOFF_MS);
            } else {
              // keep pumping
              setImmediate(pump);
            }
          }
        })();
      }
    };

    // Kick off initial pump
    pump();
  });
}

async function sendBroadcastFast({ sock, username, from, jids, messageContent, USERS }) {
  // Optional waves (disabled by default for max speed)
  const waveSize = WAVE_SIZE > 0 ? WAVE_SIZE : jids.length;

  let totalSent = 0;
  let totalFailed = 0;
  let processed = 0;

  const reusable = await prepareReusable(sock, messageContent);

  while (processed < jids.length) {
    const end = Math.min(processed + waveSize, jids.length);
    const slice = jids.slice(processed, end);

    const { sent, failed } = await sendPipeline({
      sock,
      jids: slice,
      reusable,
      caption: messageContent.caption,
      progressCb: ({ sent, total }) => {
        // Notify every 100 sends for massive jobs (keeps chat clean)
        if (sent % 100 === 0) {
          const u = USERS[username];
          const notify = u?.userJid || from;
          try { sock.safeSend(notify, { text: `Progress: ${totalSent + sent}/${jids.length}` }); } catch {}
        }
      }
    });

    totalSent += sent;
    totalFailed += failed;
    processed = end;

    if (processed < jids.length && WAVE_SIZE > 0) {
      await _sleep(WAVE_PAUSE_MS);
    }
  }

  return { total: jids.length, sent: totalSent, failed: totalFailed };
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

  // De-dupe repeat upserts for the same WhatsApp message
  if (u.lastMsgId === msg.key?.id) return;
  u.lastMsgId = msg.key?.id;

  // Ignore our *own* system DMs by id (but do NOT blanket-ignore fromMe)
  if (u.ignoreIds && msg.key?.id && u.ignoreIds.has(msg.key.id)) {
    u.ignoreIds.delete(msg.key.id); // one-shot
    return;
  }

  // defaults
  if (!u.mode) u.mode = 'media'; // 'media' | 'text'

  const body = getMessageText(m).trim();
  const p = getUserPaths(username);

  // Disk fallback (only if empty in-memory)
  if (!u.categories || !Object.keys(u.categories).length) {
    u.categories = readJSON(p.categories, u.categories || {});
  }
  if (!u.allGroups || !Object.keys(u.allGroups).length) {
    u.allGroups = readJSON(p.groups, u.allGroups || {});
  }
  // Normalise to JIDs
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
      text: `✍️ Type the message you want to broadcast, then press Send.`
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
        `/media - Switch to Media mode (send images)\n` +
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

    for (const j of Object.keys(groups)) {
      if (norm(groups[j]?.name) === target) { jid = j; break; }
    }
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

    u.awaitingCategory = false;
    if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }

    const rawList = chosen === '__ALL__'
      ? Object.keys(groups)
      : (cats[chosen] || []);
    const jids = normalizeCategoryToJids(rawList, groups).filter(Boolean);

    if (!jids.length) {
      return await sendSys(USERS, username, sock, from, { text: 'No valid groups in that category.' });
    }

    // TEXT
    if (u.mode === 'text' && u.pendingText) {
      await sendSys(USERS, username, sock, from, { text: `Broadcasting *text* to ${jids.length} group(s)…` });
      const result = await sendBroadcastFast({
        sock, username, from, jids,
        messageContent: { text: u.pendingText },
        USERS
      });

      await sendSys(USERS, username, sock, from, {
        text: `✅ Done. Sent: ${result.sent}/${result.total}. Failures: ${result.failed}.\n\n✍️ Send another message to broadcast, or /stop to cancel.`
      });

      u.pendingText = null;
      u.awaitingPayload = 'text';
      u.lastPromptChat = null;
      return;
    }

    // IMAGE
    if (u.pendingImage) {
      const imagePath = u.pendingImage?.filePath;
      if (!imagePath || !fs.existsSync(imagePath)) {
        return await sendSys(USERS, username, sock, from, { text: '⚠️ Could not find saved image. Please resend it.' });
      }

      await sendSys(USERS, username, sock, from, { text: `Broadcasting *image* to ${jids.length} group(s)…` });

      const result = await sendBroadcastFast({
        sock, username, from, jids,
        messageContent: {
          image: { url: imagePath },
          mimetype: 'image/jpeg',
          caption: u.pendingImage.caption || ''
        },
        USERS
      });

      if (u.mode === 'text') {
        await sendSys(USERS, username, sock, from, {
          text: `✅ Done. Sent: ${result.sent}/${result.total}. Failures: ${result.failed}.\n\n✍️ Send another message to broadcast, or /stop to cancel.`
        });
        u.awaitingPayload = 'text';
      } else {
        await sendSys(USERS, username, sock, from, {
          text: `✅ Done. Sent: ${result.sent}/${result.total}. Failures: ${result.failed}.\n\n🖼️ Send another image to broadcast, or /text to switch to text mode.`
        });
        u.awaitingPayload = null;
      }

      try { fs.unlinkSync(imagePath); } catch {}
      u.pendingImage = null;
      u.lastPromptChat = null;
      return;
    }

    return await sendSys(USERS, username, sock, from, { text: 'Nothing pending to send. Use /text then type a message, or send an image.' });
  }

  /* -------------- content capture -------------- */

  // TEXT MODE: capture content, then prompt categories
  if (u.mode === 'text') {
    if (u.awaitingPayload === 'text' && body && !body.startsWith('/')) {
      u.pendingText = body;
      u.awaitingPayload = null;
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
    if (u.awaitingCategory && !selection) return; // ignore chatter
  }

  // MEDIA MODE: capture an image, then prompt categories
  if (m.imageMessage && u.mode === 'media') {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: sock.logger,
      reuploadRequest: sock.sendMessage
    });

    const caption = m.imageMessage.caption || '';
    const timestamp = Date.now();
    const paths = getUserPaths(username);
    const imagePath = path.join(paths.tmp, `image_${timestamp}.jpg`);
    ensureDir(paths.tmp);
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

/* ------------------------------ exports -------------------------------- */
module.exports = {
  autoScanAndCategorise,
  buildCategoryPrompt,
  handleBroadcastMessage,
  categoriseGroupName
};
