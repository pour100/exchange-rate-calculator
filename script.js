const CURRENCY_NAMES_API_BASE = "https://api.frankfurter.app"; // for currency names
const LIVE_RATES_API_BASE = "https://open.er-api.com/v6/latest"; // for frequently-updated rates
const TREND_API_BASE = "https://api.frankfurter.app"; // for historical timeseries (ECB)

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
const trendCanvas = document.getElementById("trend-canvas");
const trendHint = document.getElementById("trend-hint");
const trendSubtitle = document.getElementById("trend-subtitle");
const trendTabs = Array.from(document.querySelectorAll(".tab[data-range]"));

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 6
});
let inputDebounceTimer = null;
const ratesCacheByBase = new Map(); // base -> { rates, lastUpdateUtc }
let inFlightRatesController = null;
let trendRange = "1m";
const trendCache = new Map(); // key -> { points, start, end, lastDate }
let inFlightTrendController = null;

function setResult(valueText, metaText, isError = false) {
  resultValue.textContent = valueText;
  resultMeta.textContent = metaText;
  resultMeta.classList.toggle("error", isError);
}

function setStatus(text) {
  rateStatus.textContent = text;
}

function setTrendHint(text) {
  trendHint.textContent = text;
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

function toYMD(date) {
  return date.toISOString().slice(0, 10);
}

function computeTrendStart(range, now) {
  const d = new Date(now.getTime());
  if (range === "1m") {
    d.setMonth(d.getMonth() - 1);
    return d;
  }
  if (range === "6m") {
    d.setMonth(d.getMonth() - 6);
    return d;
  }
  if (range === "1y") {
    d.setFullYear(d.getFullYear() - 1);
    return d;
  }
  if (range === "5y") {
    d.setFullYear(d.getFullYear() - 5);
    return d;
  }
  if (range === "10y") {
    d.setFullYear(d.getFullYear() - 10);
    return d;
  }
  // ECB series commonly starts in 1999; use an early date as "unlimited".
  return new Date("1999-01-04T00:00:00.000Z");
}

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += step) {
    out.push(points[i]);
  }
  // Ensure last point is present for the "latest" read.
  if (out[out.length - 1] !== points[points.length - 1]) {
    out.push(points[points.length - 1]);
  }
  return out;
}

