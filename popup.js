const DEFAULT_BENCHMARK = "^NSEI";
const DEFAULT_TIMEFRAME_WEEKS = 6;
const MAX_STOCKS = 10;
const PALETTE = ["#0b6bcb", "#198754", "#c25d00", "#7a4dd8", "#0f8f8f", "#cc3a7a", "#4f6d7a", "#b08900", "#2f54eb", "#ad6800"];

const state = {
  stocks: [],
  benchmark: DEFAULT_BENCHMARK,
  timeframeWeeks: DEFAULT_TIMEFRAME_WEEKS,
  isLoading: false,
  pendingAutoSymbol: "",
  series: [],
  errors: []
};

const statusEl = document.getElementById("status");
const symbolInput = document.getElementById("symbolInput");
const addStockBtn = document.getElementById("addStockBtn");
const stockSuggestionsEl = document.getElementById("stockSuggestions");
const stockListEl = document.getElementById("stockList");
const clearAllStocksBtn = document.getElementById("clearAllStocksBtn");
const benchmarkSelect = document.getElementById("benchmarkSelect");
const timeframeInput = document.getElementById("timeframeInput");
const timeframeValue = document.getElementById("timeframeValue");
const canvas = document.getElementById("rrgCanvas");
const chartLoadingEl = document.getElementById("chartLoading");
const legendText = document.getElementById("legendText");
const errorListEl = document.getElementById("errorList");

const ctx = canvas.getContext("2d");
const width = canvas.width;
const height = canvas.height;
let suggestionsTimer = null;
let suggestionsRequestId = 0;
let latestSuggestionSymbols = new Set();

init().catch((error) => {
  setStatus(`Initialization failed: ${error.message}`);
});

addStockBtn.addEventListener("click", async () => {
  const symbol = normalizeSymbol(symbolInput.value);
  if (!symbol) {
    setStatus("Enter a valid stock symbol", "error");
    symbolInput.focus();
    return;
  }

  const added = await tryAddStock(symbol, true, true);
  if (!added) {
    return;
  }

  symbolInput.value = "";
  renderStockSuggestions([]);
  renderStockList();
  await persistState();
  await loadChart(false);
});

symbolInput.addEventListener("input", () => {
  const query = symbolInput.value.trim();
  if (suggestionsTimer) {
    clearTimeout(suggestionsTimer);
  }

  if (query.length < 2) {
    renderStockSuggestions([]);
    return;
  }

  suggestionsTimer = setTimeout(async () => {
    const requestId = ++suggestionsRequestId;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "FETCH_STOCK_SUGGESTIONS",
        query
      });

      if (requestId !== suggestionsRequestId) {
        return;
      }

      const suggestions = response?.ok ? response.payload?.suggestions || [] : [];
      renderStockSuggestions(suggestions);
    } catch (_error) {
      if (requestId === suggestionsRequestId) {
        renderStockSuggestions([]);
      }
    }
  }, 220);
});

symbolInput.addEventListener("focus", () => {
  if (!symbolInput.value.trim()) {
    renderStockSuggestions([]);
  }
});

symbolInput.addEventListener("change", async () => {
  const symbol = normalizeSymbol(symbolInput.value);
  if (!symbol || !latestSuggestionSymbols.has(symbol)) {
    return;
  }

  const added = await tryAddStock(symbol, true, true);
  if (!added) {
    return;
  }

  symbolInput.value = "";
  renderStockSuggestions([]);
  renderStockList();
  await persistState();
  await loadChart(false);
});

symbolInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") {
    return;
  }

  const symbol = normalizeSymbol(symbolInput.value);
  if (!symbol) {
    return;
  }

  event.preventDefault();

  const added = await tryAddStock(symbol, true, true);
  if (!added) {
    return;
  }

  symbolInput.value = "";
  renderStockSuggestions([]);
  renderStockList();
  await persistState();
  await loadChart(false);
});

stockListEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-remove]");
  if (!button) {
    return;
  }

  const symbol = normalizeSymbol(button.dataset.remove || "");
  const key = instrumentKey(symbol);
  const before = state.stocks.length;
  state.stocks = state.stocks.filter((item) => instrumentKey(item) !== key);

  if (state.stocks.length === before) {
    return;
  }

  renderStockList();
  await persistState();

  if (!state.stocks.length) {
    drawEmptyChart("Add at least one stock");
    setStatus("Stock list is empty");
    return;
  }

  await loadChart(false);
});

