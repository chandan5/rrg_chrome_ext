chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "EXTRACT_STOCK_CONTEXT") {
    return;
  }

  sendResponse(extractStockContext());
});

function extractStockContext() {
  const candidates = [];
  const href = window.location.href || "";
  const pathname = window.location.pathname || "";
  const title = document.title || "";
  const host = window.location.hostname || "";

  pushMatches(candidates, href, /(?:[?&](?:symbol|ticker|s|stock|scId)=)([A-Z0-9.\-:]{1,20})/gi, 0.96, "url_query");
  pushMatches(candidates, pathname, /\/(?:quote|stocks|symbol|equity|stock|company)\/([A-Z0-9.\-]{1,20})(?:[/?#]|$)/gi, 0.9, "url_path");

  if (host.includes("screener.in")) {
    pushMatches(candidates, pathname, /\/company\/([A-Z0-9.\-]{1,20})(?:[/?#]|$)/gi, 0.99, "screener_company");
  }

  if (host.includes("moneycontrol.com")) {
    pushMatches(candidates, `${href} ${title}`, /(?:NSE|BSE)\s*[:|-]\s*([A-Z][A-Z0-9.\-]{1,10})/gi, 0.94, "moneycontrol_exchange");
  }

  if (host.includes("tickertape.in")) {
    pushMatches(candidates, pathname, /\/stocks\/[^/]*-([A-Z0-9]{2,12})(?:[/?#]|$)/gi, 0.95, "tickertape_slug");
    pushMatches(candidates, href, /(?:\?|&)symbol=([A-Z0-9.\-:]{1,20})/gi, 0.94, "tickertape_query");
  }

  pushMatches(candidates, title, /\(([A-Z][A-Z0-9.\-]{1,10})\)/g, 0.78, "title_paren");
  pushMatches(candidates, title, /\b([A-Z]{2,10})\b/g, 0.42, "title_token");

  const pageText = (document.body?.textContent || "").slice(0, 200000);
  pushMatches(candidates, pageText, /(?:NSE|BSE)\s*[:|-]\s*([A-Z][A-Z0-9.\-]{1,10})/gi, 0.92, "body_exchange");

  const filtered = candidates
    .map((candidate) => ({
      ...candidate,
      symbol: normalizeSymbol(candidate.symbol)
    }))
    .filter((candidate) => isLikelyTicker(candidate.symbol))
    .sort((a, b) => b.confidence - a.confidence);

  const best = filtered[0];
  if (!best) {
    return { symbol: "", source: "none", confidence: 0 };
  }

  return {
    symbol: best.symbol,
    source: best.source,
    confidence: best.confidence
  };
}

function pushMatches(candidates, input, regex, confidence, source) {
  if (!input) {
    return;
  }

  let match;
  while ((match = regex.exec(input)) !== null) {
    candidates.push({
      symbol: match[1],
      confidence,
      source
    });
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

  return /^[A-Z][A-Z0-9.\-:^]*$/.test(symbol);
}
