// lib/broadcast.js
'use strict';

const fs = require('fs-extra');
const path = require('path');
const {
  getUserPaths,
  readJSON,
  writeJSON,
  sleep,
  categoriseGroupName
} = require('./utils');
const { saveUserState } = require('./state');
// NOTE: do not call downloadMediaMessage here — your media handler populates USERS[username].lastMedia
// If you ever want to send images from here, ensure you already have a normalized buffer in u.lastMedia

/* ---------------------- config ---------------------- */
const DEFAULTS = {
  perSendDelayMs: 2500,           // conservative: ~1 msg / 2.5s
  batchSize: 4,                   // mini-batch size
  batchDelayMs: 10_000,           // delay between mini-batches
  retryCount: 3,
  retryBaseMs: 1000,
  throttleFailureThreshold: 0.6,  // if >60% of batch fails → backoff
  throttleBackoffMs: 60_000,      // backoff window
};

/* ---------------------- helpers ---------------------- */

function log(uName, ...args) {
  console.log(`[broadcast:${uName}]`, ...args);
}

// ALWAYS resolve from global.USERS so index.js doesn't have to pass USERS around
function safeGetUser(username) {
  const store = global.USERS || (global.USERS = {});
  return store[username] || (store[username] = {});
}

function writeGroupsToDisk(username, allGroups) {
  try {
    const p = getUserPaths(username).groups;
    writeJSON(p, allGroups);
    log(username, `wrote groups.json (${Object.keys(allGroups || {}).length} groups)`);
  } catch (e) {
    log(username, 'failed to write groups.json:', e?.message || e);
  }
}

function bareJid(j) {
  return String(j || '').replace(/:[^@]+(?=@)/, '');
}

/**
 * Ensure we have fresh metadata from the server for a group.
 * Returns:
 * { jid, subject, announce, size, iAmIn, iAmAdmin, raw?, error? }
 */
async function fetchGroupMetadataSafe(sock, jid) {
  try {
    const meta = await sock.groupMetadata(jid);
    const participants = (meta?.participants || []).map(p => p.id || p.jid || p);
    const size = participants.length;

    const botJid = bareJid(sock?.user?.id || '');
    const iAmIn = participants.some(p => bareJid(p) === botJid);

    let iAmAdmin = false;
    try {
      iAmAdmin = !!meta?.participants?.find(p =>
        bareJid(p.id || p.jid || p) === botJid &&
        (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin)
      );
    } catch {}

    return {
      jid,
      subject: meta?.subject || meta?.name || jid,
      announce: !!meta?.announce,
      size,
      iAmIn,
      iAmAdmin,
      raw: meta
    };
  } catch (e) {
    return {
      jid,
      subject: jid,
      announce: false,
      size: 0,
      iAmIn: false,
      iAmAdmin: false,
      raw: null,
      error: e
    };
  }
}

/**
 * Send content to a single group safely with retries.
 * content = { text } OR { image, mimetype, caption }
 */
async function sendToGroupWithRetries({
  sock,
  jid,
  content,
  opts = {},
  retryCount = DEFAULTS.retryCount
}) {
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      await sock.sendMessage(jid, content, opts);
      return { ok: true };
    } catch (err) {
      const msg = err?.message || String(err);

      // Treat these as permanent failures (membership/content restrictions)
      if (/not-acceptable|403|400|not allowed/i.test(msg)) {
        return { ok: false, permanent: true, error: msg };
      }

      if (attempt < retryCount) {
        const wait = DEFAULTS.retryBaseMs * Math.pow(2, attempt);
        await sleep(wait);
        continue;
      }
      return { ok: false, permanent: false, error: msg };
    }
  }
}

/* ---------------------- scanning & categorising ---------------------- */

/**
 * Scans groups via groupFetchAllParticipating (preferred) or falls back to disk.
 * Populates USERS[username].allGroups and writes to disk.
 */
