// lib/broadcast.js
'use strict';

const fs = require('fs-extra');
const {
  getUserPaths,
  readJSON,
  writeJSON,
  sleep,
  categoriseGroupName
} = require('./utils');
const { saveUserState } = require('./state');

/* ---------------------- config (throttle nuked) ---------------------- */
const DEFAULTS = {
  perSendDelayMs: 800,        // tighter pacing; raise if you see temp blocks
  batchSize: 6,               // slightly larger mini-batches
  batchDelayMs: 0,            // no idle delay between batches
  retryCount: 3,
  retryBaseMs: 600,           // faster backoff
  throttleFailureThreshold: 2,// impossible to hit -> no throttle
  throttleBackoffMs: 0,       // disabled
};

/* ---------------------- small utils ---------------------- */

function log(uName, ...args) { console.log(`[broadcast:${uName}]`, ...args); }
function store() { return global.USERS || (global.USERS = {}); }
function safeGetUser(username) { const s = store(); return s[username] || (s[username] = {}); }
function bareJid(j) { return String(j || '').replace(/:[^@]+(?=@)/, ''); }

/** System send that records IDs so we can ignore our own echoes */
async function sendSys(username, sock, jid, content, opts = {}) {
  const u = safeGetUser(username);
  if (!u.ignoreIds) u.ignoreIds = new Set();

  const send = typeof sock.safeSend === 'function'
    ? sock.safeSend.bind(sock)
    : sock.sendMessage.bind(sock);

  const res = await send(jid, content, opts).catch(e => {
    if (!/SOCKET_NOT_OPEN|Connection Closed/i.test(e?.message || '')) throw e;
  });

  try {
    const id = res?.key?.id;
    if (id) {
      u.ignoreIds.add(id);
      if (u.ignoreIds.size > 200) {
        const it = u.ignoreIds.values();
        for (let i = 0; i < 120; i++) {
          const v = it.next(); if (v.done) break; u.ignoreIds.delete(v.value);
        }
      }
    }
  } catch {}
  return res;
}

/* ---------------------- group metadata & warm-up ---------------------- */

async function fetchGroupMetadataSafe(sock, jid) {
  try {
    const meta = await sock.groupMetadata(jid);
    const participants = (meta?.participants || []).map(p => p.id || p.jid || p);
    const bot = bareJid(sock?.user?.id || '');
    const iAmIn = participants.some(p => bareJid(p) === bot);
    let iAmAdmin = false;
    try {
      iAmAdmin = !!meta?.participants?.find(p =>
        bareJid(p.id || p.jid || p) === bot &&
        (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin)
      );
    } catch {}
    return {
      jid,
      subject: meta?.subject || meta?.name || jid,
      announce: !!meta?.announce,
      size: (meta?.participants || []).length,
      iAmIn,
      iAmAdmin,
      participants,
      raw: meta
    };
  } catch (e) {
    return {
      jid, subject: jid, announce: false, size: 0,
      iAmIn: false, iAmAdmin: false, participants: [], raw: null, error: e
    };
  }
}

/**
 * Pre-establish sessions for all participants of a group.
 * (Kept — this reduces 'not-acceptable'/No sessions.)
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
      await sleep(200);
      return jids.length;
    }

    // Fallback: prod key stores so prekeys/sender-keys load
    const ks = sock?.authState?.keys;
    if (ks?.get) {
      await Promise.allSettled([
        ks.get('app-state-sync-key', ['']),
        ...jids.map(id => ks.get('sender-key-memory', [id]))
      ]);
    }
    await sleep(200);
    return jids.length;
  } catch (e) {
    sock?.logger?.warn?.(`warmSessionsForGroup failed: ${e?.message || e}`);
    return 0;
  }
}

/* ---------------------- send with retries + warm-up ---------------------- */

