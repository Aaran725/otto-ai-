import { getFmpCache } from "./cache";
import { fetchFinnhubFundamentals, fetchFinnhubFinancialsTrend, fetchFinnhubProfile2, fetchFinnhubQuote } from "./finnhub";
import { fetchYahooHistoricalMonthly } from "./yahoo";
import { fetchAlpacaSnapshot, fetchAlpacaHistoricalMonthly } from "./alpaca";
import { fetchCikForSymbol } from "./sec-universe";
import type { ProgressFn } from "./chat-types";

const FMP_BASE = "https://financialmodelingprep.com/stable";

function getFmpKeys(): string[] {
  return [
    process.env.FMP_API_KEY,
    process.env.FMP_API_KEY_2,
    process.env.FMP_API_KEY_3,
    process.env.FMP_API_KEY_4,
    process.env.FMP_API_KEY_5,
    process.env.FMP_API_KEY_6,
  ].filter((k): k is string => Boolean(k));
}

/** Tags whether rotating to another key could plausibly help. A 429 or a
 * "Limit Reach" body means THIS key's quota is spent — try the next one. A
 * 402 / "Premium Query Parameter" restriction is a per-ticker data-plan gate
 * that's very likely shared across all free-tier accounts, so burning
 * through every key on it would waste quota for nothing. */
class FmpApiError extends Error {
  constructor(message: string, public isRateLimit: boolean) {
    super(message);
  }
}

// Sticky cursor: once a key gets rate-limited, every subsequent call starts
// from the next one directly rather than re-trying (and re-failing) the
// exhausted key first on every request.
const globalForFmpRotation = globalThis as unknown as { __ottoFmpKeyIndex?: number };

async function fmpRequest<T>(path: string, params: Record<string, string>, apiKey: string): Promise<T> {
  const url = new URL(`${FMP_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString(), { next: { revalidate: 300 } });

  if (res.status === 429) {
    throw new FmpApiError("FMP rate limit reached on this key", true);
  }
  if (res.status === 402) {
    throw new FmpApiError(
      `Price data for "${params.symbol}" isn't available on the current data plan.`,
      false
    );
  }
  if (!res.ok) {
    throw new FmpApiError(`FMP request failed (${res.status}) for ${path}`, false);
  }
  const data = await res.json();
  if (data && typeof data === "object" && "Error Message" in data) {
    const msg = String(data["Error Message"]);
    throw new FmpApiError(`FMP error: ${msg}`, /limit reach/i.test(msg));
  }
  return data as T;
}

async function fmpGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const keys = getFmpKeys();
  if (keys.length === 0) throw new Error("FMP_API_KEY is not set");

  const startIndex = globalForFmpRotation.__ottoFmpKeyIndex ?? 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (startIndex + attempt) % keys.length;
    try {
      const result = await fmpRequest<T>(path, params, keys[idx]);
      globalForFmpRotation.__ottoFmpKeyIndex = idx;
      return result;
    } catch (err) {
      lastError = err;
      if (err instanceof FmpApiError && err.isRateLimit) continue;
      throw err; // not a rate-limit error — another key won't fix it
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All FMP keys are rate-limited");
}

/** Raw shape of the /quote endpoint. On this FMP key it's blocked for a
 * seemingly arbitrary whitelist of tickers (large, liquid names like RDDT
 * and CRWD included) — so it's treated as a bonus source, never required. */
export interface FmpQuote {
  symbol: string;
  name: string;
  price: number;
  changePercentage: number;
  marketCap: number;
  yearHigh: number;
  yearLow: number;
  priceAvg50: number;
  priceAvg200: number;
}

/** /profile has been reliable for every ticker tested so far, including
 * ones /quote blocks — it's the primary price source. */
export interface FmpProfile {
  symbol: string;
  companyName: string;
  currency: string;
  industry: string;
  sector: string;
  description: string;
  price: number;
  marketCap: number;
  change: number;
  changePercentage: number;
  cik?: string;
  isEtf?: boolean;
  isFund?: boolean;
}

/** The merged, always-present price snapshot used throughout the app.
 * Core fields come from /profile; yearHigh/yearLow/priceAvg50/priceAvg200
 * are bonus fields from /quote and are undefined when that endpoint is
 * blocked for this ticker. */
export interface PriceSnapshot {
  symbol: string;
  name: string;
  price: number;
  changePercentage: number;
  marketCap: number;
  currency: string;
  yearHigh?: number;
  yearLow?: number;
  priceAvg50?: number;
  priceAvg200?: number;
}

