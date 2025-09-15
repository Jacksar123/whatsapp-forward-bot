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

// Baseline pacing (used in prompts; adaptive loop manages actual pacing)
const SEND_MAX_RETRIES = 4;           // retries per group on failure
const SEND_BACKOFF_MS = 1200;         // base backoff (exponential)
const SEND_TIMEOUT_MS = 20000;        // HARD timeout per send (prevents stalls)

const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000; // 30 mins to pick a category
const DASHBOARD_URL = "https://whats-broadcast-hub.lovable.app";

const FOOTER = '— Sent automatically via whats-broadcast-hub.lovable.app | 🔥 Free trial available 🔥';
const MAX_NAMES_PER_CATEGORY = 30;

// Adaptive pacing bounds
const DEFAULT_PACING = { batchSize: 3, perSendDelay: 300, batchDelay: 6000, lastAdjustAt: 0 };
const MIN_PACING     = { batchSize: 2, perSendDelay: 250, batchDelay: 8000 };
const MAX_PACING     = { batchSize: 6, perSendDelay: 200, batchDelay: 3000 };

const JITTER_MS = 400;
const jitter = (ms) => ms + Math.floor(Math.random() * JITTER_MS);

/* --------------------------- adaptive pacing ---------------------------- */

function pacingFor(u) {
  if (!u.pacing) u.pacing = { ...DEFAULT_PACING };
  return u.pacing;
}

function adjustPacing(u, stats) {
  const p = pacingFor(u);
  const now = Date.now();
  if (now - (p.lastAdjustAt || 0) < 10_000) return;
  p.lastAdjustAt = now;

  const fail = (stats.failed || 0) + (stats.timedOut || 0);
  const total = (stats.sentOk || 0) + fail;
  const rate = total ? fail / total : 0;

  if (rate >= 0.15 || (stats.timedOut || 0) > 0) {
    p.batchSize   = Math.max(MIN_PACING.batchSize, p.batchSize - 1);
    p.batchDelay  = Math.min(20_000, Math.max(MIN_PACING.batchDelay, p.batchDelay + 1000));
    p.perSendDelay= Math.min(2000,   Math.max(MIN_PACING.perSendDelay, p.perSendDelay + 100));
  } else if (rate === 0 && (stats.sentOk || 0) >= 5) {
    p.batchSize   = Math.min(MAX_PACING.batchSize, p.batchSize + 1);
    p.batchDelay  = Math.max(MAX_PACING.batchDelay, p.batchDelay - 500);
    p.perSendDelay= Math.max(MAX_PACING.perSendDelay, p.perSendDelay - 50);
  }
}

/* --------------------------- utilities ---------------------------------- */

function USERSG() { return global.USERS || (global.USERS = {}); }

function cancelFlag(u){ if(!u._cancel) u._cancel={requested:false,at:0}; return u._cancel; }
function isCancelled(u){ return !!(u._cancel && u._cancel.requested); }
function requestCancel(u){ const c=cancelFlag(u); c.requested=true; c.at=Date.now(); }
function clearCancel(u){ const c=cancelFlag(u); c.requested=false; c.at=0; }

/** Strip device suffix (e.g., ":96") before "@domain". */
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

