import { NextResponse } from "next/server";
import { fetchFinnhubQuote } from "@/lib/otto/finnhub";
import { fetchAlpacaHistoricalMonthly } from "@/lib/otto/alpaca";
import { fetchYahooHistoricalMonthly } from "@/lib/otto/yahoo";
import { mapWithConcurrency } from "@/lib/otto/batch";

interface TrackRecordRequestBody {
  symbols: string[];
}

/**
 * Returns current prices for a batch of previously-logged call symbols, so
 * the client can compute "Otto said Buy on X at $Y, it's now at $Z" without
 * spending any FMP quota — this is a mark-to-market check, not a full
 * analysis, so Finnhub's free quote endpoint (60 req/min/key, 5 keys) is
 * the right tool, not the 9-call FMP bundle.
 *
 * Also returns a real SPY benchmark series (monthly resolution, same
 * source used for every price chart in the app) — a raw "went up" win rate
 * doesn't tell you anything if the whole market went up over the same
 * stretch. The client matches each call's date to the nearest SPY point
 * and computes real alpha, not just direction.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as TrackRecordRequestBody;
  const symbols = [...new Set(body.symbols ?? [])].slice(0, 100); // bound one request's cost

  if (symbols.length === 0) {
    return NextResponse.json({ prices: {}, spy: { history: [], current: null } });
  }

  const [results, spyQuote, spyHistoryAlpaca] = await Promise.all([
    mapWithConcurrency(symbols, 15, async (symbol) => {
      const quote = await fetchFinnhubQuote(symbol).catch(() => null);
      return [symbol, quote?.price ?? null] as const;
    }),
    fetchFinnhubQuote("SPY").catch(() => null),
    fetchAlpacaHistoricalMonthly("SPY").catch(() => []),
  ]);
  const spyHistory = spyHistoryAlpaca.length > 0 ? spyHistoryAlpaca : await fetchYahooHistoricalMonthly("SPY").catch(() => []);

  const prices: Record<string, number | null> = Object.fromEntries(results);
  return NextResponse.json({
    prices,
    spy: {
      history: spyHistory.map((p) => ({ date: p.date, price: p.price })),
      current: spyQuote?.price ?? null,
    },
  });
}
