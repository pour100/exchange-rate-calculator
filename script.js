const CURRENCY_NAMES_API_BASE = "https://api.frankfurter.app"; // currency names (Frankfurter)
const LIVE_RATES_API_BASE = "https://open.er-api.com/v6/latest"; // frequently updated live rates
const TREND_API_BASE = "https://api.frankfurter.app"; // historical series (Frankfurter / ECB)
const DISPLAY_TZ = "Asia/Seoul";

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

const appTitle = document.getElementById("app-title");
const labelFrom = document.getElementById("label-from");
const labelTo = document.getElementById("label-to");
const trendTitle = document.getElementById("trend-title");
const resultMetaEl = document.getElementById("result-meta");
const musicButton = document.getElementById("music-btn");
const langButtons = Array.from(document.querySelectorAll(".seg-btn[data-lang]"));
const themeButtons = Array.from(document.querySelectorAll(".seg-btn[data-theme]"));

const integerFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

let currentLang = "ko";
let currentTheme = "bright";
let trendRange = "1m";

const ratesCacheByBase = new Map(); // base -> { rates, lastUpdateUtc }
let inFlightRatesController = null;

const trendCache = new Map(); // key -> { points, startYmd, endYmd, lastDateYmd }
let inFlightTrendController = null;

let audio = null;
let bgmAutoplayAttempted = false;

const chartState = {
  points: [],
  from: null,
  to: null,
  range: "1m",
  selectedIndex: null,
  tooltipPinned: false,
  lastReadout: "",
  // derived each draw
  dpr: 1,
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  x0: 0,
  x1: 1
};

const I18N = {
  ko: {
    title: "우식의 실시간 환율 변환기",
    from: "From",
    to: "To",
    refresh: "환율 새로고침",
    resultMeta: "통화를 선택하면 환율이 표시됩니다.",
    trend: "Trend",
    trendHelp: "빨간선을 터치하고 드래그하면 해당 시점 환율이 표시됩니다.",
    loadingCurrencies: "통화 목록 불러오는 중…",
    loadingLive: "실시간 환율 불러오는 중…",
    liveLoaded: "실시간 환율 로드 완료",
    updated: "업데이트",
    sameCurrency: "같은 통화입니다.",
    chooseCurrencies: "통화를 선택하세요.",
    calcFailed: "환율을 가져오지 못했습니다. 새로고침을 눌러주세요.",
    trendLoading: "트렌드 불러오는 중…",
    trendNA: "트렌드를 표시할 수 없습니다.",
    trendUnavailable: "트렌드를 가져오지 못했습니다.",
    trendNone: "트렌드 데이터가 없습니다.",
    selected: "선택"
  },
  en: {
    title: "Woosik Live FX Converter",
    from: "From",
    to: "To",
    refresh: "Refresh Rate",
    resultMeta: "Select currencies to see the rate.",
    trend: "Trend",
    trendHelp: "Tap and drag the red line to inspect rates.",
    loadingCurrencies: "Loading currencies…",
    loadingLive: "Loading live rate…",
    liveLoaded: "Live rate loaded.",
    updated: "Updated",
    sameCurrency: "Same currency selected.",
    chooseCurrencies: "Choose currencies.",
    calcFailed: "Rate fetch failed. Use Refresh Rate.",
    trendLoading: "Loading trend…",
    trendNA: "Trend not applicable.",
    trendUnavailable: "Trend unavailable right now.",
    trendNone: "No trend data available for this pair.",
    selected: "Selected"
  }
};

function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || (I18N.en && I18N.en[key]) || key;
}