/** HARD timeout wrapper so slices never hang */
function withTimeout(promise, ms, tag = 'op') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT:${tag}:${ms}ms`)), ms)),
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
          const v = it.next(); if (v.done) break; u.ignoreIds.delete(v.value);
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

  const selfBare = bareJid(sock?.user?.id || '');

  for (const g of groups) {
    // g typically includes: id, subject, announce, participants, etc.
    const name = g.subject || g.name || g.id;
    let botIsAdmin = false;
    try {
      const parts = g.participants || [];
      const me = parts.find(p => bareJid(p?.id) === selfBare);
      botIsAdmin = !!(me && (me.admin === 'admin' || me.admin === 'superadmin' || me.isAdmin));
    } catch {}
    allGroups[g.id] = {
      id: g.id,
      name,
      announce: !!g.announce,       // admin-only if true
      botIsAdmin                    // whether this session is admin in that group
    };

    // auto-categorise new ones
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
/** Avoids "Waiting for this message" by retrying + updateMediaMessage */
async function safeDownloadMedia(msg, sock, retries = 12, delay = 5000) {
  await sleep(800); // let WA finalize upload + keys
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
      const m = String(e?.message || e);
      if (!/cipher|not found|download media failed|message not available|waiting for this message/i.test(m)) {
        console.warn(`[media] non-retryable? ${m}`);
      }
    }
    if (i < retries - 1) await sleep(delay + Math.floor(Math.random() * 700));
  }
  return null;
}

/* ----------------------------- preflight -------------------------------- */

async function ensureSessionForJid(sock, jid) {
  try {
    if (jid.endsWith('@g.us') && typeof sock.groupMetadata === 'function') {
      await withTimeout(sock.groupMetadata(jid), 5000, `meta:${jid}`);
    }
  } catch {}
  try {
    if (typeof sock.assertSessions === 'function') {
      await withTimeout(sock.assertSessions([jid], false), 8000, `assert:${jid}`);
    }
  } catch {}
  await sleep(250 + Math.floor(Math.random() * 120));
}

/* ----------------------------- batching --------------------------------- */

function classifySkipReason(rec, selfBare) {
  if (!rec) return 'unknown';
  if (rec.announce && !rec.botIsAdmin) return 'admins-only (not admin)';
  return null;
}

/** Single target sender with retries + HARD timeout + session/assert handling. */
async function sendToOneWithRetry(sock, jid, payload) {
  let attempt = 0;
  let preflightDone = false;

  while (attempt <= SEND_MAX_RETRIES) {
    try {
      if (!preflightDone) { await ensureSessionForJid(sock, jid); preflightDone = true; }
      const sendPromise = sock.safeSend ? sock.safeSend(jid, payload) : sock.sendMessage(jid, payload);
      const res = await withTimeout(sendPromise, SEND_TIMEOUT_MS, `send:${jid}`);
      return res;
    } catch (err) {
      const msg = String(err?.message || err);

      // Socket genuinely gone → bubble up (reconnector elsewhere)
      if (/SOCKET_NOT_OPEN|Connection Closed/i.test(msg)) throw err;

      const isNoSessions = /no sessions?/i.test(msg);
      const isNotAcceptable = /not-acceptable/i.test(msg);

      // re-assert & retry on "no sessions"
      if (isNoSessions) {
        try { await ensureSessionForJid(sock, jid); } catch {}
      }

      attempt++;
      if (isNotAcceptable) {
        // No point retrying "not-acceptable" (admin-only, non-participant, etc.)
        throw err;
      }

      const retryable =
        isNoSessions ||
        /TIMEOUT:send|timed out|rate|temporar|retry|disconnect|socket|stream|closed|request_entity_too_large|too many/i.test(msg);

      if (!retryable || attempt > SEND_MAX_RETRIES) throw err;

      const base = isNoSessions ? 2000 : SEND_BACKOFF_MS;
      const wait = base * Math.pow(2, Math.max(0, attempt - 1)) + Math.floor(Math.random() * 400);
      console.warn(`[send] retry ${attempt} for ${jid} after ${wait}ms: ${msg}`);
      await sleep(wait);
    }
  }
}

/**
 * Adaptive, self-healing batch sender:
 * - normalises image once
 * - adapts pacing up/down per user
 * - skips JIDs that are admin-only if bot not admin
 * - re-asserts sessions for "No sessions" races
 * - respects /stop via cancel token
 * - watchdog: exits if no progress for 10 minutes
 */
async function sendInBatches(sock, username, from, jids, messageContent) {
  const USERS = USERSG();
  const u = USERS[username];
  const totalInitialTargets = jids.length;

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

  const badJids = new Map();  // jid -> fail count (excludes once-requeued "No sessions")
  const timedOutJids = new Set();
  const skippedJids = [];     // {jid, reason}

  const p = pacingFor(u);
  const stats = { sentOk: 0, failed: 0, timedOut: 0 };
  const startTime = Date.now();
  let lastProgressAt = Date.now();

  // Filter out admin-only where bot isn’t admin
  const selfBare = bareJid(sock?.user?.id || '');
  const sendable = [];
  for (const jid of jids) {
    const rec = USERS[username]?.allGroups?.[jid];
    const reason = classifySkipReason(rec, selfBare);
    if (reason) skippedJids.push({ jid, reason });
    else sendable.push(jid);
  }

  // progress/watchdog
  const EARLY_ABORT_CHECK_AT = Math.min(totalInitialTargets, 20);

  let nextIndex = 0;

  while (nextIndex < sendable.length) {
    if (isCancelled(u)) { await sendSys(username, sock, from, { text: `🛑 Broadcast cancelled.` }); break; }
    if (Date.now() - lastProgressAt > 10 * 60_000) {
      await sendSys(username, sock, from, { text: `⛔ Watchdog: no progress for 10 minutes. Stopping this broadcast.` });
      requestCancel(u); break;
    }

    await guardMemory512();

    // build batch dynamically, skipping jids that failed >=2 times
    const batch = [];
    while (batch.length < p.batchSize && nextIndex < sendable.length) {
      const jid = sendable[nextIndex++];
      if ((badJids.get(jid) || 0) >= 2) continue;
      batch.push(jid);
    }
    if (!batch.length) break;

    const succeededThisBatch = [];
    const failedThisBatch = [];
    const groupNames = batch.map(jid => USERS[username].allGroups[jid]?.name || jid);

    for (const jid of batch) {
      if (isCancelled(u)) break;

      try {
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
        stats.sentOk++; succeededThisBatch.push(jid); lastProgressAt = Date.now();
        console.log(`[${username}] ✅ Sent to ${jid}`);
      } catch (error) {
        const msg = String(error?.message || error);
        const isNoSessions = /no sessions?/i.test(msg);
        const isNotAcceptable = /not-acceptable/i.test(msg);

        stats.failed++;
        if (/TIMEOUT:send/i.test(msg)) { stats.timedOut++; timedOutJids.add(jid); }

        if (isNotAcceptable) {
          // Convert runtime not-acceptable into a “skip” with reason
          skippedJids.push({ jid, reason: 'not-acceptable (likely admins-only or not a participant)' });
        } else if (isNoSessions) {
          // soft mark as bad once; assertSessions already done inside sender
          badJids.set(jid, (badJids.get(jid) || 0) + 1);
          failedThisBatch.push(jid);
        } else {
          badJids.set(jid, (badJids.get(jid) || 0) + 1);
          failedThisBatch.push(jid);
        }

        lastProgressAt = Date.now();
        console.warn(`[${username}] ❌ Failed to send to ${jid} (fail#${badJids.get(jid) || 1}): ${msg}`);
      }

      await sleep(jitter(p.perSendDelay));
    }

    // Per-batch status
    const namesOk = succeededThisBatch.map(j => USERS[username].allGroups[j]?.name || j);
    const namesFail = failedThisBatch.map(j => USERS[username].allGroups[j]?.name || j);
    const remaining = sendable.length - nextIndex;

    let statusText = '';
    if (namesOk.length)   statusText += `✅ Sent to:\n${namesOk.map(n => `- ${n}`).join('\n')}\n\n`;
    if (namesFail.length) statusText += `⚠️ Failed (retry-limited) in this batch (${namesFail.length}):\n${namesFail.map(n => `- ${n}`).join('\n')}\n\n`;
    if (remaining > 0)    statusText += `⏳ Next batch soon… (${remaining} remaining)`;
    else                  statusText += (namesFail.length === 0 ? '🎉 All messages sent!' : '✅ Finished all batches (some failures).');

    await sendSys(username, sock, from, { text: statusText });

    // adapt pacing
    adjustPacing(u, stats);

    // early throttle signal
    if ((namesOk.length + namesFail.length) >= Math.min(p.batchSize, EARLY_ABORT_CHECK_AT) &&
        stats.timedOut >= Math.ceil(EARLY_ABORT_CHECK_AT * 0.4)) {
      await sendSys(username, sock, from, { text: `⚠️ Many timeouts early — slowing down for a bit.` });
      p.batchSize   = Math.max(2, p.batchSize - 1);
      p.perSendDelay= Math.min(2500, p.perSendDelay + 250);
      p.batchDelay  = Math.min(20_000, p.batchDelay + 2000);
      stats.timedOut = 0;
    }

    if (remaining > 0) await sleep(jitter(p.batchDelay));
  }

  // summarize skipped (admin-only & explicit not-acceptable)
  if (skippedJids.length) {
    const lines = skippedJids.slice(0, 40).map(({ jid, reason }) => {
      const n = USERS[username].allGroups[jid]?.name || jid;
      return `- ${n} — ${reason}`;
    });
    await sendSys(username, sock, from, {
      text: `ℹ️ Skipped ${skippedJids.length} group(s):\n${lines.join('\n')}${skippedJids.length>lines.length?'\n...':''}`
    });
  }

  // summarize hard-failed (>=2)
  const skipped = Array.from(badJids.entries()).filter(([, n]) => n >= 2).map(([jid]) => jid);
  if (skipped.length) {
    const names = skipped.map(j => USERS[username].allGroups[j]?.name || j).slice(0, 20);
    await sendSys(username, sock, from, {
      text: `ℹ️ Gave up after retries on ${skipped.length} group(s):\n` +
            names.map(n => `- ${n}`).join('\n') + (skipped.length > names.length ? `\n...` : '')
    });
  }

  if (imagePath) { try { fs.unlinkSync(imagePath); } catch {} }

  clearCancel(u);

  console.log(`[${username}] 📊 run done: ok=${stats.sentOk} fail=${stats.failed} timeouts=${stats.timedOut} ` +
              `elapsed=${Math.round((Date.now()-startTime)/1000)}s pacing=${JSON.stringify(p)}`);
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

  if (chatJid.endsWith('@g.us')) return; // ignore groups inbound
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

  // Anti-echo
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
  if (!u.categories || !Object.keys(u.categories).length) u.categories = readJSON(p.categories, u.categories || {});
  if (!u.allGroups || !Object.keys(u.allGroups).length) u.allGroups = readJSON(p.groups, u.allGroups || {});
  for (const c of Object.keys(u.categories || {})) u.categories[c] = normalizeCategoryToJids(u.categories[c], u.allGroups);

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

  // show contents of a category
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
    u.categoryTimeout = setTimeout(() => { notifyAndResetOnTimeout(username, sock, ownerBare); }, INTERACTION_TIMEOUT_MS);
    return await sendSys(username, sock, ownerBare, { text });
  }

  if (body === '/stop') {
    requestCancel(u);
    u.pendingImage = null;
    u.pendingText  = null;
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
      const candidates = Object.keys(groups).filter(j => norm(groups[j]?.name).includes(target));
      if (candidates.length === 1) jid = candidates[0];
    }

    if (!jid) {
      const candidates = Object.values(groups || {})
        .map(g => g?.name || '')
        .filter(Boolean)
        .map(n => [n, norm(n)])
        .filter(([raw, nn]) => nn.includes(target) || target.includes(nn))
        .slice(0, 8)
        .map(([raw]) => raw);

      const hint = candidates.length ? `\n\nDid you mean:\n` + candidates.map(x => `- ${x}`).join('\n') : '';
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

    const rawList = chosen === '__ALL__' ? Object.keys(groups || {}) : (cats[chosen] || []);
    const jidsRaw = normalizeCategoryToJids(rawList, groups || {}).filter(Boolean);

    if (!jidsRaw.length) {
      return await sendSys(username, sock, ownerBare, { text: 'No valid groups in that category.' });
    }

    // Inform what will be skipped due to admin-only
    const selfBare2 = bareJid(sock?.user?.id || '');
    const mustSkip = [];
    const willSend = [];
    for (const jid of jidsRaw) {
      const rec = groups[jid];
      const reason = classifySkipReason(rec, selfBare2);
      if (reason) mustSkip.push({ jid, reason });
      else willSend.push(jid);
    }

    if (!willSend.length) {
      const preview = mustSkip.slice(0, 20).map(({jid,reason}) => `- ${(groups[jid]?.name||jid)} — ${reason}`).join('\n');
      return await sendSys(username, sock, ownerBare, {
        text: `⚠️ All selected groups are admin-only and this account isn’t an admin:\n${preview}${mustSkip.length>20?'\n...':''}`
      });
    }

    if (u.broadcasting) {
      return await sendSys(username, sock, ownerBare, { text: '⏳ A broadcast is already running. Please wait.' });
    }
    u.broadcasting = true;

    try {
      if (u.mode === 'text' && u.pendingText) {
        await sendSys(username, sock, ownerBare, {
          text: `Broadcasting *text* to ${willSend.length} group(s)…` + (mustSkip.length?`\n(skipping ${mustSkip.length} admin-only)`:'')
        });
        await sendInBatches(sock, username, ownerBare, willSend, { text: u.pendingText });
        await sendSys(username, sock, ownerBare, { text: `✍️ Done. Send another message to broadcast, or /stop to cancel.` });
        u.pendingText = null; u.awaitingPayload = 'text'; u.lastPromptChat = null;
        return;
      }

      if (u.pendingImage) {
        const imagePath = u.pendingImage?.filePath || u.pendingImage?.image?.url;
        if (!imagePath || !fs.existsSync(imagePath)) {
          return await sendSys(username, sock, ownerBare, { text: '⚠️ Could not find saved image. Please resend it.' });
        }
        await sendSys(username, sock, ownerBare, {
          text: `Broadcasting *image* to ${willSend.length} group(s)…` + (mustSkip.length?`\n(skipping ${mustSkip.length} admin-only)`:'')
        });

        await sendInBatches(sock, username, ownerBare, willSend, { image: { url: imagePath }, caption: u.pendingImage.caption || '' });

        if (u.mode === 'text') {
          await sendSys(username, sock, ownerBare, { text: `✍️ Done. Send another message to broadcast, or /stop to cancel.` });
          u.awaitingPayload = 'text';
        } else {
          await sendSys(username, sock, ownerBare, { text: `🖼️ Done. Send another image to broadcast, or /text to switch to text mode.` });
          u.awaitingPayload = null;
        }

        u.pendingImage = null; u.lastPromptChat = null; return;
      }

      return await sendSys(username, sock, ownerBare, { text: 'Nothing pending to send. Use /text then type a message, or send an image.' });
    } finally {
      u.broadcasting = false;
      if (u.categoryTimeout) { clearTimeout(u.categoryTimeout); u.categoryTimeout = null; }
      u.awaitingCategory = false;
    }
  }

  /* ----------------------- content capture flow ------------------------- */

  // TEXT MODE
  if (u.mode === 'text') {
    const isCommand = body.startsWith('/');
    if ((u.awaitingPayload === 'text' || (!u.pendingText && !isCommand)) && body && !isCommand) {
      u.pendingText = body; u.awaitingPayload = null; u.pendingImage = null; u.lastPromptChat = ownerBare;

      const { text } = buildCategoryPrompt(username);
      u.awaitingCategory = true;
      if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
      u.categoryTimeout = setTimeout(() => { notifyAndResetOnTimeout(username, sock, ownerBare); }, INTERACTION_TIMEOUT_MS);

      await sendSys(username, sock, ownerBare, { text });
      return;
    }
    if (u.awaitingCategory && !selection) return;
  }

  // MEDIA MODE
  if (u.mode === 'media' && hasImage(msg)) {
    const buffer = await safeDownloadMedia(msg, sock, 12, 5000);
    if (!buffer?.length) { await sendSys(username, sock, ownerBare, { text: '❌ Failed to download image (media not ready).' }); return; }

    const caption = getContent(msg)?.imageMessage?.caption || '';
    const timestamp = Date.now();
    const up = getUserPaths(username);

    ensureDir(up.tmp);
    const imagePath = path.join(up.tmp, `image_${timestamp}`);

    try { fs.writeFileSync(imagePath, buffer); try { buffer.fill(0); } catch {} }
    catch (e) { await sendSys(username, sock, ownerBare, { text: `❌ Failed to save image buffer: ${e.message}` }); return; }

    u.pendingText = null; u.pendingImage = { filePath: imagePath, caption }; u.awaitingPayload = null; u.lastPromptChat = ownerBare;

    const { text } = buildCategoryPrompt(username);
    u.awaitingCategory = true;
    if (u.categoryTimeout) clearTimeout(u.categoryTimeout);
    u.categoryTimeout = setTimeout(() => { notifyAndResetOnTimeout(username, sock, ownerBare); }, INTERACTION_TIMEOUT_MS);

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
  const u = USERSG()[username]; if (!u) return;
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
