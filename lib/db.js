// lib/db.js
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/* ---------------------- sanity checks ----------------------- */
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[FATAL] ❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

/* ---------------------- client setup ------------------------ */
let supabase;
try {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { 'x-client-info': 'whats-broadcast-bot/1.0' }
    }
  });
  console.log('[DB] ✅ Supabase client initialised');
} catch (err) {
  console.error('[DB] ❌ Failed to create Supabase client:', err?.message || err);
  process.exit(1);
}

/* ---------------------- simple test ping --------------------- */
(async () => {
  try {
    const { error } = await supabase.from('bot_user_state').select('username').limit(1);
    if (error) {
      console.warn('[DB] ⚠️ Supabase test query failed:', error.message);
    } else {
      console.log('[DB] 🔌 Supabase connection looks good');
    }
  } catch (err) {
    console.warn('[DB] ⚠️ Supabase unreachable:', err?.message || err);
  }
})();

module.exports = { supabase };
