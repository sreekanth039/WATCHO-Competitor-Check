const EXCLUDED_TERMS = [
  "pre-owned",
  "used",
  "second hand",
  "refurbished",
  "replica",
  "strap only",
  "bracelet only",
  "replacement strap",
  "parts",
];

const REJECT_PAGE_PATTERNS = [
  "/collections/",
  "/category/",
  "/categories/",
  "?page=",
  "&page=",
  "/search",
  "/brand/",
  "page=",
  "watches-c-",
  "page ",
  "official uk retailer",
  "watches -",
  "| smart watches",
];

function normaliseText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseRefValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\-+]+/g, "")
    .trim();
}

function extractReferenceCandidates(value) {
  const text = String(value || "").toUpperCase();
  const candidates = new Set();
  const patterns = [
    /\b\d{3}[-+\s]?\d{5}[-+\s]?\d{2}\b/g,
    /\b[A-Z]{2,5}(?:[-+\s]?\d{2,6}){1,3}(?:[-+\s]?[A-Z0-9]{1,3})?\b/g,
  ];

  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    for (const match of matches) {
      const trimmed = match.trim();
      if (trimmed.length >= 6) {
        candidates.add(trimmed);
      }
    }
  }

  return [...candidates];
}

function buildExactVariantPatterns(ref) {
  const compact = normaliseRefValue(ref).toUpperCase();

  if (!compact) {
    return [];
  }

  if (/^\d+$/.test(compact) && compact.length === 10) {
    const parts = [compact.slice(0, 3), compact.slice(3, 8), compact.slice(8, 10)];
    const separator = "[-+\\s]?";
    return [new RegExp(`(^|[^A-Z0-9])${parts.join(separator)}([^A-Z0-9]|$)`, "i")];
  }

  const segments = String(ref || "")
    .toUpperCase()
    .match(/[A-Z]+|\d+/g);

  if (segments && segments.length > 1) {
    return [new RegExp(`(^|[^A-Z0-9])${segments.join("[-+\\s]?")}([^A-Z0-9]|$)`, "i")];
  }

  return [new RegExp(`(^|[^A-Z0-9])${compact}([^A-Z0-9]|$)`, "i")];
}

function getExactRefMatchDetails(ref, text) {
  const rawText = String(text || "");
  const compactRef = normaliseRefValue(ref);
  const extractedRefs = extractReferenceCandidates(rawText);
  const matchingRefs = extractedRefs.filter((candidate) => normaliseRefValue(candidate) === compactRef);
  const conflictingRefs = extractedRefs.filter((candidate) => normaliseRefValue(candidate) !== compactRef);
  const fallbackPatternMatched = buildExactVariantPatterns(ref).some((pattern) => pattern.test(rawText));
  const matched = matchingRefs.length > 0 || fallbackPatternMatched;

  return {
    matched,
    exactRefMatch: matched,
    extractedRefs,
    matchingRefs,
    conflictingRefs,
  };
}

function isExactRefMatch(ref, text) {
  return getExactRefMatchDetails(ref, text).matched;
}

function parsePriceText(rawPrice) {
  if (rawPrice === null || rawPrice === undefined || rawPrice === "") {
    return null;
  }

  return String(rawPrice).trim();
}

function parsePrice(rawPrice, extractedPrice) {
  if (typeof extractedPrice === "number" && Number.isFinite(extractedPrice)) {
    return extractedPrice;
  }

  if (rawPrice === null || rawPrice === undefined) {
    return null;
  }

  if (typeof rawPrice === "number" && Number.isFinite(rawPrice)) {
    return rawPrice;
  }

  const text = String(rawPrice);
  const numeric = text.replace(/[^0-9.,]/g, "").replace(/,(?=\d{3}\b)/g, "");
  const value = Number.parseFloat(numeric.replace(/,/g, ""));

  return Number.isFinite(value) ? value : null;
}

function extractCurrency(...sources) {
  for (const source of sources) {
    const text = String(source || "");

    if (text.includes("£") || /\bGBP\b/i.test(text)) {
      return "GBP";
    }

    if (text.includes("$") || /\bUSD\b/i.test(text)) {
      return "USD";
    }

    if (text.includes("€") || /\bEUR\b/i.test(text)) {
      return "EUR";
    }
  }

  return null;
}

function includesExcludedTerm(text) {
  const normalised = normaliseText(text);
  return EXCLUDED_TERMS.find((term) => normalised.includes(term)) || null;
}

function normalizedRefMatch(ref, text) {
  return isExactRefMatch(ref, text);
}

function normalizedRefMatchInUrl(ref, value) {
  if (!value) {
    return false;
  }

  try {
    const parsed = new URL(String(value));
    const pathname = decodeURIComponent(parsed.pathname || "");
    const hostname = decodeURIComponent(parsed.hostname || "");
    const urlBody = `${hostname}${pathname}`;
    return isExactRefMatch(ref, urlBody);
  } catch (error) {
    return isExactRefMatch(ref, value);
  }
}

function getPagePatternRejection(candidate) {
  const url = normaliseText(candidate.url);
  const title = normaliseText(candidate.title);
  const combined = `${url} ${title}`;
  const matchedPattern = REJECT_PAGE_PATTERNS.find((pattern) => combined.includes(pattern));

  return matchedPattern ? `Rejected likely category/listing page: ${matchedPattern}` : null;
}