export interface FmpRatios {
  symbol: string;
  fiscalYear: string;
  priceToEarningsRatio?: number;
  priceToEarningsGrowthRatio?: number;
  priceToFreeCashFlowRatio?: number;
  priceToBookRatio?: number;
  priceToSalesRatio?: number;
  debtToEquityRatio?: number;
  currentRatio?: number;
  quickRatio?: number;
  cashRatio?: number;
  interestCoverageRatio?: number;
  netProfitMargin?: number;
  grossProfitMargin?: number;
  operatingProfitMargin?: number;
  /** Only populated by the Finnhub fallback — FMP's own /ratios doesn't include it. */
  revenueGrowthYoY?: number;
}

export interface FmpKeyMetrics {
  symbol: string;
  fiscalYear: string;
  returnOnInvestedCapital?: number;
  returnOnEquity?: number;
  freeCashFlowYield?: number;
  netDebtToEBITDA?: number;
  /** Only populated by the Finnhub fallback — real 13/26-week trailing price
   * return and 13-week performance vs the S&P 500, straight from Finnhub's
   * free /stock/metric response (already fetched for ratios/keyMetrics, so
   * this is zero extra API cost). Lets the momentum axis judge a sustained
   * multi-week trend instead of only today's 1-day move. */
  thirteenWeekReturn?: number;
  twentySixWeekReturn?: number;
  relativeStrength13Week?: number;
}

export interface FmpPriceTargetConsensus {
  symbol: string;
  targetHigh: number;
  targetLow: number;
  targetConsensus: number;
  targetMedian: number;
}

export interface FmpGradesConsensus {
  symbol: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  consensus: string;
}

export interface FmpHistoricalPricePoint {
  symbol: string;
  date: string;
  price: number;
  volume: number;
}

export interface FmpIncomeStatement {
  date: string;
  fiscalYear: string;
  revenue: number;
  netIncome: number;
}

export interface FmpCashFlowStatement {
  date: string;
  fiscalYear: string;
  netIncome: number;
  freeCashFlow: number;
  operatingCashFlow?: number;
  capex?: number; // always a positive magnitude, regardless of the source's sign convention
}

/** Raw FMP /cash-flow-statement shape — netCashProvidedByOperatingActivities
 * and investmentsInPropertyPlantAndEquipment (real fields, confirmed live)
 * were being silently discarded by the old FmpCashFlowStatement interface
 * even though the API already returns them; mapped into the clean
 * operatingCashFlow/capex names below rather than fetched separately. */
interface FmpCashFlowStatementRaw {
  date: string;
  fiscalYear: string;
  netIncome: number;
  freeCashFlow: number;
  netCashProvidedByOperatingActivities?: number;
  investmentsInPropertyPlantAndEquipment?: number;
}

export interface StockBundle {
  symbol: string;
  quote: PriceSnapshot;
  profile: FmpProfile | null;
  ratios: FmpRatios | null;
  keyMetrics: FmpKeyMetrics | null;
  priceTargetConsensus: FmpPriceTargetConsensus | null;
  gradesConsensus: FmpGradesConsensus | null;
  historicalMonthly: FmpHistoricalPricePoint[];
  income: FmpIncomeStatement[];
  cashFlow: FmpCashFlowStatement[];
}

/**
 * FMP restricts or errors on some endpoints for certain tickers depending on
 * plan/coverage (e.g. a 402 on historical prices for thinly-covered names).
 * Only the quote is load-bearing — everything else degrades gracefully to
 * an empty/null value rather than failing the whole analysis.
 */
export async function fmpGetOptional<T>(path: string, params: Record<string, string>, fallback: T): Promise<T> {
  try {
    return await fmpGet<T>(path, params);
  } catch {
    return fallback;
  }
}

export interface FmpMarketMover {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changesPercentage: number;
  exchange: string;
}

/** /company-screener, batch /quote, /sp500-constituent, and /stock-list are
 * all paid-only on this plan (confirmed live, not a quota artifact) — but
 * these "market movers" lists are free and are exactly what a momentum/
 * rocket-stock screen needs anyway. */
export async function fetchMostActive(): Promise<FmpMarketMover[]> {
  return fmpGetOptional<FmpMarketMover[]>("/most-actives", {}, []);
}

export async function fetchBiggestGainers(): Promise<FmpMarketMover[]> {
  return fmpGetOptional<FmpMarketMover[]>("/biggest-gainers", {}, []);
}

// Shortened from 3 min — the Finnhub fallback this now retries through
// (see finnhub.ts's finnhubGet) is materially more resilient, so a bundle
// that's still empty after that deserves a faster second chance.
const PARTIAL_BUNDLE_TTL_MS = 60 * 1000;

