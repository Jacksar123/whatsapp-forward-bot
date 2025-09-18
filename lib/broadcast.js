// lib/broadcast.js
'use strict';

const fs = require('fs-extra');
const path = require('path');
const { getUserPaths, readJSON, writeJSON, sleep, categoriseGroupName } = require('./utils');
const { saveUserState } = require('./state');
const { normaliseImage } = require('./media-normalise'); // if you use image normalization here
// NOTE: do not call downloadMediaMessage here — media handler populates USERS[username].lastMedia

/* ---------------------- config ---------------------- */
const DEFAULTS = {
  perSendDelayMs: 2500,      // conservative: 1 send every 2.5s
  batchSize: 4,              // how many groups per "mini-batch"
  batchDelayMs: 10_000,      // delay between mini-batches
  retryCount: 3,
  retryBaseMs: 1000,
  throttleFailureThreshold: 0.6, // if >60% of a mini-batch fails => slow down
  throttleBackoffMs: 60_000,     // when we detect throttling, wait this long
};

/* ---------------------- helpers ---------------------- */

function log(uName, ...args) {
  console.log(`[broadcast:${uName}]`, ...args);
}

function safeGetUser(USERS, username) {
  return USERS[username] || (USERS[username] = {});
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

/**
 * Ensure we have fresh metadata from the server for a group.
 * Returns an object:
 * { jid, subject, announce, size, iAmIn, iAmAdmin }
 */
async function fetchGroupMetadataSafe(sock, jid) {
  try {
    const meta = await sock.groupMetadata(jid);
    const participants = (meta?.participants || []).map(p => p.id || p.jid || p);
    const size = participants.length;
    // determine if bot is in and admin if we know sock.user.id
    const botJid = sock?.user?.id;
    const iAmIn = !!participants.find(p => p && String(p).replace(/:[^@]+(?=@)/, '') === String(botJid).replace(/:[^@]+(?=@)/, ''));
    let iAmAdmin = false;
    try {
      iAmAdmin = !!meta?.participants?.find(p => (p.id || p.jid || p).toString().includes(botJid) && (p.admin === 'admin' || p.isAdmin));
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
    // metadata could fail for groups we are not in or if blocked
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
 * content is the second param as passed to sock.sendMessage (e.g. { text } or { image, mimetype, caption })
 */
async function sendToGroupWithRetries({ sock, jid, content, opts = {}, retryCount = DEFAULTS.retryCount }) {
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      await sock.sendMessage(jid, content, opts);
      return { ok: true };
    } catch (err) {
      const msg = err?.message || String(err);
      // not-acceptable is often a content/membership issue; treat as permanent for this item
      if (/not-acceptable|403|400|not allowed/i.test(msg)) {
        return { ok: false, permanent: true, error: msg };
      }
      // connection or transient errors -> retry
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
 * Scans groups from socket (via fetchGroupMetadata for each chat listed in sock.chats)
 * and populates USERS[username].allGroups = { jid: { id, name, subject, announce, size, iAmIn, iAmAdmin } }
 * Also writes groups.json to disk.
 */
async function autoScanAndCategorise(username, sock, USERS) {
  const u = safeGetUser(USERS, username);
  if (!sock) {
    log(username, 'autoScan skipped: sock missing');
    return;
  }

  log(username, 'Starting group scan...');

  // Baileys exposes store or we can ask the connection for chats: try sock.chats or sock.ev.state
  let chatKeys = [];
  try {
    // prefer sock.chats (available in recent baileys) otherwise fallback to reading from disk
    if (sock.chats && typeof sock.chats === 'object') {
      chatKeys = Object.keys(sock.chats).filter(k => typeof k === 'string' && k.endsWith('@g.us'));
    } else if (sock.chats && Array.isArray(sock.chats)) {
      chatKeys = sock.chats.filter(c => c.id && String(c.id).endsWith('@g.us')).map(c => c.id);
    } else {
      // no chat store available: maybe rely on previously saved groups
      log(username, 'No sock chat store; falling back to disk groups');
      const p = getUserPaths(username).groups;
      const existing = readJSON(p, {});
      Object.assign(u, { allGroups: existing || {} });
      return;
    }
  } catch (e) {
    log(username, 'Failed to enumerate sock chats:', e?.message || e);
    return;
  }

  const allGroups = {};
  for (const jid of chatKeys) {
    try {
      const meta = await fetchGroupMetadataSafe(sock, jid);
      allGroups[jid] = {
        id: jid,
        name: meta.subject || meta.jid,
        subject: meta.subject || meta.jid,
        announce: !!meta.announce,
        size: meta.size || 0,
        iAmIn: !!meta.iAmIn,
        iAmAdmin: !!meta.iAmAdmin
      };
    } catch (e) {
      // continue
      allGroups[jid] = { id: jid, name: jid, subject: jid, announce: false, size: 0, iAmIn: false, iAmAdmin: false };
    }
  }

  u.allGroups = allGroups;
  // auto-categorise based on group name keywords if categories empty
  if (!u.categories || Object.keys(u.categories).length === 0) {
    const candidateCats = {};
    for (const [jid, g] of Object.entries(allGroups)) {
      const cat = categoriseGroupName((g.subject || g.name || '') );
      if (cat) {
        candidateCats[cat] = candidateCats[cat] || [];
        candidateCats[cat].push(jid);
      }
    }
    u.categories = candidateCats;
  }

  // persist
  writeGroupsToDisk(username, u.allGroups);
  try { saveUserState(username, u.categories || {}, u.allGroups || {}); } catch (e) {}
  log(username, `Scan complete: found ${Object.keys(allGroups).length} groups`);
}

/* ---------------------- cleaning categories ---------------------- */

/**
 * Map names in categories to current JIDs. Drops stale JIDs.
 * This tries best-effort mapping by exact name or normalized name.
 */
function cleanCategories(username, USERS) {
  const u = safeGetUser(USERS, username);
  const allGroups = u.allGroups || {};
  const paths = getUserPaths(username);

  const byExact = new Map(Object.values(allGroups).map(g => [ (g.name||g.subject||g.id||'').trim(), g.id ]));
  const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  const byNorm = new Map(Object.values(allGroups).map(g => [ norm(g.name||g.subject||g.id||''), g.id ]));

  const categories = u.categories || {};
  const normalized = {};
  let kept = 0, fixed = 0, dropped = 0;

  for (const [cat, arr] of Object.entries(categories || {})) {
    const out = [];
    for (const entry of arr || []) {
      if (!entry) continue;
      if (typeof entry === 'string' && entry.endsWith('@g.us')) { out.push(entry); kept++; continue; }
      const exact = byExact.get((entry||'').trim());
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
 * - adaptive backoff on failure rate
 */
async function runBroadcast({ sock, USERS, username, jids = [], content, contentType = 'text', caption = '', mimetype = null, force = false }) {
  const u = safeGetUser(USERS, username);
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
    // chunk into mini-batches for adaptive throttling
    for (let i = 0; i < jids.length; i += batchSize) {
      if (u._cancel?.requested) {
        log(username, 'Broadcast cancel requested -- stopping after current item');
        break;
      }
      const batch = jids.slice(i, i + batchSize);

      // prepare parallel results (we still send sequentially to limit concurrency)
      let batchFails = 0;
      let batchOk = 0;

      for (const jid of batch) {
        if (u._cancel?.requested) break;

        // refresh metadata to ensure we have membership flags
        const meta = await fetchGroupMetadataSafe(sock, jid);
        const iAmIn = !!meta.iAmIn;
        const info = { jid, iAmIn, subject: meta.subject || meta.jid };

        if (!force && !iAmIn) {
          log(username, `skipping ${jid} (not a member)`);
          results.skipped++;
          results.details.push({ jid, ok: false, reason: 'not-member' });
          batchFails++;
          // small delay still to look natural
          await sleep(200);
          continue;
        }

        // build content payload
        let payload = null;
        if (contentType === 'text') {
          payload = { text: content };
        } else if (contentType === 'image') {
          if (!content || !content.buffer) {
            results.details.push({ jid, ok: false, reason: 'no-media' });
            batchFails++;
            continue;
          }
          payload = {
            image: content.buffer,
            mimetype: content.mimetype || 'image/jpeg',
            caption: caption || ''
          };
        } else {
          // extendable for other types
          payload = { text: content };
        }

        // actually send with retries
        try {
          const res = await sendToGroupWithRetries({ sock, jid, content: payload });
          if (res.ok) {
            log(username, `Sent to ${jid}`);
            results.ok++;
            batchOk++;
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

        // inter-send delay
        await sleep(perSendDelay);
      } // end batch loop

      // detect throttling and adjust
      const failRate = batchFails / Math.max(1, batch.length);
      if (failRate >= DEFAULTS.throttleFailureThreshold) {
        // high failure -> likely throttling or membership issues
        log(username, `⚠️ Throttling detected (failRate=${(failRate*100).toFixed(0)}%). Backing off ${DEFAULTS.throttleBackoffMs}ms.`);
        await sleep(DEFAULTS.throttleBackoffMs);
      } else {
        // normal batch pause
        await sleep(batchDelay);
      }
    } // end all jids
  } finally {
    u.isBroadcasting = false;
    // clear cancel flag after finished
    if (u._cancel) { u._cancel.requested = false; u._cancel.at = 0; }
  }

  log(username, `Broadcast run done: ok=${results.ok} fail=${results.fail} skipped=${results.skipped}`);
  return results;
}

/* ---------------------- command/message handler ---------------------- */

/**
 * Handles incoming messages from the user (owner) to control the bot.
 * - simple command parser for rescan/clean/cats/media/text/force/sendto
 *
 * Called from index.js: handleBroadcastMessage(username, msg, sock)
 */
async function handleBroadcastMessage(username, msg, sock, USERS) {
  const u = safeGetUser(USERS, username);
  if (!msg || !msg.message) return;
  try {
    // identify who sent it (owner or others)
    const from = msg?.key?.remoteJid;
    const isOwner = !!u.ownerJid && String(from) === String(u.ownerJid);

    // update lastActive
    u.lastActive = Date.now();

    // If an image is received from owner and mode is media -> store lastMedia
    const mediaKey = Object.keys(msg.message).find(k => /imageMessage|documentMessage|videoMessage/.test(k));
    if (isOwner && mediaKey && (u.mode === 'media' || !u.mode)) {
      // extract buffer if media handler already saved buffer into USERS by another hook; if not, we rely on your media handler
      // Here we just store the raw message so your existing media handler (lib/media.js) can pick it up if you're using that.
      log(username, 'Owner sent media — expecting media handler to save buffer');
      // nothing more to do here; your media handler (downloadMediaMessage -> normalise -> u.lastMedia) will keep working
      return;
    }

    // text commands
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
    if (!text) return;

    // allow only owner to run commands
    if (!isOwner) {
      // non-owner messages may be used in conversation flows but ignore commands
      return;
    }

    const parts = text.split(' ').filter(Boolean);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/rescan':
      case '/syncgroups':
        await sock.sendMessage(u.ownerJid, { text: '🔄 Rescanning groups...' }).catch(() => {});
        await autoScanAndCategorise(username, sock, USERS);
        await sock.sendMessage(u.ownerJid, { text: '✅ Rescanned and categorised groups.' }).catch(() => {});
        break;

      case '/clean':
        {
          const res = cleanCategories(username, USERS);
          await sock.sendMessage(u.ownerJid, { text: `🧹 Categories cleaned.\nKept: ${res.kept}, Fixed: ${res.fixed}, Dropped: ${res.dropped}` }).catch(()=>{});
        }
        break;

      case '/cats':
        {
          // send list of categories + counts
          const cats = u.categories || {};
          const allGroups = u.allGroups || {};
          let out = `Choose a category to broadcast to:\n\nMode: ${u.mode === 'text' ? 'Text' : 'Media'} — use /text or /media to switch.\n\n`;
          let idx = 1;
          for (const [cat, arr] of Object.entries(cats)) {
            out += `${idx++}. ${cat} (${(arr||[]).length} groups)\n`;
            const names = (arr||[]).slice(0, 10).map(jid => (allGroups[jid]?.subject || allGroups[jid]?.name || jid)).map(n => ` - ${n}`).join('\n');
            out += `${names}\n\n`;
          }
          out += `${idx}. Send to ALL\n\nReply with the number.`;
          await sock.sendMessage(u.ownerJid, { text: out }).catch(()=>{});
          // store a small flow state so next numeric reply triggers broadcast
          u.lastPromptChat = { type: 'choose_category' , ts: Date.now() };
        }
        break;

      case '/text':
        u.mode = 'text';
        await sock.sendMessage(u.ownerJid, { text: '✏️ Switched to text mode. Send a message to broadcast.' }).catch(()=>{});
        break;

      case '/media':
        u.mode = 'media';
        await sock.sendMessage(u.ownerJid, { text: '🖼️ Switched to media mode. Send an image to broadcast.' }).catch(()=>{});
        break;

      case '/force':
        {
          const arg = parts[1] || 'off';
          u.force = (arg.toLowerCase() === 'on');
          await sock.sendMessage(u.ownerJid, { text: `🔧 Force mode ${u.force ? 'ON' : 'OFF'} (bypass membership preflight)` }).catch(()=>{});
        }
        break;

      case '/sendto':
        {
          // format: /sendto <jid> <text...>
          const to = parts[1];
          if (!to || !to.endsWith('@g.us')) {
            await sock.sendMessage(u.ownerJid, { text: 'Usage: /sendto <group.jid@g.us> <message>' }).catch(()=>{});
            break;
          }
          const body = parts.slice(2).join(' ');
          if (!body) {
            await sock.sendMessage(u.ownerJid, { text: 'Please provide message text.' }).catch(()=>{});
            break;
          }
          await sock.sendMessage(u.ownerJid, { text: `🔁 Sending to ${to}...` }).catch(()=>{});
          const meta = await fetchGroupMetadataSafe(sock, to);
          if (!u.force && !meta.iAmIn) {
            await sock.sendMessage(u.ownerJid, { text: `❌ Not a member of ${to} according to metadata. Use /force on to bypass.` }).catch(()=>{});
            break;
          }
          const res = await sendToGroupWithRetries({ sock, jid: to, content: { text: body } });
          if (res.ok) await sock.sendMessage(u.ownerJid, { text: `✅ Sent to ${to}` }).catch(()=>{});
          else await sock.sendMessage(u.ownerJid, { text: `❌ Failed to send to ${to}: ${res.error}` }).catch(()=>{});
        }
        break;

      default:
        // numeric reply flow (after /cats)
        if (u.lastPromptChat && u.lastPromptChat.type === 'choose_category') {
          const num = parseInt(text, 10);
          const cats = Object.keys(u.categories || {});
          if (!isNaN(num) && num >= 1 && num <= cats.length + 1) {
            if (num === cats.length + 1) {
              // send to all groups
              const allJids = Object.keys(u.allGroups || {});
              await sock.sendMessage(u.ownerJid, { text: `Broadcasting ${u.mode === 'text' ? 'text' : 'image'} to ${allJids.length} group(s)...` }).catch(()=>{});
              // prepare content
              if (u.mode === 'media') {
                if (!u.lastMedia || u.lastMedia.kind !== 'image') {
                  await sock.sendMessage(u.ownerJid, { text: 'No pending image to broadcast. Send an image first.' }).catch(()=>{});
                  break;
                }
                await runBroadcast({ sock, USERS, username, jids: allJids, content: { buffer: u.lastMedia.buffer, mimetype: u.lastMedia.mimetype }, contentType: 'image', caption: u.lastMedia.caption || '', force: u.force }).catch(()=>{});
                await sock.sendMessage(u.ownerJid, { text: '✅ Done. Send another image to broadcast, or /text to switch to text mode.' }).catch(()=>{});
                delete u.lastMedia;
              } else {
                // text mode
                if (!u.pendingText) {
                  await sock.sendMessage(u.ownerJid, { text: 'No pending text to broadcast. Send a message first.' }).catch(()=>{});
                  break;
                }
                await runBroadcast({ sock, USERS, username, jids: allJids, content: u.pendingText, contentType: 'text', force: u.force }).catch(()=>{});
                await sock.sendMessage(u.ownerJid, { text: '✅ Done. Send more text to broadcast, or /media to switch to media mode.' }).catch(()=>{});
                delete u.pendingText;
              }
            } else {
              // send to that category
              const chosen = cats[num-1];
              const jids = (u.categories[chosen] || []);
              await sock.sendMessage(u.ownerJid, { text: `Broadcasting ${u.mode === 'text' ? 'text' : 'image'} to ${jids.length} group(s) in ${chosen}...` }).catch(()=>{});
              if (u.mode === 'media') {
                if (!u.lastMedia || u.lastMedia.kind !== 'image') {
                  await sock.sendMessage(u.ownerJid, { text: 'No pending image to broadcast. Send an image first.' }).catch(()=>{});
                  break;
                }
                await runBroadcast({ sock, USERS, username, jids, content: { buffer: u.lastMedia.buffer, mimetype: u.lastMedia.mimetype }, contentType: 'image', caption: u.lastMedia.caption || '', force: u.force }).catch(()=>{});
                await sock.sendMessage(u.ownerJid, { text: '✅ Done. Send another image to broadcast, or /text to switch to text mode.' }).catch(()=>{});
                delete u.lastMedia;
              } else {
                if (!u.pendingText) {
                  await sock.sendMessage(u.ownerJid, { text: 'No pending text to broadcast. Send a message first.' }).catch(()=>{});
                  break;
                }
                await runBroadcast({ sock, USERS, username, jids, content: u.pendingText, contentType: 'text', force: u.force }).catch(()=>{});
                await sock.sendMessage(u.ownerJid, { text: '✅ Done. Send more text to broadcast, or /media to switch to media mode.' }).catch(()=>{});
                delete u.pendingText;
              }
            }
            // clear prompt state
            u.lastPromptChat = null;
          } else {
            await sock.sendMessage(u.ownerJid, { text: 'Invalid selection. Reply with the number shown.' }).catch(()=>{});
          }
        } else {
          // If in text mode and owner sends a normal message not a command, store it as pending text
          if (u.mode === 'text') {
            u.pendingText = text;
            await sock.sendMessage(u.ownerJid, { text: `Saved message for broadcast. Use /cats to choose categories and send.` }).catch(()=>{});
          } else {
            // not recognized command
          }
        }
        break;
    } // switch
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
