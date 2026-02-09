const CURRENCY_NAMES_API_BASE = "https://api.frankfurter.app"; // for currency names
const LIVE_RATES_API_BASE = "https://open.er-api.com/v6/latest"; // for frequently-updated rates
const TREND_API_BASE = "https://api.frankfurter.app"; // for historical timeseries (ECB)

const form = document.getElementById("converter-form");
const fromSelect = document.getElementById("from-currency");
const toSelect = document.getElementById("to-currency");
const refreshButton = document.getElementById("refresh-btn");
const resultContainer = document.getElementById("result");
const resultValue = resultContainer.querySelector(".value");
const resultMeta = resultContainer.querySelector(".meta");
const rateStatus = document.getElementById("rate-status");
const trendCanvas = document.getElementById("trend-canvas");
const trendSubtitle = document.getElementById("trend-subtitle");
const trendTooltip = document.getElementById("trend-tooltip");
const trendReadout = document.getElementById("trend-readout");
const trendTabs = Array.from(document.querySelectorAll(".tab[data-range]"));

const integerFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0
});
const ratesCacheByBase = new Map(); // base -> { rates, lastUpdateUtc }
let inFlightRatesController = null;
let trendRange = "1m";
const trendCache = new Map(); // key -> { points, start, end, lastDate }
let inFlightTrendController = null;
const chartState = {
  points: [],
  from: null,
  to: null,
  range: "1m",
  selectedIndex: null,
  tooltipPinned: false,
  lastReadout: "Tap and drag the red line to inspect rates.",
  // computed each render
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  dpr: 1,
  x0: 0,
  x1: 1,
  minY: 0,
  maxY: 1
};

function setResult(valueText, metaText, isError = false) {
  resultValue.textContent = valueText;
  resultMeta.textContent = metaText;
  resultMeta.classList.toggle("error", isError);
}

function setStatus(text) {
  rateStatus.textContent = text;
}

function setTrendReadout(text) {
  trendReadout.textContent = text;
}

function formatInt(value) {
  return integerFormatter.format(Math.round(value));
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

function addDays(d, days) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + days);
  return x;
}

function addMonths(d, months) {
  const x = new Date(d.getTime());
  x.setMonth(x.getMonth() + months);
  return x;
}

function addYears(d, years) {
  const x = new Date(d.getTime());
  x.setFullYear(x.getFullYear() + years);
  return x;
}

function buildXTicks(range, startMs, endMs) {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const ticks = [];

  let unit = "month";
  let step = 1;
  let suffix = "M";

  if (range === "1m") {
    unit = "week";
    step = 1;
    suffix = "W";
  } else if (range === "6m") {
    unit = "month";
    step = 1;
    suffix = "M";
  } else if (range === "1y") {
    unit = "month";
    step = 1;
    suffix = "M";
  } else if (range === "5y") {
    unit = "year";
    step = 1;
    suffix = "Y";
  } else if (range === "10y") {
    unit = "year";
    step = 1;
    suffix = "Y";
  } else {
    unit = "year";
    step = 5;
    suffix = "Y";
  }

  let i = 1;
  let t = start;
  while (true) {
    if (unit === "week") t = addDays(start, 7 * step * i);
    else if (unit === "month") t = addMonths(start, step * i);
    else t = addYears(start, step * i);

    const ms = t.getTime();
    if (ms >= end.getTime()) break;
    ticks.push({ x: ms, label: `${step * i}${suffix}` });
    i++;
    if (i > 300) break;
  }

  return ticks;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function findNearestPointIndex(points, tMs) {
  // points are sorted by x asc
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].x < tMs) lo = mid + 1;
    else hi = mid;
  }
  const i = lo;
  if (i <= 0) return 0;
  if (i >= points.length) return points.length - 1;
  const a = points[i - 1];
  const b = points[i];
  return (tMs - a.x) <= (b.x - tMs) ? (i - 1) : i;
}

function timeFromCanvasX(xCss) {
  const leftCss = chartState.left / chartState.dpr;
  const rightCss = chartState.right / chartState.dpr;
  const xClamped = clamp(xCss, leftCss, rightCss);
  const frac = (xClamped - leftCss) / Math.max(1e-6, (rightCss - leftCss));
  return chartState.x0 + frac * (chartState.x1 - chartState.x0);
}