clearAllStocksBtn.addEventListener("click", async () => {
  if (!state.stocks.length) {
    return;
  }

  state.stocks = [];
  renderStockList();
  await persistState();
  await loadChart(false);
});

timeframeInput.addEventListener("input", () => {
  state.timeframeWeeks = sanitizeWeeks(timeframeInput.value);
  timeframeValue.textContent = `${state.timeframeWeeks}W`;
});

timeframeInput.addEventListener("change", async () => {
  await persistState();
  if (state.stocks.length) {
    await loadChart(false);
  }
});

benchmarkSelect.addEventListener("change", async () => {
  state.benchmark = pickBenchmark(benchmarkSelect.value);
  benchmarkSelect.value = state.benchmark;
  await persistState();
  if (state.stocks.length) {
    await loadChart(false);
  }
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.activeStockContext?.newValue) {
    const symbol = normalizeSymbol(changes.activeStockContext.newValue.symbol || "");
    if (symbol && !hasStockByInstrument(symbol)) {
      if (state.isLoading) {
        state.pendingAutoSymbol = symbol;
      } else {
        const added = await tryAddStock(symbol, true, false);
        if (added) {
          renderStockList();
          void persistState();
          void loadChart(true);
        }
      }
    }
  }
});

async function init() {
  drawEmptyChart("No data loaded");

  const stored = await chrome.storage.local.get([
    "benchmark",
    "stockList",
    "lastSymbol",
    "timeframeWeeks",
    "activeStockContext"
  ]);

  state.benchmark = pickBenchmark(stored.benchmark);
  state.timeframeWeeks = sanitizeWeeks(stored.timeframeWeeks);

  if (Array.isArray(stored.stockList)) {
    state.stocks = dedupeStocksByInstrument(stored.stockList.map((item) => normalizeSymbol(item)).filter(Boolean)).slice(0, MAX_STOCKS);
  }

  const contextSymbol = normalizeSymbol(stored.activeStockContext?.symbol || "");
  const lastSymbol = normalizeSymbol(stored.lastSymbol || "");
  if (!state.stocks.length && contextSymbol) {
    state.stocks = [contextSymbol];
  } else if (!state.stocks.length && lastSymbol) {
    state.stocks = [lastSymbol];
  }

  benchmarkSelect.value = pickBenchmark(state.benchmark);
  timeframeInput.value = String(state.timeframeWeeks);
  timeframeValue.textContent = `${state.timeframeWeeks}W`;
  renderStockList();

  setStatus("Detecting stock from active tab...");
  const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_STOCK_CONTEXT" });

  if (response?.ok && response.context?.symbol) {
    const symbol = normalizeSymbol(response.context.symbol);
    const added = await tryAddStock(symbol, true, false);
    if (added) {
      renderStockList();
      setStatus(`Detected ${symbol} (${response.context.source})`);
    }
  }

  await persistState();

  if (state.stocks.length) {
    await loadChart(false);
  } else {
    setStatus("No stock detected. Add stocks to begin.");
    drawEmptyChart("Add at least one stock");
  }
}

