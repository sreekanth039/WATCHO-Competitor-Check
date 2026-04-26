const SERPAPI_BASE_URL = "https://serpapi.com/search.json";

function getApiKeys() {
  const primaryKey = process.env.SERPAPI_KEY;
  const fallbackKeys = String(process.env.SERPAPI_FALLBACK_KEYS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!primaryKey) {
    throw new Error("Missing SERPAPI_KEY in environment.");
  }

  return [primaryKey, ...fallbackKeys];
}

function getFallbackKeyCount() {
  return String(process.env.SERPAPI_FALLBACK_KEYS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean).length;
}

function buildUrl(params) {
  const url = new URL(SERPAPI_BASE_URL);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

async function fetchSerpApi(url) {
  const response = await fetch(url);

  if (response.ok) {
    return response.json();
  }

  const text = await response.text();
  const error = new Error(`SerpApi request failed (${response.status}).`);
  error.status = response.status;
  error.responseText = text;
  error.isQuotaExceeded = response.status === 429 && String(text || "").toLowerCase().includes("run out of searches");
  throw error;
}

function shouldRetryWithFallback(error) {
  const text = String(error?.responseText || error?.message || "").toLowerCase();
  return (
    error?.status === 429 ||
    text.includes("quota") ||
    text.includes("run out of searches") ||
    text.includes("exhausted") ||
    text.includes("invalid api key") ||
    text.includes("invalid-key") ||
    text.includes("unauthorized")
  );
}

async function searchSerpApi(params) {
  const apiKeys = getApiKeys();

  for (let index = 0; index < apiKeys.length; index += 1) {
    const apiKey = apiKeys[index];
    const url = buildUrl({
      engine: "google",
      api_key: apiKey,
      google_domain: "google.co.uk",
      gl: "uk",
      hl: "en",
      location: "United Kingdom",
      num: 10,
      ...params,
    });

    try {
      if (index === 0) {
        console.warn("Trying primary SerpApi key");
      }
      return await fetchSerpApi(url);
    } catch (error) {
      const canRetry = index < apiKeys.length - 1 && shouldRetryWithFallback(error);
      if (!canRetry) {
        if (index > 0 && apiKeys.length > 1) {
          console.warn("Fallback SerpApi key also failed");
        }
        throw error;
      }
      if (index === 0) {
        console.warn("Primary quota exhausted, trying fallback key #1");
      } else {
        console.warn(`Fallback key #${index} failed, trying fallback key #${index + 1}`);
      }
    }
  }
}

async function searchOrganic(query) {
  return searchSerpApi({ q: query });
}

async function searchShopping(query) {
  return searchSerpApi({
    engine: "google_shopping",
    q: query,
  });
}

module.exports = {
  getFallbackKeyCount,
  searchOrganic,
  searchShopping,
};
