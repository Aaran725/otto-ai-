import { fetchStockBundle } from "./fmp";
import { runOttoAnalysis } from "./groq";

export interface DigestEntry {
  symbol: string;
  currentVerdict: string;
  currentScore: number;
  currentPrice: number;
}

// A digest that ran the full pipeline for an unbounded watchlist would be
// the same cost as the user manually re-searching every single name at
// once — bounded here the same way the portfolio-analysis route already
// bounds its own symbol count, just tighter, since this does real
// multi-source fetch + LLM synthesis per symbol, not just a price series.
const MAX_DIGEST_SYMBOLS = 10;

/**
 * "Automate the standing watch" — the diff itself (see WhatChangedBanner /
 * getPriorCall) already exists and fires on a manual re-search; this is
 * what makes it check itself instead of waiting for the user to ask.
 * Reuses the exact same 24h-cached runOttoAnalysis every other search path
 * uses, so opening the watchlist panel more than once a day is cheap
 * (cache hit) even though the first open each day pays the real cost.
 */
export async function buildWatchlistDigest(symbols: string[]): Promise<DigestEntry[]> {
  const capped = symbols.slice(0, MAX_DIGEST_SYMBOLS);
  const results = await Promise.all(
    capped.map(async (symbol): Promise<DigestEntry | null> => {
      try {
        const bundle = await fetchStockBundle(symbol);
        const analysis = await runOttoAnalysis(symbol, bundle);
        return { symbol, currentVerdict: analysis.verdict, currentScore: analysis.convictionScore, currentPrice: analysis.price };
      } catch {
        return null;
      }
    })
  );
  return results.filter((r): r is DigestEntry => r !== null);
}