async function loadChart(fromAutoSwitch) {
  if (!state.stocks.length) {
    setChartLoading(false);
    setStatus("Add at least one stock");
    drawEmptyChart("Add at least one stock");
    return;
  }

  state.isLoading = true;
  setChartLoading(true);

  const benchmark = pickBenchmark(benchmarkSelect.value);
  state.benchmark = benchmark;
  state.timeframeWeeks = sanitizeWeeks(timeframeInput.value);
  timeframeInput.value = String(state.timeframeWeeks);
  timeframeValue.textContent = `${state.timeframeWeeks}W`;

  setStatus(`Loading ${state.stocks.length} stock(s) vs ${benchmark} for ${state.timeframeWeeks}W...`);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "FETCH_MULTI_RRG_DATA",
      symbols: state.stocks,
      benchmark: state.benchmark,
      timeframeWeeks: state.timeframeWeeks
    });

    if (!response?.ok || !response.payload?.series?.length) {
      throw new Error(response?.error || "No chart data available");
    }

    state.series = response.payload.series;
    state.errors = response.payload.errors || [];
    state.benchmark = pickBenchmark(response.payload.benchmark || state.benchmark);

    drawRrgMulti(state.series, state.benchmark);
    renderErrors(state.errors);

    const dt = new Date(response.payload.updatedAt);
    const autoTag = fromAutoSwitch ? " [auto]" : "";
    legendText.textContent = `${state.series.length} stock(s), ${state.timeframeWeeks}W trail`;
    setStatus(`Updated ${dt.toLocaleString()}${autoTag}`);

    const resolvedSymbols = state.series.map((item) => normalizeSymbol(item.symbol)).filter(Boolean);
    state.stocks = dedupeStocksByInstrument([...resolvedSymbols, ...state.stocks]).slice(0, MAX_STOCKS);
    renderStockList();
    benchmarkSelect.value = pickBenchmark(state.benchmark);
    await persistState();
  } catch (error) {
    state.series = [];
    state.errors = [{ symbol: "ALL", error: error.message || "Failed to load chart" }];
    renderErrors(state.errors);
    drawEmptyChart("Failed to load data");
    setStatus(error.message || "Failed to load chart");
  } finally {
    setChartLoading(false);
    state.isLoading = false;

    if (state.pendingAutoSymbol && !hasStockByInstrument(state.pendingAutoSymbol)) {
      const pending = state.pendingAutoSymbol;
      state.pendingAutoSymbol = "";
      if (await tryAddStock(pending, true, false)) {
        renderStockList();
        await persistState();
        await loadChart(true);
      }
    }
  }
}

function setChartLoading(isLoading) {
  chartLoadingEl.hidden = !isLoading;
}

function drawRrgMulti(series, benchmark) {
  ctx.clearRect(0, 0, width, height);

  const margin = 40;
  const plot = {
    left: margin,
    top: margin,
    right: width - margin,
    bottom: height - margin
  };

  const allPoints = series.flatMap((item) => item.points);
  const xRange = deriveRange(allPoints.map((point) => point.x));
  const yRange = deriveRange(allPoints.map((point) => point.y));

  const xMidPx = mapX(100, xRange, plot);
  const yMidPx = mapY(100, yRange, plot);

  fillQuadrants(plot, xMidPx, yMidPx);
  drawAxes(plot, xMidPx, yMidPx, benchmark, xRange, yRange);

  series.forEach((item, index) => {
    const color = PALETTE[index % PALETTE.length];
    drawTrailWithArrows(item.points, item.symbol, color, xRange, yRange, plot);
  });
}

function fillQuadrants(plot, xMidPx, yMidPx) {
  ctx.fillStyle = "#d9fbe6";
  ctx.fillRect(xMidPx, plot.top, plot.right - xMidPx, yMidPx - plot.top);

  ctx.fillStyle = "#fff3d1";
  ctx.fillRect(xMidPx, yMidPx, plot.right - xMidPx, plot.bottom - yMidPx);

  ctx.fillStyle = "#ffe0e0";
  ctx.fillRect(plot.left, yMidPx, xMidPx - plot.left, plot.bottom - yMidPx);

  ctx.fillStyle = "#dde9ff";
  ctx.fillRect(plot.left, plot.top, xMidPx - plot.left, yMidPx - plot.top);
}

function drawAxes(plot, xMidPx, yMidPx, benchmark, xRange, yRange) {
  ctx.strokeStyle = "#8da2bc";
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(plot.left, yMidPx);
  ctx.lineTo(plot.right, yMidPx);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(xMidPx, plot.top);
  ctx.lineTo(xMidPx, plot.bottom);
  ctx.stroke();

  ctx.strokeStyle = "#d2dce9";
  ctx.strokeRect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);

  ctx.fillStyle = "#274264";
  ctx.font = "12px Segoe UI";
  ctx.fillText("Leading", plot.right - 56, plot.top + 14);
  ctx.fillText("Weakening", plot.right - 68, plot.bottom - 8);
  ctx.fillText("Lagging", plot.left + 4, plot.bottom - 8);
  ctx.fillText("Improving", plot.left + 4, plot.top + 14);

  ctx.fillStyle = "#54667c";
  ctx.font = "11px Segoe UI";
  ctx.fillText(`JdK RS-Ratio (${benchmark})`, plot.left + 4, height - 10);

  ctx.save();
  ctx.translate(12, plot.bottom - 8);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("JdK RS-Momentum", 0, 0);
  ctx.restore();

  ctx.fillStyle = "#54667c";
  ctx.fillText(`${xRange.min.toFixed(1)}`, plot.left, plot.bottom + 14);
  ctx.fillText(`${xRange.max.toFixed(1)}`, plot.right - 30, plot.bottom + 14);
  ctx.fillText(`${yRange.max.toFixed(1)}`, 2, plot.top + 8);
  ctx.fillText(`${yRange.min.toFixed(1)}`, 2, plot.bottom);
}

