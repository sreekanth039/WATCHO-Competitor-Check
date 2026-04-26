const { execFileSync } = require("child_process");
const { compactRef, generateRefVariants, getMatchedRefVariant } = require("./refVariants");

const SEARCH_FALLBACKS = {
  "watcho.co.uk": {
    buildUrl: (ref) => `https://www.watcho.co.uk/search.php?search_query=${encodeURIComponent(ref)}`,
  },
  "goldsmiths.co.uk": {
    buildUrl: (ref) => `https://www.goldsmiths.co.uk/search?q=${encodeURIComponent(ref)}`,
  },
};

function fetchHtml(url) {
  try {
    return execFileSync(
      "curl",
      [
        "-sS",
        "-L",
        "--max-time",
        "12",
        "-A",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "-H",
        "Accept-Language: en-GB,en;q=0.9",
        url,
      ],
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }
    );
  } catch (error) {
    return "";
  }
}

function absolutizeUrl(baseUrl, value) {
  try {
    return new URL(String(value || ""), baseUrl).toString();
  } catch (error) {
    return "";
  }
}

function looksLikeProductLink(url, domain) {
  const value = String(url || "").toLowerCase();

  return (
    value.includes(domain) &&
    !value.includes("/search") &&
    !value.includes("?page=") &&
    !value.includes("&page=") &&
    !value.includes("/category/") &&
    !value.includes("/collections/")
  );
}

function extractAnchorCandidates(html, baseUrl, ref, domain) {
  const matches = String(html || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  const candidates = [];
  const seen = new Set();

  for (const match of matches) {
    const url = absolutizeUrl(baseUrl, match[1]);
    const title = String(match[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const matchedRefVariant = getMatchedRefVariant(ref, `${url} ${title}`);

    if (!url || !looksLikeProductLink(url, domain) || !matchedRefVariant || seen.has(url)) {
      continue;
    }

    seen.add(url);
    candidates.push({
      title: title || url,
      url,
      snippet: title,
      rawType: "site_search_fallback",
      matchedRefVariant,
    });
  }

  return candidates.slice(0, 6);
}

function resolveRetailerSearchFallback(ref, competitor) {
  const config = SEARCH_FALLBACKS[competitor.domain];

  if (!config) {
    return {
      triedUrls: [],
      productCandidates: [],
    };
  }

  const triedUrls = [];
  const productCandidates = [];
  const seenUrls = new Set();

  for (const variant of generateRefVariants(ref)) {
    const url = config.buildUrl(variant);
    triedUrls.push(url);

    const html = fetchHtml(url);
    if (!html) {
      continue;
    }

    for (const candidate of extractAnchorCandidates(html, url, ref, competitor.domain)) {
      if (seenUrls.has(candidate.url)) {
        continue;
      }
      seenUrls.add(candidate.url);
      productCandidates.push(candidate);
    }

    if (productCandidates.length) {
      break;
    }
  }

  return {
    triedUrls,
    productCandidates,
  };
}

module.exports = {
  compactRef,
  generateRefVariants,
  getMatchedRefVariant,
  resolveRetailerSearchFallback,
};
