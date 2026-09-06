import { getMacroCache } from "./cache";

/**
 * Kalshi's real, public, no-auth-required prediction-market API — verified
 * live: `GET /trade-api/v2/markets?series_ticker=KXFED&status=open` returns
 * a real threshold ladder per upcoming FOMC meeting (e.g. "Above 3.75%"),
 * each with real yes/no bid-ask pricing from real trades, not a survey.
 *
 * `applyRegimeTilt` (screener.ts) already tilts scoring weights on the Fed
 * funds rate — but FRED's FEDFUNDS series is the rate as of its last
 * observation, backward-looking. Kalshi's markets price where the rate
 * will actually land after the *next* meeting, continuously, from real
 * money — a genuinely more forward-looking input to the exact same tilt
 * logic, not a new mechanism. This module produces one number
 * (fetchImpliedFedFundsRate) that's a drop-in alternative to
 * macro.fedFundsRate; applyRegimeTilt itself needs no changes at all.
 */
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

interface KalshiMarket {
  event_ticker: string;
  close_time: string;
  floor_strike: number;
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  status: string;
}

interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor: string;
}

/**
 * The market's median-implied fed funds upper bound after the next FOMC
 * meeting — found by interpolating where the real "yes" probability
 * (rate ends up ABOVE this threshold) crosses 50% across the real
 * threshold ladder. Real math on real prices, not a guess: if the ladder
 * never actually crosses 50% in the observed strike range (all thresholds
 * priced near-certain either way), there's nothing honest to interpolate
 * and this returns null rather than extrapolating past real data.
 */
function impliedMedianStrike(markets: { floorStrike: number; yesProb: number }[]): number | null {
  const sorted = [...markets].sort((a, b) => a.floorStrike - b.floorStrike);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    // Ladder is "probability rate is ABOVE this threshold" — strictly
    // decreasing as the threshold rises. Find the one bracket where it
    // actually crosses the 50% midpoint.
    if (a.yesProb >= 0.5 && b.yesProb < 0.5) {
      const frac = (a.yesProb - 0.5) / (a.yesProb - b.yesProb);
      return a.floorStrike + frac * (b.floorStrike - a.floorStrike);
    }
  }
  return null;
}

/**
 * Real, live, cached (6h — matches the macro cache's own cadence, these
 * markets don't need to be re-read more often than the rest of the macro
 * context) implied fed funds rate from Kalshi's nearest upcoming FOMC
 * event. Returns null on any real failure (network, no open markets, no
 * clean 50% crossing) — the caller is expected to fall back to FRED's
 * actual current rate, never to treat null as "0% expected rate."
 */
export async function fetchImpliedFedFundsRate(): Promise<number | null> {
  return getMacroCache<number | null>().getOrSet("kalshi-implied-fedfunds", async () => {
    try {
      const res = await fetch(`${KALSHI_BASE}/markets?series_ticker=KXFED&status=open&limit=200`);
      if (!res.ok) return null;
      const data = (await res.json()) as KalshiMarketsResponse;
      if (!data.markets?.length) return null;

      // Group by event (one event per FOMC meeting date), pick the
      // soonest real close_time — the next actual decision, not a later
      // one further out on the calendar.
      const byEvent = new Map<string, KalshiMarket[]>();
      for (const m of data.markets) {
        if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []);
        byEvent.get(m.event_ticker)!.push(m);
      }
      const nextEvent = [...byEvent.values()].sort(
        (a, b) => new Date(a[0].close_time).getTime() - new Date(b[0].close_time).getTime()
      )[0];
      if (!nextEvent) return null;

      const ladder = nextEvent
        .map((m) => {
          const bid = Number(m.yes_bid_dollars);
          const ask = Number(m.yes_ask_dollars);
          if (Number.isNaN(bid) || Number.isNaN(ask)) return null;
          return { floorStrike: m.floor_strike, yesProb: (bid + ask) / 2 };
        })
        .filter((r): r is { floorStrike: number; yesProb: number } => r !== null);

      return impliedMedianStrike(ladder);
    } catch {
      return null;
    }
  });
}
