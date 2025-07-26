require("dotenv").config();
const fs = require("fs-extra");
const qrcode = require("qrcode-terminal");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const { listenForMedia } = require("./shared/broadcast");

const USERS = ["jackmeet"]; // Add more usernames here

function userDir(userId) {
  return `./users/${userId}`;
}

function userFile(userId, filename) {
  return `${userDir(userId)}/${filename}`;
}

async function startBotForUser(userId) {
  console.log(`🚀 Launching bot for user: ${userId}`);

  const authDir = userFile(userId, "auth");
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === "open") {
      console.log(`✅ ${userId}: Connected to WhatsApp!`);

      // 🔄 Auto-sync all groups
      const chats = await sock.groupFetchAllParticipating();
      const groups = Object.entries(chats).map(([jid, group]) => ({
        id: jid,
        name: group.subject
      }));
      fs.writeJsonSync(userFile(userId, "all_groups.json"), groups, { spaces: 2 });
      console.log(`✅ ${userId}: Found ${groups.length} groups. Saved to all_groups.json.`);

      // 🧠 Auto-categorise based on group names
      const categoriesPath = userFile(userId, "categories.json");
      const categories = fs.readJsonSync(categoriesPath);

      for (const cat of Object.values(categories)) cat.groups = [];

      const keywords = {
        Shoes: ["shoe", "crep", "kick", "jordan", "dunk", "yeezy", "rep", "airmax", "foam", "airforce", "trainer", "aj1"],
        Clothing: ["drip", "hoodie", "tee", "fashion", "fit", "puffer", "northface", "supreme", "trapstar", "moncler", "cargo", "bape"],
        Tech: ["ps5", "switch", "iphone", "ipad", "macbook", "gadget", "tech", "electronic", "airpod", "console", "samsung"]
      };

      for (const group of groups) {
        const name = group.name.toLowerCase();
        for (const [catId, cat] of Object.entries(categories)) {
          const match = keywords[cat.name]?.some(keyword => name.includes(keyword));
          if (match) {
            cat.groups.push(group);
            break;
          }
        }
      }

      fs.writeJsonSync(categoriesPath, categories, { spaces: 2 });
      console.log(`✅ ${userId}: Groups auto-categorised.`);

      // 📨 Send welcome/help message
      const jid = sock.user?.id || process.env.MY_NUMBER + "@s.whatsapp.net";
      const helpMessage = `
📣 *Bot Activated for ${userId}*

👟 Send a product image to start broadcasting  
🔢 Then reply 1 = *Shoes*, 2 = *Tech*, 3 = *Clothing*

🧠 Auto-categorises based on group name keywords  
🛠 Commands:
/addgroup [Group Name] [Category]  
/removegroup [Group Name]  
/listgroups  
/syncgroups (manual refresh)
/stop (Stops Broadcast)
      `.trim();

      await sock.sendMessage(jid, { text: helpMessage });
      console.log(`📨 ${userId}: Welcome message sent.`);
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log(`🔁 ${userId}: Disconnected. Reconnecting:`, shouldReconnect);
      if (shouldReconnect) startBotForUser(userId);
    }
  });

  listenForMedia(sock, userId);
}

// 🛠 Setup user folders/files
USERS.forEach((userId) => {
  const requiredFiles = [
    "auth",
    "all_groups.json",
    "categories.json",
    "message_logs.json"
  ];

  fs.ensureDirSync(userDir(userId));
  fs.ensureDirSync(userFile(userId, "auth"));

  requiredFiles.forEach((file) => {
    const fullPath = userFile(userId, file);
    if (!fs.existsSync(fullPath)) {
      if (file.endsWith(".json")) {
        const defaultData = file === "categories.json"
          ? {
              "1": { name: "Shoes", groups: [] },
              "2": { name: "Tech", groups: [] },
              "3": { name: "Clothing", groups: [] }
            }
          : file === "message_logs.json"
          ? []
          : {};
        fs.writeJsonSync(fullPath, defaultData, { spaces: 2 });
      } else {
        fs.ensureFileSync(fullPath);
      }
    }
  });

  startBotForUser(userId);
});

// --- Express Server for API integration ---
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ Bot API is live");
});

// Example placeholder for QR route in future
// app.get("/qr", (req, res) => { ... });

app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
});
