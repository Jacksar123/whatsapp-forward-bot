// lib/state.js
const { supabase } = require('./db');

async function loadUserState(username) {
  const { data, error } = await supabase
    .from('bot_user_state')
    .select('categories, groups, updated_at')
    .eq('username', username)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('[STATE] loadUserState error:', error);
  }
  return data || { categories: {}, groups: {} };
}

// Debounced save so we don't hammer Supabase
const SAVE_DEBOUNCE_MS = 1200;
const timers = new Map();

function _doSave(username, categories, groups) {
  return supabase
    .from('bot_user_state')
    .upsert(
      {
        username,
        categories: categories || {},
        groups: groups || {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'username' }
    )
    .then(({ error }) => {
      if (error) console.error('[STATE] saveUserState error:', error);
      else console.log(`[STATE] saved for ${username}`);
    });
}

function saveUserState(username, categories, groups) {
  const key = username;
  if (timers.has(key)) clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    _doSave(username, categories, groups);
    timers.delete(key);
  }, SAVE_DEBOUNCE_MS));
}

module.exports = { loadUserState, saveUserState };