async function autoScanAndCategorise(username, sock) {
  const u = safeGetUser(username);
  if (!sock) {
    log(username, 'autoScan skipped: sock missing');
    return;
  }

  log(username, 'Starting group scan...');

  let groupsObj = {};
  try {
    // Preferred: fetch all participating groups directly from WhatsApp
    const metaMap = await sock.groupFetchAllParticipating();
    for (const [jid, g] of Object.entries(metaMap || {})) {
      const meta = await fetchGroupMetadataSafe(sock, jid);
      groupsObj[jid] = {
        id: jid,
        name: meta.subject || jid,
        subject: meta.subject || jid,
        announce: !!meta.announce,
        size: meta.size || 0,
        iAmIn: !!meta.iAmIn,
        iAmAdmin: !!meta.iAmAdmin
      };
    }
  } catch (e) {
    log(username, 'groupFetchAllParticipating failed; falling back to disk:', e?.message || e);
    const p = getUserPaths(username).groups;
    groupsObj = readJSON(p, {});
  }

  u.allGroups = groupsObj;

  // Auto-categorise by keywords ONLY if categories are empty
  if (!u.categories || Object.keys(u.categories).length === 0) {
    const candidateCats = {};
    for (const [jid, g] of Object.entries(groupsObj)) {
      const cat = categoriseGroupName((g.subject || g.name || ''));
      if (cat) {
        (candidateCats[cat] ||= []).push(jid);
      }
    }
    u.categories = candidateCats;
  }

  // Persist
  writeGroupsToDisk(username, u.allGroups);
  try { saveUserState(username, u.categories || {}, u.allGroups || {}); } catch {}
  log(username, `Scan complete: found ${Object.keys(groupsObj).length} groups`);
}

/* ---------------------- cleaning categories ---------------------- */

/**
 * Map names in categories to current JIDs. Drops stale entries.
 */
function cleanCategories(username) {
  const u = safeGetUser(username);
  const allGroups = u.allGroups || {};
  const paths = getUserPaths(username);

  const byExact = new Map(
    Object.values(allGroups).map(g => [ (g.name || g.subject || g.id || '').trim(), g.id ])
  );
  const norm = s => (s || '')
    .toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
  const byNorm = new Map(
    Object.values(allGroups).map(g => [ norm(g.name || g.subject || g.id || ''), g.id ])
  );

  const categories = u.categories || {};
  const normalized = {};
  let kept = 0, fixed = 0, dropped = 0;

  for (const [cat, arr] of Object.entries(categories || {})) {
    const out = [];
    for (const entry of arr || []) {
      if (!entry) continue;
      if (typeof entry === 'string' && entry.endsWith('@g.us')) { out.push(entry); kept++; continue; }
      const exact = byExact.get((entry || '').trim());
      if (exact) { out.push(exact); fixed++; continue; }
      const maybe = byNorm.get(norm(entry || ''));
      if (maybe) { out.push(maybe); fixed++; continue; }
      dropped++;
    }
    normalized[cat] = Array.from(new Set(out));
  }

  u.categories = normalized;
  try {
    writeJSON(paths.categories, normalized);
    if (u.allGroups && Object.keys(u.allGroups).length) writeJSON(paths.groups, u.allGroups);
    saveUserState(username, normalized, u.allGroups || {});
  } catch (e) {
    log(username, 'Failed to save cleaned categories:', e?.message || e);
  }

  return { kept, fixed, dropped, categories: normalized };
}

/* ---------------------- broadcast engine ---------------------- */

/**
 * Core function to broadcast an image or text to an array of JIDs.
 * - honors rate limits
 * - checks membership before sending unless force=true
 * - adaptive backoff on high failure rate
 */