function isLikelyProductDetailCandidate(ref, candidate) {
  const title = normaliseText(candidate.title);

  try {
    const parsed = new URL(String(candidate.url || ""));
    const path = decodeURIComponent(parsed.pathname || "").toLowerCase();
    const segments = path.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1] || "";
    const hasProductId = /\/p\/\d+/i.test(path) || /\b\d{5,}\b/.test(path);
    const hasLongSlug = lastSegment.length >= 25;
    const hasDetailStyleSuffix = /\.html$/i.test(lastSegment) || /-p-\d+\/?$/i.test(path);
    const hasRefInUrl = normalizedRefMatchInUrl(ref, candidate.url);
    const looksLikeBrandListing =
      segments.length <= 2 &&
      /\bwatch(?:es)?\b/.test(title) &&
      !hasProductId &&
      !hasLongSlug &&
      !hasDetailStyleSuffix &&
      !hasRefInUrl &&
      !/\b(?:47mm|42mm|sapphire|amoled|chronograph|automatic|smartwatch)\b/.test(title);

    if (looksLikeBrandListing) {
      return false;
    }

    return hasProductId || hasLongSlug || hasDetailStyleSuffix || hasRefInUrl;
  } catch (error) {
    return normalizedRefMatchInUrl(ref, candidate.url);
  }
}

function getCandidateConfidence(ref, candidate) {
  if (isExactRefMatch(ref, candidate.title)) {
    return 100;
  }

  if (isExactRefMatch(ref, candidate.snippet)) {
    return 95;
  }

  if (normalizedRefMatchInUrl(ref, candidate.url) || normalizedRefMatchInUrl(ref, candidate.displayedLink)) {
    return 90;
  }

  return 0;
}

function normalizeSerpApiResults(rawResponse, competitor) {
  const sections = [
    { key: "organic_results", items: rawResponse.organic_results || [] },
    { key: "shopping_results", items: rawResponse.shopping_results || [] },
    { key: "inline_shopping_results", items: rawResponse.inline_shopping_results || [] },
    { key: "immersive_products", items: rawResponse.immersive_products || [] },
  ];

  return sections.flatMap(({ key, items }) =>
    items.map((item) => {
      const priceText = parsePriceText(item.price || item.price_from || item.price_text);
      const extractedPrice = item.extracted_price || item.price_numeric || item.price_value;
      const price = parsePrice(priceText, extractedPrice);
      const currency = extractCurrency(
        priceText,
        item.currency,
        item.extracted_price_currency,
        item.snippet,
        item.title
      );

      return {
        competitorName: competitor.name,
        competitorDomain: competitor.domain,
        title: item.title || "",
        snippet: item.snippet || item.source || item.delivery || "",
        source: item.source || key,
        priceText,
        price,
        currency,
        url: item.link || item.product_link || item.serpapi_link || "",
        displayedLink: item.displayed_link || item.source || "",
        thumbnail: item.thumbnail || item.thumbnails?.[0] || null,
        rating: item.rating ?? null,
        reviews: item.reviews ?? item.review_count ?? null,
        delivery: item.delivery || null,
        rawType: key,
      };
    })
  );
}

function evaluateCandidate(ref, candidate) {
  const combinedText = `${candidate.title} ${candidate.snippet} ${candidate.url} ${candidate.displayedLink}`;
  const excludedTerm = includesExcludedTerm(combinedText);
  const exactRefDetails = getExactRefMatchDetails(ref, combinedText);

  if (excludedTerm) {
    return {
      accepted: false,
      confidence: 0,
      reason: `Excluded term matched: ${excludedTerm}`,
      candidate,
    };
  }

  const pagePatternRejection = getPagePatternRejection(candidate);
  if (pagePatternRejection) {
    return {
      accepted: false,
      confidence: 0,
      reason: pagePatternRejection,
      candidate,
    };
  }

  if (!isLikelyProductDetailCandidate(ref, candidate)) {
    return {
      accepted: false,
      confidence: 0,
      reason: "Rejected likely non-product page",
      candidate,
    };
  }

  const confidence = getCandidateConfidence(ref, candidate);

  if (confidence === 0) {
    return {
      accepted: false,
      confidence,
      reason: exactRefDetails.conflictingRefs.length > 0 ? "Rejected wrong variant: exact ref not found" : "No exact reference match found",
      candidate,
    };
  }

  return {
    accepted: true,
    confidence,
    reason: null,
    candidate,
  };
}

function rankCandidates(ref, candidates) {
  const evaluations = candidates.map((candidate) => evaluateCandidate(ref, candidate));
  const acceptedCandidates = evaluations
    .filter((entry) => entry.accepted)
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }

      if ((left.candidate.currency === "GBP") !== (right.candidate.currency === "GBP")) {
        return left.candidate.currency === "GBP" ? -1 : 1;
      }

      return 0;
    });

  return {
    acceptedCandidates,
    rejectedResults: evaluations
      .filter((entry) => !entry.accepted)
      .map((entry) => ({
        title: entry.candidate.title,
        url: entry.candidate.url,
        rawType: entry.candidate.rawType,
        reason: entry.reason,
        confidence: entry.confidence,
        currency: entry.candidate.currency,
        priceText: entry.candidate.priceText,
      })),
  };
}

module.exports = {
  normalizeSerpApiResults,
  rankCandidates,
  normalizedRefMatch,
  normalizedRefMatchInUrl,
  parsePrice,
  extractCurrency,
  extractReferenceCandidates,
  getExactRefMatchDetails,
  isExactRefMatch,
};