function canvasXForTime(tMs) {
  const frac = (tMs - chartState.x0) / Math.max(1, (chartState.x1 - chartState.x0));
  const x = chartState.left + frac * (chartState.right - chartState.left);
  return x / chartState.dpr;
}

function renderTooltipForSelection() {
  if (!chartState.points.length || chartState.selectedIndex == null) {
    trendTooltip.hidden = true;
    return;
  }
  const p = chartState.points[chartState.selectedIndex];
  const from = chartState.from || fromSelect.value;
  const to = chartState.to || toSelect.value;

  trendTooltip.innerHTML = `<div><b>${p.date}</b></div><div>1 ${from} = ${formatInt(p.y)} ${to}</div>`;
  trendTooltip.hidden = false;

  const wrap = trendCanvas.parentElement;
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();

  // position near the red line, but keep it within the chart box
  const xCss = canvasXForTime(p.x);
  const tipRect = trendTooltip.getBoundingClientRect();
  const pad = 10;
  const left = clamp(xCss - tipRect.width / 2, pad, wrapRect.width - tipRect.width - pad);
  trendTooltip.style.left = `${left}px`;
  trendTooltip.style.top = `${pad}px`;

  setTrendReadout(`Selected: ${p.date} | 1 ${from} = ${formatInt(p.y)} ${to}`);
}

