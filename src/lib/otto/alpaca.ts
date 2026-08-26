import type { FmpHistoricalPricePoint } from "./fmp";

const ALPACA_BASE = "https://data.alpaca.markets/v2";

function getAlpacaHeaders(): Record<string, string> | null {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) return null;
  return { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
}

interface AlpacaSnapshotResponse {
  dailyBar?: { c: number };
  prevDailyBar?: { c: number };
}

export interface AlpacaSnapshot {
  price: number;
  changePercent: number;
}

/**
 * Alpaca's free Basic tier (IEX feed, 200 req/min — confirmed live, far
 * more generous than FMP's 250/day) bundles the day's OHLC bar and the
 * previous day's close in one call — enough to derive a price + 1-day
 * change without needing FMP's /profile or /quote at all. No fundamentals
 * on this tier (confirmed: it's a pure market-data API), so this only ever
 * covers the price-snapshot piece of the pipeline.
 */
export async function fetchAlpacaSnapshot(symbol: string): Promise<AlpacaSnapshot | null> {
  const headers = getAlpacaHeaders();
  if (!headers) return null;
  try {
    const res = await fetch(`${ALPACA_BASE}/stocks/${encodeURIComponent(symbol)}/snapshot?feed=iex`, { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as AlpacaSnapshotResponse;
    const close = data.dailyBar?.c;
    if (close === undefined) return null;
    const prevClose = data.prevDailyBar?.c;
    const changePercent = prevClose ? ((close - prevClose) / prevClose) * 100 : 0;
    return { price: close, changePercent };
  } catch {
    return null;
  }
}

interface AlpacaBar {
  c: number;
  o: number;
  h: number;
  l: number;
  t: string; // ISO timestamp
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[];
}

/**
 * Historical monthly closes — same role as the Yahoo fallback, tried first
 * since this is an authenticated, official API with a generous documented
 * quota rather than an unofficial endpoint that could break without notice
 * (confirmed live: default feed 403s with "subscription does not permit
 * querying recent SIP data" — `feed=iex` is required on the Basic tier).
 */
export async function fetchAlpacaHistoricalMonthly(symbol: string): Promise<FmpHistoricalPricePoint[]> {
  const headers = getAlpacaHeaders();
  if (!headers) return [];
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 370 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const url = `${ALPACA_BASE}/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Month&start=${fmt(start)}&end=${fmt(end)}&limit=15&feed=iex`;
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as AlpacaBarsResponse;
    return (data.bars ?? []).slice(-12).map((b) => ({
      symbol,
      date: b.t.slice(0, 10),
      price: b.c,
      volume: 0,
      open: b.o,
      high: b.h,
      low: b.l,
    }));
  } catch {
    return [];
  }
}

export interface DailyPricePoint {
  date: string;
  price: number;
}

/**
 * Daily-granularity closes, distinct from the monthly fetcher above (which
 * SPY-vs-call-date tracking needs and shouldn't be disturbed). Correlation
 * math between finalists needs real daily returns — 12 monthly points is far
 * too coarse to compute a meaningful pairwise correlation. Same auth/error
 * pattern as fetchAlpacaHistoricalMonthly, just a different timeframe and no
 * 12-point cap.
 */
export async function fetchAlpacaHistoricalDaily(symbol: string, lookbackDays = 90): Promise<DailyPricePoint[]> {
  const headers = getAlpacaHeaders();
  if (!headers) return [];
  try {
    const end = new Date();
    const start = new Date(end.getTime() - (lookbackDays + 10) * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const url = `${ALPACA_BASE}/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${fmt(start)}&end=${fmt(end)}&limit=${lookbackDays + 10}&feed=iex`;
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as AlpacaBarsResponse;
    return (data.bars ?? []).slice(-lookbackDays).map((b) => ({
      date: b.t.slice(0, 10),
      price: b.c,
    }));
  } catch {
    return [];
  }
}
