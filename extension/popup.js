const API_BASE_URL = "https://watcho-price-compare-api.onrender.com";
const RESULTS_STORAGE_KEY = "lastResults";
const REF_STORAGE_KEY = "lastRef";
const SORT_STORAGE_KEY = "selectedSort";

const form = document.getElementById("search-form");
const refInput = document.getElementById("ref-input");
const searchButton = document.getElementById("search-button");
const clearButton = document.getElementById("clear-button");
const sortSelect = document.getElementById("sort-select");
const statusBox = document.getElementById("status");
const resultsSection = document.getElementById("results");
const refDisplay = document.getElementById("ref-display");
const lastChecked = document.getElementById("last-checked");
const lastSearchLabel = document.getElementById("last-search-label");
const watchoTitle = document.getElementById("watcho-title");
const watchoPrice = document.getElementById("watcho-price");
const watchoConfidence = document.getElementById("watcho-confidence");
const watchoWarning = document.getElementById("watcho-warning");
const watchoUrl = document.getElementById("watcho-url");
const resultsBody = document.getElementById("results-body");

let currentResult = null;

function showStatus(message, kind) {
  statusBox.textContent = message;
  statusBox.className = `status visible ${kind || ""}`.trim();
}

function hideStatus() {
  statusBox.textContent = "";
  statusBox.className = "status";
}

function formatMoney(price, currency = "GBP") {
  if (price === null || price === undefined) {
    return "No price";
  }

  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(price);
  } catch (error) {
    return `${currency} ${price}`;
  }
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("en-GB");
}

function getConfidenceLabel(confidence) {
  if (confidence >= 85) {
    return { text: `${confidence}% high`, className: "badge badge-high" };
  }

  if (confidence >= 60) {
    return { text: `${confidence}% medium`, className: "badge badge-medium" };
  }

  return { text: `${confidence}% low`, className: "badge badge-low" };
}

function buildDiffMeta(competitorPrice, watchoPriceValue) {
  if (competitorPrice === null || competitorPrice === undefined || watchoPriceValue === null || watchoPriceValue === undefined) {
    return { display: "N/A", className: "empty-cell", value: Number.POSITIVE_INFINITY };
  }

  const diff = competitorPrice - watchoPriceValue;
  const className = diff < 0 ? "price-down" : diff > 0 ? "price-up" : "";
  const sign = diff > 0 ? "+" : "";

  return {
    display: `${sign}${formatMoney(diff)}`,
    className,
    value: diff,
  };
}

function buildLink(url) {
  if (!url) {
    return '<span class="empty-cell">No result found</span>';
  }

  return `<button type="button" class="open-link" data-url="${url}">Open</button>`;
}

async function openUrlInNewTab(url) {
  if (!url) {
    return;
  }

  await chrome.tabs.create({ url, active: true });
}

function updateSavedSearchLabel(ref) {
  if (!ref) {
    lastSearchLabel.textContent = "No saved search yet";
    return;
  }

  lastSearchLabel.textContent = `Last searched ref: ${ref}`;
}

function renderWatcho(watcho) {
  if (!watcho?.found) {
    watchoTitle.textContent = watcho?.reason || "No WATCHO result found";
    watchoPrice.textContent = "-";
    watchoConfidence.textContent = "Confidence: 0%";
    watchoWarning.classList.add("hidden");
    watchoUrl.innerHTML = '<span class="empty-cell">No WATCHO product match found.</span>';
    return;
  }

  watchoTitle.textContent = watcho.title || "WATCHO result";
  watchoPrice.textContent = formatMoney(watcho.price, watcho.currency);
  watchoConfidence.textContent = `Confidence: ${watcho.confidence}%`;
  watchoWarning.classList.toggle("hidden", !watcho.priceNeedsChecking);
  watchoUrl.innerHTML = buildLink(watcho.url);
}

function getSortedCompetitors(data) {
  const watchoPriceValue = data.watcho?.price ?? null;
  const sortMode = sortSelect.value;
  const competitors = [...data.competitors];

  competitors.sort((left, right) => {
    const leftHasPrice = left.found && left.price !== null ? 0 : 1;
    const rightHasPrice = right.found && right.price !== null ? 0 : 1;

    if (leftHasPrice !== rightHasPrice) {
      return leftHasPrice - rightHasPrice;
    }

    if (sortMode === "highest-price") {
      return (right.price ?? Number.NEGATIVE_INFINITY) - (left.price ?? Number.NEGATIVE_INFINITY);
    }

    if (sortMode === "name-az") {
      return left.name.localeCompare(right.name);
    }

    if (sortMode === "confidence") {
      return (right.confidence ?? 0) - (left.confidence ?? 0);
    }

    if (sortMode === "difference") {
      return buildDiffMeta(left.price, watchoPriceValue).value - buildDiffMeta(right.price, watchoPriceValue).value;
    }

    return (left.price ?? Number.POSITIVE_INFINITY) - (right.price ?? Number.POSITIVE_INFINITY);
  });

  return competitors;
}