export async function fetchStockBundle(ticker: string, onProgress?: ProgressFn): Promise<StockBundle> {
  const symbol = ticker.toUpperCase();
  const cache = getFmpCache<StockBundle>();

  const cached = cache.get(symbol);
  if (cached) return cached; // cache hit: genuinely instant, no stages to report

  onProgress?.({ id: "market-data", text: `Pulling market data for ${symbol}…`, icon: "fmp", tracksFinding: true });
  const bundle = await buildStockBundle(symbol);
  onProgress?.({
    id: "market-data",
    text: `Pulling market data for ${symbol}…`,
    finding: bundle.profile ? "Live price, financials & ratios pulled" : "Price pulled — some fundamentals limited",
    icon: "fmp",
    tracksFinding: true,
  });

  // A fetch that came back empty due to a rate limit (not a genuine "this
  // ticker has no data") shouldn't get stuck behind the full TTL — that's
  // exactly what caused a ticker to show "unavailable" for the better part
  // of a day even after the underlying key/quota issue had cleared. Also
  // covers ratios/keyMetrics both failing (the AYI case: FMP paywalled all
  // three endpoints and the Finnhub fallback didn't land either) even when
  // history/income happened to come through some other way.
  const isPartial =
    bundle.historicalMonthly.length === 0 ||
    bundle.income.length === 0 ||
    (bundle.ratios === null && bundle.keyMetrics === null);
  cache.set(symbol, bundle, isPartial ? PARTIAL_BUNDLE_TTL_MS : undefined);
  return bundle;
}

/**
 * Reconstructs the handful of FmpProfile fields the rest of the pipeline
 * actually needs (price, name, currency, industry/sector, market cap) from
 * free sources when FMP's /profile itself is unavailable — not a data-plan
 * restriction like the whitelist gates elsewhere in this file, but FMP's
 * quota being fully exhausted, which used to take the entire analysis down
 * with it regardless of how many other fallbacks existed downstream.
 */
async function buildFallbackProfile(symbol: string): Promise<FmpProfile | null> {
  const [alpaca, finnhubProfile, finnhubQuote, cik] = await Promise.all([
    fetchAlpacaSnapshot(symbol),
    fetchFinnhubProfile2(symbol),
    fetchFinnhubQuote(symbol),
    fetchCikForSymbol(symbol).catch(() => null),
  ]);

  const price = alpaca?.price ?? finnhubQuote?.price;
  if (price === undefined) return null; // no source could confirm this symbol trades at all

  return {
    symbol,
    companyName: finnhubProfile.name ?? symbol,
    currency: finnhubProfile.currency ?? "USD",
    industry: finnhubProfile.industry ?? "",
    sector: finnhubProfile.industry ?? "",
    description: "",
    price,
    marketCap: finnhubProfile.marketCapMillions ? finnhubProfile.marketCapMillions * 1_000_000 : 0,
    change: 0,
    changePercentage: alpaca?.changePercent ?? finnhubQuote?.changePercent ?? 0,
    cik: cik ?? undefined,
  };
}

