const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "watch-search-cache.json");

function ensureCacheFile() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  if (!fs.existsSync(CACHE_FILE)) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({}, null, 2), "utf8");
  }
}

function readCacheFile() {
  ensureCacheFile();

  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    return {};
  }
}

function writeCacheFile(cache) {
  ensureCacheFile();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

function getCacheKey(parts) {
  return parts
    .map((part) => String(part || "").trim().toUpperCase())
    .join("::");
}

function getCachedResult(parts, ttlHours) {
  const cache = readCacheFile();
  const key = getCacheKey(parts);
  const entry = cache[key];

  if (!entry || !entry.searchedAt || !entry.data) {
    return null;
  }

  const ageMs = Date.now() - new Date(entry.searchedAt).getTime();
  const ttlMs = ttlHours * 60 * 60 * 1000;

  if (Number.isNaN(ageMs) || ageMs > ttlMs) {
    delete cache[key];
    writeCacheFile(cache);
    return null;
  }

  return entry.data;
}

function setCachedResult(parts, data) {
  const cache = readCacheFile();
  const key = getCacheKey(parts);

  cache[key] = {
    searchedAt: new Date().toISOString(),
    data,
  };

  writeCacheFile(cache);
}

function clearCache() {
  writeCacheFile({});
}

module.exports = {
  getCachedResult,
  setCachedResult,
  getCacheKey,
  clearCache,
};
