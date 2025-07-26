require("dotenv").config();
const express = require("express");
const fs = require("fs-extra");
const qrcode = require("qrcode-terminal");
const cors = require("cors");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const { listenForMedia } = require("./shared/broadcast");

const app = express();
app.use(express.json());
app.use(cors());

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
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(`✅ ${userId}: Connected to WhatsApp!`);

      const chats = await sock.groupFetchAllParticipating();
      const groups = Object.entries(chats).map(([jid, group]) => ({
        id: jid,
        name: group.subject
      }));
      fs.writeJsonSync(userFile(userId, "all_groups.json"), groups, { spaces: 2 });
      console.log(`✅ ${userId}: Found ${groups.length} groups.`);

      const categoriesPath = userFile(userId, "categories.json");
      const categories = fs.readJsonSync(categoriesPath);

      for (const cat of Object.values(categories)) cat.groups = [];

      const keywords = {
        Shoes: ["shoe", "crep", "kick", "jordan"],
        Clothing: ["hoodie", "tee", "drip"],
        Tech: ["iphone", "macbook", "ps5"]
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

      const jid = sock.user?.id || process.env.MY_NUMBER + "@s.whatsapp.net";
      const helpMessage = `
📣 *Bot Activated for ${userId}*

Send a product image to broadcast.
Commands:
/addgroup [Group Name] [Category]  
/removegroup [Group Name]  
/syncgroups  
/stop
      `.trim();

      await sock.sendMessage(jid, { text: helpMessage });
      console.log(`📨 ${userId}: Help message sent.`);
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log(`🔁 ${userId}: Disconnected. Reconnecting:`, shouldReconnect);
      if (shouldReconnect) startBotForUser(userId);
    }
  });

  listenForMedia(sock, userId);
}

// 👇 API to create a new bot for a user
app.post("/create-user", async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Username required" });

  const requiredFiles = [
    "auth",
    "all_groups.json",
    "categories.json",
    "message_logs.json"
  ];

  fs.ensureDirSync(userDir(username));
  fs.ensureDirSync(userFile(username, "auth"));

  requiredFiles.forEach((file) => {
    const fullPath = userFile(username, file);
    if (!fs.existsSync(fullPath)) {
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
    }
  });

  startBotForUser(username);
  res.json({ success: true, message: `Bot launched for ${username}` });
});

// ✅ Health check route
app.get("/", (req, res) => res.send("Multi-user WhatsApp bot is running."));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
});
