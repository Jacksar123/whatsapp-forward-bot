// lib/utils.js
const fs = require('fs-extra');
const path = require('path');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');

// 🔧 CATEGORY KEYWORDS
const CATEGORY_KEYWORDS = {
  Shoes: ['shoe', 'sneaker', 'crep', 'yeezy', 'jordan', 'footwear', 'nike', 'adidas', 'sb', 'dunk'],
  Tech: ['tech', 'dev', 'coding', 'engineer', 'ai', 'crypto', 'blockchain', 'startup', 'hack', 'js', 'python'],
  Clothing: ['clothing', 'threads', 'garms', 'fashion', 'streetwear', 'hoodie', 'tees', 'fit', 'wear']
};

// 🧱 Utility Functions
function ensureDir(dirPath) {
  if (!dirPath || typeof dirPath !== "string") {
    throw new Error(`ensureDir: invalid path "${dirPath}"`);
  }
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
  if (!username || typeof username !== "string") {
    throw new Error("getUserBasePath: username missing/invalid");
  }
  return path.join(__dirname, '..', 'users', username);
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
    data: path.join(base, 'data'), // added so index.js doesn’t break
  };
}

module.exports = {
  ensureDir,
  writeJSON,
  readJSON,
  normaliseJid,
  sleep,
  categoriseGroupName,
  getUserPaths,
  getUserBasePath
};