async function runBroadcast({
  sock,
  username,
  jids = [],
  content,                  // string (text) OR { buffer, mimetype } for image
  contentType = 'text',     // 'text' | 'image'
  caption = '',
  mimetype = null,
  force = false
}) {
  const u = safeGetUser(username);
  if (!sock) throw new Error('sock missing');
  if (!Array.isArray(jids) || !jids.length) {
    log(username, 'No targets to broadcast to');
    return { ok: true, sent: 0, fail: 0 };
  }

  // per-user lock
  if (u.isBroadcasting) {
    log(username, 'broadcast blocked: already running');
    return { ok: false, reason: 'already_running' };
  }
  u.isBroadcasting = true;

  const perSendDelay = u.pacing?.perSendDelay ?? DEFAULTS.perSendDelayMs;
  const batchSize = u.pacing?.batchSize ?? DEFAULTS.batchSize;
  const batchDelay = u.pacing?.batchDelay ?? DEFAULTS.batchDelayMs;

  const results = { ok: 0, fail: 0, skipped: 0, details: [] };

  try {
    for (let i = 0; i < jids.length; i += batchSize) {
      if (u._cancel?.requested) {
        log(username, 'Broadcast cancel requested — stopping after current item');
        break;
      }
      const batch = jids.slice(i, i + batchSize);

      let batchFails = 0;

      for (const jid of batch) {
        if (u._cancel?.requested) break;

        // validate membership unless force
        const meta = await fetchGroupMetadataSafe(sock, jid);
        const iAmIn = !!meta.iAmIn;

        if (!force && !iAmIn) {
          log(username, `skipping ${jid} (not a member)`);
          results.skipped++;
          results.details.push({ jid, ok: false, reason: 'not-member' });
          await sleep(200);
          continue;
        }

        // construct payload
        let payload = null;
        if (contentType === 'text') {
          payload = { text: String(content ?? '') };
          if (!payload.text) {
            results.details.push({ jid, ok: false, reason: 'empty-text' });
            batchFails++; results.fail++;
            continue;
          }
        } else if (contentType === 'image') {
          const buf = (content && content.buffer) || null;
          const type = (content && content.mimetype) || mimetype || 'image/jpeg';
          if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
            results.details.push({ jid, ok: false, reason: 'no-media' });
            batchFails++; results.fail++;
            continue;
          }
          payload = { image: buf, mimetype: type, caption: caption || '' };
        } else {
          payload = { text: String(content ?? '') };
        }

        try {
          const res = await sendToGroupWithRetries({ sock, jid, content: payload });
          if (res.ok) {
            log(username, `Sent to ${jid}`);
            results.ok++;
            results.details.push({ jid, ok: true });
          } else {
            results.fail++;
            batchFails++;
            results.details.push({ jid, ok: false, reason: res.error, permanent: !!res.permanent });
            log(username, `Failed send to ${jid}: ${res.error}`);
          }
        } catch (e) {
          results.fail++;
          batchFails++;
          results.details.push({ jid, ok: false, reason: e?.message || e });
          log(username, `Unhandled send error for ${jid}:`, e);
        }

        await sleep(perSendDelay);
      }

      // adaptive backoff if batch failure rate high
      const failRate = batchFails / Math.max(1, batch.length);
      if (failRate >= DEFAULTS.throttleFailureThreshold) {
        log(username, `⚠️ High failure rate (batch ${(failRate*100).toFixed(0)}%). Backing off ${DEFAULTS.throttleBackoffMs}ms.`);
        await sleep(DEFAULTS.throttleBackoffMs);
      } else {
        await sleep(batchDelay);
      }
    }
  } finally {
    u.isBroadcasting = false;
    if (u._cancel) { u._cancel.requested = false; u._cancel.at = 0; }
  }

  log(username, `Broadcast run done: ok=${results.ok} fail=${results.fail} skipped=${results.skipped}`);
  return results;
}

/* ---------------------- command/message handler ---------------------- */

/**
 * Handles incoming messages from the user (owner) to control the bot.
 * Called from index.js: handleBroadcastMessage(username, msg, sock)
 */
