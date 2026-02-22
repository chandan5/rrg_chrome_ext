const GA4_MEASUREMENT_ID = "G-PGBYXYQNS1";
// TODO(telemetry): Temporary client-side secret; move GA4 Measurement Protocol calls to a backend and remove this from the extension bundle.
const GA4_API_SECRET = "50NdcL9eRhq7Xcl3PTQwQw";
const GA4_ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${GA4_API_SECRET}`;

const DEFAULT_BENCHMARK = "^NSEI";
const DEFAULT_TIMEFRAME_WEEKS = 6;
const MIN_TIMEFRAME_WEEKS = 1;
const MAX_TIMEFRAME_WEEKS = 26;
const HISTORY_RANGE = "2y";
const HISTORY_INTERVAL = "1wk";

const BENCHMARK_ALIASES = {
  NIFTY50: ["^NSEI"],
  NIFTY: ["^NSEI"],
  NIFTY500: ["^CRSLDX"],
  NIFTYSMALLCAP100: ["^CNXSC", "NIFTYSMLCAP100.NS"],
  NIFTYMIDCAP50: ["^NSEMDCP50", "NIFTYMIDCAP50.NS"],
  NIFTYBANK: ["^NSEBANK"],
  BANKNIFTY: ["^NSEBANK"]
};

const BENCHMARK_FALLBACKS_BY_SYMBOL = {
  "^NSEI": ["^NSEI"],
  "^CRSLDX": ["^CRSLDX", "NIFTY500.NS"],
  "^CNXSC": ["^CNXSC", "NIFTYSMLCAP100.NS", "NIFSMCP100", "NIFSMCP100.NS"],
  "^NSEMDCP50": ["^NSEMDCP50", "NIFTYMIDCAP50.NS"],
  "^NSEBANK": ["^NSEBANK"]
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([
    "benchmark",
    "lastSymbol",
    "activeStockContext",
    "timeframeWeeks"
  ]);

  const updates = {};
  if (!existing.benchmark) {
    updates.benchmark = DEFAULT_BENCHMARK;
  }
  if (!existing.lastSymbol) {
    updates.lastSymbol = "";
  }
  if (!existing.activeStockContext) {
    updates.activeStockContext = { symbol: "", source: "none", confidence: 0, updatedAt: Date.now() };
  }
  if (!Number.isFinite(existing.timeframeWeeks)) {
    updates.timeframeWeeks = DEFAULT_TIMEFRAME_WEEKS;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  await refreshActiveStockContext();
});

chrome.runtime.onStartup.addListener(async () => {
  await refreshActiveStockContext();
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await refreshActiveStockContext(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab?.active) {
    return;
  }

  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    await refreshActiveStockContext(tabId);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  await refreshActiveStockContext();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error("Message handling error", error);
      sendResponse({ ok: false, error: error.message || "Unknown error" });
    });

  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_ACTIVE_STOCK_CONTEXT":
      return { context: await refreshActiveStockContext() };
    case "FETCH_RRG_DATA":
      return {
        payload: await fetchAndBuildRrg({
          symbol: normalizeSymbol(message.symbol),
          benchmark: normalizeSymbol(message.benchmark || DEFAULT_BENCHMARK),
          timeframeWeeks: sanitizeWeeks(message.timeframeWeeks)
        })
      };
    case "FETCH_MULTI_RRG_DATA":
      return {
        payload: await fetchAndBuildMultiRrg({
          symbols: Array.isArray(message.symbols) ? message.symbols : [],
          benchmark: normalizeSymbol(message.benchmark || DEFAULT_BENCHMARK),
          timeframeWeeks: sanitizeWeeks(message.timeframeWeeks)
        })
      };
    case "VALIDATE_STOCK":
      return {
        payload: await validateStockSymbol(normalizeSymbol(message.symbol))
      };
    case "FETCH_STOCK_SUGGESTIONS":
      return {
        payload: await fetchStockSuggestions(message.query)
      };
    default:
      throw new Error("Unsupported message type");
  }
}

async function validateStockSymbol(symbol) {
  if (!symbol) {
    return { valid: false, resolvedSymbol: "", error: "Invalid symbol" };
  }

  try {
    const data = await fetchCloseSeriesResolved(symbol, "stock", DEFAULT_TIMEFRAME_WEEKS);
    return { valid: true, resolvedSymbol: data.resolvedSymbol, error: "" };
  } catch (error) {
    return { valid: false, resolvedSymbol: "", error: error.message || "Symbol not found" };
  }
}

async function fetchStockSuggestions(query) {
  const text = String(query || "").trim();
  if (text.length < 2) {
    return { suggestions: [] };
  }

  const url = new URL("https://query2.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", text);
  url.searchParams.set("quotesCount", "12");
  url.searchParams.set("newsCount", "0");
  url.searchParams.set("listsCount", "0");
  url.searchParams.set("enableFuzzyQuery", "false");

  const response = await fetch(url.toString(), { method: "GET" });
  if (!response.ok) {
    return { suggestions: [] };
  }

  const json = await response.json();
  const quotes = Array.isArray(json?.quotes) ? json.quotes : [];
  const seen = new Set();
  const suggestions = [];

  for (const quote of quotes) {
    const quoteType = String(quote?.quoteType || "").toUpperCase();
    const exchange = String(quote?.exchange || "").toUpperCase();
    const exchDisp = String(quote?.exchDisp || "").toUpperCase();

    const isIndianExchange =
      exchange.includes("NSI") ||
      exchange.includes("NSE") ||
      exchange.includes("BSE") ||
      exchDisp.includes("NSE") ||
      exchDisp.includes("BSE");

    if (!isIndianExchange || quoteType !== "EQUITY") {
      continue;
    }

    const symbol = normalizeSymbol(quote?.symbol);
    if (!symbol || seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);

    suggestions.push({
      symbol,
      name: String(quote?.shortname || quote?.longname || "").trim(),
      exchange: String(quote?.exchDisp || quote?.exchange || "").trim()
    });
  }

  return { suggestions: suggestions.slice(0, 10) };
}

async function refreshActiveStockContext(tabId) {
  const tab = await resolveTargetTab(tabId);
  if (tab?.id == null) {
    return { symbol: "", source: "none", confidence: 0 };
  }

  const fromContent = await extractFromContentScript(tab.id);
  const fallback = inferSymbolFromTabMeta(tab);
  const context = fromContent?.symbol ? fromContent : fallback;

  const persisted = {
    symbol: normalizeSymbol(context.symbol),
    source: context.source || "fallback",
    confidence: Number(context.confidence || 0),
    tabId: tab.id,
    url: tab.url || "",
    title: tab.title || "",
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({ activeStockContext: persisted });

  return {
    symbol: persisted.symbol,
    source: persisted.source,
    confidence: persisted.confidence,
    tabId: persisted.tabId
  };
}

async function resolveTargetTab(tabId) {
  if (tabId != null) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (_error) {
      return null;
    }
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab || null;
}

async function extractFromContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "EXTRACT_STOCK_CONTEXT"
    });

    if (response?.symbol) {
      return {
        symbol: normalizeSymbol(response.symbol),
        source: response.source || "content",
        confidence: Number(response.confidence || 0)
      };
    }
  } catch (_error) {
    // Content script is unavailable on restricted pages.
  }

  return null;
}

async function getClientId() {
  const stored = await chrome.storage.local.get("_cid");
  if (stored._cid) return stored._cid;
  const cid = crypto.randomUUID();
  await chrome.storage.local.set({ _cid: cid });
  return cid;
}

async function track(eventName, params = {}) {
  try {
    await fetch(GA4_ENDPOINT, {
      method: "POST",
      body: JSON.stringify({
        client_id: await getClientId(),
        events: [{ name: eventName, params }]
      })
    });
  } catch (error) {
    console.debug("Failed to track event", eventName, params, error);
  }
}

function inferSymbolFromTabMeta(tab) {
  const href = tab?.url || "";
  const title = tab?.title || "";
  const candidates = [];

  pushMatches(candidates, href, /(?:[?&](?:symbol|ticker|s|scId|stock)=)([A-Z0-9.\-:]{1,20})/gi, 0.9, "url_query");
  pushMatches(candidates, href, /\/(?:company|stocks|stock|quote|symbol)\/([A-Z0-9.\-]{1,20})(?:[/?#]|$)/gi, 0.86, "url_path");
  pushMatches(candidates, `${href} ${title}`, /(?:NSE|BSE)\s*[:|-]\s*([A-Z][A-Z0-9.\-]{1,10})/gi, 0.92, "exchange_hint");
  pushMatches(candidates, title, /\(([A-Z][A-Z0-9.\-]{1,10})\)/g, 0.74, "title_paren");

  const filtered = candidates
    .map((candidate) => ({
      ...candidate,
      symbol: normalizeSymbol(candidate.symbol)
    }))
    .filter((candidate) => isLikelyTicker(candidate.symbol))
    .sort((a, b) => b.confidence - a.confidence);

  return filtered[0] || { symbol: "", source: "none", confidence: 0 };
}

async function fetchAndBuildRrg({ symbol, benchmark, timeframeWeeks }) {
  const payload = await fetchAndBuildMultiRrg({ symbols: [symbol], benchmark, timeframeWeeks });
  const firstSeries = payload.series[0];

  if (!firstSeries) {
    const firstError = payload.errors[0]?.error || "No chart data available";
    throw new Error(firstError);
  }

  return {
    symbol: firstSeries.symbol,
    requestedSymbol: firstSeries.requestedSymbol,
    benchmark: payload.benchmark,
    requestedBenchmark: payload.requestedBenchmark,
    points: firstSeries.points,
    updatedAt: payload.updatedAt,
    timeframeWeeks: payload.timeframeWeeks
  };
}

async function fetchAndBuildMultiRrg({ symbols, benchmark, timeframeWeeks }) {
  const cleanedSymbols = dedupeSymbolsByInstrument(symbols.map((symbol) => normalizeSymbol(symbol)).filter(Boolean));
  if (!cleanedSymbols.length) {
    throw new Error("At least one stock symbol is required");
  }
  if (!benchmark) {
    throw new Error("A benchmark symbol is required");
  }

  const safeWeeks = sanitizeWeeks(timeframeWeeks);
  const benchmarkResult = await resolveBenchmarkWithFallback(benchmark, safeWeeks);
  const benchmarkData = benchmarkResult.data;

  const outcomes = await Promise.all(
    cleanedSymbols.map(async (symbol) => {
      try {
        const stockData = await fetchCloseSeriesResolved(symbol, "stock", safeWeeks);
        const points = computeRrgPoints(stockData.rows, benchmarkData.rows, safeWeeks);

        if (points.length < 2) {
          return {
            ok: false,
            symbol,
            error: "Not enough overlapping data to build RRG points"
          };
        }

        return {
          ok: true,
          series: {
            symbol: stockData.resolvedSymbol,
            requestedSymbol: symbol,
            points
          }
        };
      } catch (error) {
        return {
          ok: false,
          symbol,
          error: error.message || "Failed to load symbol"
        };
      }
    })
  );

  const series = outcomes.filter((o) => o.ok).map((o) => o.series);
  const errors = outcomes.filter((o) => !o.ok).map((o) => ({ symbol: o.symbol, error: o.error }));

  if (!series.length) {
    throw new Error(errors[0]?.error || "No symbols produced RRG data");
  }

  const updatedAt = Date.now();
  await chrome.storage.local.set({
    lastSymbol: series[0].symbol,
    benchmark: benchmarkData.resolvedSymbol,
    timeframeWeeks: safeWeeks,
    lastUpdatedAt: updatedAt
  });

  track("chart_loaded", {
    symbols: series.map(s => s.symbol).join(",").slice(0, 100),
    symbol_count: series.length,
    failed_count: errors.length,
    benchmark: benchmarkData.resolvedSymbol,
    timeframe_weeks: safeWeeks
  });

  return {
    benchmark: benchmarkData.resolvedSymbol,
    requestedBenchmark: benchmark,
    timeframeWeeks: safeWeeks,
    updatedAt,
    series,
    errors: benchmarkResult.warning ? [{ symbol: "BENCHMARK", error: benchmarkResult.warning }, ...errors] : errors
  };
}

async function resolveBenchmarkWithFallback(benchmark, timeframeWeeks) {
  try {
    const data = await fetchCloseSeriesResolved(benchmark, "benchmark", timeframeWeeks);
    return { data, warning: "" };
  } catch (primaryError) {
    const requested = normalizeSymbol(benchmark);
    if (!requested || requested === DEFAULT_BENCHMARK) {
      throw primaryError;
    }

    const fallbackData = await fetchCloseSeriesResolved(DEFAULT_BENCHMARK, "benchmark", timeframeWeeks);
    return {
      data: fallbackData,
      warning: `Selected benchmark ${requested} unavailable. Using ${fallbackData.resolvedSymbol}.`
    };
  }
}

async function fetchCloseSeriesResolved(rawSymbol, kind, timeframeWeeks) {
  const candidates = buildYahooCandidates(rawSymbol, kind);
  const failures = [];
  const minRows = Math.max(8, sanitizeWeeks(timeframeWeeks) + 2);

  for (const symbol of candidates) {
    try {
      const rows = await fetchCloseSeries(symbol, minRows);
      return { resolvedSymbol: symbol, rows };
    } catch (error) {
      failures.push(`${symbol}: ${error.message}`);
    }
  }

  throw new Error(`Unable to resolve ${kind} symbol ${rawSymbol}. Tried: ${failures.join(" | ")}`);
}

function buildYahooCandidates(input, kind) {
  let normalized = normalizeSymbol(input);
  if (!normalized) {
    return [];
  }

  const exchangeMatch = normalized.match(/^(NSE|BSE):([A-Z0-9.\-]{1,12})$/);
  if (exchangeMatch) {
    normalized = exchangeMatch[2];
  }

  if (kind === "benchmark") {
    const bySymbol = BENCHMARK_FALLBACKS_BY_SYMBOL[normalized];
    if (bySymbol) {
      return unique(bySymbol);
    }

    const aliasKey = normalized.replace(/[^A-Z0-9]/g, "");
    const alias = BENCHMARK_ALIASES[aliasKey];
    if (alias) {
      return unique(alias);
    }
  }

  if (normalized.startsWith("^") || /\.(NS|BO)$/i.test(normalized)) {
    return [normalized.toUpperCase()];
  }

  if (kind === "stock") {
    return unique([`${normalized}.NS`, normalized, `${normalized}.BO`]);
  }

  return unique([normalized, `${normalized}.NS`, `${normalized}.BO`]);
}

async function fetchCloseSeries(symbol, minRows) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", HISTORY_RANGE);
  url.searchParams.set("interval", HISTORY_INTERVAL);

  const response = await fetch(url.toString(), { method: "GET" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const json = await response.json();
  const result = json?.chart?.result?.[0];
  const apiError = json?.chart?.error?.description;
  if (apiError) {
    throw new Error(apiError);
  }

  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;

  if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
    throw new Error("Unexpected data format");
  }

  const rows = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = closes[i];
    const ts = timestamps[i];
    if (Number.isFinite(close) && Number.isFinite(ts)) {
      rows.push({ ts, close });
    }
  }

  if (rows.length < Math.max(1, Number(minRows) || 0)) {
    throw new Error("Insufficient history");
  }

  return rows;
}

function computeRrgPoints(stockRows, benchmarkRows, trailLength) {
  const benchByTs = new Map(benchmarkRows.map((row) => [row.ts, row.close]));
  const aligned = [];

  for (const row of stockRows) {
    const benchClose = benchByTs.get(row.ts);
    if (Number.isFinite(benchClose) && benchClose > 0) {
      aligned.push({ ts: row.ts, rs: row.close / benchClose });
    }
  }

  const minAligned = Math.max(8, sanitizeWeeks(trailLength) + 2);
  if (aligned.length < minAligned) {
    return [];
  }

  const rsValues = aligned.map((value) => value.rs);
  const rsEma = ema(rsValues, 20);

  const ratio = rsValues.map((value, index) => {
    const base = rsEma[index];
    return Number.isFinite(base) && base !== 0 ? 100 * (value / base) : NaN;
  });

  const momentumBase = ema(ratio.map((value) => (Number.isFinite(value) ? value : 100)), 10);
  const momentum = ratio.map((value, index) => {
    const base = momentumBase[index];
    return Number.isFinite(value) && Number.isFinite(base) && base !== 0 ? 100 * (value / base) : NaN;
  });

  const points = [];
  for (let i = 0; i < aligned.length; i += 1) {
    const x = ratio[i];
    const y = momentum[i];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ ts: aligned[i].ts, x: round(x), y: round(y) });
    }
  }

  return points.slice(-sanitizeWeeks(trailLength));
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) {
      out.push(prev);
      continue;
    }

    if (i === 0 || !Number.isFinite(prev)) {
      prev = value;
    } else {
      prev = value * k + prev * (1 - k);
    }
    out.push(prev);
  }

  return out;
}

function sanitizeWeeks(value) {
  const weeks = Number(value);
  if (!Number.isFinite(weeks)) {
    return DEFAULT_TIMEFRAME_WEEKS;
  }
  return Math.max(MIN_TIMEFRAME_WEEKS, Math.min(MAX_TIMEFRAME_WEEKS, Math.round(weeks)));
}

function pushMatches(candidates, input, regex, confidence, source) {
  if (!input) {
    return;
  }

  let match;
  while ((match = regex.exec(input)) !== null) {
    candidates.push({ symbol: match[1], confidence, source });
  }
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-:^]/g, "")
    .slice(0, 20);
}

function isLikelyTicker(symbol) {
  if (!symbol || symbol.length < 1 || symbol.length > 20) {
    return false;
  }

  if (/^(HTTP|HTTPS|WWW|COM|HTML|LOGIN|NEWS|STOCK|QUOTE|MONEYCONTROL|SCREENER|TICKERTAPE)$/.test(symbol)) {
    return false;
  }

  return /^[A-Z^][A-Z0-9.\-:^]*$/.test(symbol);
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => value.toUpperCase()))];
}

function instrumentKey(symbol) {
  return normalizeSymbol(symbol)
    .replace(/^(NSE|BSE):/, "")
    .replace(/\.(NS|BO)$/i, "");
}

function dedupeSymbolsByInstrument(symbols) {
  const deduped = [];
  const seen = new Set();

  for (const symbol of symbols) {
    const normalized = normalizeSymbol(symbol);
    const key = instrumentKey(normalized);
    if (!normalized || !key) {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
