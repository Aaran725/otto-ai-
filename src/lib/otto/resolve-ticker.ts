import { searchTicker, type FmpSearchResult } from "./fmp";
import { resolveTickerViaFinnhub } from "./finnhub";
import { searchSecUniverseByName } from "./sec-universe";

// Common short English words that would otherwise look like tickers (all-caps
// after normalization, <=5 letters) — excluded so "IS UBER A BUY" doesn't
// try to resolve "IS" or "BUY" as symbols.
const STOPWORDS = new Set([
  "A", "I", "IS", "IT", "OK", "UP", "GO", "NO", "SO", "ON", "IN", "OF", "TO",
  "THE", "AND", "FOR", "ARE", "BUY", "SELL", "HOLD", "ARE", "CEO", "CFO",
  "ROI", "ROIC", "FCF", "P/E", "PE", "PEG", "ETF", "USD", "AI", "API", "GOOD",
  "BAD", "WHY", "WHAT", "HOW", "TELL", "ME", "ABOUT", "STOCK", "SHARE",
  "SHARES", "PRICE", "NOW", "TODAY",
]);

/** Exported for the regression suite (resolve-ticker.test.ts) — this is the
 * pure, network-free logic behind most of the word-collision bugs this
 * session found and fixed ("P/E" -> stray "P" candidate, etc). */
export function extractExplicitCandidates(text: string): string[] {
  const matches = text.match(/\$?[A-Za-z]{1,5}\b/g) ?? [];
  const candidates: string[] = [];
  for (const raw of matches) {
    const hadDollar = raw.startsWith("$");
    const token = raw.replace("$", "");
    const upper = token.toUpperCase();
    if (STOPWORDS.has(upper)) continue;
    // A bare (non-$) single letter is too noisy to trust as a ticker — it's
    // far more often a stray fragment of a ratio abbreviation the "/" split
    // apart ("P/E", "P/B", "P/S" -> "P", "E"/"B"/"S" as separate tokens)
    // than an intentional mention of a real single-letter ticker (F, T, C).
    // A real single-letter ticker mention should use $F/$T/$C, which still
    // passes via hadDollar below.
    if (!hadDollar && token.length < 2) continue;
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

// A comparison view needs at least 2 to mean anything and stays readable up
// to 3 — capped here (not left open-ended) so one message naming a long run
// of stray all-caps words can't fan out into a 10-way comparison nobody
// asked for.
const MAX_COMPARISON_TICKERS = 3;

/**
 * Like resolveExplicitTicker, but keeps resolving past the first hit instead
 * of returning on it — resolveExplicitTicker collapses "compare NVDA and
 * AMD" down to just NVDA, silently discarding AMD. This is what lets a
 * multi-ticker message actually surface every real symbol it named, for
 * comparison mode. Same trust model: only explicit ($TICKER or literal
 * all-caps token) candidates, same FMP-then-Finnhub verification per
 * candidate, no fuzzy matching.
 */
export async function resolveExplicitTickers(text: string, max = MAX_COMPARISON_TICKERS): Promise<ResolvedTicker[]> {
  const explicit = extractExplicitCandidates(text);
  const resolved: ResolvedTicker[] = [];
  const seen = new Set<string>();

  for (const candidate of explicit) {
    if (resolved.length >= max) break;
    const result = await searchTicker(candidate).catch(() => null);
    if (result && result.symbol.replace(/\..*$/, "") === candidate && !seen.has(result.symbol)) {
      seen.add(result.symbol);
      resolved.push(result);
    }
  }
  // Finnhub fallback only for candidates FMP couldn't resolve at all — same
  // two-pass structure as resolveExplicitTicker, extended to keep collecting
  // instead of stopping at the first success.
  if (resolved.length < max) {
    for (const candidate of explicit) {
      if (resolved.length >= max) break;
      if ([...seen].some((s) => s.replace(/\..*$/, "") === candidate)) continue;
      const fallback = await resolveTickerViaFinnhub(candidate).catch(() => null);
      if (fallback && !seen.has(fallback.symbol)) {
        seen.add(fallback.symbol);
        resolved.push(fallback);
      }
    }
  }
  return resolved;
}

/**
 * Only the unambiguous signals: a literal $TICKER or an all-caps token the
 * user actually typed. Safe to trust immediately, with no risk of a
 * screen-y phrase ("mega cap stocks", "P/E under 30") getting misread as a
 * company mention — unlike the whole-message fuzzy fallback below, which
 * keys on loose word overlap and needs a screen-request check to run first.
 *
 * FMP's /search-symbol quota has run out entirely more than once this
 * session — when that happens every ticker lookup used to die with a
 * generic "give me a ticker" reply, even for something as unambiguous as
 * "AAPL". Each candidate now falls back to a direct Finnhub quote check
 * (confirms the symbol actually trades) before giving up.
 */
export async function resolveExplicitTicker(text: string): Promise<ResolvedTicker | null> {
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
  return null;
}

/**
 * Whole-message fuzzy company-name match — deliberately a *last resort*.
 * Any phrase that happens to share a word with a real company name ("Apple",
 * "Rocket", "Under [Armour]", "Safe [Bulkers]") can misfire here, so callers
 * must only reach this after confirming the message isn't a market-screen
 * request (screen-y phrases regularly contain exactly this kind of
 * coincidental word overlap — confirmed live on "mega cap stocks like
 * Apple...", "any rocket stocks?", and "P/E under 30" all misresolving to a
 * single ticker before this split existed). Falls back to a free word-
 * overlap search against SEC's full universe when FMP's search is down.
 */
export async function resolveTickerByFuzzyName(text: string): Promise<ResolvedTicker | null> {
  // Only accept a match if the matched company name plausibly appears in
  // the text (avoids misfiring on generic questions like "what does ROIC
  // mean").
  const result = await searchTicker(text).catch(() => null);
  if (result) {
    const lowerText = text.toLowerCase();
    const nameWords = result.name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2 &&
          !["inc", "corp", "ltd", "the", "company", "group"].includes(w) &&
          // A bare number ("100", "500", "2000") is common in fund/index
          // names (Nasdaq 100, S&P 500, Russell 2000) but far too generic to
          // signal a real company mention — confirmed live: a follow-up
          // question containing "not 100 what analysts say" fuzzy-matched
          // "Nuveen Nasdaq 100 Dynamic Overwrite Fund" purely off the digits.
          !/^\d+$/.test(w)
      );

    if (nameWords.some((w) => lowerText.includes(w))) return result;
  }

  const secMatch = await searchSecUniverseByName(text).catch(() => null);
  if (secMatch) {
    return { symbol: secMatch.symbol, name: secMatch.companyName, currency: "USD", exchange: "" };
  }

  return null;
}

/** Convenience wrapper for callers that don't need to gate the fuzzy fallback
 * behind their own screen-detection (e.g. one-off scripts/tests) — most
 * production call sites should use the two functions above directly so the
 * fuzzy fallback only runs after a screen check. */
export async function resolveTickerFromText(text: string): Promise<ResolvedTicker | null> {
  return (await resolveExplicitTicker(text)) ?? (await resolveTickerByFuzzyName(text));
}
