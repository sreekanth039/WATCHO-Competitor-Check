const { extractCurrency, parsePrice } = require("./matcher");
const { execFileSync } = require("child_process");

const REQUEST_TIMEOUT_MS = 8000;
const PRICE_CANDIDATE_LIMIT = 12;
const PRICE_EXCLUSION_TERMS = [
  "klarna",
  "month",
  "per month",
  "monthly",
  "finance",
  "interest free",
  "paypal credit",
  "v12",
  "deposit",
  "warranty",
  "delivery",
  "saving",
  "save",
  "discount",
  "rrp",
  "was",
  "recommended retail",
  "insurance",
  "add-on",
  "addon",
];

const STRONG_PRICE_SOURCES = new Set([
  "json_ld_offers",
  "meta_tag",
  "itemprop_price",
  "watcho_meta_tag",
  "wallace_allan_meta_tag",
  "goldsmiths_state_price",
  "goldsmiths_price_object",
  "serpapi_price_fallback",
]);

function buildFetchOptions() {
  return {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-GB,en;q=0.9",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
}

function extractPageTitle(html) {
  const titleMatch = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : null;
}

function normaliseSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getHostname(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch (error) {
    return "";
  }
}

function isWeakSource(source) {
  return source === "visible_selector" || source === "visible_text_regex";
}

function shouldRejectPriceContext(context) {
  const lowered = normaliseSpace(context).toLowerCase();
  return PRICE_EXCLUSION_TERMS.find((term) => lowered.includes(term)) || null;
}

function isLikelyPremiumWatchContext(text) {
  return /(garmin|fenix|luxury watch|luxury watches|rolex|omega|tudor|cartier|breitling|tag heuer|grand seiko|iwc)/i.test(
    String(text || "")
  );
}

function getSuspiciousPriceReason(candidate, pageContext) {
  if (
    candidate.price === null ||
    candidate.price >= 300 ||
    STRONG_PRICE_SOURCES.has(candidate.source) ||
    !isLikelyPremiumWatchContext(pageContext)
  ) {
    return null;
  }

  return "Rejected suspiciously low price, likely finance/add-on price";
}

function buildCandidate({
  priceText,
  price,
  currency,
  context,
  source,
  method,
  needsChecking = false,
  accepted = price !== null,
  reason = null,
}) {
  return {
    priceText: priceText || null,
    price: price ?? null,
    currency: currency || extractCurrency(priceText) || null,
    context: normaliseSpace(context),
    source,
    method,
    needsChecking: Boolean(needsChecking),
    accepted: Boolean(accepted),
    reason,
  };
}

function buildFinalResult(html, candidate, matchedCandidates, rejectedCandidates) {
  return {
    price: candidate.price,
    currency: candidate.currency || null,
    priceText: candidate.priceText || null,
    source: candidate.source,
    method: candidate.method,
    needsChecking: Boolean(candidate.needsChecking),
    html,
    matchedCandidates,
    rejectedCandidates,
    acceptedPriceCandidate: {
      priceText: candidate.priceText || null,
      price: candidate.price ?? null,
      currency: candidate.currency || null,
      source: candidate.source,
      method: candidate.method,
      context: candidate.context,
    },
    productPageTitle: extractPageTitle(html),
    blockedByCloudflare: false,
  };
}

function buildEmptyResult(html, matchedCandidates, rejectedCandidates, source = "not_found") {
  return {
    price: null,
    currency: null,
    priceText: null,
    source,
    method: null,
    needsChecking: false,
    html,
    matchedCandidates,
    rejectedCandidates,
    acceptedPriceCandidate: null,
    productPageTitle: extractPageTitle(html),
    blockedByCloudflare: false,
  };
}

function isCloudflareBlockedPage(html) {
  const raw = String(html || "");
  const body = raw.toLowerCase();
  const title = extractPageTitle(raw)?.toLowerCase() || "";

  return (
    title.includes("attention required") ||
    title.includes("cloudflare") ||
    body.includes("cf-chl") ||
    body.includes("please enable cookies") ||
    body.includes("why have i been blocked") ||
    body.includes("attention required! | cloudflare")
  );
}

function extractJsonLdBlocks(html) {
  const matches = String(html || "").match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  return matches
    .map((block) => block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim())
    .filter(Boolean);
}

function getObjectValueCaseInsensitive(object, key) {
  if (!object || typeof object !== "object") {
    return undefined;
  }

  const matchedKey = Object.keys(object).find((candidateKey) => candidateKey.toLowerCase() === key.toLowerCase());
  return matchedKey ? object[matchedKey] : undefined;
}

function flattenJsonLd(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(flattenJsonLd);
  }

  if (typeof value === "object") {
    const graph = Array.isArray(value["@graph"]) ? flattenJsonLd(value["@graph"]) : [];
    return [value, ...graph];
  }

  return [];
}

