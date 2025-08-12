cp lib/utils.js lib/utils.backup.$(date +%s).js

cat > lib/utils.js <<'EOF'
const fs = require('fs-extra');
const path = require('path');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

// Allow persistent disk in prod (Render): set DATA_DIR=/var/data/whats-broadcast-hub
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'users');

// 🔧 CATEGORY KEYWORDS
const CATEGORY_KEYWORDS = {
  Shoes: ['shoe', 'sneaker', 'crep', 'yeezy', 'jordan', 'footwear', 'nike', 'adidas', 'sb', 'dunk'],
  Tech: ['tech', 'dev', 'coding', 'engineer', 'ai', 'crypto', 'blockchain', 'startup', 'hack', 'js', 'python'],
  Clothing: ['clothing', 'threads', 'garms', 'fashion', 'streetwear', 'hoodie', 'tees', 'fit', 'wear']
};

// 🧱 Utility Functions
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// Atomic write (tmp + rename) to prevent truncation/corruption
function writeJSONAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// Keep legacy name, but route to atomic
function writeJSON(filePath, data) {
  return writeJSONAtomic(filePath, data);
}

function readJSON(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath));
  } catch {
    return fallback;
  }
}

function normaliseJid(jid) {
  return jidNormalizedUser(jid);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function categoriseGroupName(name = '') {
  const lower = name.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category;
    }
  }
  return null;
}

function getUserBasePath(username) {
  return path.join(DATA_DIR, username);
}

function getUserPaths(username) {
  const base = getUserBasePath(username);
  return {
    base,
    auth: path.join(base, 'auth_info'),
    groups: path.join(base, 'all_groups.json'),
    categories: path.join(base, 'categories.json'),
    tmp: path.join(base, 'tmp'),
    media: path.join(base, 'received_media'),
  };
}

module.exports = {
  ensureDir,
  writeJSON,
  writeJSONAtomic,
  readJSON,
  normaliseJid,
  sleep,
  categoriseGroupName,
  getUserPaths,
  getUserBasePath
};
EOF
