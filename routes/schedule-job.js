// routes/schedule-job.js
const express = require("express");
const { supabase } = require("../lib/db");
const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { username, category, message_type, content, scheduled_for } = req.body;

    if (!username || !category || !message_type || !content || !scheduled_for) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { data, error } = await supabase
      .from("scheduled_jobs")
      .insert([{ username, category, message_type, content, scheduled_for, status: "pending" }])
      .select();

    if (error) throw error;
    return res.json({ ok: true, job: data[0] });
  } catch (err) {
    console.error("schedule-job error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = (USERS) => router;