async function sendToGroupWithRetries({ sock, jid, content, opts = {}, retryCount = DEFAULTS.retryCount }) {
  let didWarmup = false;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      await sock.sendMessage(jid, content, opts);
      return { ok: true };
    } catch (err) {
      const msg = err?.message || String(err);

      // We no longer pre-skip anything; just report 4xx as failures.
      if (/403|400|not allowed/i.test(msg)) {
        // still return permanent for visibility in results
        return { ok: false, permanent: true, error: msg };
      }

      // First-time warm-up on 'No sessions' / 'not-acceptable'
      if ((!didWarmup && /No sessions/i.test(msg)) ||
          (!didWarmup && /not-acceptable/i.test(msg))) {
        try {
          await warmSessionsForGroup(sock, jid);
          didWarmup = true;
          await sleep(200);
          continue;
        } catch {}
      }

      // transient/connectivity
      if (/timed out|timeout|retry|temporar|disconnect|socket|stream|closed/i.test(msg)) {
        if (attempt < retryCount) {
          const wait = DEFAULTS.retryBaseMs * Math.pow(2, attempt);
          await sleep(wait);
          continue;
        }
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

/* ---------------------- scan & clean (unchanged) ---------------------- */

async function autoScanAndCategorise(username, sock) {
  const u = safeGetUser(username);
  if (!sock) { log(username, 'autoScan skipped: sock missing'); return; }

  log(username, 'Starting group scan…');

  let out = {};
  try {
    const metaMap = await sock.groupFetchAllParticipating();
    for (const [jid] of Object.entries(metaMap || {})) {
      const meta = await fetchGroupMetadataSafe(sock, jid);
      out[jid] = {
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
    out = readJSON(p, {});
  }

  u.allGroups = out;

  if (!u.categories || Object.keys(u.categories).length === 0) {
    const guess = {};
    for (const [jid, g] of Object.entries(out)) {
      const cat = categoriseGroupName(g.subject || g.name || '');
      if (cat) (guess[cat] ||= []).push(jid);
    }
    u.categories = guess;
  }

  try {
    const paths = getUserPaths(username);
    writeJSON(paths.groups, u.allGroups);
    log(username, `wrote groups.json (${Object.keys(out).length} groups)`);
  } catch (e) {
    log(username, 'failed to write groups.json:', e?.message || e);
  }

  try { saveUserState(username, u.categories || {}, u.allGroups || {}); } catch {}
  log(username, `Scan complete: ${Object.keys(out).length} groups`);
}

function cleanCategories(username) {
  const u = safeGetUser(username);
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

/* ---------------------- broadcast engine (admin/throttle removed) ---------------------- */

async function runBroadcast({
  sock,
  username,
  jids = [],
  content,
  contentType = 'text',
  caption = '',
  mimetype = null,
  // force ignored: we *always* attempt send now
}) {
  const u = safeGetUser(username);
  if (!sock) throw new Error('sock missing');
  if (!Array.isArray(jids) || !jids.length) {
    log(username, 'No targets to broadcast to'); return { ok: true, sent: 0, fail: 0, skipped: 0, details: [] };
  }
  if (u.isBroadcasting) {
    log(username, 'broadcast blocked: already running'); return { ok: false, reason: 'already_running' };
  }
  u.isBroadcasting = true;

  const perSendDelay = u.pacing?.perSendDelay ?? DEFAULTS.perSendDelayMs;
  const batchSize    = u.pacing?.batchSize    ?? DEFAULTS.batchSize;
  const batchDelay   = u.pacing?.batchDelay   ?? DEFAULTS.batchDelayMs;

  const results = { ok: 0, fail: 0, skipped: 0, details: [] };

  try {
    for (let i = 0; i < jids.length; i += batchSize) {
      if (u._cancel?.requested) { log(username, 'cancel requested'); break; }
      const batch = jids.slice(i, i + batchSize);

      for (const jid of batch) {
        if (u._cancel?.requested) break;

        // We do NOT pre-skip announce-only or non-membership anymore.
        // We warm up sessions to reduce 'not-acceptable', then we just try.

        await warmSessionsForGroup(sock, jid).catch(() => {});
        await sleep(120);

        let payload;
        if (contentType === 'text') {
          const text = String(content ?? '');
          if (!text) { results.fail++; results.details.push({ jid, ok: false, reason: 'empty-text' }); continue; }
          payload = { text };
        } else if (contentType === 'image') {
          const buf = content && content.buffer;
          const type = (content && content.mimetype) || mimetype || 'image/jpeg';
          if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
            results.fail++; results.details.push({ jid, ok: false, reason: 'no-media' }); continue;
          }
          payload = { image: buf, mimetype: type, caption: caption || '' };
        } else {
          payload = { text: String(content ?? '') };
        }

        try {
          const res = await sendToGroupWithRetries({ sock, jid, content: payload });
          if (res.ok) { results.ok++; results.details.push({ jid, ok: true }); }
          else { results.fail++; results.details.push({ jid, ok: false, reason: res.error, permanent: !!res.permanent }); }
        } catch (e) {
          results.fail++; results.details.push({ jid, ok: false, reason: e?.message || e });
        }

        await sleep(perSendDelay);
      }

      // No throttle/backoff any more.
      if (batchDelay) await sleep(batchDelay);
    }
  } finally {
    u.isBroadcasting = false;
    if (u._cancel) { u._cancel.requested = false; u._cancel.at = 0; }
  }

  log(username, `Broadcast done: ok=${results.ok} fail=${results.fail} skipped=${results.skipped}`);
  return results;
}

/* ---------------------- inbound command handler (unchanged UX) ---------------------- */

async function handleBroadcastMessage(username, msg, sock) {
  const u = safeGetUser(username);
  if (!msg || !msg.message) return;

  // anti-echo
  try {
    const id = msg?.key?.id;
    if (id && u.ignoreIds && u.ignoreIds.has(id)) { u.ignoreIds.delete(id); return; }
  } catch {}

  try {
    const from = msg?.key?.remoteJid;
    const isOwner = !!u.ownerJid && String(from) === String(u.ownerJid);
    u.lastActive = Date.now();

    // media note: external media handler persists u.lastMedia
    if (isOwner && msg.message.imageMessage && (u.mode === 'media' || !u.mode)) {
      log(username, 'Owner sent media — external handler will persist buffer'); return;
    }

    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
    if (!text) return;
    if (!isOwner) return;

    const parts = text.split(' ').filter(Boolean);
    const cmd = parts[0]?.toLowerCase();

    switch (cmd) {
      case '/rescan':
      case '/syncgroups':
        await sendSys(username, sock, u.ownerJid, { text: '🔄 Rescanning groups…' });
        await autoScanAndCategorise(username, sock);
        try {
          const res = cleanCategories(username);
          await sendSys(username, sock, u.ownerJid, { text: `✅ Rescanned.\n🧹 Cleaned: kept=${res.kept}, fixed=${res.fixed}, dropped=${res.dropped}` });
        } catch {}
        break;

      case '/clean': {
        const res = cleanCategories(username);
        await sendSys(username, sock, u.ownerJid, { text: `🧹 Categories cleaned.\nKept: ${res.kept}, Fixed: ${res.fixed}, Dropped: ${res.dropped}` });
        break;
      }

      case '/cats': {
        const cats = u.categories || {};
        const allGroups = u.allGroups || {};
        let out = `Choose a category to broadcast to:\n\nMode: ${u.mode === 'text' ? 'Text' : 'Media'} — use /text or /media to switch.\n\n`;
        let idx = 1;
        for (const [cat, arr] of Object.entries(cats)) {
          out += `${idx++}. ${cat} (${(arr || []).length} groups)\n`;
          const names = (arr || []).slice(0, 10)
            .map(jid => (allGroups[jid]?.subject || allGroups[jid]?.name || jid))
            .map(n => ` - ${n}`).join('\n');
          if (names) out += `${names}\n`;
          out += `\n`;
        }
        out += `${idx}. Send to ALL\n\nReply with the number.`;
        await sendSys(username, sock, u.ownerJid, { text: out });
        u.lastPromptChat = { type: 'choose_category', ts: Date.now() };
        break;
      }

      case '/text':
        u.mode = 'text';
        await sendSys(username, sock, u.ownerJid, { text: '✏️ Switched to text mode. Send a message to broadcast.' });
        break;

      case '/media':
        u.mode = 'media';
        await sendSys(username, sock, u.ownerJid, { text: '🖼️ Switched to image mode. Send an image to broadcast.' });
        break;

      case '/force': { // harmless now; we always attempt sends anyway
        const arg = (parts[1] || 'off').toLowerCase();
        u.force = (arg === 'on' || arg === 'true' || arg === '1');
        await sendSys(username, sock, u.ownerJid, { text: `🔧 Force mode ${u.force ? 'ON' : 'OFF'} (informational only)` });
        break;
      }

      case '/sendto': {
        const to = parts[1];
        if (!to || !to.endsWith('@g.us')) {
          await sendSys(username, sock, u.ownerJid, { text: 'Usage: /sendto <group.jid@g.us> [message]' });
          break;
        }

        // Still show diagnostics, but we won't pre-skip anything
        const meta = await fetchGroupMetadataSafe(sock, to);
        await sendSys(username, sock, u.ownerJid, {
          text: `/sendto DIAG: group=${to} subject="${meta.subject}" announce=${meta.announce} size=${meta.size} iAmIn=${meta.iAmIn} iAmAdmin=${meta.iAmAdmin}`
        });

        await warmSessionsForGroup(sock, to).catch(() => {});
        await sleep(200);

        if (u.mode === 'text') {
          const body = parts.slice(2).join(' ');
          if (!body) { await sendSys(username, sock, u.ownerJid, { text: 'Please provide message text after the JID.' }); break; }
          const res = await sendToGroupWithRetries({ sock, jid: to, content: { text: body } });
          await sendSys(username, sock, u.ownerJid, { text: res.ok ? `✅ Sent to ${to}` : `❌ Failed: ${res.error}` });
        } else {
          if (!u.lastMedia || u.lastMedia.kind !== 'image' || !u.lastMedia.buffer) {
            await sendSys(username, sock, u.ownerJid, { text: 'No pending image to broadcast. Send an image first.' });
            break;
          }
          const res = await sendToGroupWithRetries({
            sock, jid: to,
            content: { image: u.lastMedia.buffer, mimetype: u.lastMedia.mimetype || 'image/jpeg', caption: u.lastMedia.caption || '' }
          });
          await sendSys(username, sock, u.ownerJid, { text: res.ok ? `✅ Image sent to ${to}` : `❌ Failed: ${res.error}` });
        }
        break;
      }

      default: {
        // numeric flow after /cats
        if (u.lastPromptChat && u.lastPromptChat.type === 'choose_category') {
          const num = parseInt(text, 10);
          const cats = Object.keys(u.categories || {});
          if (!isNaN(num) && num >= 1 && num <= cats.length + 1) {
            const sendSet = (num === cats.length + 1)
              ? Object.keys(u.allGroups || {})
              : (u.categories[cats[num - 1]] || []);

            await sendSys(username, sock, u.ownerJid, {
              text: `Broadcasting ${u.mode === 'text' ? 'text' : 'image'} to ${sendSet.length} group(s)…`
            });

            if (u.mode === 'media') {
              if (!u.lastMedia || u.lastMedia.kind !== 'image' || !u.lastMedia.buffer) {
                await sendSys(username, sock, u.ownerJid, { text: 'No pending image to broadcast. Send an image first.' });
              } else {
                await runBroadcast({
                  sock, username, jids: sendSet,
                  content: { buffer: u.lastMedia.buffer, mimetype: u.lastMedia.mimetype },
                  contentType: 'image', caption: u.lastMedia.caption || ''
                });
                await sendSys(username, sock, u.ownerJid, { text: '✅ Done. Send another image, or /text to switch.' });
                delete u.lastMedia;
              }
            } else {
              if (!u.pendingText) {
                await sendSys(username, sock, u.ownerJid, { text: 'No pending text to broadcast. Send a message first.' });
              } else {
                await runBroadcast({ sock, username, jids: sendSet, content: u.pendingText, contentType: 'text' });
                await sendSys(username, sock, u.ownerJid, { text: '✅ Done. Send more text, or /media to switch.' });
                delete u.pendingText;
              }
            }
            u.lastPromptChat = null;
          } else {
            await sendSys(username, sock, u.ownerJid, { text: 'Invalid selection. Reply with the number shown.' });
          }
        } else {
          // friendlier text capture
          if (isOwner && text && !text.startsWith('/')) {
            const changed = (u.pendingText !== text);
            u.pendingText = text;
            if (changed) {
              u.mode = 'text';
              await sendSys(username, sock, u.ownerJid, { text: '✏️ Text saved (text mode). Use /cats to choose where to send.' });
            }
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