function renderCompetitors(data) {
  resultsBody.innerHTML = "";

  getSortedCompetitors(data).forEach((competitor) => {
    const row = document.createElement("tr");
    const confidenceMeta = getConfidenceLabel(competitor.confidence || 0);
    const diffMeta = buildDiffMeta(competitor.price, data.watcho.price);
    const blockedByCloudflare = Boolean(competitor.blockedByCloudflare);
    const statusText = competitor.status
      ? competitor.status
      : blockedByCloudflare && !competitor.found
      ? "Open to check"
      : competitor.found
        ? "Found"
        : competitor.reason || "No exact reference match found";
    const priceCell = competitor.found
        ? formatMoney(competitor.price, competitor.currency)
        : blockedByCloudflare
          ? '<span class="empty-cell">Needs page check</span>'
          : '<span class="empty-cell">No result found</span>';
    const statusCell = statusText === "Open to check"
      ? 'Open to check <span class="assist-note">Open product page to capture price</span>'
      : statusText;

    row.innerHTML = `
      <td>${competitor.name}</td>
      <td>${statusCell}</td>
      <td>${priceCell}</td>
      <td>${competitor.found ? `<span class="badge ${diffMeta.className}">${diffMeta.display}</span>` : '<span class="empty-cell">N/A</span>'}</td>
      <td><span class="${confidenceMeta.className}">${confidenceMeta.text}</span></td>
      <td>${buildLink(competitor.url)}</td>
    `;

    resultsBody.appendChild(row);
  });
}

function renderResult(data) {
  currentResult = data;
  updateSavedSearchLabel(data.ref);
  refDisplay.textContent = `Reference: ${data.ref}`;
  lastChecked.textContent = `Last checked: ${formatDate(data.searchedAt)}`;
  renderWatcho(data.watcho);
  renderCompetitors(data);
  resultsSection.classList.remove("hidden");
}

async function saveResults(data) {
  await chrome.storage.local.set({
    [RESULTS_STORAGE_KEY]: data,
    [REF_STORAGE_KEY]: data.ref,
  });
}

async function loadSavedResults() {
  const saved = await chrome.storage.local.get([RESULTS_STORAGE_KEY, REF_STORAGE_KEY]);
  const data = saved[RESULTS_STORAGE_KEY];
  const lastRef = saved[REF_STORAGE_KEY] || data?.ref || "";

  updateSavedSearchLabel(lastRef);
  refInput.value = lastRef;

  if (data) {
    renderResult(data);
  }
}

async function loadSavedSortMode() {
  const saved = await chrome.storage.local.get(SORT_STORAGE_KEY);
  const sortMode = saved[SORT_STORAGE_KEY];

  if (sortMode && [...sortSelect.options].some((option) => option.value === sortMode)) {
    sortSelect.value = sortMode;
  }
}

async function saveSortMode() {
  await chrome.storage.local.set({
    [SORT_STORAGE_KEY]: sortSelect.value,
  });
}

async function clearSavedResult() {
  currentResult = null;
  await chrome.storage.local.remove([
    RESULTS_STORAGE_KEY,
    REF_STORAGE_KEY,
  ]);
  resultsSection.classList.add("hidden");
  updateSavedSearchLabel("");
  refDisplay.textContent = "";
  lastChecked.textContent = "";
  refInput.value = "";
  hideStatus();
}

async function searchRef(ref) {
  showStatus("Searching WATCHO and competitors…", "loading");
  searchButton.disabled = true;
  resultsSection.classList.add("hidden");

  try {
    const response = await fetch(`${API_BASE_URL}/api/compare-watch?ref=${encodeURIComponent(ref)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Search failed.");
    }

    hideStatus();
    renderResult(data);
    await saveResults(data);
  } catch (error) {
    showStatus(error.message || "Unable to complete search.", "error");
  } finally {
    searchButton.disabled = false;
  }
}

sortSelect.addEventListener("change", () => {
  if (currentResult) {
    renderResult(currentResult);
  }
  saveSortMode();
});

clearButton.addEventListener("click", () => {
  clearSavedResult();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const ref = refInput.value.trim();

  if (!ref) {
    showStatus("Enter a watch reference number first.", "error");
    return;
  }

  searchRef(ref);
});

document.addEventListener("click", (event) => {
  const button = event.target.closest(".open-link");

  if (!button) {
    return;
  }

  event.preventDefault();
  openUrlInNewTab(button.dataset.url);
});

Promise.all([loadSavedSortMode(), loadSavedResults()]).then(() => {
  if (currentResult) {
    renderResult(currentResult);
  }
});