function drawLineChart(canvas, points, opts) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const ratio = rect.width < 520 ? 0.78 : 0.52;
  const h = Math.max(1, Math.floor(Math.max(320, rect.width * ratio) * dpr));
  canvas.width = w;
  canvas.height = h;

  ctx.clearRect(0, 0, w, h);

  const pad = Math.floor(18 * dpr);
  const labelPad = Math.floor(22 * dpr);
  const left = pad;
  const top = pad;
  const right = w - pad;
  const bottom = h - pad - labelPad;

  chartState.left = left;
  chartState.top = top;
  chartState.right = right;
  chartState.bottom = bottom;
  chartState.dpr = dpr;

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

  chartState.x0 = x0;
  chartState.x1 = x1;
  chartState.minY = minY;
  chartState.maxY = maxY;

  // Vertical grid + x labels (relative time)
  const ticks = buildXTicks(opts.range, x0, x1);
  ctx.strokeStyle = "#dfe7e3";
  ctx.lineWidth = Math.max(1, Math.floor(1 * dpr));
  ctx.globalAlpha = 0.95;
  for (const tick of ticks) {
    const x = xScale(tick.x);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = "#54605c";
    ctx.font = `${Math.floor(12 * dpr)}px Space Grotesk, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(tick.label, x, bottom + Math.floor(6 * dpr));
    ctx.globalAlpha = 0.95;
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

  // Selection line (red) + marker
  const idx = chartState.selectedIndex ?? (points.length - 1);
  const p = points[Math.min(points.length - 1, Math.max(0, idx))];
  const sx = xScale(p.x);
  const sy = yScale(p.y);

  ctx.strokeStyle = "rgba(255, 58, 58, 0.9)";
  ctx.lineWidth = Math.max(2, Math.floor(2 * dpr));
  ctx.beginPath();
  ctx.moveTo(sx, top);
  ctx.lineTo(sx, bottom);
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 58, 58, 0.95)";
  ctx.beginPath();
  ctx.arc(sx, sy, Math.max(4, Math.floor(4 * dpr)), 0, Math.PI * 2);
  ctx.fill();
}

function selectByCanvasEvent(ev) {
  if (!chartState.points.length) return;
  const rect = trendCanvas.getBoundingClientRect();
  const xCss = ev.clientX - rect.left;
  const tMs = timeFromCanvasX(xCss);
  const idx = findNearestPointIndex(chartState.points, tMs);
  chartState.selectedIndex = idx;
  drawLineChart(trendCanvas, chartState.points, { quote: chartState.to || toSelect.value, range: trendRange });
  renderTooltipForSelection();
}

function hideTrendTooltip() {
  chartState.tooltipPinned = false;
  trendTooltip.hidden = true;
  setTrendReadout(chartState.lastReadout);
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
    chartState.lastReadout = "Trend not applicable.";
    setTrendReadout(chartState.lastReadout);
    chartState.points = [];
    chartState.from = from;
    chartState.to = to;
    chartState.range = trendRange;
    chartState.selectedIndex = null;
    trendTooltip.hidden = true;
    drawLineChart(trendCanvas, [], { quote: to, range: trendRange });
    return;
  }

  setTrendReadout("Loading trend…");
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
    chartState.points = series.points;
    chartState.from = from;
    chartState.to = to;
    chartState.range = trendRange;
    chartState.selectedIndex = series.points.length ? (series.points.length - 1) : null;
    chartState.tooltipPinned = false;
    trendTooltip.hidden = true;

    drawLineChart(trendCanvas, series.points, { quote: to, range: trendRange });
    const last = series.points.length ? series.points[series.points.length - 1] : null;
    if (last) {
      chartState.lastReadout = `Last: ${last.date} | 1 ${from} = ${formatInt(last.y)} ${to}`;
      setTrendReadout(chartState.lastReadout);
      trendSubtitle.textContent = `1 ${from} in ${to} (${trendRange.toUpperCase()}) | Last: ${series.lastDate || "-"}`;
    } else {
      chartState.lastReadout = "No trend data available for this pair.";
      setTrendReadout(chartState.lastReadout);
    }
  } catch (error) {
    chartState.lastReadout = "Trend unavailable right now.";
    setTrendReadout(chartState.lastReadout);
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
  const { from, to } = getSelectedCodes();

  if (!from || !to) {
    setResult("-", "Choose both source and target currencies.", true);
    setStatus("Choose currencies.");
    return;
  }

  if (from === to) {
    setResult(
      `1 ${to}`,
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
  const converted = 1 * rate;

  setResult(
    `${formatInt(converted)} ${to}`,
    `1 ${from} = ${formatInt(rate)} ${to}${lastUpdateUtc ? ` | Updated: ${lastUpdateUtc}` : ""}`
  );
  setStatus(lastUpdateUtc ? `Live rate updated: ${lastUpdateUtc}` : "Live rate loaded.");
}

form.addEventListener("submit", (event) => {
  // Form submit isn't used (no "Convert" button). Keep this to prevent accidental submits.
  event.preventDefault();
});

refreshButton.addEventListener("click", () => {
  void safeConvert(true);
  void updateTrend(true);
});

fromSelect.addEventListener("change", () => {
  hideTrendTooltip();
  void safeConvert(false);
  void updateTrend(false);
});
toSelect.addEventListener("change", () => {
  hideTrendTooltip();
  void safeConvert(false);
  void updateTrend(false);
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
        hideTrendTooltip();
        void updateTrend(false);
      });
    });
    window.addEventListener("resize", () => {
      // Re-render only; avoid refetch on resize.
      drawLineChart(trendCanvas, chartState.points, { quote: chartState.to || toSelect.value, range: trendRange });
      if (!trendTooltip.hidden) {
        renderTooltipForSelection();
      }
    });

    trendCanvas.addEventListener("pointerdown", (ev) => {
      if (!chartState.points.length) return;
      ev.preventDefault();
      chartState.tooltipPinned = true;
      try {
        trendCanvas.setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      selectByCanvasEvent(ev);
    });

    trendCanvas.addEventListener("pointermove", (ev) => {
      if (!chartState.tooltipPinned) return;
      if (!chartState.points.length) return;
      // While dragging (or after tap), keep updating selection as the pointer moves.
      selectByCanvasEvent(ev);
    });

    trendCanvas.addEventListener("pointerup", (ev) => {
      try {
        trendCanvas.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
    });

    document.addEventListener("pointerdown", (ev) => {
      if (!chartState.tooltipPinned) return;
      const wrap = trendCanvas.parentElement;
      if (wrap && wrap.contains(ev.target)) return;
      hideTrendTooltip();
    });

    await updateTrend(false);
  } catch (error) {
    setResult("-", "Could not load currency list. Refresh and retry.", true);
    setStatus("Failed to initialize.");
  }
}

init();