function drawLineChart(canvas, points, opts) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor((rect.width * 0.36) * dpr));
  canvas.width = w;
  canvas.height = h;

  ctx.clearRect(0, 0, w, h);

  const pad = Math.floor(18 * dpr);
  const left = pad;
  const top = pad;
  const right = w - pad;
  const bottom = h - pad;

  if (!points.length) {
    ctx.fillStyle = "#54605c";
    ctx.font = `${Math.floor(14 * dpr)}px Space Grotesk, sans-serif`;
    ctx.fillText("No trend data.", left, top + Math.floor(22 * dpr));
    return;
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (minY === maxY) {
    minY = minY * 0.995;
    maxY = maxY * 1.005;
  }

  const rangeY = maxY - minY;
  const x0 = points[0].x;
  const x1 = points[points.length - 1].x;
  const rangeX = Math.max(1, x1 - x0);

  const xScale = (t) => left + ((t - x0) / rangeX) * (right - left);
  const yScale = (v) => bottom - ((v - minY) / rangeY) * (bottom - top);

  // Grid
  ctx.strokeStyle = "#dfe7e3";
  ctx.lineWidth = Math.max(1, Math.floor(1 * dpr));
  ctx.globalAlpha = 0.9;
  for (let i = 0; i <= 4; i++) {
    const y = top + ((bottom - top) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Area fill
  const grad = ctx.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, "rgba(46, 67, 255, 0.18)");
  grad.addColorStop(1, "rgba(0, 194, 168, 0.02)");

  ctx.beginPath();
  ctx.moveTo(xScale(points[0].x), yScale(points[0].y));
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(xScale(points[i].x), yScale(points[i].y));
  }
  ctx.lineTo(xScale(points[points.length - 1].x), bottom);
  ctx.lineTo(xScale(points[0].x), bottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(xScale(points[0].x), yScale(points[0].y));
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(xScale(points[i].x), yScale(points[i].y));
  }
  ctx.strokeStyle = "rgba(13, 20, 18, 0.9)";
  ctx.lineWidth = Math.max(2, Math.floor(2 * dpr));
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // End marker
  const last = points[points.length - 1];
  const lx = xScale(last.x);
  const ly = yScale(last.y);
  ctx.fillStyle = "rgba(255, 107, 53, 0.95)";
  ctx.beginPath();
  ctx.arc(lx, ly, Math.max(4, Math.floor(4 * dpr)), 0, Math.PI * 2);
  ctx.fill();

  // Labels (min/max)
  ctx.fillStyle = "#54605c";
  ctx.font = `${Math.floor(12 * dpr)}px Space Grotesk, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(`${opts.quote}: ${formatAmount(maxY)}`, left, top);
  ctx.textBaseline = "bottom";
  ctx.fillText(`${formatAmount(minY)}`, left, bottom);
}

async function fetchTrendSeries(base, quote, range) {
  const now = new Date();
  const start = computeTrendStart(range, now);
  const end = now;

  const startYmd = toYMD(start);
  const endYmd = toYMD(end);
  const key = `${base}:${quote}:${range}:${startYmd}:${endYmd}`;
  const cached = trendCache.get(key);
  if (cached) return cached;

  if (inFlightTrendController) {
    inFlightTrendController.abort();
  }
  inFlightTrendController = new AbortController();

  const url =
    `${TREND_API_BASE}/${encodeURIComponent(startYmd)}..${encodeURIComponent(endYmd)}` +
    `?from=${encodeURIComponent(base)}&to=${encodeURIComponent(quote)}`;

  const response = await fetch(url, { signal: inFlightTrendController.signal });
  if (!response.ok) {
    throw new Error("Failed to fetch trend series.");
  }

  const payload = await response.json();
  const rateByDate = payload.rates || {};
  const points = [];
  const dates = Object.keys(rateByDate).sort();
  for (const d of dates) {
    const v = rateByDate[d]?.[quote];
    if (typeof v === "number") {
      points.push({ x: Date.parse(d), y: v, date: d });
    }
  }

  const sampled = downsample(points, 320);
  const lastDate = points.length ? points[points.length - 1].date : null;
  const entry = { points: sampled, start: startYmd, end: endYmd, lastDate };
  trendCache.set(key, entry);
  return entry;
}

async function updateTrend(force = false) {
  const { from, to } = getSelectedCodes();
  if (!from || !to) return;

  if (from === to) {
    trendSubtitle.textContent = "Same currency selected.";
    setTrendHint("Trend not applicable.");
    drawLineChart(trendCanvas, [], { quote: to });
    return;
  }

  setTrendHint("Loading trend…");
  trendSubtitle.textContent = `1 ${from} in ${to} (${trendRange.toUpperCase()})`;

  try {
    if (force) {
      // Clear cache entries for this pair/range quickly by recreating map
      for (const k of trendCache.keys()) {
        if (k.startsWith(`${from}:${to}:${trendRange}:`)) {
          trendCache.delete(k);
        }
      }
    }
    const series = await fetchTrendSeries(from, to, trendRange);
    drawLineChart(trendCanvas, series.points, { quote: to });
    const last = series.points.length ? series.points[series.points.length - 1] : null;
    if (last) {
      setTrendHint(`Last: ${last.date} | 1 ${from} = ${formatAmount(last.y)} ${to}`);
      trendSubtitle.textContent = `1 ${from} in ${to} (${trendRange.toUpperCase()}) | Last: ${series.lastDate || "-"}`;
    } else {
      setTrendHint("No trend data available for this pair.");
    }
  } catch (error) {
    setTrendHint("Trend unavailable right now.");
  }
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
  void updateTrend(false);
});

refreshButton.addEventListener("click", () => {
  void safeConvert(true);
  void updateTrend(true);
});

fromSelect.addEventListener("change", () => {
  void safeConvert(false);
  void updateTrend(false);
});
toSelect.addEventListener("change", () => {
  void safeConvert(false);
  void updateTrend(false);
});
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
    trendTabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.getAttribute("data-range");
        if (!next || next === trendRange) return;
        trendRange = next;
        for (const t of trendTabs) {
          const active = t === btn;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        }
        void updateTrend(false);
      });
    });
    window.addEventListener("resize", () => void updateTrend(false));
    await updateTrend(false);
  } catch (error) {
    setResult("-", "Could not load currency list. Refresh and retry.", true);
    setStatus("Failed to initialize.");
  }
}

init();
