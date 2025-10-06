// lib/scheduler.js
const { supabase } = require("./db");
const { sendInBatches } = require("./broadcast");

async function processJobs(USERS) {
  const now = new Date().toISOString();

  const { data: jobs, error } = await supabase
    .from("scheduled_jobs")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_for", now);

  if (error) return console.error("[Scheduler] Fetch error:", error.message);
  if (!jobs?.length) return;

  for (const job of jobs) {
    const { username, category, message_type, content, id } = job;
    const u = USERS[username];
    if (!u || !u.sock || !u.socketActive) {
      console.warn(`[Scheduler] ${username} offline, skipping job ${id}`);
      continue;
    }

    const jids =
      category === "__ALL__"
        ? Object.keys(u.allGroups || {})
        : (u.categories?.[category] || []).filter(Boolean);

    if (!jids.length) {
      console.warn(`[Scheduler] No valid groups for ${category}`);
      continue;
    }

    const jobId = `job-${id}`;
    try {
      if (message_type === "text") {
        await sendInBatches(u.sock, username, u.ownerJid, jids, { text: content.text }, jobId);
      } else if (message_type === "image") {
        await sendInBatches(
          u.sock,
          username,
          u.ownerJid,
          jids,
          { image: { url: content.image_url }, caption: content.caption || "" },
          jobId
        );
      }
      await supabase.from("scheduled_jobs").update({ status: "sent" }).eq("id", id);
      console.log(`[Scheduler] ✅ Sent job ${id} for ${username}`);
    } catch (err) {
      console.error(`[Scheduler] ❌ Job ${id} failed:`, err.message);
      await supabase.from("scheduled_jobs").update({ status: "failed" }).eq("id", id);
    }
  }
}

function startScheduler(USERS) {
  setInterval(() => processJobs(USERS), 60_000);
  console.log("[Scheduler] ⏰ Job processor started (every 1 min)");
}

module.exports = { startScheduler };
