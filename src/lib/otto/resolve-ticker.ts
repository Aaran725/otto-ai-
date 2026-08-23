import { searchTicker, type FmpSearchResult } from "./fmp";
import { resolveTickerViaFinnhub } from "./finnhub";
import { searchSecUniverseByName } from "./sec-universe";

// Common short English words that would otherwise look like tickers (all-caps
// after normalization, <=5 letters) — excluded so "IS UBER A BUY" doesn't
// try to resolve "IS" or "BUY" as symbols.
const STOPWORDS = new Set([
  "A", "I", "IS", "IT", "OK", "UP", "GO", "NO", "SO", "ON", "IN", "OF", "TO",
  "THE", "AND", "FOR", "ARE", "BUY", "SELL", "HOLD", "ARE", "CEO", "CFO",
  "ROI", "ROIC", "FCF", "P/E", "PE", "ETF", "USD", "AI", "API", "GOOD",
  "BAD", "WHY", "WHAT", "HOW", "TELL", "ME", "ABOUT", "STOCK", "SHARE",
  "SHARES", "PRICE", "NOW", "TODAY",
]);

function extractExplicitCandidates(text: string): string[] {
  const matches = text.match(/\$?[A-Za-z]{1,5}\b/g) ?? [];
  const candidates: string[] = [];
  for (const raw of matches) {
    const hadDollar = raw.startsWith("$");
    const token = raw.replace("$", "");
    const upper = token.toUpperCase();
    if (STOPWORDS.has(upper)) continue;
    // A bare $XYZ is always a strong signal; a bare all-caps token (as the
    // user typed it, e.g. "UBER") also counts. Lowercase words are skipped
    // here — they fall through to the name-search path instead.
    if (hadDollar || token === upper) {
      candidates.push(upper);
    }
  }
  return candidates;
}

export interface ResolvedTicker extends FmpSearchResult {}

/**
 * FMP's /search-symbol and /search-name are the primary resolver, but FMP's
 * shared 250-req/day-per-key quota has run out entirely more than once this
 * session — when that happens every single ticker lookup used to die with
 * a generic "give me a ticker" reply, even for something as unambiguous as
 * "AAPL". Each explicit candidate now falls back to a direct Finnhub quote
 * check (confirms the symbol actually trades) before giving up, and the
 * whole-message company-name path falls back to a free word-overlap search
 * against SEC's full ticker universe. Neither fallback is as good as FMP's
 * real search, but "works, cruder" beats "the whole pipeline is down."
 */
export async function resolveTickerFromText(
  text: string,
  opts: { skipFuzzyNameMatch?: boolean } = {}
): Promise<ResolvedTicker | null> {
  const explicit = extractExplicitCandidates(text);

  for (const candidate of explicit) {
    const result = await searchTicker(candidate).catch(() => null);
    if (result && result.symbol.replace(/\..*$/, "") === candidate) {
      return result;
    }
  }
  for (const candidate of explicit) {
    const fallback = await resolveTickerViaFinnhub(candidate).catch(() => null);
    if (fallback) return fallback;
  }

  // Callers that already detected a market-screen request (e.g. "mega cap
  // stocks", "any rocket stocks?") skip the fuzzy whole-message match below —
  // a screen-y phrase that happens to share a word with a real company name
  // ("Apple", "Rocket", "Safe") would otherwise get misrouted to that single
  // ticker instead of running the screener across hundreds of candidates.
  if (opts.skipFuzzyNameMatch) return null;

  // Fallback: try resolving the whole message as a company name, but only
  // accept it if the matched company name plausibly appears in the text
  // (avoids misfiring on generic questions like "what does ROIC mean").
  const result = await searchTicker(text).catch(() => null);
  if (result) {
    const lowerText = text.toLowerCase();
    const nameWords = result.name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !["inc", "corp", "ltd", "the", "company", "group"].includes(w));

    if (nameWords.some((w) => lowerText.includes(w))) return result;
  }

  const secMatch = await searchSecUniverseByName(text).catch(() => null);
  if (secMatch) {
    return { symbol: secMatch.symbol, name: secMatch.companyName, currency: "USD", exchange: "" };
  }

  return null;
}
