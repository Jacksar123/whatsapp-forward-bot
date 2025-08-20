// lib/state.js
const { supabase } = require('./db');

/* ----------------------------- load ----------------------------------- */
/**
 * Loads user state (categories + groups) from Supabase.
 * If no row exists, returns empty defaults.
 */
async function loadUserState(username) {
  try {
    const { data, error } = await supabase
      .from('bot_user_state')
      .select('categories, groups, updated_at')
      .eq('username', username)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error(`[STATE] loadUserState error for ${username}:`, error);
    }

    if (!data) {
      return { categories: {}, groups: {} };
    }
    return {
      categories: data.categories || {},
      groups: data.groups || {},
      updated_at: data.updated_at || null
    };
  } catch (err) {
    console.error(`[STATE] loadUserState crash for ${username}:`, err?.message || err);
    return { categories: {}, groups: {} };
  }
}

/* ----------------------------- save ----------------------------------- */

// Debounced save (prevents hammering Supabase)
const SAVE_DEBOUNCE_MS = 1200;
const timers = new Map();

async function _doSave(username, categories, groups) {
  try {
    const { error } = await supabase
      .from('bot_user_state')
      .upsert(
        {
          username,
          categories: categories || {},
          groups: groups || {},
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'username' }
      );

    if (error) {
      console.error(`[STATE] saveUserState error for ${username}:`, error);
    } else {
      console.log(`[STATE] ✅ saved for ${username}`);
    }
  } catch (err) {
    console.error(`[STATE] saveUserState crash for ${username}:`, err?.message || err);
  }
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

module.exports = { loadUserState, saveUserState };
