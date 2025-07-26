require("dotenv").config();
const express = require("express");
const fs = require("fs-extra");
const qrcode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const { listenForMedia } = require("./shared/broadcast");

const app = express();
const port = process.env.PORT || 10000;
app.use(express.json());

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
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrPath = userFile(userId, "qr.png");
      await qrcode.toFile(qrPath, qr);
      console.log(`🧾 ${userId}: QR code generated.`);
    }

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

function ensureUserFiles(userId) {
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
}

// === API ROUTES ===

app.post("/start-bot", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    ensureUserFiles(userId);
    await startBotForUser(userId);
    return res.json({ success: true, message: `Bot started for ${userId}` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to start bot" });
  }
});

app.get("/qr/:userId", async (req, res) => {
  const { userId } = req.params;
  const qrPath = userFile(userId, "qr.png");
  if (!fs.existsSync(qrPath)) return res.status(404).send("QR not found");
  res.sendFile(qrPath, { root: "." });
});

app.get("/", (_, res) => res.send("✅ WhatsApp bot backend is live."));

app.listen(port, () => {
  console.log(`✅ API running on port ${port}`);
});
