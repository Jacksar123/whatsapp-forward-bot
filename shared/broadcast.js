const fs = require("fs-extra");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");

let pendingMedia = {};
let stopRequests = {};

function listenForMedia(sock, userId) {
  const userPath = `users/${userId}`;
  const allGroupsPath = `${userPath}/all_groups.json`;
  const categoriesPath = `${userPath}/categories.json`;
  const messageLogsPath = `${userPath}/message_logs.json`;

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg) return;

    const sender = msg.key.remoteJid;
    const isFromMe = msg.key.fromMe;
    const messageType = Object.keys(msg.message || {})[0];
    const text = msg.message?.conversation?.trim();

    if (sender.split("@")[0] !== process.env.MY_NUMBER) return;

    const allGroups = fs.readJsonSync(allGroupsPath);
    const categories = fs.readJsonSync(categoriesPath);
    const messageLogs = fs.readJsonSync(messageLogsPath);

    // /stop broadcast
    if (text?.startsWith("/stop")) {
      stopRequests[sender] = true;
      await sock.sendMessage(sender, { text: "🛑 Broadcast manually stopped." });
      return;
    }

    // /addgroup
    if (text?.startsWith("/addgroup")) {
      const parts = text.split(" ");
      if (parts.length < 3) {
        await sock.sendMessage(sender, { text: "❌ Usage: /addgroup [Group Name] [Category]" });
        return;
      }
      const groupName = parts.slice(1, -1).join(" ");
      const categoryName = parts.slice(-1)[0];

      const groupObj = allGroups.find(g => g.name.toLowerCase() === groupName.toLowerCase());
      if (!groupObj) {
        await sock.sendMessage(sender, { text: `❌ Group "${groupName}" not found.` });
        return;
      }

      const catKey = Object.entries(categories).find(([k, v]) => v.name.toLowerCase() === categoryName.toLowerCase());
      if (!catKey) {
        await sock.sendMessage(sender, { text: `❌ Category "${categoryName}" not found.` });
        return;
      }

      const [catId, catObj] = catKey;
      if (!catObj.groups.some(g => g.id === groupObj.id)) {
        catObj.groups.push(groupObj);
        fs.writeJsonSync(categoriesPath, categories, { spaces: 2 });
      }

      await sock.sendMessage(sender, { text: `✅ Added "${groupObj.name}" to category "${catObj.name}"` });
      return;
    }

    // /removegroup
    if (text?.startsWith("/removegroup")) {
      const groupName = text.slice(13).trim();
      const groupObj = allGroups.find(g => g.name.toLowerCase() === groupName.toLowerCase());
      if (!groupObj) {
        await sock.sendMessage(sender, { text: `❌ Group "${groupName}" not found.` });
        return;
      }

      let removed = false;
      for (const cat of Object.values(categories)) {
        const initial = cat.groups.length;
        cat.groups = cat.groups.filter(g => g.id !== groupObj.id);
        if (cat.groups.length !== initial) removed = true;
      }

      if (removed) {
        fs.writeJsonSync(categoriesPath, categories, { spaces: 2 });
        await sock.sendMessage(sender, { text: `🗑️ Removed "${groupObj.name}" from all categories.` });
      } else {
        await sock.sendMessage(sender, { text: `⚠️ "${groupObj.name}" was not in any category.` });
      }
      return;
    }

    // /listgroups
    if (text?.startsWith("/listgroups")) {
      let out = "📂 Categories and Groups:\n";
      for (const [k, cat] of Object.entries(categories)) {
        out += `\n${k}. ${cat.name} (${cat.groups.length} groups)\n`;
        cat.groups.forEach(g => out += `   • ${g.name}\n`);
      }
      await sock.sendMessage(sender, { text: out });
      return;
    }

    // /syncgroups
    if (text?.startsWith("/syncgroups")) {
      await sock.sendMessage(sender, { text: "🔄 Resyncing group list..." });
      const chats = await sock.groupFetchAllParticipating();
      const updated = Object.entries(chats).map(([jid, group]) => ({
        id: jid,
        name: group.subject
      }));
      fs.writeJsonSync(allGroupsPath, updated, { spaces: 2 });
      await sock.sendMessage(sender, { text: `✅ Synced ${updated.length} groups.` });
      return;
    }

    // Category selection: 1 / 2 / 3 / 4
    if (["1", "2", "3", "4"].includes(text)) {
      const pending = pendingMedia[sender];
      if (!pending || !pending.msg.message?.imageMessage) {
        await sock.sendMessage(sender, { text: "⚠️ No pending image to broadcast." });
        return;
      }

      await sock.sendMessage(sender, { text: "📤 Preparing to send your message..." });

      const buffer = await downloadMediaMessage(pending.msg, "buffer", {});
      const originalCaption = pending.msg.message.imageMessage.caption || "";

      const targetGroups =
        text === "4"
          ? allGroups
          : categories[text]?.groups || [];

      for (let i = 0; i < targetGroups.length; i += 5) {
        if (stopRequests[sender]) {
          await sock.sendMessage(sender, { text: "🛑 Broadcast stopped midway by user." });
          stopRequests[sender] = false;
          delete pendingMedia[sender];
          return;
        }

        const batch = targetGroups.slice(i, i + 5);

        for (const g of batch) {
          await sock.sendMessage(g.id, {
            image: buffer,
            caption: originalCaption
          });
          console.log(`✅ Sent to ${g.name}`);
        }

        await sock.sendMessage(sender, {
          text: `✅ Sent to:\n${batch.map(g => `• ${g.name}`).join("\n")}`,
        });

        if (i + 5 < targetGroups.length) {
          await sock.sendMessage(sender, { text: "⏳ Waiting 5 seconds before next batch..." });
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      await sock.sendMessage(sender, {
        text: `🎉 Image sent to all ${targetGroups.length} groups${text === "4" ? "" : ` in '${categories[text].name}'`}`
      });

      messageLogs.push({
        time: new Date().toISOString(),
        category: text === "4" ? "All Groups" : categories[text].name,
        groups: targetGroups,
      });

      fs.writeJsonSync(messageLogsPath, messageLogs, { spaces: 2 });
      delete pendingMedia[sender];
      return;
    }

    // Handle incoming image
    if ((messageType === "imageMessage" || messageType === "extendedTextMessage") && isFromMe) {
      try {
        const image = msg.message?.imageMessage;
        if (!image) return;

        pendingMedia[sender] = {
          msg: JSON.parse(JSON.stringify(msg)),
          mediaType: "imageMessage",
        };

        let prompt = "📂 Yo you're live. Pick a number to blast that pic:\n";
        for (const [key, cat] of Object.entries(categories)) {
          prompt += `${key}. ${cat.name} (${cat.groups.length} groups)\n`;
          cat.groups.forEach(g => prompt += `   • ${g.name}\n`);
        }
        prompt += `\n4. 🧨 *Send to EVERY group (${allGroups.length})*`;

        await sock.sendMessage(sender, { text: prompt });
        return;
      } catch (err) {
        console.error("❌ Error processing image for category:", err);
        await sock.sendMessage(sender, { text: "❌ Couldn't prep your category list. Try again." });
      }
    }
  });
}

module.exports = { listenForMedia };