async function handleBroadcastMessage(username, msg, sock) {
  const u = safeGetUser(username);
  if (!msg || !msg.message) return;

  try {
    const from = msg?.key?.remoteJid;
    const isOwner = !!u.ownerJid && String(from) === String(u.ownerJid);

    // update lastActive
    u.lastActive = Date.now();

    // If an image is received from owner and mode is media -> rely on media handler to save u.lastMedia
    const hasImage = !!msg.message.imageMessage;
    if (isOwner && hasImage && (u.mode === 'media' || !u.mode)) {
      log(username, 'Owner sent media — external media handler should save buffer to u.lastMedia');
      return;
    }

    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
    if (!text) return;

    if (!isOwner) return; // ignore commands from non-owner

    const parts = text.split(' ').filter(Boolean);
    const cmd = parts[0]?.toLowerCase();

    switch (cmd) {
      case '/rescan':
      case '/syncgroups': {
        await sock.sendMessage(u.ownerJid, { text: '🔄 Rescanning groups...' }).catch(() => {});
        await autoScanAndCategorise(username, sock);
        await sock.sendMessage(u.ownerJid, { text: '✅ Rescanned and categorised groups.' }).catch(() => {});
        break;
      }

      case '/clean': {
        const res = cleanCategories(username);
        await sock.sendMessage(u.ownerJid, {
          text: `🧹 Categories cleaned.\nKept: ${res.kept}, Fixed: ${res.fixed}, Dropped: ${res.dropped}`
        }).catch(() => {});
        break;
      }

      case '/cats': {
        const cats = u.categories || {};
        const allGroups = u.allGroups || {};
        let out =
          `Choose a category to broadcast to:\n\n` +
          `Mode: ${u.mode === 'text' ? 'Text' : 'Media'} — use /text or /media to switch.\n\n`;
        let idx = 1;
        for (const [cat, arr] of Object.entries(cats)) {
          out += `${idx++}. ${cat} (${(arr || []).length} groups)\n`;
          const names = (arr || [])
            .slice(0, 10)
            .map(jid => (allGroups[jid]?.subject || allGroups[jid]?.name || jid))
            .map(n => ` - ${n}`).join('\n');
          if (names) out += `${names}\n`;
          out += `\n`;
        }
        out += `${idx}. Send to ALL\n\nReply with the number.`;
        await sock.sendMessage(u.ownerJid, { text: out }).catch(() => {});
        u.lastPromptChat = { type: 'choose_category', ts: Date.now() };
        break;
      }

      case '/text':
        u.mode = 'text';
        await sock.sendMessage(u.ownerJid, { text: '✏️ Switched to text mode. Send a message to broadcast.' }).catch(() => {});
        break;

      case '/media':
        u.mode = 'media';
        await sock.sendMessage(u.ownerJid, { text: '🖼️ Switched to media mode. Send an image to broadcast.' }).catch(() => {});
        break;

      case '/force': {
        const arg = (parts[1] || 'off').toLowerCase();
        u.force = (arg === 'on' || arg === 'true' || arg === '1');
        await sock.sendMessage(u.ownerJid, {
          text: `🔧 Force mode ${u.force ? 'ON' : 'OFF'} (bypass membership preflight)`
        }).catch(() => {});
        break;
      }

      case '/sendto': {
        // /sendto <jid> <text...>  (text mode)
        // /sendto <jid>            (media mode; uses u.lastMedia)
        const to = parts[1];
        if (!to || !to.endsWith('@g.us')) {
          await sock.sendMessage(u.ownerJid, { text: 'Usage: /sendto <group.jid@g.us> [message]' }).catch(() => {});
          break;
        }

        const meta = await fetchGroupMetadataSafe(sock, to);
        await sock.sendMessage(u.ownerJid, {
          text: `/sendto DIAG: group=${to} subject="${meta.subject}" announce=${meta.announce} size=${meta.size} iAmIn=${meta.iAmIn} iAmAdmin=${meta.iAmAdmin}`
        }).catch(() => {});

        if (!u.force && !meta.iAmIn) {
          await sock.sendMessage(u.ownerJid, { text: `❌ Not a member of ${to} according to metadata. Use /force on to bypass.` }).catch(() => {});
          break;
        }

        if (u.mode === 'text') {
          const body = parts.slice(2).join(' ');
          if (!body) {
            await sock.sendMessage(u.ownerJid, { text: 'Please provide message text after the JID.' }).catch(() => {});
            break;
          }
          const res = await sendToGroupWithRetries({ sock, jid: to, content: { text: body } });
          if (res.ok) await sock.sendMessage(u.ownerJid, { text: `✅ Sent to ${to}` }).catch(() => {});
          else await sock.sendMessage(u.ownerJid, { text: `❌ Failed to send to ${to}: ${res.error}` }).catch(() => {});
        } else {
          // media mode
          if (!u.lastMedia || u.lastMedia.kind !== 'image' || !u.lastMedia.buffer) {
            await sock.sendMessage(u.ownerJid, { text: 'No pending image to broadcast. Send an image first.' }).catch(() => {});
            break;
          }
          const payload = {
            image: u.lastMedia.buffer,
            mimetype: u.lastMedia.mimetype || 'image/jpeg',
            caption: u.lastMedia.caption || ''
          };
          const res = await sendToGroupWithRetries({ sock, jid: to, content: payload });
          if (res.ok) await sock.sendMessage(u.ownerJid, { text: `✅ Image sent to ${to}` }).catch(() => {});
          else await sock.sendMessage(u.ownerJid, { text: `❌ Failed to send to ${to}: ${res.error}` }).catch(() => {});
        }
        break;
      }

      default: {
        // Numeric reply flow after /cats
        if (u.lastPromptChat && u.lastPromptChat.type === 'choose_category') {
          const num = parseInt(text, 10);
          const cats = Object.keys(u.categories || {});
          if (!isNaN(num) && num >= 1 && num <= cats.length + 1) {
            if (num === cats.length + 1) {
              // send to ALL
              const allJids = Object.keys(u.allGroups || {});
              await sock.sendMessage(u.ownerJid, {
                text: `Broadcasting ${u.mode === 'text' ? 'text' : 'image'} to ${allJids.length} group(s)...`
              }).catch(() => {});

              if (u.mode === 'media') {
                if (!u.lastMedia || u.lastMedia.kind !== 'image' || !u.lastMedia.buffer) {
                  await sock.sendMessage(u.ownerJid, { text: 'No pending image to broadcast. Send an image first.' }).catch(() => {});
                } else {
                  await runBroadcast({
                    sock,
                    username,
                    jids: allJids,
                    content: { buffer: u.lastMedia.buffer, mimetype: u.lastMedia.mimetype },
                    contentType: 'image',
                    caption: u.lastMedia.caption || '',
                    force: u.force
                  }).catch(() => {});
                  await sock.sendMessage(u.ownerJid, { text: '✅ Done. Send another image to broadcast, or /text to switch to text mode.' }).catch(() => {});
                  delete u.lastMedia;
                }
              } else {
                if (!u.pendingText) {
                  await sock.sendMessage(u.ownerJid, { text: 'No pending text to broadcast. Send a message first.' }).catch(() => {});
                } else {
                  await runBroadcast({
                    sock,
                    username,
                    jids: allJids,
                    content: u.pendingText,
                    contentType: 'text',
                    force: u.force
                  }).catch(() => {});
                  await sock.sendMessage(u.ownerJid, { text: '✅ Done. Send more text to broadcast, or /media to switch to media mode.' }).catch(() => {});
                  delete u.pendingText;
                }
              }
            } else {
              // send to selected category
              const chosen = cats[num - 1];
              const jids = (u.categories[chosen] || []);
              await sock.sendMessage(u.ownerJid, {
                text: `Broadcasting ${u.mode === 'text' ? 'text' : 'image'} to ${jids.length} group(s) in ${chosen}...`
              }).catch(() => {});
              if (u.mode === 'media') {
                if (!u.lastMedia || u.lastMedia.kind !== 'image' || !u.lastMedia.buffer) {
                  await sock.sendMessage(u.ownerJid, { text: 'No pending image to broadcast. Send an image first.' }).catch(() => {});
                } else {
                  await runBroadcast({
                    sock,
                    username,
                    jids,
                    content: { buffer: u.lastMedia.buffer, mimetype: u.lastMedia.mimetype },
                    contentType: 'image',
                    caption: u.lastMedia.caption || '',
                    force: u.force
                  }).catch(() => {});
                  await sock.sendMessage(u.ownerJid, { text: '✅ Done. Send another image to broadcast, or /text to switch to text mode.' }).catch(() => {});
                  delete u.lastMedia;
                }
              } else {
                if (!u.pendingText) {
                  await sock.sendMessage(u.ownerJid, { text: 'No pending text to broadcast. Send a message first.' }).catch(() => {});
                } else {
                  await runBroadcast({
                    sock,
                    username,
                    jids,
                    content: u.pendingText,
                    contentType: 'text',
                    force: u.force
                  }).catch(() => {});
                  await sock.sendMessage(u.ownerJid, { text: '✅ Done. Send more text to broadcast, or /media to switch to media mode.' }).catch(() => {});
                  delete u.pendingText;
                }
              }
            }
            u.lastPromptChat = null;
          } else {
            await sock.sendMessage(u.ownerJid, { text: 'Invalid selection. Reply with the number shown.' }).catch(() => {});
          }
        } else {
          // store normal text in text mode
          if (u.mode === 'text') {
            u.pendingText = text;
            await sock.sendMessage(u.ownerJid, { text: `Saved message for broadcast. Use /cats to choose categories and send.` }).catch(() => {});
          }
        }
        break;
      }
    }
  } catch (err) {
    log(username, 'handleBroadcastMessage error:', err?.message || err);
  }
}

/* ---------------------- exports ---------------------- */

module.exports = {
  autoScanAndCategorise,
  cleanCategories,
  handleBroadcastMessage,
  runBroadcast
};
