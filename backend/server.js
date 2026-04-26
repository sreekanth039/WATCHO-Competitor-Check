require("dotenv").config();

const express = require("express");
const { WATCHO, COMPETITORS } = require("./competitors");
const { getCachedResult, setCachedResult, clearCache } = require("./cache");
const { searchOrganic, searchShopping, getFallbackKeyCount } = require("./serpApiClient");
const {
  normalizeSerpApiResults,
  rankCandidates,
  normalizedRefMatch,
  normalizedRefMatchInUrl,
  getExactRefMatchDetails,
  isExactRefMatch,
} = require("./matcher");
const { extractPriceFromProductPage, isWeakSource } = require("./priceExtractor");
const { compactRef, generateRefVariants, getMatchedRefVariant, resolveRetailerSearchFallback } = require("./retailerSearchFallbacks");
const manualProductOverrides = require("./manualProductOverrides");

const app = express();
const port = Number.parseInt(process.env.PORT || "3000", 10);
const cacheTtlHours = clampTtlHours(process.env.CACHE_TTL_HOURS);
const useSerpApi = String(process.env.USE_SERPAPI || "true").toLowerCase() !== "false";

function clampTtlHours(value) {
  const parsed = Number.parseInt(value || "6", 10);

  if (!Number.isFinite(parsed)) {
    return 6;
  }

  return Math.min(24, Math.max(6, parsed));
}

function normaliseRef(ref) {
  return String(ref || "").trim().toUpperCase();
}

function isValidRef(ref) {
  return /^[A-Z0-9][A-Z0-9./ -]{2,49}$/.test(ref);
}

function parseDebugFlag(value) {
  return String(value || "").toLowerCase() === "true";
}

function buildEmptySearchResponse() {
  return {
    organic_results: [],
    shopping_results: [],
    inline_shopping_results: [],
    immersive_products: [],
  };
}

function buildSiteQuery(refVariant, domain) {
  return `"${refVariant}" site:${domain}`;
}

function buildSupplierCodeQuery(refVariant, domain) {
  return `"${refVariant}" "Supplier Code" site:${domain}`;
}

function buildCompactRefQuery(ref, domain) {
  return `"${compactRef(ref)}" site:${domain}`;
}

function buildBrandModelQuery(ref, domain, brandModelHint) {
  return brandModelHint ? `"${brandModelHint}" "${ref}" site:${domain}` : null;
}

function buildShoppingQuery(ref) {
  return `"${ref}" watch UK`;
}

function getSearchCacheKey(ref, domain, searchType, query) {
  return [ref, domain, searchType, query];
}

