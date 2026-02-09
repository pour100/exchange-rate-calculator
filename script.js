const CURRENCY_NAMES_API_BASE = "https://api.frankfurter.app"; // for currency names
const LIVE_RATES_API_BASE = "https://open.er-api.com/v6/latest"; // for frequently-updated rates

const form = document.getElementById("converter-form");
const amountInput = document.getElementById("amount");
const fromSelect = document.getElementById("from-currency");
const toSelect = document.getElementById("to-currency");
const swapButton = document.getElementById("swap-btn");
const refreshButton = document.getElementById("refresh-btn");
const resultContainer = document.getElementById("result");
const resultValue = resultContainer.querySelector(".value");
const resultMeta = resultContainer.querySelector(".meta");
const rateStatus = document.getElementById("rate-status");

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 6
});
let inputDebounceTimer = null;
const ratesCacheByBase = new Map(); // base -> { rates, lastUpdateUtc }
let inFlightRatesController = null;

function setResult(valueText, metaText, isError = false) {
  resultValue.textContent = valueText;
  resultMeta.textContent = metaText;
  resultMeta.classList.toggle("error", isError);
}

function setStatus(text) {
  rateStatus.textContent = text;
}

function formatAmount(value) {
  return numberFormatter.format(value);
}

function getSelectedCodes() {
  return {
    from: fromSelect.value,
    to: toSelect.value
  };
}

function buildCurrencyOption(code, name) {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = `${code} - ${name}`;
  return option;
}

async function loadCurrencies() {
  const response = await fetch(`${CURRENCY_NAMES_API_BASE}/currencies`);
  if (!response.ok) {
    throw new Error("Failed to load currencies.");
  }

  const currencies = await response.json();
  const entries = Object.entries(currencies).sort(([a], [b]) => a.localeCompare(b));

  const fromFragment = document.createDocumentFragment();
  const toFragment = document.createDocumentFragment();

  for (const [code, name] of entries) {
    fromFragment.appendChild(buildCurrencyOption(code, name));
    toFragment.appendChild(buildCurrencyOption(code, name));
  }

  fromSelect.appendChild(fromFragment);
  toSelect.appendChild(toFragment);

  fromSelect.value = "USD";
  toSelect.value = "KRW";
}

async function fetchLiveRatesForBase(base) {
  if (!base) {
    throw new Error("Missing base currency.");
  }

  const cached = ratesCacheByBase.get(base);
  if (cached) {
    return cached;
  }

  if (inFlightRatesController) {
    inFlightRatesController.abort();
  }
  inFlightRatesController = new AbortController();

  const url = `${LIVE_RATES_API_BASE}/${encodeURIComponent(base)}`;
  const response = await fetch(url, { signal: inFlightRatesController.signal });
  if (!response.ok) {
    throw new Error("Failed to fetch live rates.");
  }

  const payload = await response.json();
  if (payload.result !== "success" || !payload.rates) {
    throw new Error("Live rates API returned an unexpected response.");
  }

  const entry = {
    rates: payload.rates,
    lastUpdateUtc: payload.time_last_update_utc || null
  };
  ratesCacheByBase.set(base, entry);
  return entry;
}

function getCachedRate(base, quote) {
  const cached = ratesCacheByBase.get(base);
  if (!cached) return null;
  const rate = cached.rates?.[quote];
  if (typeof rate !== "number") return null;
  return { rate, lastUpdateUtc: cached.lastUpdateUtc };
}

async function ensureRate(base, quote, forceRefresh = false) {
  if (forceRefresh) {
    ratesCacheByBase.delete(base);
  }
  const cached = getCachedRate(base, quote);
  if (cached) return cached;

  const entry = await fetchLiveRatesForBase(base);
  const rate = entry.rates?.[quote];
  if (typeof rate !== "number") {
    throw new Error(`Rate not available for ${base} -> ${quote}.`);
  }
  return { rate, lastUpdateUtc: entry.lastUpdateUtc };
}

async function convertCurrency(forceRefreshRate = false) {
  const amount = Number(amountInput.value);
  if (Number.isNaN(amount) || amount < 0) {
    setResult("-", "Enter a valid non-negative amount.", true);
    setStatus("Fix the amount to continue.");
    return;
  }

  const { from, to } = getSelectedCodes();

  if (!from || !to) {
    setResult("-", "Choose both source and target currencies.", true);
    setStatus("Choose currencies.");
    return;
  }

  if (from === to) {
    setResult(
      `${formatAmount(amount)} ${to}`,
      `1 ${from} = 1 ${to}`
    );
    setStatus("Same currency selected.");
    return;
  }

  if (forceRefreshRate) {
    setStatus("Refreshing live rate…");
  } else {
    setStatus("Using latest cached rate…");
  }
  setResult("...", "Calculating…");

  const { rate, lastUpdateUtc } = await ensureRate(from, to, forceRefreshRate);
  const converted = amount * rate;

  setResult(
    `${formatAmount(converted)} ${to}`,
    `1 ${from} = ${formatAmount(rate)} ${to}${lastUpdateUtc ? ` | Updated: ${lastUpdateUtc}` : ""}`
  );
  setStatus(lastUpdateUtc ? `Live rate updated: ${lastUpdateUtc}` : "Live rate loaded.");
}

function swapCurrencies() {
  const currentFrom = fromSelect.value;
  fromSelect.value = toSelect.value;
  toSelect.value = currentFrom;
}

form.addEventListener("submit", (event) => {
  // Form submit isn't used (no "Convert" button). Keep this to prevent accidental submits.
  event.preventDefault();
});

swapButton.addEventListener("click", () => {
  swapCurrencies();
  void safeConvert(false);
});

refreshButton.addEventListener("click", () => {
  void safeConvert(true);
});

fromSelect.addEventListener("change", () => void safeConvert(false));
toSelect.addEventListener("change", () => void safeConvert(false));
amountInput.addEventListener("input", () => {
  window.clearTimeout(inputDebounceTimer);
  inputDebounceTimer = window.setTimeout(() => {
    void safeConvert(false);
  }, 250);
});

async function safeConvert(forceRefreshRate) {
  try {
    await convertCurrency(forceRefreshRate);
  } catch (error) {
    setResult("-", "Could not convert right now. Try again.", true);
    setStatus("Rate fetch failed. Try Refresh Rate.");
  }
}

async function init() {
  try {
    setStatus("Loading currencies…");
    await loadCurrencies();
    setStatus("Loading live rate…");
    await safeConvert(true);
  } catch (error) {
    setResult("-", "Could not load currency list. Refresh and retry.", true);
    setStatus("Failed to initialize.");
  }
}

init();