function drawTrailWithArrows(points, symbol, color, xRange, yRange, plot) {
  if (!Array.isArray(points) || points.length < 2) {
    return;
  }

  const coords = points.map((point) => ({ x: mapX(point.x, xRange, plot), y: mapY(point.y, yRange, plot) }));

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.8;
  ctx.beginPath();
  coords.forEach((p, idx) => {
    if (idx === 0) {
      ctx.moveTo(p.x, p.y);
    } else {
      ctx.lineTo(p.x, p.y);
    }
  });
  ctx.stroke();

  for (let i = 1; i < coords.length; i += 1) {
    drawArrowMidpoint(coords[i - 1], coords[i], color);
  }

  coords.forEach((p, idx) => {
    const alpha = 0.35 + (idx / Math.max(1, coords.length - 1)) * 0.65;
    ctx.beginPath();
    ctx.fillStyle = withAlpha(color, alpha);
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  });

  const last = coords[coords.length - 1];
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(last.x, last.y, 6.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = "bold 10px Segoe UI";
  ctx.fillText(symbol, last.x + 6, last.y - 6);
}

function drawArrowMidpoint(from, to, color) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 10) {
    return;
  }

  const ux = dx / len;
  const uy = dy / len;
  const midX = from.x + dx * 0.5;
  const midY = from.y + dy * 0.5;
  const size = 8;
  const tipX = midX + ux * (size * 0.6);
  const tipY = midY + uy * (size * 0.6);
  const baseX = midX - ux * (size * 0.6);
  const baseY = midY - uy * (size * 0.6);

  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX - uy * 4, baseY + ux * 4);
  ctx.lineTo(baseX + uy * 4, baseY - ux * 4);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
}

function drawEmptyChart(message) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f2f6fb";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d2dce9";
  ctx.strokeRect(10, 10, width - 20, height - 20);
  ctx.fillStyle = "#5c7189";
  ctx.font = "13px Segoe UI";
  ctx.fillText(message, 16, 28);
  legendText.textContent = message;
}

function renderStockList() {
  stockListEl.textContent = "";
  clearAllStocksBtn.hidden = state.stocks.length < 2;

  if (!state.stocks.length) {
    const empty = document.createElement("span");
    empty.className = "chip";
    empty.textContent = "No stocks selected";
    stockListEl.appendChild(empty);
    return;
  }

  state.stocks.forEach((symbol) => {
    const chip = document.createElement("span");
    chip.className = "chip";

    const label = document.createElement("span");
    label.textContent = symbol;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.dataset.remove = symbol;
    removeBtn.textContent = "x";
    removeBtn.title = `Remove ${symbol}`;

    chip.append(label, removeBtn);
    stockListEl.appendChild(chip);
  });
}

function renderStockSuggestions(suggestions) {
  stockSuggestionsEl.textContent = "";
  latestSuggestionSymbols = new Set();

  for (const item of suggestions) {
    const option = document.createElement("option");
    option.value = item.symbol;
    option.label = item.name ? `${item.symbol} - ${item.name}` : item.symbol;
    stockSuggestionsEl.appendChild(option);
    latestSuggestionSymbols.add(option.value);
  }
}

function renderErrors(errors) {
  errorListEl.textContent = "";
  if (!errors.length) {
    return;
  }

  errors.forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = `${entry.symbol}: ${entry.error}`;
    errorListEl.appendChild(li);
  });
}