function extractBrandModelHint(title, ref) {
  const value = String(title || "")
    .split("|")[0]
    .replace(new RegExp(String(ref || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ")
    .replace(/\b(?:watch|watches|mens|ladies|unisex)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return value || null;
}

function looksLikeListingPage(title, url) {
  const combined = `${String(title || "")} ${String(url || "")}`.toLowerCase();
  return [
    "collections",
    "smart watches",
    "watches for men",
    "official uk retailer",
    "/collections/",
    "mens-watches.html",
    "/watches/garmin/",
    "garmin watches for men",
    "shop sale",
  ].some((pattern) => combined.includes(pattern));
}

function isValidProductUrl(url, expectedDomain) {
  try {
    const parsed = new URL(String(url));
    return /^https?:$/.test(parsed.protocol) && parsed.hostname.includes(expectedDomain);
  } catch (error) {
    return false;
  }
}

function buildEmptyResult(meta, reason) {
  return {
    ...meta,
    found: false,
    title: meta.title ?? null,
    price: meta.price ?? null,
    currency: meta.currency || "GBP",
    url: meta.url ?? null,
    confidence: meta.confidence ?? 0,
    source: meta.source ?? null,
    reason,
    blockedByCloudflare: Boolean(meta.blockedByCloudflare),
    browserAssistAvailable: Boolean(meta.browserAssistAvailable),
    fallbackAttempted: meta.fallbackAttempted || null,
  };
}

function buildDebugPayload(queries, rawResultsCount, rejectedResults, verificationResults) {
  return {
    queries,
    rawResultsFound: rawResultsCount,
    rejectedResults: rejectedResults.slice(0, 3),
    verificationResults: verificationResults.slice(0, 3),
  };
}

async function fetchSearchResponse({ ref, competitor, searchType, query }) {
  const cacheKey = getSearchCacheKey(ref, competitor.domain, searchType, query);
  const cached = getCachedResult(cacheKey, cacheTtlHours);

  console.log(`[cache] ${cached ? "hit" : "miss"} ref=${ref} domain=${competitor.domain} type=${searchType}`);
  console.log(`[query] ref=${ref} competitor="${competitor.name}" type=${searchType} query=${query}`);

  if (cached) {
    return {
      rawResponse: cached,
      usedSerpApi: false,
    };
  }

  if (!useSerpApi) {
    return {
      rawResponse: buildEmptySearchResponse(),
      usedSerpApi: false,
    };
  }

  const rawResponse =
    searchType === "google_shopping"
      ? await searchShopping(query)
      : await searchOrganic(query);

  setCachedResult(cacheKey, rawResponse);
  return {
    rawResponse,
    usedSerpApi: true,
  };
}

function findRefMatchLocations(ref, candidate, html) {
  const locations = [];
  const pageHtml = String(html || "");

  if (normalizedRefMatch(ref, candidate.title)) {
    locations.push("title");
  }

  if (normalizedRefMatch(ref, candidate.snippet)) {
    locations.push("snippet");
  }

  if (normalizedRefMatchInUrl(ref, candidate.url) || normalizedRefMatchInUrl(ref, candidate.displayedLink)) {
    locations.push("url");
  }

  if (normalizedRefMatch(ref, pageHtml)) {
    const specificationPattern = /(supplier code|suppliercode|model number|model no|reference|ref[\s:.#]|sku)/i;
    locations.push(specificationPattern.test(pageHtml) ? "specifications" : "html");
  }

  return [...new Set(locations)];
}

function getRejectedWrongVariant(candidate, ref) {
  const fields = [candidate.title, candidate.snippet, candidate.url, candidate.displayedLink];
  const exactMatch = fields.some((field) => isExactRefMatch(ref, field));
  const conflictingRefs = fields.flatMap((field) => getExactRefMatchDetails(ref, field).conflictingRefs);

  if (!exactMatch && conflictingRefs.length > 0) {
    return {
      title: candidate.title,
      url: candidate.url,
      conflictingRefs: [...new Set(conflictingRefs)],
      reason: "Rejected wrong variant: exact ref not found",
    };
  }

  return null;
}

function getManualOverrideUrl(ref, competitor) {
  return manualProductOverrides[competitor.domain]?.[ref] || null;
}

function buildVariantQueries(ref, competitor, brandModelHint) {
  const variants = generateRefVariants(ref);
  const queries = variants.flatMap((variant, index) => [
    { label: index === 0 ? "primary" : `variant_${index + 1}`, searchType: "google", query: buildSiteQuery(variant, competitor.domain), matchedRefVariant: variant },
    { label: `supplier_code_${index + 1}`, searchType: "google", query: buildSupplierCodeQuery(variant, competitor.domain), matchedRefVariant: variant },
  ]);

  queries.push({
    label: "compact_ref",
    searchType: "google",
    query: buildCompactRefQuery(ref, competitor.domain),
    matchedRefVariant: compactRef(ref),
  });

  if (brandModelHint) {
    queries.push({
      label: "brand_model_ref",
      searchType: "google",
      query: buildBrandModelQuery(ref, competitor.domain, brandModelHint),
      matchedRefVariant: getMatchedRefVariant(ref, brandModelHint) || variants[0],
    });
  }

  if (competitor.domain === WATCHO.domain) {
    queries.push({
      label: "watcho_named_exact",
      searchType: "google",
      query: `"${ref}" "WATCHO"`,
      matchedRefVariant: ref,
    });
    queries.push({
      label: "watcho_domain_exact",
      searchType: "google",
      query: `"${ref}" "watcho.co.uk"`,
      matchedRefVariant: ref,
    });
  }

  if (competitor.domain === WATCHO.domain && /^[A-Z]{2,5}\d+[A-Z0-9]+$/i.test(ref)) {
    const parts = String(ref).toUpperCase().match(/[A-Z]+|\d+/g) || [];
    if (parts.length >= 3) {
      queries.push({
        label: "watcho_split_spaced",
        searchType: "google",
        query: `"${parts.join(" ")}" site:${competitor.domain}`,
        matchedRefVariant: parts.join(" "),
      });
      queries.push({
        label: "watcho_split_dual",
        searchType: "google",
        query: `"${parts.slice(0, -1).join("")}" "${parts.slice(-1).join("")}" site:${competitor.domain}`,
        matchedRefVariant: `${parts.slice(0, -1).join("")} ${parts.slice(-1).join("")}`,
      });
    }
  }

  queries.push({
    label: "shopping_fallback",
    searchType: "google_shopping",
    query: buildShoppingQuery(ref),
    matchedRefVariant: variants[0] || ref,
  });

  return queries.filter(
    (entry, index, items) =>
      items.findIndex((candidate) => candidate.searchType === entry.searchType && candidate.query === entry.query) === index
  );
}

async function verifyCandidateWithProductPage(ref, competitor, acceptedCandidate) {
  const candidate = acceptedCandidate.candidate;
  const searchMatchLocations = findRefMatchLocations(ref, candidate, "");
  const searchMatch = searchMatchLocations.length > 0;
  const manualOverrideUsed = Boolean(acceptedCandidate.manualOverrideUsed);
  const rejectedWrongVariants = [];

  if (
    competitor.domain === "wallaceallan.co.uk" &&
    (!String(candidate.url || "").toLowerCase().endsWith(".html") || !isExactRefMatch(ref, candidate.url))
  ) {
    return {
      success: false,
      reason: "Rejected wrong variant: exact ref not found",
      candidate,
      confidence: acceptedCandidate.confidence,
      productPageFetched: false,
      refFoundInHtml: false,
      matchedRefLocation: null,
      matchedRefLocations: [],
      exactRefMatch: false,
      selectedUrl: candidate.url || null,
      priceExtractionSource: null,
      priceText: null,
      matchedPriceCandidates: [],
      rejectedPriceCandidates: [],
      acceptedPriceCandidate: null,
      productPageTitle: null,
      blockedByCloudflare: false,
      fallbackAttempted: null,
      browserAssistAvailable: false,
      rejectedWrongVariants: [{ url: candidate.url, reason: "Rejected wrong variant: exact ref not found" }],
      manualOverrideUsed,
    };
  }

  if (!isValidProductUrl(candidate.url, competitor.domain)) {
    return {
      success: false,
      reason: "Matched result does not point to a valid product page URL",
      candidate,
      confidence: acceptedCandidate.confidence,
      productPageFetched: false,
      refFoundInHtml: false,
      matchedRefLocation: null,
      matchedRefLocations: [],
      exactRefMatch: false,
      selectedUrl: candidate.url || null,
      priceExtractionSource: null,
      priceText: null,
      matchedPriceCandidates: [],
      rejectedPriceCandidates: [],
      acceptedPriceCandidate: null,
      productPageTitle: null,
      blockedByCloudflare: false,
      fallbackAttempted: null,
      browserAssistAvailable: false,
      rejectedWrongVariants,
      manualOverrideUsed,
    };
  }

  const extraction = await extractPriceFromProductPage(candidate.url);
  const matchedRefLocations = findRefMatchLocations(ref, candidate, extraction.html || "");
  const refFoundInHtml = matchedRefLocations.includes("html") || matchedRefLocations.includes("specifications");
  const pageHtmlMatch = refFoundInHtml;
  const refFoundInStableLocation = matchedRefLocations.includes("title") || matchedRefLocations.includes("url");
  const exactRefMatch = matchedRefLocations.length > 0;
  const fallbackAttempted = null;

  if (!exactRefMatch) {
    rejectedWrongVariants.push({
      url: candidate.url,
      reason: "Rejected wrong variant: exact ref not found",
    });
  }

  if (!refFoundInStableLocation && looksLikeListingPage(extraction.productPageTitle || candidate.title, candidate.url)) {
    return {
      success: false,
      reason: "Fetched page appears to be a listing page",
      candidate,
      confidence: acceptedCandidate.confidence,
      productPageFetched: extraction.fetched,
      refFoundInHtml,
      matchedRefLocation: matchedRefLocations.join(",") || null,
      matchedRefLocations,
      exactRefMatch,
      selectedUrl: candidate.url || null,
      priceExtractionSource: extraction.source,
      priceText: extraction.priceText,
      matchedPriceCandidates: extraction.matchedCandidates || [],
      rejectedPriceCandidates: extraction.rejectedCandidates || [],
      acceptedPriceCandidate: extraction.acceptedPriceCandidate || null,
      productPageTitle: extraction.productPageTitle || null,
      blockedByCloudflare: Boolean(extraction.blockedByCloudflare),
      fallbackAttempted,
      browserAssistAvailable: false,
      rejectedWrongVariants,
      manualOverrideUsed,
    };
  }

  if (!searchMatch && !pageHtmlMatch) {
    return {
      success: false,
      reason: "Rejected wrong variant: exact ref not found",
      candidate,
      confidence: acceptedCandidate.confidence,
      productPageFetched: extraction.fetched,
      refFoundInHtml,
      matchedRefLocation: matchedRefLocations.join(",") || null,
      matchedRefLocations,
      exactRefMatch,
      selectedUrl: candidate.url || null,
      priceExtractionSource: extraction.source,
      priceText: extraction.priceText,
      matchedPriceCandidates: extraction.matchedCandidates || [],
      rejectedPriceCandidates: extraction.rejectedCandidates || [],
      acceptedPriceCandidate: extraction.acceptedPriceCandidate || null,
      productPageTitle: extraction.productPageTitle || null,
      blockedByCloudflare: Boolean(extraction.blockedByCloudflare),
      fallbackAttempted,
      browserAssistAvailable: false,
      rejectedWrongVariants,
      manualOverrideUsed,
    };
  }

  if (extraction.currency !== "GBP" || extraction.price === null) {
    return {
      success: false,
      reason: "Product page found but price could not be extracted",
      candidate,
      confidence: acceptedCandidate.confidence,
      productPageFetched: extraction.fetched,
      refFoundInHtml,
      matchedRefLocation: matchedRefLocations.join(",") || null,
      matchedRefLocations,
      exactRefMatch,
      selectedUrl: candidate.url || null,
      priceExtractionSource: extraction.source,
      priceText: extraction.priceText,
      matchedPriceCandidates: extraction.matchedCandidates || [],
      rejectedPriceCandidates: extraction.rejectedCandidates || [],
      acceptedPriceCandidate: extraction.acceptedPriceCandidate || null,
      productPageTitle: extraction.productPageTitle || null,
      blockedByCloudflare: Boolean(extraction.blockedByCloudflare),
      fallbackAttempted,
      browserAssistAvailable: false,
      rejectedWrongVariants,
      manualOverrideUsed,
    };
  }

  return {
    success: true,
    result: {
      name: competitor.name,
      domain: competitor.domain,
      found: true,
      title: candidate.title,
      price: extraction.price,
      currency: extraction.currency,
      url: candidate.url,
      confidence: acceptedCandidate.confidence,
      source: candidate.rawType,
      priceSource: extraction.source,
      priceSourceMethod: extraction.method,
      priceText: extraction.priceText,
      priceNeedsChecking: isWeakSource(extraction.source) || extraction.needsChecking,
      reason: null,
      blockedByCloudflare: Boolean(extraction.blockedByCloudflare),
      browserAssistAvailable: false,
      fallbackAttempted,
      manualOverrideUsed,
    },
    productPageFetched: extraction.fetched,
    refFoundInHtml,
    matchedRefLocation: matchedRefLocations.join(",") || null,
    matchedRefLocations,
    exactRefMatch,
    selectedUrl: candidate.url || null,
    priceExtractionSource: extraction.source,
    priceText: extraction.priceText,
    matchedPriceCandidates: extraction.matchedCandidates || [],
    rejectedPriceCandidates: extraction.rejectedCandidates || [],
    acceptedPriceCandidate: extraction.acceptedPriceCandidate || null,
    productPageTitle: extraction.productPageTitle || null,
    blockedByCloudflare: Boolean(extraction.blockedByCloudflare),
    fallbackAttempted,
    browserAssistAvailable: false,
    rejectedWrongVariants,
    manualOverrideUsed,
  };
}

function buildSearchPlan(ref, competitor, brandModelHint) {
  const queries = buildVariantQueries(ref, competitor, brandModelHint);

  if (competitor.domain === "beaverbrooks.co.uk") {
    queries.unshift({
      label: "beaverbrooks_supplier_code",
      searchType: "google",
      query: buildSupplierCodeQuery(ref, competitor.domain),
      matchedRefVariant: ref,
    });
  }

  return queries.filter(
    (entry, index, items) =>
      items.findIndex((candidate) => candidate.searchType === entry.searchType && candidate.query === entry.query) === index
  );
}

async function resolveCompetitorResult(ref, competitor, debugMode, brandModelHint) {
  const searchPlan = buildSearchPlan(ref, competitor, brandModelHint);
  const verificationResults = [];
  const rejectedResults = [];
  const rejectedWrongVariants = [];
  const attemptedQueries = [];
  const fallbackSearchUrlsTried = [];
  const productLinksFoundFromSiteSearch = [];
  let rawResultsCount = 0;
  let serpApiCallsUsed = 0;

  const overrideUrl = getManualOverrideUrl(ref, competitor);
  if (overrideUrl) {
    const overrideVerification = await verifyCandidateWithProductPage(ref, competitor, {
      confidence: 100,
      manualOverrideUsed: true,
      candidate: {
        title: "",
        snippet: "",
        displayedLink: competitor.domain,
        url: overrideUrl,
        rawType: "manual_override",
      },
    });

    verificationResults.push({
      title: overrideVerification.result?.title || null,
      url: overrideUrl,
      rawType: "manual_override",
      matchedRefVariant: ref,
      reason: overrideVerification.success ? null : overrideVerification.reason,
      confidence: 100,
      productPageFetched: overrideVerification.productPageFetched,
      refFoundInHtml: overrideVerification.refFoundInHtml,
      matchedRefLocation: overrideVerification.matchedRefLocation,
      matchedRefLocations: overrideVerification.matchedRefLocations || [],
      exactRefMatch: Boolean(overrideVerification.exactRefMatch),
      selectedUrl: overrideVerification.selectedUrl || overrideUrl,
      priceExtractionSource: overrideVerification.priceExtractionSource,
      priceText: overrideVerification.priceText || null,
      matchedPriceCandidates: (overrideVerification.matchedPriceCandidates || []).slice(0, 5),
      rejectedPriceCandidates: (overrideVerification.rejectedPriceCandidates || []).slice(0, 5),
      acceptedPriceCandidate: overrideVerification.acceptedPriceCandidate || null,
      productPageTitle: overrideVerification.productPageTitle || null,
      blockedByCloudflare: Boolean(overrideVerification.blockedByCloudflare),
      fallbackAttempted: overrideVerification.fallbackAttempted || null,
      browserAssistAvailable: Boolean(overrideVerification.browserAssistAvailable),
      manualOverrideUsed: true,
    });
    rejectedWrongVariants.push(...(overrideVerification.rejectedWrongVariants || []));

    if (overrideVerification.success) {
      console.log(
        `[result] ref=${ref} competitor="${competitor.name}" found=true title=${overrideVerification.result.title || "-"} price=${overrideVerification.result.price ?? "-"} confidence=${overrideVerification.result.confidence}`
      );
      if (debugMode) {
        overrideVerification.result.debug = {
          ...buildDebugPayload(attemptedQueries, rawResultsCount, rejectedResults, verificationResults),
          searchedRef: ref,
          selectedUrl: overrideVerification.selectedUrl || overrideUrl,
          exactRefMatch: Boolean(overrideVerification.exactRefMatch),
          matchedRefLocations: overrideVerification.matchedRefLocations || [],
          rejectedWrongVariants,
          manualOverrideUsed: true,
          serpApiCallsUsed,
          fallbackSearchUrlsTried,
          productLinksFoundFromSiteSearch,
          currentTabFallbackUsed: false,
        };
      }
      return overrideVerification.result;
    }
  }

  for (const searchStep of searchPlan) {
    attemptedQueries.push({
      label: searchStep.label,
      searchType: searchStep.searchType,
      query: searchStep.query,
      matchedRefVariant: searchStep.matchedRefVariant || null,
    });

    const { rawResponse, usedSerpApi } = await fetchSearchResponse({
      ref,
      competitor,
      searchType: searchStep.searchType,
      query: searchStep.query,
    });
    if (usedSerpApi) {
      serpApiCallsUsed += 1;
    }

    const candidates = normalizeSerpApiResults(rawResponse, competitor).filter((candidate) => {
      if (searchStep.searchType !== "google_shopping") {
        return true;
      }

      const link = String(candidate.url || "");
      const displayedLink = String(candidate.displayedLink || "");
      return link.includes(competitor.domain) || displayedLink.includes(competitor.domain);
    });

    rawResultsCount += candidates.length;
    const ranking = rankCandidates(ref, candidates);
    rejectedResults.push(...ranking.rejectedResults);
    rejectedWrongVariants.push(...ranking.rejectedResults.filter((entry) => entry.reason === "Rejected wrong variant: exact ref not found"));

    for (const acceptedCandidate of ranking.acceptedCandidates) {
      const verification = await verifyCandidateWithProductPage(ref, competitor, acceptedCandidate);
      rejectedWrongVariants.push(...(verification.rejectedWrongVariants || []));

      verificationResults.push({
        title: acceptedCandidate.candidate.title,
        url: acceptedCandidate.candidate.url,
        rawType: acceptedCandidate.candidate.rawType,
        matchedRefVariant: acceptedCandidate.candidate.matchedRefVariant || searchStep.matchedRefVariant || null,
        reason: verification.success ? null : verification.reason,
        confidence: acceptedCandidate.confidence,
        productPageFetched: verification.productPageFetched,
        refFoundInHtml: verification.refFoundInHtml,
        matchedRefLocation: verification.matchedRefLocation,
        matchedRefLocations: verification.matchedRefLocations || [],
        exactRefMatch: Boolean(verification.exactRefMatch),
        selectedUrl: verification.selectedUrl || acceptedCandidate.candidate.url,
        priceExtractionSource: verification.priceExtractionSource,
        priceText: verification.priceText || null,
        matchedPriceCandidates: (verification.matchedPriceCandidates || []).slice(0, 5),
        rejectedPriceCandidates: (verification.rejectedPriceCandidates || []).slice(0, 5),
        acceptedPriceCandidate: verification.acceptedPriceCandidate || null,
        productPageTitle: verification.productPageTitle || null,
        blockedByCloudflare: Boolean(verification.blockedByCloudflare),
        fallbackAttempted: verification.fallbackAttempted || null,
        browserAssistAvailable: Boolean(verification.browserAssistAvailable),
        manualOverrideUsed: Boolean(verification.manualOverrideUsed),
      });

      if (verification.success) {
        console.log(
          `[result] ref=${ref} competitor="${competitor.name}" found=true title=${verification.result.title || "-"} price=${verification.result.price ?? "-"} confidence=${verification.result.confidence}`
        );

        if (debugMode) {
          verification.result.debug = {
            ...buildDebugPayload(attemptedQueries, rawResultsCount, rejectedResults, verificationResults),
            searchedRef: ref,
            selectedUrl: verification.selectedUrl || acceptedCandidate.candidate.url,
            exactRefMatch: Boolean(verification.exactRefMatch),
            matchedRefLocations: verification.matchedRefLocations || [],
            rejectedWrongVariants,
            manualOverrideUsed: Boolean(verification.manualOverrideUsed),
            serpApiCallsUsed,
            fallbackSearchUrlsTried,
            productLinksFoundFromSiteSearch,
            currentTabFallbackUsed: false,
          };
        }

        return verification.result;
      }
    }
  }

  const siteSearchFallback = resolveRetailerSearchFallback(ref, competitor);
  fallbackSearchUrlsTried.push(...siteSearchFallback.triedUrls);
  productLinksFoundFromSiteSearch.push(
    ...siteSearchFallback.productCandidates.map((candidate) => ({
      title: candidate.title,
      url: candidate.url,
      matchedRefVariant: candidate.matchedRefVariant || null,
    }))
  );

  for (const fallbackCandidate of siteSearchFallback.productCandidates) {
    const verification = await verifyCandidateWithProductPage(ref, competitor, {
      confidence: 95,
      candidate: fallbackCandidate,
    });
    rejectedWrongVariants.push(...(verification.rejectedWrongVariants || []));

    verificationResults.push({
      title: fallbackCandidate.title,
      url: fallbackCandidate.url,
      rawType: fallbackCandidate.rawType,
      matchedRefVariant: fallbackCandidate.matchedRefVariant || null,
      reason: verification.success ? null : verification.reason,
      confidence: 95,
      productPageFetched: verification.productPageFetched,
      refFoundInHtml: verification.refFoundInHtml,
      matchedRefLocation: verification.matchedRefLocation,
      matchedRefLocations: verification.matchedRefLocations || [],
      exactRefMatch: Boolean(verification.exactRefMatch),
      selectedUrl: verification.selectedUrl || fallbackCandidate.url,
      priceExtractionSource: verification.priceExtractionSource,
      priceText: verification.priceText || null,
      matchedPriceCandidates: (verification.matchedPriceCandidates || []).slice(0, 5),
      rejectedPriceCandidates: (verification.rejectedPriceCandidates || []).slice(0, 5),
      acceptedPriceCandidate: verification.acceptedPriceCandidate || null,
      productPageTitle: verification.productPageTitle || null,
      blockedByCloudflare: Boolean(verification.blockedByCloudflare),
      fallbackAttempted: verification.fallbackAttempted || null,
      browserAssistAvailable: Boolean(verification.browserAssistAvailable),
      manualOverrideUsed: Boolean(verification.manualOverrideUsed),
    });

    if (verification.success) {
      if (debugMode) {
        verification.result.debug = {
          ...buildDebugPayload(attemptedQueries, rawResultsCount, rejectedResults, verificationResults),
          searchedRef: ref,
          selectedUrl: verification.selectedUrl || fallbackCandidate.url,
          exactRefMatch: Boolean(verification.exactRefMatch),
          matchedRefLocations: verification.matchedRefLocations || [],
          rejectedWrongVariants,
          manualOverrideUsed: Boolean(verification.manualOverrideUsed),
          serpApiCallsUsed,
          fallbackSearchUrlsTried,
          productLinksFoundFromSiteSearch,
          currentTabFallbackUsed: false,
        };
      }

      return verification.result;
    }
  }

  const reason =
    verificationResults.find((entry) => entry.reason === "Product page found but price could not be extracted")?.reason ||
    verificationResults.find((entry) => entry.reason === "Rejected wrong variant: exact ref not found")?.reason ||
    (competitor.domain === WATCHO.domain
      ? "WATCHO not found from search. Open WATCHO product page to capture directly."
      : null) ||
    "No exact reference match found";

  const selectedFailure =
    verificationResults.find((entry) => entry.reason === reason) ||
    verificationResults.find((entry) => entry.exactRefMatch) ||
    verificationResults.find((entry) => entry.url) ||
    null;

  const result = buildEmptyResult(
    {
      name: competitor.name,
      domain: competitor.domain,
      url: selectedFailure?.url || null,
      blockedByCloudflare: Boolean(selectedFailure?.blockedByCloudflare),
      browserAssistAvailable: false,
      fallbackAttempted: selectedFailure?.fallbackAttempted || null,
      matchedRefVariant: selectedFailure?.matchedRefVariant || null,
      status: null,
    },
    reason
  );

  console.log(
    `[result] ref=${ref} competitor="${competitor.name}" found=false title=- price=- confidence=0 reason="${reason}"`
  );

  if (debugMode) {
    result.debug = {
      ...buildDebugPayload(attemptedQueries, rawResultsCount, rejectedResults, verificationResults),
      searchedRef: ref,
      selectedUrl: result.url || null,
      exactRefMatch: false,
      matchedRefLocations: [],
      rejectedWrongVariants,
      manualOverrideUsed: Boolean(overrideUrl),
      serpApiCallsUsed,
      fallbackSearchUrlsTried,
      productLinksFoundFromSiteSearch,
      currentTabFallbackUsed: false,
    };
  }

  return result;
}

async function buildComparison(ref, debugMode) {
  console.log(`[compare] ref=${ref} debug=${debugMode}`);

  const watchoResult = await resolveCompetitorResult(ref, WATCHO, debugMode);
  const brandModelHint = extractBrandModelHint(watchoResult.title, ref);
  const competitors = await Promise.all(
    COMPETITORS.map((competitor) => resolveCompetitorResult(ref, competitor, debugMode, brandModelHint))
  );

  const response = {
    ref,
    searchedAt: new Date().toISOString(),
    watcho: {
      found: watchoResult.found,
      title: watchoResult.title,
      price: watchoResult.price,
      currency: watchoResult.currency,
      url: watchoResult.url,
      confidence: watchoResult.confidence,
      reason: watchoResult.reason || null,
      priceSource: watchoResult.priceSource || null,
      priceSourceMethod: watchoResult.priceSourceMethod || null,
      priceText: watchoResult.priceText || null,
      priceNeedsChecking: Boolean(watchoResult.priceNeedsChecking),
    },
    competitors,
  };

  if (debugMode) {
    response.debug = {
      watcho: watchoResult.debug || null,
      competitors: competitors.map((competitor) => ({
        name: competitor.name,
        domain: competitor.domain,
        debug: competitor.debug || null,
      })),
    };
  }

  return response;
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

app.post("/api/cache/clear", (req, res) => {
  clearCache();
  res.json({
    ok: true,
    clearedAt: new Date().toISOString(),
  });
});

app.get("/api/compare-watch", async (req, res) => {
  const ref = normaliseRef(req.query.ref);
  const debugMode = parseDebugFlag(req.query.debug);

  if (!isValidRef(ref)) {
    return res.status(400).json({
      error: "Invalid watch reference number. Use 3-50 letters, numbers, dots, slashes, spaces, or hyphens.",
    });
  }

  try {
    const comparison = await buildComparison(ref, debugMode);
    return res.json(comparison);
  } catch (error) {
    console.error(`[error] ref=${ref} message=${error.message}`);
    if (error.status === 429 || error.isQuotaExceeded) {
      return res.status(503).json({
        error: "SerpApi quota exceeded. Add a new key or enable fallback key.",
      });
    }

    return res.status(500).json({
      error: "Failed to compare watch prices.",
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cacheTtlHours,
    serpApiConfigured: Boolean(process.env.SERPAPI_KEY),
    fallbackKeyCount: getFallbackKeyCount(),
    useSerpApi,
    location: "United Kingdom",
    googleDomain: "google.co.uk",
    gl: "uk",
    hl: "en",
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`WATCHO comparison backend listening on http://localhost:${port}`);
  });
}

module.exports = {
  app,
  buildComparison,
};