function extractMetaContent(html, namePattern) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const attrRegex = /([a-zA-Z:-]+)=["']([^"']*)["']/g;
    const attrs = {};
    let attrMatch;

    while ((attrMatch = attrRegex.exec(tag))) {
      attrs[attrMatch[1].toLowerCase()] = attrMatch[2];
    }

    if (attrs.property === namePattern || attrs.name === namePattern || attrs.itemprop === namePattern) {
      return attrs.content || null;
    }
  }

  return null;
}

function extractPriceFromText(value, extractedPrice) {
  const price = parsePrice(value, extractedPrice);
  const currency = extractCurrency(value) || "GBP";
  return { price, currency };
}

function addCandidate(store, candidate) {
  if (!candidate || !candidate.priceText) {
    return;
  }

  const dedupeKey = [
    candidate.priceText,
    candidate.source,
    candidate.method,
    candidate.context,
    candidate.reason,
  ].join("|");

  if (store.seen.has(dedupeKey)) {
    return;
  }

  store.seen.add(dedupeKey);
  store.matched.push(candidate);
  if (!candidate.accepted) {
    store.rejected.push({
      priceText: candidate.priceText,
      price: candidate.price,
      currency: candidate.currency,
      source: candidate.source,
      method: candidate.method,
      context: candidate.context,
      reason: candidate.reason || "Rejected",
    });
  }
}

function makeCandidateStore() {
  return {
    matched: [],
    rejected: [],
    seen: new Set(),
  };
}

function acceptCandidate(store, candidate) {
  addCandidate(store, candidate);
  return buildFinalResult("", candidate, store.matched.slice(0, PRICE_CANDIDATE_LIMIT), store.rejected.slice(0, PRICE_CANDIDATE_LIMIT));
}

function finalizeResult(html, store, acceptedCandidate) {
  if (acceptedCandidate) {
    return buildFinalResult(
      html,
      acceptedCandidate,
      store.matched.slice(0, PRICE_CANDIDATE_LIMIT),
      store.rejected.slice(0, PRICE_CANDIDATE_LIMIT)
    );
  }

  return buildEmptyResult(
    html,
    store.matched.slice(0, PRICE_CANDIDATE_LIMIT),
    store.rejected.slice(0, PRICE_CANDIDATE_LIMIT)
  );
}

function candidateFromValue({ priceText, extractedPrice, currency, context, source, method, needsChecking = false }) {
  const parsed = extractPriceFromText(priceText, extractedPrice);
  const reason = shouldRejectPriceContext(context);
  return buildCandidate({
    priceText: String(priceText),
    price: parsed.price,
    currency: currency || parsed.currency,
    context,
    source,
    method,
    needsChecking,
    accepted: parsed.price !== null && !reason && (currency || parsed.currency) === "GBP",
    reason: reason ? `Rejected finance/auxiliary context: ${reason}` : (currency || parsed.currency) !== "GBP" ? "Rejected non-GBP price" : null,
  });
}

function extractJsonLdOfferCandidates(html) {
  const candidates = [];

  for (const block of extractJsonLdBlocks(html)) {
    try {
      const parsed = JSON.parse(block);
      const objects = flattenJsonLd(parsed);

      for (const object of objects) {
        const type = String(getObjectValueCaseInsensitive(object, "@type") || "").toLowerCase();
        const rawOffers = getObjectValueCaseInsensitive(object, "offers");
        const offers = Array.isArray(rawOffers) ? rawOffers : [rawOffers].filter(Boolean);

        for (const offer of offers) {
          const priceText =
            getObjectValueCaseInsensitive(offer, "price") ??
            getObjectValueCaseInsensitive(offer, "lowPrice") ??
            getObjectValueCaseInsensitive(offer, "highPrice") ??
            null;

          if (priceText === null) {
            continue;
          }

          candidates.push(
            candidateFromValue({
              priceText: String(priceText),
              currency: getObjectValueCaseInsensitive(offer, "priceCurrency") || extractCurrency(priceText) || "GBP",
              context: `json_ld ${type || "unknown"} offers`,
              source: "json_ld_offers",
              method: "json_ld",
            })
          );
        }
      }
    } catch (error) {
      continue;
    }
  }

  return candidates;
}