function deriveRange(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  let min = Math.min(...finite);
  let max = Math.max(...finite);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 98;
    max = 102;
  }

  const center = 100;
  min = Math.min(min, center - 0.5);
  max = Math.max(max, center + 0.5);

  const pad = Math.max(0.6, (max - min) * 0.18);
  return { min: min - pad, max: max + pad };
}

function mapX(value, range, plot) {
  const pct = (value - range.min) / (range.max - range.min);
  return plot.left + pct * (plot.right - plot.left);
}

function mapY(value, range, plot) {
  const pct = (value - range.min) / (range.max - range.min);
  return plot.bottom - pct * (plot.bottom - plot.top);
}

function withAlpha(hex, alpha) {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function addStock(symbol, prioritize) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    return false;
  }
  const key = instrumentKey(normalized);
  const existingIndex = state.stocks.findIndex((item) => instrumentKey(item) === key);
  if (existingIndex >= 0) {
    if (prioritize) {
      const existing = state.stocks[existingIndex];
      const preferred = prefersResolvedSymbol(normalized, existing) ? normalized : existing;
      const rest = state.stocks.filter((_, idx) => idx !== existingIndex);
      state.stocks = [preferred, ...rest];
    }
    return true;
  }

  const next = prioritize ? [normalized, ...state.stocks] : [...state.stocks, normalized];
  state.stocks = dedupeStocksByInstrument(next).slice(0, MAX_STOCKS);

  if (next.length > MAX_STOCKS) {
    setStatus(`Max ${MAX_STOCKS} stocks allowed`);
  }

  return true;
}

async function tryAddStock(symbol, prioritize, showError) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    if (showError) {
      setStatus("Enter a valid stock symbol", "error");
    }
    return false;
  }

  if (hasStockByInstrument(normalized)) {
    return addStock(normalized, prioritize);
  }

  const response = await chrome.runtime.sendMessage({
    type: "VALIDATE_STOCK",
    symbol: normalized
  });

  const valid = response?.ok && response.payload?.valid;
  if (!valid) {
    if (showError) {
      setStatus(`Stock ${normalized} not found`, "error");
    }
    return false;
  }

  const resolved = normalizeSymbol(response.payload.resolvedSymbol || normalized);
  return addStock(resolved, prioritize);
}

async function persistState() {
  await chrome.storage.local.set({
    stockList: state.stocks,
    benchmark: state.benchmark,
    timeframeWeeks: state.timeframeWeeks
  });
}

function sanitizeWeeks(value) {
  const weeks = Number(value);
  if (!Number.isFinite(weeks)) {
    return DEFAULT_TIMEFRAME_WEEKS;
  }
  return Math.max(1, Math.min(26, Math.round(weeks)));
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-:^]/g, "")
    .slice(0, 20);
}

function unique(values) {
  return [...new Set(values)];
}

function instrumentKey(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    return "";
  }
  return normalized
    .replace(/^(NSE|BSE):/, "")
    .replace(/\.(NS|BO)$/i, "");
}

function hasStockByInstrument(symbol) {
  const key = instrumentKey(symbol);
  return state.stocks.some((item) => instrumentKey(item) === key);
}

function dedupeStocksByInstrument(stocks) {
  const seen = new Set();
  const deduped = [];

  for (const raw of stocks) {
    const symbol = normalizeSymbol(raw);
    const key = instrumentKey(symbol);
    if (!symbol || !key) {
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(symbol);
      continue;
    }

    const index = deduped.findIndex((item) => instrumentKey(item) === key);
    if (index >= 0 && prefersResolvedSymbol(symbol, deduped[index])) {
      deduped[index] = symbol;
    }
  }

  return deduped;
}

function prefersResolvedSymbol(candidate, existing) {
  const c = normalizeSymbol(candidate);
  const e = normalizeSymbol(existing);
  return /\.(NS|BO)$/i.test(c) && !/\.(NS|BO)$/i.test(e);
}

function pickBenchmark(value) {
  const normalized = normalizeSymbol(value);
  const allowed = new Set(["^NSEI", "^CRSLDX", "HDFCSML250.NS", "^NSEMDCP50", "^NSEBANK"]);
  return allowed.has(normalized) ? normalized : DEFAULT_BENCHMARK;
}

function setStatus(message, tone = "info") {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", tone === "error");
}
