// This file is injected on-demand via chrome.scripting.executeScript from
// background.js. It runs in the page context, extracts a stock symbol, and
// returns the result. There is no persistent message listener.

(() => {
  const candidates = [];
  const href = window.location.href || "";
  const pathname = window.location.pathname || "";
  const title = document.title || "";
  const host = window.location.hostname || "";

  function pushMatches(list, input, regex, confidence, source) {
    if (!input) return;
    let match;
    while ((match = regex.exec(input)) !== null) {
      list.push({ symbol: match[1], confidence, source });
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
    if (!symbol || symbol.length < 1 || symbol.length > 20) return false;
    if (/^(HTTP|HTTPS|WWW|COM|HTML|LOGIN|NEWS|STOCK|QUOTE|MONEYCONTROL|SCREENER|TICKERTAPE)$/.test(symbol)) return false;
    return /^[A-Z][A-Z0-9.\-:^]*$/.test(symbol);
  }

  // --- Generic URL / title detections ---
  pushMatches(candidates, href, /(?:[?&](?:symbol|ticker|s|stock|scId)=)([A-Z0-9.\-:]{1,20})/gi, 0.96, "url_query");
  pushMatches(candidates, pathname, /\/(?:quote|stocks|symbol|equity|stock|company)\/([A-Z0-9.\-]{1,20})(?:[/?#]|$)/gi, 0.9, "url_path");

  // --- Site-specific detections ---
  if (host.includes("screener.in")) {
    pushMatches(candidates, pathname, /\/company\/([A-Z0-9.\-]{1,20})(?:[/?#]|$)/gi, 0.99, "screener_company");
  }

  if (host.includes("moneycontrol.com")) {
    // 1. Best source: nseid hidden input (only on stockpricequote pages, client-rendered)
    const nseidEl = document.getElementById("nseid");
    const nseidValue = normalizeSymbol(nseidEl?.value || "");
    if (nseidValue && !/^(NA|NIL|NONE|NULL|0)$/.test(nseidValue)) {
      candidates.push({ symbol: nseidValue, confidence: 1, source: "moneycontrol_nseid" });
    }

    // 1b. Also highly reliable: inline scripts with nseId (works on TA pages and before DOM fully mounts)
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const match = (script.textContent || "").match(/(?:"nseid"|"nseId"|var\s+nseId)\s*[:=]\s*"([A-Z0-9.\-]+)"/i);
      if (match && match[1]) {
        const val = normalizeSymbol(match[1]);
        if (val && !/^(NA|NIL|NONE|NULL|0)$/.test(val)) {
          candidates.push({ symbol: val, confidence: 1, source: "moneycontrol_script_nseid" });
          break;
        }
      }
    }

    // 2. Detect NSE/BSE ticker from page text / title
    pushMatches(candidates, `${href} ${title}`, /(?:NSE|BSE)\s*[:|-]\s*([A-Z][A-Z0-9.\-]{1,10})/gi, 0.94, "moneycontrol_exchange");

    // 3. Extract company slug from stockpricequote OR technical-analysis URLs
    //    stockpricequote: /india/stockpricequote/{sector}/{company-slug}/{mc-code}
    //    technical-analysis: /technical-analysis/{company-slug}/{mc-code}/{timeframe}
    const mcSlugMatch = String(pathname || "").match(
      /\/india\/stockpricequote\/[^/]+\/([a-z0-9-]{2,60})\/[a-z0-9-]{1,20}(?:[/?#]|$)/i
    ) || String(pathname || "").match(
      /\/technical-analysis\/([a-z0-9-]{2,60})\/[a-z0-9-]{1,20}(?:\/[a-z0-9-]{1,20})?(?:[/?#]|$)/i
    );
    if (mcSlugMatch) {
      const rawSlug = mcSlugMatch[1].replace(/-+/g, "");
      const slug = normalizeSymbol(rawSlug);
      if (slug) {
        // Try as-is first (some slugs happen to be tickers e.g. "LT")
        candidates.push({ symbol: slug, confidence: 0.85, source: "moneycontrol_company_slug" });
      }
    }
  }

  if (host.includes("tickertape.in")) {
    const ttTitleCandidates = [
      document.querySelector('meta[property="og:title"]')?.content || "",
      document.querySelector('meta[name="twitter:title"]')?.content || "",
      document.querySelector('meta[name="title"]')?.content || "",
      document.title || ""
    ];
    for (const text of ttTitleCandidates) {
      const m = text.match(/\b([A-Z][A-Z0-9.\-]{1,14})\s+Share Price\b/);
      if (m) { candidates.push({ symbol: normalizeSymbol(m[1]), confidence: 0.995, source: "tickertape_meta" }); break; }
    }
    const ldJsonScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldJsonScripts) {
      const idMatch = (script.textContent || "").match(/"(?:identifier|name)"\s*:\s*"(?:NSE|BSE):([A-Z][A-Z0-9.\-]{1,14})"/i);
      if (idMatch) { candidates.push({ symbol: normalizeSymbol(idMatch[1]), confidence: 0.995, source: "tickertape_meta" }); break; }
    }
    pushMatches(candidates, pathname, /\/stocks\/[^/]*-([A-Z0-9]{2,12})(?:[/?#]|$)/gi, 0.86, "tickertape_slug");
    pushMatches(candidates, href, /(?:\?|&)symbol=([A-Z0-9.\-:]{1,20})/gi, 0.9, "tickertape_query");
  }

  if (host.includes("chartink.com")) {
    pushMatches(candidates, pathname, /\/stocks\/([A-Z0-9.\-]{1,20})\.html(?:[/?#]|$)/gi, 0.99, "chartink_stock_page");
  }

  if (host.includes("kite.zerodha.com")) {
    pushMatches(candidates, pathname, /\/markets\/chart\/[^/]+\/[^/]+\/(?:NSE|BSE)\/([A-Z0-9.\-]{1,20})\/\d+(?:[/?#]|$)/gi, 0.99, "kite_chart");
  }

  if (host.includes("marketsmojo.com")) {
    const mmTitleCandidates = [
      document.querySelector('meta[property="og:title"]')?.content || "",
      document.querySelector('meta[name="twitter:title"]')?.content || "",
      document.title || ""
    ];
    for (const text of mmTitleCandidates) {
      const spMatch = text.match(/\b([A-Z][A-Z0-9.\-]{1,14})\s+Share Price\b/);
      if (spMatch) { candidates.push({ symbol: normalizeSymbol(spMatch[1]), confidence: 0.99, source: "marketsmojo_meta" }); break; }
      const pMatch = text.match(/\(([A-Z][A-Z0-9.\-]{1,14})\)/);
      if (pMatch) { candidates.push({ symbol: normalizeSymbol(pMatch[1]), confidence: 0.99, source: "marketsmojo_meta" }); break; }
    }
  }

  if (host.includes("tijorifinance.com")) {
    const companyDataEl = document.getElementById("company_details_data");
    if (companyDataEl?.textContent) {
      try {
        const parsed = JSON.parse(companyDataEl.textContent);
        const fromJson = normalizeSymbol(parsed?.symbol || "");
        if (fromJson) candidates.push({ symbol: fromJson, confidence: 0.995, source: "tijori_company_data" });
      } catch (_e) { /* fall through */ }
    }
    if (!candidates.some(c => c.source === "tijori_company_data")) {
      const domSymbol = normalizeSymbol(document.querySelector(".symbol")?.textContent || "");
      if (domSymbol) candidates.push({ symbol: domSymbol, confidence: 0.995, source: "tijori_company_data" });
    }
  }

  if (host.includes("nseindia.com")) {
    const nseMatch = String(pathname || "").match(
      /\/get-quote\/equity\/[A-Z0-9.\-]{1,30}\/([A-Z0-9\-]{2,80})(?:[/?#]|$)/i
    );
    if (nseMatch) {
      const cleaned = nseMatch[1].toUpperCase().replace(/[^A-Z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
      candidates.push({ symbol: normalizeSymbol(cleaned), confidence: 0.995, source: "nse_quote_company_slug" });
    }
  }

  if (host.includes("bseindia.com")) {
    const bseMatch = String(pathname || "").match(
      /\/stock-share-price\/[a-z0-9\-]{2,120}\/([a-z0-9.\-]{1,20})\/[0-9]{3,12}(?:[/?#]|$)/i
    );
    if (bseMatch) {
      candidates.push({ symbol: normalizeSymbol(bseMatch[1]), confidence: 0.995, source: "bse_quote_symbol_slug" });
    }
  }

  // --- Generic fallback detections ---
  pushMatches(candidates, title, /\(([A-Z][A-Z0-9.\-]{1,10})\)/g, 0.78, "title_paren");
  pushMatches(candidates, title, /\b([A-Z]{2,10})\b/g, 0.42, "title_token");

  const pageText = (document.body?.textContent || "").slice(0, 200000);
  pushMatches(candidates, pageText, /(?:NSE|BSE)\s*[:|-]\s*([A-Z][A-Z0-9.\-]{1,10})/gi, 0.92, "body_exchange");

  // --- Pick best candidate ---
  const filtered = candidates
    .map(c => ({ ...c, symbol: normalizeSymbol(c.symbol) }))
    .filter(c => !(c.source === "title_token" && /^(NSE|BSE)$/.test(c.symbol)))
    .filter(c => isLikelyTicker(c.symbol))
    .sort((a, b) => b.confidence - a.confidence);

  const best = filtered[0];
  if (!best) return { symbol: "", source: "none", confidence: 0 };
  return { symbol: best.symbol, source: best.source, confidence: best.confidence };
})();