function extractMetaCandidates(html) {
  const priceText =
    extractMetaContent(html, "product:price:amount") ||
    extractMetaContent(html, "og:price:amount") ||
    extractMetaContent(html, "twitter:data1");
  const currency =
    extractMetaContent(html, "product:price:currency") ||
    extractMetaContent(html, "og:price:currency") ||
    extractCurrency(priceText);

  return priceText
    ? [
        candidateFromValue({
          priceText,
          currency: currency || "GBP",
          context: "meta product price",
          source: "meta_tag",
          method: "meta",
        }),
      ]
    : [];
}

function extractItempropCandidates(html) {
  const candidates = [];
  const itempropMetaMatch = String(html || "").match(
    /<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["'][^>]*>/i
  );
  const itempropTextMatch = String(html || "").match(
    /itemprop=["']price["'][^>]*>([^<]*£\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?[^<]*)</i
  );

  for (const value of [itempropMetaMatch?.[1], itempropTextMatch?.[1]]) {
    if (!value) {
      continue;
    }

    candidates.push(
      candidateFromValue({
        priceText: value,
        currency: extractMetaContent(html, "priceCurrency") || extractMetaContent(html, "product:price:currency") || "GBP",
        context: "itemprop price",
        source: "itemprop_price",
        method: "itemprop",
      })
    );
  }

  return candidates;
}

function extractVisibleSelectorCandidates(html, selectors) {
  const candidates = [];

  for (const selector of selectors) {
    const regex = new RegExp(selector, "i");
    const match = String(html || "").match(regex);
    if (!match) {
      continue;
    }

    const snippet = match[1] || match[0];
    const priceTextMatch = snippet.match(/£\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\bGBP\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/i);
    if (!priceTextMatch) {
      continue;
    }

    candidates.push(
      candidateFromValue({
        priceText: priceTextMatch[0],
        context: snippet,
        source: "visible_selector",
        method: "visible_selector",
        needsChecking: true,
      })
    );
  }

  return candidates;
}

function collectRegexCandidates(html) {
  const text = String(html || "");
  const regex = /£\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\bGBP\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/gi;
  const candidates = [];
  let match;

  while ((match = regex.exec(text)) && candidates.length < PRICE_CANDIDATE_LIMIT) {
    const start = Math.max(0, match.index - 120);
    const end = Math.min(text.length, match.index + match[0].length + 120);
    const context = text.slice(start, end).replace(/\s+/g, " ");

    candidates.push(
      candidateFromValue({
        priceText: match[0],
        context,
        source: "visible_text_regex",
        method: "visible_text",
        needsChecking: true,
      })
    );
  }

  return candidates;
}

function extractBcDataCandidates(html) {
  const matched = [];
  const bcDataMatch = String(html || "").match(/BCData\s*=\s*(\{[\s\S]*?\});/i);

  if (!bcDataMatch) {
    return matched;
  }

  const valueMatch = bcDataMatch[1].match(/"value"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const formattedMatch = bcDataMatch[1].match(/"formatted"\s*:\s*"([^"]+)"/i);
  const currencyMatch = bcDataMatch[1].match(/"currency"\s*:\s*"([A-Z]{3})"/i);
  const priceText = formattedMatch ? formattedMatch[1] : valueMatch?.[1] || null;

  if (!priceText) {
    return matched;
  }

  matched.push(
    candidateFromValue({
      priceText,
      extractedPrice: valueMatch ? Number.parseFloat(valueMatch[1]) : undefined,
      currency: currencyMatch ? currencyMatch[1].toUpperCase() : "GBP",
      context: "bcdata script",
      source: "bcdata_script",
      method: "script",
    })
  );

  return matched;
}

function extractWallaceAllanCandidates(html) {
  const candidates = [];
  const metaPrice = extractMetaContent(html, "product:price:amount");
  const metaCurrency = extractMetaContent(html, "product:price:currency") || "GBP";
  if (metaPrice) {
    candidates.push(
      candidateFromValue({
        priceText: metaPrice,
        currency: metaCurrency,
        context: "wallace allan meta product price",
        source: "wallace_allan_meta_tag",
        method: "meta",
      })
    );
  }

  const finalPriceMatch = String(html || "").match(
    /data-price-amount=["']([0-9]+(?:\.[0-9]+)?)["'][^>]*data-price-type=["']finalPrice["'][\s\S]{0,200}?<span[^>]*class=["'][^"']*price[^"']*["'][^>]*>\s*(£\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i
  );
  if (finalPriceMatch) {
    candidates.push(
      candidateFromValue({
        priceText: finalPriceMatch[2] || finalPriceMatch[1],
        extractedPrice: Number.parseFloat(finalPriceMatch[1]),
        currency: "GBP",
        context: finalPriceMatch[0],
        source: "wallace_allan_final_price_selector",
        method: "visible_selector",
      })
    );
  }

  const dataLayerMatch = String(html || "").match(/["']price["']\s*:\s*["']?([0-9]+(?:\.[0-9]+)?)["']?/i);
  if (dataLayerMatch) {
    candidates.push(
      candidateFromValue({
        priceText: dataLayerMatch[1],
        extractedPrice: Number.parseFloat(dataLayerMatch[1]),
        currency: "GBP",
        context: "wallace allan dataLayer price",
        source: "wallace_allan_datalayer",
        method: "script",
      })
    );
  }

  return candidates;
}

function extractGoldsmithsCandidates(html) {
  const candidates = [];
  const aurumMatch = String(html || "").match(
    /"aurumPrice"\s*:\s*\{[\s\S]{0,300}?"currencyIso"\s*:\s*"([A-Z]{3})"[\s\S]{0,300}?"formattedValue"\s*:\s*"([^"]+)"[\s\S]{0,300}?"value"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i
  );

  if (aurumMatch) {
    candidates.push(
      candidateFromValue({
        priceText: aurumMatch[2],
        extractedPrice: Number.parseFloat(aurumMatch[3]),
        currency: aurumMatch[1],
        context: "goldsmiths aurumPrice product state",
        source: "goldsmiths_state_price",
        method: "script",
      })
    );
  }

  const formattedPriceMatch = String(html || "").match(/"price"\s*:\s*\{[\s\S]{0,200}?"formattedValue"\s*:\s*"([^"]+)"/i);
  if (formattedPriceMatch) {
    candidates.push(
      candidateFromValue({
        priceText: formattedPriceMatch[1],
        currency: extractCurrency(formattedPriceMatch[1]) || "GBP",
        context: "goldsmiths product price object",
        source: "goldsmiths_price_object",
        method: "script",
      })
    );
  }

  return candidates;
}

function extractFirstClassWatchesCandidates(html) {
  return extractVisibleSelectorCandidates(html, [
    'class=["\'][^"\']*(?:our-price|productSpecialPrice|special-price|price-now|current-price)[^"\']*["\'][^>]*>([\\s\\S]{0,200}?)<',
    'id=["\'][^"\']*(?:our_price_display|productSpecialPrice)[^"\']*["\'][^>]*>([\\s\\S]{0,200}?)<',
    'class=["\'][^"\']*price[^"\']*["\'][^>]*>([\\s\\S]{0,200}?)<',
  ]);
}

function extractGenericCandidates(html) {
  return [
    ...extractJsonLdOfferCandidates(html),
    ...extractMetaCandidates(html),
    ...extractItempropCandidates(html),
    ...extractBcDataCandidates(html),
    ...extractVisibleSelectorCandidates(html, [
      'class=["\'][^"\']*(?:sale|current|final|now)[^"\']*price[^"\']*["\'][^>]*>([\\s\\S]{0,200}?)<',
      'class=["\'][^"\']*price[^"\']*["\'][^>]*>([\\s\\S]{0,200}?)<',
      'data-price-type=["\']finalPrice["\'][\\s\\S]{0,220}?(£\\s?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?)',
    ]),
  ];
}

function chooseBestCandidate(store, candidates, options = {}) {
  const { allowRegexFallback = true, pageContext = "" } = options;
  let accepted = null;

  for (const candidate of candidates) {
    const suspiciousReason = getSuspiciousPriceReason(candidate, pageContext);
    const evaluatedCandidate = suspiciousReason
      ? {
          ...candidate,
          accepted: false,
          reason: suspiciousReason,
        }
      : candidate;

    addCandidate(store, evaluatedCandidate);
    if (!accepted && evaluatedCandidate.accepted) {
      accepted = evaluatedCandidate;
    }
  }

  if (!accepted && allowRegexFallback) {
    for (const candidate of store.matched) {
      if (candidate.source === "visible_text_regex" && candidate.accepted) {
        accepted = candidate;
        break;
      }
    }
  }

  return accepted;
}

function extractPriceFromHtml(html, url) {
  const hostname = getHostname(url);
  const store = makeCandidateStore();
  let acceptedCandidate = null;
  const pageContext = `${extractPageTitle(html) || ""} ${String(html || "").slice(0, 4000)}`;

  if (hostname.includes("wallaceallan.co.uk")) {
    acceptedCandidate = chooseBestCandidate(store, [
      ...extractWallaceAllanCandidates(html),
      ...extractJsonLdOfferCandidates(html),
    ], { allowRegexFallback: false, pageContext });
  } else if (hostname.includes("goldsmiths.co.uk")) {
    acceptedCandidate = chooseBestCandidate(store, [
      ...extractGoldsmithsCandidates(html),
      ...extractMetaCandidates(html),
      ...extractJsonLdOfferCandidates(html),
    ], { allowRegexFallback: false, pageContext });
  } else if (hostname.includes("beaverbrooks.co.uk")) {
    acceptedCandidate = chooseBestCandidate(store, [
      ...extractMetaCandidates(html),
      ...extractJsonLdOfferCandidates(html),
      ...extractItempropCandidates(html),
      ...extractVisibleSelectorCandidates(html, [
        'class=["\'][^"\']*(?:price|current-price|product-price)[^"\']*["\'][^>]*>([\\s\\S]{0,200}?)<',
      ]),
    ], { allowRegexFallback: false, pageContext });
  }

  if (!acceptedCandidate) {
    acceptedCandidate = chooseBestCandidate(store, extractGenericCandidates(html), {
      allowRegexFallback: false,
      pageContext,
    });
  }

  if (!acceptedCandidate) {
    acceptedCandidate = chooseBestCandidate(store, collectRegexCandidates(html), { allowRegexFallback: true });
  }

  return finalizeResult(html, store, acceptedCandidate);
}

function fetchHtmlWithCurl(url) {
  try {
    return execFileSync(
      "curl",
      [
        "-sS",
        "-L",
        "--max-time",
        String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
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

function extractWatchoMetaPrice(url) {
  if (!String(url).includes("watcho.co.uk")) {
    return null;
  }

  const html = fetchHtmlWithCurl(url);
  if (!html) {
    return null;
  }

  const priceText = extractMetaContent(html, "product:price:amount");
  const currency = extractMetaContent(html, "product:price:currency") || extractCurrency(priceText) || "GBP";
  const price = parsePrice(priceText);

  if (price === null) {
    return null;
  }

  const candidate = buildCandidate({
    priceText,
    price,
    currency,
    context: "watcho meta product price",
    source: "watcho_meta_tag",
    method: "meta",
  });

  return {
    ...buildFinalResult(html, candidate, [candidate], []),
    fetched: true,
  };
}

async function extractPriceFromProductPage(url) {
  const watchoMetaResult = extractWatchoMetaPrice(url);
  if (watchoMetaResult) {
    return watchoMetaResult;
  }

  const curlHtml = fetchHtmlWithCurl(url);
  if (curlHtml && isCloudflareBlockedPage(curlHtml)) {
    return {
      ...buildEmptyResult(curlHtml, [], [], "cloudflare_blocked"),
      fetched: true,
      blockedByCloudflare: true,
    };
  }
  const extractedFromCurl = curlHtml ? extractPriceFromHtml(curlHtml, url) : null;

  if (extractedFromCurl?.price !== null) {
    return {
      ...extractedFromCurl,
      fetched: true,
    };
  }

  try {
    const response = await fetch(url, buildFetchOptions());
    if (!response.ok) {
      return {
        ...(extractedFromCurl || buildEmptyResult("", [], [], `fetch_failed_${response.status}`)),
        source: extractedFromCurl?.source || `fetch_failed_${response.status}`,
        fetched: Boolean(curlHtml),
      };
    }

    const html = await response.text();
    if (isCloudflareBlockedPage(html)) {
      return {
        ...buildEmptyResult(html, [], [], "cloudflare_blocked"),
        fetched: true,
        blockedByCloudflare: true,
      };
    }
    const extractedFromFetch = extractPriceFromHtml(html, url);
    return {
      ...extractedFromFetch,
      fetched: true,
    };
  } catch (error) {
    return {
      ...(extractedFromCurl || buildEmptyResult(curlHtml || "", [], [], error.name === "TimeoutError" ? "timeout" : "fetch_error")),
      source: extractedFromCurl?.source || (error.name === "TimeoutError" ? "timeout" : "fetch_error"),
      fetched: Boolean(curlHtml),
      blockedByCloudflare: Boolean(extractedFromCurl?.blockedByCloudflare),
    };
  }
}

module.exports = {
  extractPriceFromProductPage,
  isWeakSource,
};
