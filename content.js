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
    const moneycontrolNseId = extractMoneycontrolNseId();
    if (moneycontrolNseId) {
      candidates.push({
        symbol: moneycontrolNseId,
        confidence: 1,
        source: "moneycontrol_nseid"
      });
    }

    const moneycontrolCompany = extractMoneycontrolCompanySlug(pathname);
    if (moneycontrolCompany) {
      candidates.push({
        symbol: moneycontrolCompany,
        confidence: 0.88,
        source: "moneycontrol_company_slug"
      });
    }
    pushMatches(candidates, `${href} ${title}`, /(?:NSE|BSE)\s*[:|-]\s*([A-Z][A-Z0-9.\-]{1,10})/gi, 0.94, "moneycontrol_exchange");
  }

  if (host.includes("tickertape.in")) {
    const tickertapeTicker = extractTickertapeTicker();
    if (tickertapeTicker) {
      candidates.push({
        symbol: tickertapeTicker,
        confidence: 0.995,
        source: "tickertape_meta"
      });
    }
    pushMatches(candidates, pathname, /\/stocks\/[^/]*-([A-Z0-9]{2,12})(?:[/?#]|$)/gi, 0.86, "tickertape_slug");
    pushMatches(candidates, href, /(?:\?|&)symbol=([A-Z0-9.\-:]{1,20})/gi, 0.9, "tickertape_query");
  }

  if (host.includes("chartink.com")) {
    pushMatches(candidates, pathname, /\/stocks\/([A-Z0-9.\-]{1,20})\.html(?:[/?#]|$)/gi, 0.99, "chartink_stock_page");
  }

  if (host.includes("marketsmojo.com")) {
    const marketsMojoTicker = extractMarketsMojoTicker();
    if (marketsMojoTicker) {
      candidates.push({
        symbol: marketsMojoTicker,
        confidence: 0.99,
        source: "marketsmojo_meta"
      });
    }
  }

  if (host.includes("tijorifinance.com")) {
    const tijoriTicker = extractTijoriTicker();
    if (tijoriTicker) {
      candidates.push({
        symbol: tijoriTicker,
        confidence: 0.995,
        source: "tijori_company_data"
      });
    }
  }

  if (host.includes("nseindia.com")) {
    const nseTicker = extractNseQuoteTicker(pathname);
    if (nseTicker) {
      candidates.push({
        symbol: nseTicker,
        confidence: 0.995,
        source: "nse_quote_company_slug"
      });
    }
  }

  if (host.includes("bseindia.com")) {
    const bseTicker = extractBseQuoteTicker(pathname);
    if (bseTicker) {
      candidates.push({
        symbol: bseTicker,
        confidence: 0.995,
        source: "bse_quote_symbol_slug"
      });
    }
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
    .filter((candidate) => !(candidate.source === "title_token" && /^(NSE|BSE)$/.test(candidate.symbol)))
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

function extractMoneycontrolCompanySlug(pathname) {
  const match = String(pathname || "").match(
    /\/india\/stockpricequote\/[^/]+\/([a-z0-9-]{2,60})\/[a-z0-9-]{1,20}(?:[/?#]|$)/i
  );
  if (!match) {
    return "";
  }

  const slug = match[1].replace(/-+/g, "");
  return normalizeSymbol(slug);
}

function extractMoneycontrolNseId() {
  const el = document.getElementById("nseid");
  const value = normalizeSymbol(el?.value || "");
  if (!value) {
    return "";
  }

  if (/^(NA|NIL|NONE|NULL|0)$/.test(value)) {
    return "";
  }

  return value;
}

function extractMarketsMojoTicker() {
  const titleCandidates = [
    document.querySelector('meta[property="og:title"]')?.content || "",
    document.querySelector('meta[name="twitter:title"]')?.content || "",
    document.title || ""
  ];

  for (const text of titleCandidates) {
    const sharePriceMatch = text.match(/\b([A-Z][A-Z0-9.\-]{1,14})\s+Share Price\b/);
    if (sharePriceMatch) {
      return normalizeSymbol(sharePriceMatch[1]);
    }

    const parenMatch = text.match(/\(([A-Z][A-Z0-9.\-]{1,14})\)/);
    if (parenMatch) {
      return normalizeSymbol(parenMatch[1]);
    }
  }

  return "";
}

function extractTickertapeTicker() {
  const titleCandidates = [
    document.querySelector('meta[property="og:title"]')?.content || "",
    document.querySelector('meta[name="twitter:title"]')?.content || "",
    document.querySelector('meta[name="title"]')?.content || "",
    document.title || ""
  ];

  for (const text of titleCandidates) {
    const sharePriceMatch = text.match(/\b([A-Z][A-Z0-9.\-]{1,14})\s+Share Price\b/);
    if (sharePriceMatch) {
      return normalizeSymbol(sharePriceMatch[1]);
    }
  }

  const ldJsonScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of ldJsonScripts) {
    const text = script.textContent || "";
    const identifierMatch = text.match(/"(?:identifier|name)"\s*:\s*"(?:NSE|BSE):([A-Z][A-Z0-9.\-]{1,14})"/i);
    if (identifierMatch) {
      return normalizeSymbol(identifierMatch[1]);
    }
  }

  return "";
}

function extractTijoriTicker() {
  const companyDataEl = document.getElementById("company_details_data");
  if (companyDataEl?.textContent) {
    try {
      const parsed = JSON.parse(companyDataEl.textContent);
      const fromJson = normalizeSymbol(parsed?.symbol || "");
      if (fromJson) {
        return fromJson;
      }
    } catch (_error) {
      // Fall back to DOM text parser.
    }
  }

  const domSymbol = normalizeSymbol(document.querySelector(".symbol")?.textContent || "");
  if (domSymbol) {
    return domSymbol;
  }

  return "";
}

function extractNseQuoteTicker(pathname) {
  const match = String(pathname || "").match(
    /\/get-quote\/equity\/[A-Z0-9.\-]{1,30}\/([A-Z0-9\-]{2,80})(?:[/?#]|$)/i
  );
  if (!match) {
    return "";
  }

  const cleaned = match[1]
    .toUpperCase()
    .replace(/[^A-Z0-9\-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);

  return normalizeSymbol(cleaned);
}

function extractBseQuoteTicker(pathname) {
  const match = String(pathname || "").match(
    /\/stock-share-price\/[a-z0-9\-]{2,120}\/([a-z0-9.\-]{1,20})\/[0-9]{3,12}(?:[/?#]|$)/i
  );
  if (!match) {
    return "";
  }

  return normalizeSymbol(match[1]);
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
