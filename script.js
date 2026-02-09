const API_BASE = "https://api.frankfurter.app";

const form = document.getElementById("converter-form");
const amountInput = document.getElementById("amount");
const fromSelect = document.getElementById("from-currency");
const toSelect = document.getElementById("to-currency");
const swapButton = document.getElementById("swap-btn");
const resultContainer = document.getElementById("result");
const resultValue = resultContainer.querySelector(".value");
const resultMeta = resultContainer.querySelector(".meta");

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 6
});
let inputDebounceTimer = null;

function setResult(valueText, metaText, isError = false) {
  resultValue.textContent = valueText;
  resultMeta.textContent = metaText;
  resultMeta.classList.toggle("error", isError);
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
  const response = await fetch(`${API_BASE}/currencies`);
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

async function convertCurrency() {
  const amount = Number(amountInput.value);
  if (Number.isNaN(amount) || amount < 0) {
    setResult("-", "Enter a valid non-negative amount.", true);
    return;
  }

  const { from, to } = getSelectedCodes();

  if (!from || !to) {
    setResult("-", "Choose both source and target currencies.", true);
    return;
  }

  if (from === to) {
    setResult(
      `${formatAmount(amount)} ${to}`,
      `1 ${from} = 1 ${to}`
    );
    return;
  }

  setResult("...", "Fetching the latest rate...");

  const url = `${API_BASE}/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Failed to fetch exchange rate.");
  }

  const payload = await response.json();
  const rate = payload.rates[to];
  const converted = amount * rate;

  setResult(
    `${formatAmount(converted)} ${to}`,
    `1 ${from} = ${formatAmount(rate)} ${to} | Date: ${payload.date}`
  );
}

function swapCurrencies() {
  const currentFrom = fromSelect.value;
  fromSelect.value = toSelect.value;
  toSelect.value = currentFrom;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await convertCurrency();
  } catch (error) {
    setResult("-", "Could not convert right now. Try again.", true);
  }
});

swapButton.addEventListener("click", () => {
  swapCurrencies();
  form.requestSubmit();
});

fromSelect.addEventListener("change", () => form.requestSubmit());
toSelect.addEventListener("change", () => form.requestSubmit());
amountInput.addEventListener("input", () => {
  window.clearTimeout(inputDebounceTimer);
  inputDebounceTimer = window.setTimeout(() => {
    form.requestSubmit();
  }, 250);
});

async function init() {
  try {
    await loadCurrencies();
    await convertCurrency();
  } catch (error) {
    setResult("-", "Could not load currency list. Refresh and retry.", true);
  }
}

init();