async function buildStockBundle(symbol: string): Promise<StockBundle> {
  const [profile, quoteExtras, ratios, keyMetrics, priceTargetConsensus, gradesConsensus, historical, income, cashFlow] =
      await Promise.all([
        fmpGetOptional<FmpProfile[]>("/profile", { symbol }, []),
        fmpGetOptional<FmpQuote[]>("/quote", { symbol }, []),
        fmpGetOptional<FmpRatios[]>("/ratios", { symbol, limit: "1" }, []),
        fmpGetOptional<FmpKeyMetrics[]>("/key-metrics", { symbol, limit: "1" }, []),
        fmpGetOptional<FmpPriceTargetConsensus[]>("/price-target-consensus", { symbol }, []),
        fmpGetOptional<FmpGradesConsensus[]>("/grades-consensus", { symbol }, []),
        fmpGetOptional<FmpHistoricalPricePoint[]>("/historical-price-eod/light", { symbol }, []),
        fmpGetOptional<FmpIncomeStatement[]>("/income-statement", { symbol, limit: "5" }, []),
        fmpGetOptional<FmpCashFlowStatementRaw[]>("/cash-flow-statement", { symbol, limit: "5" }, []),
      ]);

    let p: FmpProfile | undefined = profile?.[0];
    if (!p) {
      // FMP's /profile is the one call this whole pipeline used to have zero
      // fallback for — when FMP's quota ran out entirely (confirmed to
      // happen repeatedly this session), every single ticker lookup died
      // here regardless of how many other free sources were wired up.
      // Finnhub's profile2 + quote (or Alpaca's snapshot, tried first since
      // its 200 req/min quota is far more generous) can reconstruct the
      // handful of fields actually needed: price, name, currency, industry.
      p = (await buildFallbackProfile(symbol)) ?? undefined;
    }
    if (!p) {
      throw new Error(`No data found for ticker "${symbol}" — check the ticker is correct.`);
    }
    const q = quoteExtras?.[0];

    const quote: PriceSnapshot = {
      symbol,
      name: p.companyName,
      price: p.price,
      changePercentage: p.changePercentage,
      marketCap: p.marketCap,
      currency: p.currency,
      yearHigh: q?.yearHigh,
      yearLow: q?.yearLow,
      priceAvg50: q?.priceAvg50,
      priceAvg200: q?.priceAvg200,
    };

    let resolvedRatios = ratios?.[0] ?? null;
    let resolvedKeyMetrics = keyMetrics?.[0] ?? null;

    // FMP blocks /ratios and /key-metrics entirely for some large, liquid
    // tickers (confirmed: CRWD, RDDT, TEM) — fall back to Finnhub's free
    // metric endpoint rather than leaving Otto with zero fundamentals.
    if (!resolvedRatios && !resolvedKeyMetrics) {
      const fallback = await fetchFinnhubFundamentals(symbol);
      if (fallback) {
        resolvedRatios = fallback.ratios;
        resolvedKeyMetrics = fallback.keyMetrics;
      }
    }

    let resolvedIncome = (income ?? []).slice().reverse();
    let resolvedCashFlow: FmpCashFlowStatement[] = (cashFlow ?? [])
      .slice()
      .reverse()
      .map((c) => ({
        date: c.date,
        fiscalYear: c.fiscalYear,
        netIncome: c.netIncome,
        freeCashFlow: c.freeCashFlow,
        operatingCashFlow: c.netCashProvidedByOperatingActivities,
        capex:
          c.investmentsInPropertyPlantAndEquipment !== undefined
            ? Math.abs(c.investmentsInPropertyPlantAndEquipment)
            : undefined,
      }));

    // Same whitelist gate as ratios/key-metrics — FMP blocks
    // /income-statement and /cash-flow-statement for some tickers
    // regardless of size (confirmed: CRWD, RDDT, TEM, MARA). Fall back to
    // Finnhub's free financials-reported (real SEC filing data) instead of
    // leaving the fundamentals chart empty.
    if (resolvedIncome.length === 0) {
      const trend = await fetchFinnhubFinancialsTrend(symbol);
      if (trend) {
        resolvedIncome = trend.income;
        resolvedCashFlow = trend.cashFlow;
      }
    }

    // trim to ~12 monthly points, oldest first, from the daily series FMP returns newest-first
    let resolvedHistorical = sampleMonthly(historical ?? []);

    // FMP blocks /historical-price-eod for the same whitelist of tickers as
    // ratios/income/cashflow. Alpaca tried first — authenticated, official,
    // 200 req/min quota (confirmed live) — then Yahoo's unauthenticated
    // endpoint as a last resort before giving up on the price chart.
    if (resolvedHistorical.length === 0) {
      const alpacaHistorical = await fetchAlpacaHistoricalMonthly(symbol);
      if (alpacaHistorical.length > 0) {
        resolvedHistorical = alpacaHistorical;
      } else {
        const yahooHistorical = await fetchYahooHistoricalMonthly(symbol);
        if (yahooHistorical.length > 0) resolvedHistorical = yahooHistorical;
      }
    }

    return {
      symbol,
      quote,
      profile: p,
      ratios: resolvedRatios,
      keyMetrics: resolvedKeyMetrics,
      priceTargetConsensus: priceTargetConsensus?.[0] ?? null,
      gradesConsensus: gradesConsensus?.[0] ?? null,
      historicalMonthly: resolvedHistorical,
      income: resolvedIncome,
      cashFlow: resolvedCashFlow,
  };
}

export interface FmpSearchResult {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
}

/** Resolves free text ("uber", "apple stock") to the most likely US-listed ticker. */
export async function searchTicker(query: string): Promise<FmpSearchResult | null> {
  const bySymbol = await fmpGet<FmpSearchResult[]>("/search-symbol", { query }).catch(() => []);
  const byName = bySymbol.length
    ? []
    : await fmpGet<FmpSearchResult[]>("/search-name", { query }).catch(() => []);
  const results = [...bySymbol, ...byName];

  // Prefer plain US tickers (no exchange suffix like .SW, .DE) over foreign listings.
  const usListing = results.find((r) => !r.symbol.includes(".") && r.currency === "USD");
  return usListing ?? results[0] ?? null;
}

function sampleMonthly(points: FmpHistoricalPricePoint[]): FmpHistoricalPricePoint[] {
  const chronological = points.slice().reverse();
  const seenMonths = new Set<string>();
  const monthly: FmpHistoricalPricePoint[] = [];
  for (const p of chronological) {
    const month = p.date.slice(0, 7);
    if (!seenMonths.has(month)) {
      seenMonths.add(month);
      monthly.push(p);
    }
  }
  return monthly.slice(-12);
}
