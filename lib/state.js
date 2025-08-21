// lib/state.js
const fs = require("fs");
const path = require("path");

let supabase = null;
try {
  // Try to import supabase client if available
  const { supabase: sb } = require("./db");
  supabase = sb;
} catch (err) {
  console.warn("[STATE] Supabase not available, falling back to disk.");
}

/* ----------------------------- helpers ----------------------------- */
function getStatePath(username) {
  const dir = path.join(__dirname, "..", "users", username);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "state.json");
}

function readLocal(username) {
  const file = getStatePath(username);
  if (!fs.existsSync(file)) return { categories: {}, groups: {} };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`[STATE] Failed to read local state for ${username}:`, e);
    return { categories: {}, groups: {} };
  }
}

function writeLocal(username, state) {
  const file = getStatePath(username);
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[STATE] Failed to write local state for ${username}:`, e);
  }
}

/* ----------------------------- load ----------------------------- */
async function loadUserState(username) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("bot_user_state")
        .select("categories, groups, updated_at")
        .eq("username", username)
        .single();

      if (error && error.code !== "PGRST116") {
        console.error(`[STATE] loadUserState error for ${username}:`, error);
      }

      if (!data) {
        return readLocal(username);
      }
      return {
        categories: data.categories || {},
        groups: data.groups || {},
        updated_at: data.updated_at || null,
      };
    } catch (err) {
      console.error(`[STATE] loadUserState crash for ${username}:`, err?.message || err);
      return readLocal(username);
    }
  } else {
    return readLocal(username);
  }
}

/* ----------------------------- save ----------------------------- */
const SAVE_DEBOUNCE_MS = 1200;
const timers = new Map();

async function _doSave(username, categories, groups) {
  const newState = {
    categories: categories || {},
    groups: groups || {},
    updated_at: new Date().toISOString(),
  };

  // Try Supabase first
  if (supabase) {
    try {
      const { error } = await supabase
        .from("bot_user_state")
        .upsert(
          {
            username,
            ...newState,
          },
          { onConflict: "username" }
        );

      if (error) {
        console.error(`[STATE] saveUserState error for ${username}:`, error);
      } else {
        console.log(`[STATE] ✅ saved for ${username} (Supabase)`);
      }
    } catch (err) {
      console.error(`[STATE] saveUserState crash for ${username}:`, err?.message || err);
    }
  }

  // Always mirror to disk
  writeLocal(username, newState);
}

/**
 * Public save function with debounce.
 */
function saveUserState(username, categories, groups) {
  const key = username;
  if (timers.has(key)) clearTimeout(timers.get(key));

  timers.set(
    key,
    setTimeout(() => {
      _doSave(username, categories, groups);
      timers.delete(key);
    }, SAVE_DEBOUNCE_MS)
  );
}

/* ----------------------- frontend helpers ------------------------ */
async function getFrontendStatus(username) {
  const u = global.USERS?.[username];
  return {
    connected: !!u?.socketActive,
    needsRelink: !!u?.needsRelink,
    qrAvailable: !!u?.lastQR
  };
}

async function notifyFrontend(username, payload) {
  // Right now this just logs — replace with websocket / push if you want real-time
  console.log(`[notifyFrontend] ${username}:`, payload);
}

module.exports = { loadUserState, saveUserState, getFrontendStatus, notifyFrontend };
