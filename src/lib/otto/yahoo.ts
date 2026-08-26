import type { FmpHistoricalPricePoint } from "./fmp";

const YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/**
 * Yahoo's unofficial chart endpoint needs no auth at all — used as a last
 * resort when FMP's /historical-price-eod is blocked (402) for a ticker
 * (same whitelist pattern as CRWD/RDDT/TEM/MARA). Unofficial and could
 * break without notice, so it only ever supplements FMP, never replaces it.
 */
export async function fetchYahooHistoricalMonthly(symbol: string): Promise<FmpHistoricalPricePoint[]> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1mo`,
      { headers: { "User-Agent": YAHOO_UA }, next: { revalidate: 3600 } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const timestamps: number[] | undefined = result?.timestamp;
    const quote = result?.indicators?.quote?.[0];
    const closes: (number | null)[] | undefined = quote?.close;
    const opens: (number | null)[] | undefined = quote?.open;
    const highs: (number | null)[] | undefined = quote?.high;
    const lows: (number | null)[] | undefined = quote?.low;
    if (!timestamps || !closes) return [];

    const points: FmpHistoricalPricePoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close === null || close === undefined) continue;
      const open = opens?.[i];
      const high = highs?.[i];
      const low = lows?.[i];
      points.push({
        symbol,
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        price: close,
        volume: 0,
        ...(open != null && high != null && low != null ? { open, high, low } : {}),
      });
    }
    return points.slice(-12);
  } catch {
    return [];
  }
}

interface YahooCrumbSession {
  cookie: string;
  crumb: string;
  fetchedAt: number;
}

const globalForYahoo = globalThis as unknown as { __ottoYahooSession?: YahooCrumbSession };
const CRUMB_TTL_MS = 45 * 60 * 1000;

async function getYahooSession(): Promise<YahooCrumbSession | null> {
  const cached = globalForYahoo.__ottoYahooSession;
  if (cached && Date.now() - cached.fetchedAt < CRUMB_TTL_MS) return cached;

  try {
    const cookieRes = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": YAHOO_UA } });
    const setCookie = cookieRes.headers.get("set-cookie");
    const cookie = setCookie?.split(";")[0];
    if (!cookie) return null;

    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": YAHOO_UA, Cookie: cookie },
    });
    if (!crumbRes.ok) return null;
    const crumb = await crumbRes.text();
    if (!crumb || crumb.includes("Invalid")) return null;

    const session: YahooCrumbSession = { cookie, crumb, fetchedAt: Date.now() };
    globalForYahoo.__ottoYahooSession = session;
    return session;
  } catch {
    return null;
  }
}

interface YahooRecommendationTrendEntry {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

interface YahooQuoteSummaryResponse {
  quoteSummary?: {
    result?: [
      {
        financialData?: {
          targetHighPrice?: { raw?: number };
          targetLowPrice?: { raw?: number };
          targetMeanPrice?: { raw?: number };
          targetMedianPrice?: { raw?: number };
          numberOfAnalystOpinions?: { raw?: number };
        };
        recommendationTrend?: { trend?: YahooRecommendationTrendEntry[] };
      },
    ];
  };
}

export interface YahooPriceTarget {
  targetHigh: number;
  targetLow: number;
  targetConsensus: number;
  targetMedian: number;
  ratingCounts: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number };
}

/**
 * Fallback for real $ analyst price targets when FMP blocks
 * /price-target-consensus for a ticker. Unofficial Yahoo endpoint needing a
 * cookie+crumb handshake (cached ~45min) — best-effort only, degrades to
 * Finnhub's ratings-only consensus (or nothing) if this fails.
 */
export async function fetchYahooPriceTarget(symbol: string): Promise<YahooPriceTarget | null> {
  const session = await getYahooSession();
  if (!session) return null;

  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData,recommendationTrend&crumb=${encodeURIComponent(session.crumb)}`,
      { headers: { "User-Agent": YAHOO_UA, Cookie: session.cookie }, next: { revalidate: 3600 } }
    );
    if (!res.ok) {
      // Crumb likely expired/invalidated — drop it so the next call re-negotiates.
      globalForYahoo.__ottoYahooSession = undefined;
      return null;
    }
    const data = (await res.json()) as YahooQuoteSummaryResponse;
    const fd = data.quoteSummary?.result?.[0]?.financialData;
    const trend = data.quoteSummary?.result?.[0]?.recommendationTrend?.trend?.[0];
    if (!fd?.targetMeanPrice?.raw) return null;

    return {
      targetHigh: fd.targetHighPrice?.raw ?? fd.targetMeanPrice.raw,
      targetLow: fd.targetLowPrice?.raw ?? fd.targetMeanPrice.raw,
      targetConsensus: fd.targetMeanPrice.raw,
      targetMedian: fd.targetMedianPrice?.raw ?? fd.targetMeanPrice.raw,
      ratingCounts: trend
        ? {
            strongBuy: trend.strongBuy,
            buy: trend.buy,
            hold: trend.hold,
            sell: trend.sell,
            strongSell: trend.strongSell,
          }
        : { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 },
    };
  } catch {
    return null;
  }
}
