require("dotenv").config();
const fs = require("fs-extra");
const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 10000;

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const { listenForMedia } = require("./shared/broadcast");

// Middleware
app.use(cors());
app.use(express.json());

// Utility functions
function userDir(userId) {
  return `./users/${userId}`;
}
function userFile(userId, filename) {
  return `${userDir(userId)}/${filename}`;
}

// 🔄 Start bot function
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
          if (keywords[cat.name]?.some(keyword => name.includes(keyword))) {
            cat.groups.push(group);
            break;
          }
        }
      }

      fs.writeJsonSync(categoriesPath, categories, { spaces: 2 });

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
/stop (Stops Brodcast)
`.trim();

      await sock.sendMessage(jid, { text: helpMessage });
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log(`🔁 ${userId}: Disconnected. Reconnecting:`, shouldReconnect);
      if (shouldReconnect) startBotForUser(userId);
    }
  });

  listenForMedia(sock, userId);
}

// 🧪 Health check route
app.get("/", (req, res) => {
  res.status(200).send("API is live");
});

// 🔐 Endpoint Lovable will call to generate bot
app.post("/api/create-bot", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: "Missing userId" });

  // Ensure folders/files exist
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

  await startBotForUser(userId);
  res.status(200).json({ success: true });
});

// 🚀 Start server
app.listen(port, () => {
  console.log(`✅ API running on port ${port}`);
});