function formatInt(value) {
  return integerFormatter.format(Math.round(value));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function formatSeoulDateTime(date) {
  const fmt = new Intl.DateTimeFormat("ko-KR", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function parseUpdateUtc(utcString) {
  const ms = Date.parse(utcString);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

function ymdInTimeZone(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  // en-CA yields YYYY-MM-DD
  return fmt.format(date);
}

function getSelectedCodes() {
  return { from: fromSelect.value, to: toSelect.value };
}

function setResult(valueText, metaText, isError = false) {
  resultValue.textContent = valueText;
  resultMeta.textContent = metaText;
  resultMeta.classList.toggle("error", isError);
}

function setStatus(text) {
  rateStatus.textContent = text;
}

function setTrendReadout(text) {
  chartState.lastReadout = text;
  trendReadout.textContent = text;
}

async function loadCurrencies() {
  const response = await fetch(`${CURRENCY_NAMES_API_BASE}/currencies`);
  if (!response.ok) throw new Error("Failed to load currencies.");

  const currencies = await response.json();
  const entries = Object.entries(currencies).sort(([a], [b]) => a.localeCompare(b));

  const fromFrag = document.createDocumentFragment();
  const toFrag = document.createDocumentFragment();
  for (const [code, name] of entries) {
    const opt1 = document.createElement("option");
    opt1.value = code;
    opt1.textContent = `${code} - ${name}`;
    fromFrag.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = code;
    opt2.textContent = `${code} - ${name}`;
    toFrag.appendChild(opt2);
  }
  fromSelect.appendChild(fromFrag);
  toSelect.appendChild(toFrag);

  fromSelect.value = "USD";
  toSelect.value = "KRW";
}

async function fetchLiveRatesForBase(base) {
  const cached = ratesCacheByBase.get(base);
  if (cached) return cached;

  if (inFlightRatesController) inFlightRatesController.abort();
  inFlightRatesController = new AbortController();

  const response = await fetch(`${LIVE_RATES_API_BASE}/${encodeURIComponent(base)}`, {
    signal: inFlightRatesController.signal
  });
  if (!response.ok) throw new Error("Failed to fetch live rates.");

  const payload = await response.json();
  if (payload.result !== "success" || !payload.rates) throw new Error("Bad live rates response.");

  const entry = { rates: payload.rates, lastUpdateUtc: payload.time_last_update_utc || null };
  ratesCacheByBase.set(base, entry);
  return entry;
}

async function ensureRate(base, quote, forceRefresh = false) {
  if (forceRefresh) ratesCacheByBase.delete(base);
  const cached = ratesCacheByBase.get(base);
  if (cached && typeof cached.rates?.[quote] === "number") {
    return { rate: cached.rates[quote], lastUpdateUtc: cached.lastUpdateUtc };
  }
  const entry = await fetchLiveRatesForBase(base);
  const rate = entry.rates?.[quote];
  if (typeof rate !== "number") throw new Error("Rate missing.");
  return { rate, lastUpdateUtc: entry.lastUpdateUtc };
}

async function convertCurrency(forceRefreshRate = false) {
  const { from, to } = getSelectedCodes();

  if (!from || !to) {
    setResult("-", t("chooseCurrencies"), true);
    setStatus(t("chooseCurrencies"));
    return;
  }

  if (from === to) {
    setResult(`1 ${to}`, `1 ${from} = 1 ${to}`);
    setStatus(t("sameCurrency"));
    return;
  }

  setStatus(t("loadingLive"));
  setResult("…", "…");

  const { rate, lastUpdateUtc } = await ensureRate(from, to, forceRefreshRate);
  const updated = lastUpdateUtc ? parseUpdateUtc(lastUpdateUtc) : null;
  const updatedKst = updated ? formatSeoulDateTime(updated) : null;

  setResult(`${formatInt(rate)} ${to}`, `1 ${from} = ${formatInt(rate)} ${to}${updatedKst ? ` | ${t("updated")}: ${updatedKst}` : ""}`);
  setStatus(updatedKst ? `${t("updated")}: ${updatedKst}` : t("liveLoaded"));
}

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

function computeTrendStartYmd(endYmd, range) {
  // Treat YYYY-MM-DD as UTC midnight for date arithmetic (we only need the date component).
  const d = new Date(`${endYmd}T00:00:00.000Z`);
  if (range === "1m") d.setMonth(d.getMonth() - 1);
  else if (range === "6m") d.setMonth(d.getMonth() - 6);
  else if (range === "1y") d.setFullYear(d.getFullYear() - 1);
  else if (range === "5y") d.setFullYear(d.getFullYear() - 5);
  else if (range === "10y") d.setFullYear(d.getFullYear() - 10);
  else return "1999-01-04";
  return d.toISOString().slice(0, 10);
}

async function fetchTrendSeries(base, quote, range) {
  const now = new Date();
  const endYmd = ymdInTimeZone(now, DISPLAY_TZ);
  const startYmd = computeTrendStartYmd(endYmd, range);
  const key = `${base}:${quote}:${range}:${startYmd}:${endYmd}`;

  const cached = trendCache.get(key);
  if (cached) return cached;

  if (inFlightTrendController) inFlightTrendController.abort();
  inFlightTrendController = new AbortController();

  const url =
    `${TREND_API_BASE}/${encodeURIComponent(startYmd)}..${encodeURIComponent(endYmd)}` +
    `?from=${encodeURIComponent(base)}&to=${encodeURIComponent(quote)}`;

  const response = await fetch(url, { signal: inFlightTrendController.signal });
  if (!response.ok) throw new Error("Failed to fetch trend series.");

  const payload = await response.json();
  const rateByDate = payload.rates || {};
  const dates = Object.keys(rateByDate).sort();

  const points = [];
  for (const d of dates) {
    const v = rateByDate[d]?.[quote];
    if (typeof v === "number") points.push({ x: Date.parse(d), y: v, date: d });
  }

  // Ensure series reaches "today" with latest live rate (even if ECB series lags).
  try {
    const { rate, lastUpdateUtc } = await ensureRate(base, quote, false);
    const lastDateYmd = points.length ? points[points.length - 1].date : null;
    if (lastDateYmd !== endYmd) {
      points.push({
        x: Date.parse(endYmd),
        y: rate,
        date: endYmd,
        liveUpdatedUtc: lastUpdateUtc || null
      });
    }
  } catch {
    // ignore
  }

  const sampled = downsample(points, 360);
  const lastDateYmd = points.length ? points[points.length - 1].date : null;
  const entry = { points: sampled, startYmd, endYmd, lastDateYmd };
  trendCache.set(key, entry);
  return entry;
}

function getTickSpec(range, startMs, endMs) {
  if (range === "1m") return { total: 4, step: 1, suffix: "W" };
  if (range === "6m") return { total: 6, step: 1, suffix: "M" };
  if (range === "1y") return { total: 12, step: 1, suffix: "M" };
  if (range === "5y") return { total: 5, step: 1, suffix: "Y" };
  if (range === "10y") return { total: 10, step: 1, suffix: "Y" };

  const start = new Date(startMs);
  const end = new Date(endMs);
  const totalYears = Math.max(1, end.getUTCFullYear() - start.getUTCFullYear());
  const step = 5;
  return { total: totalYears, step, suffix: "Y" };
}

function buildXTicks(range, startMs, endMs) {
  const { total, step, suffix } = getTickSpec(range, startMs, endMs);
  const ticks = [];
  for (let i = 0; i <= total; i += step) {
    const frac = total === 0 ? 0 : (i / total);
    const x = startMs + frac * (endMs - startMs);
    ticks.push({ x, label: `${i}${suffix}` });
  }
  // Ensure the end label exists even when total isn't divisible by step
  if (ticks.length === 0 || ticks[ticks.length - 1].label !== `${total}${suffix}`) {
    ticks.push({ x: endMs, label: `${total}${suffix}` });
  } else {
    ticks[ticks.length - 1].x = endMs;
  }
  // Ensure 0 label exists at start
  if (ticks[0].label !== `0${suffix}`) {
    ticks.unshift({ x: startMs, label: `0${suffix}` });
  } else {
    ticks[0].x = startMs;
  }
  return ticks;
}

function drawLineChart(canvas, points, opts) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const ratio = rect.width < 520 ? 0.78 : 0.52;
  const h = Math.max(1, Math.floor(Math.max(340, rect.width * ratio) * dpr));
  canvas.width = w;
  canvas.height = h;

  ctx.clearRect(0, 0, w, h);

  chartState.dpr = dpr;

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

  if (!points.length) {
    const cs = getComputedStyle(document.documentElement);
    ctx.fillStyle = (cs.getPropertyValue("--chart-label") || "#54605c").trim();
    ctx.font = `${Math.floor(14 * dpr)}px Space Grotesk, sans-serif`;
    ctx.fillText(t("trendNone"), left, top + Math.floor(22 * dpr));
    return;
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (minY === maxY) {
    minY *= 0.995;
    maxY *= 1.005;
  }

  const x0 = points[0].x;
  const x1 = points[points.length - 1].x;
  chartState.x0 = x0;
  chartState.x1 = x1;

  const rangeX = Math.max(1, x1 - x0);
  const rangeY = Math.max(1e-9, maxY - minY);

  const xScale = (tMs) => left + ((tMs - x0) / rangeX) * (right - left);
  const yScale = (v) => bottom - ((v - minY) / rangeY) * (bottom - top);

  const cs = getComputedStyle(document.documentElement);
  const gridColor = (cs.getPropertyValue("--chart-grid") || "rgba(223,231,227,0.95)").trim();
  const labelColor = (cs.getPropertyValue("--chart-label") || "rgba(84,96,92,0.92)").trim();
  const lineColor = (cs.getPropertyValue("--chart-line") || "rgba(13,20,18,0.9)").trim();
  const fillTop = (cs.getPropertyValue("--chart-fill-top") || "rgba(46,67,255,0.22)").trim();
  const fillBottom = (cs.getPropertyValue("--chart-fill-bottom") || "rgba(0,194,168,0.04)").trim();
  const redColor = (cs.getPropertyValue("--chart-red") || "rgba(255,58,58,0.92)").trim();

  // Vertical grid + X labels (0..range)
  const ticks = buildXTicks(opts.range, x0, x1);
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = Math.max(1, Math.floor(1 * dpr));
  for (const tick of ticks) {
    const x = xScale(tick.x);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();

    ctx.fillStyle = labelColor;
    ctx.font = `${Math.floor(11 * dpr)}px Space Grotesk, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(tick.label, x, bottom + Math.floor(6 * dpr));
  }

  // Area fill
  const grad = ctx.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, fillTop);
  grad.addColorStop(1, fillBottom);

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
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = Math.max(2, Math.floor(2 * dpr));
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // Selection (red line + marker)
  const idx = chartState.selectedIndex == null ? points.length - 1 : clamp(chartState.selectedIndex, 0, points.length - 1);
  chartState.selectedIndex = idx;
  const sp = points[idx];
  const sx = xScale(sp.x);
  const sy = yScale(sp.y);

  ctx.strokeStyle = redColor;
  ctx.lineWidth = Math.max(2, Math.floor(2 * dpr));
  ctx.beginPath();
  ctx.moveTo(sx, top);
  ctx.lineTo(sx, bottom);
  ctx.stroke();

  ctx.fillStyle = redColor;
  ctx.beginPath();
  ctx.arc(sx, sy, Math.max(4, Math.floor(4 * dpr)), 0, Math.PI * 2);
  ctx.fill();
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

function findNearestPointIndex(points, tMs) {
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

function renderTooltipForSelection() {
  if (!chartState.points.length || chartState.selectedIndex == null) {
    trendTooltip.hidden = true;
    return;
  }
  const p = chartState.points[chartState.selectedIndex];
  const from = chartState.from || fromSelect.value;
  const to = chartState.to || toSelect.value;

  let extra = "";
  if (p.liveUpdatedUtc) {
    const d = parseUpdateUtc(p.liveUpdatedUtc);
    if (d) extra = `<div>${t("updated")}: ${formatSeoulDateTime(d)}</div>`;
  }

  trendTooltip.innerHTML = `<div><b>${p.date}</b></div><div>1 ${from} = ${formatInt(p.y)} ${to}</div>${extra}`;
  trendTooltip.hidden = false;

  const wrap = trendCanvas.parentElement;
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();

  const xCss = canvasXForTime(p.x);
  const tipRect = trendTooltip.getBoundingClientRect();
  const pad = 10;
  const left = clamp(xCss - tipRect.width / 2, pad, wrapRect.width - tipRect.width - pad);
  trendTooltip.style.left = `${left}px`;
  trendTooltip.style.top = `${pad}px`;

  const extraText = p.liveUpdatedUtc ? ` | ${t("updated")}: ${formatSeoulDateTime(parseUpdateUtc(p.liveUpdatedUtc) || new Date())}` : "";
  trendReadout.textContent = `${t("selected")}: ${p.date} | 1 ${from} = ${formatInt(p.y)} ${to}${extraText}`;
}

function hideTrendTooltip() {
  chartState.tooltipPinned = false;
  trendTooltip.hidden = true;
  trendReadout.textContent = chartState.lastReadout || t("trendHelp");
}

function selectByClientX(clientX) {
  if (!chartState.points.length) return;
  const rect = trendCanvas.getBoundingClientRect();
  const xCss = clientX - rect.left;
  const tMs = timeFromCanvasX(xCss);
  chartState.selectedIndex = findNearestPointIndex(chartState.points, tMs);
  drawLineChart(trendCanvas, chartState.points, { quote: chartState.to || toSelect.value, range: trendRange });
  renderTooltipForSelection();
}

async function updateTrend(force = false) {
  const { from, to } = getSelectedCodes();
  if (!from || !to) return;

  chartState.from = from;
  chartState.to = to;
  chartState.range = trendRange;

  if (from === to) {
    trendSubtitle.textContent = t("sameCurrency");
    chartState.points = [];
    chartState.selectedIndex = null;
    hideTrendTooltip();
    setTrendReadout(t("trendNA"));
    drawLineChart(trendCanvas, [], { quote: to, range: trendRange });
    return;
  }

  hideTrendTooltip();
  setTrendReadout(t("trendLoading"));
  trendSubtitle.textContent = `1 ${from} in ${to} (${trendRange.toUpperCase()})`;

  if (force) {
    for (const k of trendCache.keys()) {
      if (k.startsWith(`${from}:${to}:${trendRange}:`)) trendCache.delete(k);
    }
  }

  try {
    const series = await fetchTrendSeries(from, to, trendRange);
    chartState.points = series.points;
    chartState.selectedIndex = series.points.length ? series.points.length - 1 : null;

    drawLineChart(trendCanvas, series.points, { quote: to, range: trendRange });

    const last = series.points.length ? series.points[series.points.length - 1] : null;
    if (!last) {
      setTrendReadout(t("trendNone"));
      return;
    }

    let extra = "";
    if (last.liveUpdatedUtc) {
      const d = parseUpdateUtc(last.liveUpdatedUtc);
      if (d) extra = ` | ${t("updated")}: ${formatSeoulDateTime(d)}`;
    }
    setTrendReadout(`Last: ${last.date} | 1 ${from} = ${formatInt(last.y)} ${to}${extra}`);
  } catch {
    setTrendReadout(t("trendUnavailable"));
  }
}

function applyLang(next) {
  currentLang = next === "en" ? "en" : "ko";
  localStorage.setItem("fx_lang", currentLang);
  document.documentElement.lang = currentLang === "ko" ? "ko" : "en";

  appTitle.textContent = t("title");
  labelFrom.textContent = t("from");
  labelTo.textContent = t("to");
  refreshButton.textContent = t("refresh");
  trendTitle.textContent = t("trend");
  resultMetaEl.textContent = t("resultMeta");

  if (!chartState.tooltipPinned) {
    setTrendReadout(t("trendHelp"));
  }

  for (const b of langButtons) {
    const active = b.getAttribute("data-lang") === currentLang;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  }
}

function applyTheme(next) {
  currentTheme = next === "dark" ? "dark" : "bright";
  localStorage.setItem("fx_theme", currentTheme);
  document.documentElement.setAttribute("data-theme", currentTheme);

  for (const b of themeButtons) {
    const active = b.getAttribute("data-theme") === currentTheme;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  }

  // Redraw chart with theme-specific colors.
  drawLineChart(trendCanvas, chartState.points, { quote: chartState.to || toSelect.value, range: trendRange });
  if (!trendTooltip.hidden) renderTooltipForSelection();
}

function toggleMusic() {
  if (!audio) {
    audio = new Audio("./bgm.mp3");
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = 0.12; // appropriate, not loud
  }

  const on = musicButton.classList.contains("is-on");
  if (on) {
    audio.pause();
    musicButton.classList.remove("is-on");
    musicButton.setAttribute("aria-pressed", "false");
    return;
  }

  // Some browsers require a user gesture; this function is triggered by a button click.
  audio.currentTime = audio.currentTime || 0;
  const p = audio.play();
  if (p && typeof p.then === "function") {
    p.then(() => {
      musicButton.classList.add("is-on");
      musicButton.setAttribute("aria-pressed", "true");
    }).catch(() => {
      // Autoplay/permission blocked; keep button off.
      musicButton.classList.remove("is-on");
      musicButton.setAttribute("aria-pressed", "false");
    });
  } else {
    musicButton.classList.add("is-on");
    musicButton.setAttribute("aria-pressed", "true");
  }
}

function wireEvents() {
  form.addEventListener("submit", (ev) => ev.preventDefault());

  refreshButton.addEventListener("click", () => {
    void convertCurrency(true);
    void updateTrend(true);
  });

  fromSelect.addEventListener("change", () => {
    hideTrendTooltip();
    void convertCurrency(false);
    void updateTrend(false);
  });

  toSelect.addEventListener("change", () => {
    hideTrendTooltip();
    void convertCurrency(false);
    void updateTrend(false);
  });

  for (const b of langButtons) {
    b.addEventListener("click", () => applyLang(b.getAttribute("data-lang")));
  }
  for (const b of themeButtons) {
    b.addEventListener("click", () => applyTheme(b.getAttribute("data-theme")));
  }
  musicButton.addEventListener("click", () => toggleMusic());

  trendTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-range");
      if (!next || next === trendRange) return;
      trendRange = next;
      for (const tbtn of trendTabs) {
        const active = tbtn === btn;
        tbtn.classList.toggle("is-active", active);
        tbtn.setAttribute("aria-selected", active ? "true" : "false");
      }
      hideTrendTooltip();
      void updateTrend(false);
    });
  });

  window.addEventListener("resize", () => {
    drawLineChart(trendCanvas, chartState.points, { quote: chartState.to || toSelect.value, range: trendRange });
    if (!trendTooltip.hidden) renderTooltipForSelection();
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
    selectByClientX(ev.clientX);
  });

  trendCanvas.addEventListener("pointermove", (ev) => {
    if (!chartState.tooltipPinned) return;
    if (!chartState.points.length) return;
    selectByClientX(ev.clientX);
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
}

async function init() {
  // Theme/lang init first so all default strings show correctly.
  const savedLang = localStorage.getItem("fx_lang");
  const savedTheme = localStorage.getItem("fx_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(savedTheme || (prefersDark ? "dark" : "bright"));
  applyLang(savedLang || "ko");

  wireEvents();
  setTrendReadout(t("trendHelp"));

  try {
    setStatus(t("loadingCurrencies"));
    await loadCurrencies();
    setStatus(t("loadingLive"));
    await convertCurrency(true);
    await updateTrend(false);
  } catch (err) {
    setStatus("Failed to initialize.");
    setResult("-", "Could not initialize.", true);
    setTrendReadout(t("trendUnavailable"));
  }

  // Attempt default playback if the browser allows it; otherwise it will be blocked silently.
  if (!bgmAutoplayAttempted) {
    bgmAutoplayAttempted = true;
    try {
      if (!audio) {
        audio = new Audio("./bgm.mp3");
        audio.loop = true;
        audio.preload = "auto";
        audio.volume = 0.12;
      }
      const p = audio.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          musicButton.classList.add("is-on");
          musicButton.setAttribute("aria-pressed", "true");
        }).catch(() => {
          // blocked by autoplay policy; user must click BGM
        });
      }
    } catch {
      // ignore
    }
  }
}

init();
