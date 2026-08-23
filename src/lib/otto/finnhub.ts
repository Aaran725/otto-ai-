import type { FmpRatios, FmpKeyMetrics, FmpIncomeStatement, FmpCashFlowStatement } from "./fmp";

const FINNHUB_BASE = "https://finnhub.io/api/v1";

function getFinnhubKeys(): string[] {
  return [
    process.env.FINNHUB_API_KEY,
    process.env.FINNHUB_API_KEY_2,
    process.env.FINNHUB_API_KEY_3,
    process.env.FINNHUB_API_KEY_4,
    process.env.FINNHUB_API_KEY_5,
    process.env.FINNHUB_API_KEY_6,
  ].filter((k): k is string => Boolean(k));
}

class FinnhubApiError extends Error {
  constructor(message: string, public isRateLimit: boolean) {
    super(message);
  }
}

// Sticky cursor, same pattern as fmp.ts — once a key gets rate-limited,
// later calls start from the next key instead of re-failing the exhausted
// one first every time.
const globalForFinnhubRotation = globalThis as unknown as { __ottoFinnhubKeyIndex?: number };

async function finnhubRequest<T>(path: string, apiKey: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${FINNHUB_BASE}${path}${sep}token=${apiKey}`, { next: { revalidate: 300 } });
  if (res.status === 429) throw new FinnhubApiError("Finnhub rate limit reached on this key", true);
  if (!res.ok) throw new FinnhubApiError(`Finnhub request failed (${res.status})`, false);
  return (await res.json()) as T;
}

async function finnhubGet<T>(path: string): Promise<T | null> {
  const keys = getFinnhubKeys();
  if (keys.length === 0) return null;

  const startIndex = globalForFinnhubRotation.__ottoFinnhubKeyIndex ?? 0;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (startIndex + attempt) % keys.length;
    try {
      const result = await finnhubRequest<T>(path, keys[idx]);
      globalForFinnhubRotation.__ottoFinnhubKeyIndex = idx;
      return result;
    } catch (err) {
      if (err instanceof FinnhubApiError && err.isRateLimit) continue;
      return null; // non-rate-limit error: this is a best-effort source, fail soft
    }
  }
  return null; // every key rate-limited
}

interface FinnhubMetricResponse {
  metric: Record<string, number | null>;
}

/**
 * Field-scale note: Finnhub's `*Margin*`, `roe*`, `roi*` fields are already
 * percentage points (e.g. `grossMarginTTM: 75.16` means 75.16%) — divided
 * by 100 below to match our internal fraction convention (0.05 = 5%).
 * Ratio fields (P/E, P/B, P/S, current/quick ratio, D/E) are plain
 * multiples and need no conversion.
 */
export async function fetchFinnhubFundamentals(
  symbol: string
): Promise<{ ratios: FmpRatios; keyMetrics: FmpKeyMetrics } | null> {
  const data = await finnhubGet<FinnhubMetricResponse>(`/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`);
  const m = data?.metric;
  if (!m || Object.keys(m).length === 0) return null;

  const pct = (v: number | null | undefined) => (v === null || v === undefined ? undefined : v / 100);
  const pfcf = m.pfcfShareTTM ?? m.pfcfShareAnnual ?? undefined;

  const ratios: FmpRatios = {
    symbol,
    fiscalYear: "TTM",
    priceToEarningsRatio: m.peTTM ?? m.peBasicExclExtraTTM ?? undefined,
    priceToEarningsGrowthRatio: m.forwardPEG ?? undefined,
    priceToFreeCashFlowRatio: pfcf ?? undefined,
    priceToBookRatio: m.pb ?? m.pbAnnual ?? undefined,
    priceToSalesRatio: m.psTTM ?? m.psAnnual ?? undefined,
    debtToEquityRatio: m["totalDebt/totalEquityAnnual"] ?? undefined,
    currentRatio: m.currentRatioAnnual ?? undefined,
    quickRatio: m.quickRatioAnnual ?? undefined,
    cashRatio: undefined, // not reliably available on Finnhub's free metric set
    interestCoverageRatio: undefined, // Finnhub's netInterestCoverage sign convention doesn't map cleanly — skip rather than risk a wrong signal
    netProfitMargin: pct(m.netProfitMarginTTM),
    grossProfitMargin: pct(m.grossMarginTTM),
    operatingProfitMargin: pct(m.operatingMarginTTM),
    revenueGrowthYoY: pct(m.revenueGrowthTTMYoy),
  };

  const keyMetrics: FmpKeyMetrics = {
    symbol,
    fiscalYear: "TTM",
    returnOnInvestedCapital: pct(m.roiTTM), // Finnhub's "ROI" is the closest free proxy for ROIC
    returnOnEquity: pct(m.roeTTM),
    freeCashFlowYield: pfcf && pfcf > 0 ? 1 / pfcf : undefined,
    netDebtToEBITDA: undefined,
  };

  return { ratios, keyMetrics };
}

interface FinnhubQuoteResponse {
  c: number; // current price
  dp: number; // percent change
}

export interface FinnhubQuote {
  price: number;
  changePercent: number;
}

export async function fetchFinnhubQuote(symbol: string): Promise<FinnhubQuote | null> {
  const data = await finnhubGet<FinnhubQuoteResponse>(`/quote?symbol=${encodeURIComponent(symbol)}`);
  if (!data || data.c === 0) return null; // c:0 is Finnhub's "no data" signal for unknown symbols
  return { price: data.c, changePercent: data.dp };
}

interface FinnhubProfile2Response {
  name?: string;
  currency?: string;
  finnhubIndustry?: string;
  marketCapitalization?: number; // in millions USD
}

/** One lightweight call used to classify a screener candidate — industry
 * (for theme screens like "AI stocks") and market cap (for cap-tier screens
 * like "mega cap giants") — before spending the heavier quote+metric calls
 * on candidates that don't match the requested filter. Also carries
 * name/currency, used by the ticker-resolution fallback below. */
export async function fetchFinnhubProfile2(symbol: string): Promise<{
  name: string | null;
  currency: string | null;
  industry: string | null;
  marketCapMillions: number | null;
}> {
  const data = await finnhubGet<FinnhubProfile2Response>(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`);
  return {
    name: data?.name ?? null,
    currency: data?.currency ?? null,
    industry: data?.finnhubIndustry ?? null,
    marketCapMillions: data?.marketCapitalization ?? null,
  };
}

/**
 * Fallback ticker resolution for when FMP's /search-symbol is down (its
 * whole quota exhausted, confirmed to happen repeatedly this session) — a
 * real quote (c !== 0) confirms the symbol actually exists and trades,
 * profile2 supplies the display name/currency. Only meant for candidates
 * that already look like a ticker (explicit $XYZ or bare uppercase word) —
 * this doesn't do fuzzy company-name search, Finnhub has no free endpoint
 * for that.
 */
export async function resolveTickerViaFinnhub(
  symbol: string
): Promise<{ symbol: string; name: string; currency: string; exchange: string } | null> {
  const quote = await fetchFinnhubQuote(symbol);
  if (!quote) return null;
  const profile = await fetchFinnhubProfile2(symbol);
  return {
    symbol: symbol.toUpperCase(),
    name: profile.name ?? symbol.toUpperCase(),
    currency: profile.currency ?? "USD",
    exchange: "",
  };
}

interface FinnhubRecommendationEntry {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface FinnhubRatingCounts {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

/** Free even when FMP's /price-target-consensus and /grades-consensus are
 * blocked for a ticker — the most recent month's counts become a
 * ratings-only "Street" consensus (no $ price targets, Finnhub's
 * price-target endpoint is paid-only). */
export async function fetchFinnhubRecommendation(symbol: string): Promise<FinnhubRatingCounts | null> {
  const data = await finnhubGet<FinnhubRecommendationEntry[]>(`/stock/recommendation?symbol=${encodeURIComponent(symbol)}`);
  if (!data || data.length === 0) return null;
  const latest = data[0]; // API returns newest period first
  return {
    strongBuy: latest.strongBuy,
    buy: latest.buy,
    hold: latest.hold,
    sell: latest.sell,
    strongSell: latest.strongSell,
  };
}

interface FinnhubReportConcept {
  concept: string;
  value: number;
}

interface FinnhubReportedFinancialsEntry {
  year: number;
  endDate: string;
  report: {
    ic?: FinnhubReportConcept[];
    cf?: FinnhubReportConcept[];
  };
}

interface FinnhubReportedFinancialsResponse {
  data: FinnhubReportedFinancialsEntry[];
}

function findConcept(items: FinnhubReportConcept[] | undefined, candidates: string[]): number | undefined {
  if (!items) return undefined;
  for (const concept of candidates) {
    const found = items.find((i) => i.concept === concept);
    if (found !== undefined) return found.value;
  }
  return undefined;
}

/**
 * Fallback for the 5-year fundamentals trend when FMP blocks
 * /income-statement and /cash-flow-statement for a ticker (same whitelist
 * pattern as CRWD/RDDT/TEM/MARA). Finnhub's financials-reported endpoint
 * returns raw XBRL filing data — free, but the concept tags aren't fully
 * standardized across companies, so each line item tries a few known GAAP
 * concept names in priority order. A year is skipped (not zero-filled) if
 * revenue/net income can't be found, rather than showing a fabricated 0.
 */
export async function fetchFinnhubFinancialsTrend(
  symbol: string
): Promise<{ income: FmpIncomeStatement[]; cashFlow: FmpCashFlowStatement[] } | null> {
  const data = await finnhubGet<FinnhubReportedFinancialsResponse>(
    `/stock/financials-reported?symbol=${encodeURIComponent(symbol)}&freq=annual`
  );
  if (!data?.data?.length) return null;

  // Amended/duplicate filings can share a fiscal year — keep only the most
  // recently filed report per year.
  const byYear = new Map<number, FinnhubReportedFinancialsEntry>();
  for (const entry of data.data) {
    const existing = byYear.get(entry.year);
    if (!existing || entry.endDate > existing.endDate) byYear.set(entry.year, entry);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b).slice(-5);

  const income: FmpIncomeStatement[] = [];
  const cashFlow: FmpCashFlowStatement[] = [];

  for (const year of years) {
    const entry = byYear.get(year)!;
    const { ic, cf } = entry.report;

    const revenue = findConcept(ic, [
      "us-gaap_Revenues",
      "us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax",
      "us-gaap_RevenueFromContractWithCustomerIncludingAssessedTax",
      "us-gaap_SalesRevenueNet",
    ]);
    const netIncome = findConcept(ic, ["us-gaap_NetIncomeLoss", "us-gaap_ProfitLoss"]);
    if (revenue === undefined || netIncome === undefined) continue;

    const operatingCashFlow = findConcept(cf, ["us-gaap_NetCashProvidedByUsedInOperatingActivities"]);
    const capex = findConcept(cf, ["us-gaap_PaymentsToAcquirePropertyPlantAndEquipment"]) ?? 0;

    income.push({ date: entry.endDate, fiscalYear: String(year), revenue, netIncome });
    cashFlow.push({
      date: entry.endDate,
      fiscalYear: String(year),
      netIncome,
      // Fall back to net income if operating cash flow itself wasn't
      // reported under a recognized tag — an approximation, not a real gap.
      freeCashFlow: operatingCashFlow !== undefined ? operatingCashFlow - capex : netIncome,
      operatingCashFlow,
      capex: operatingCashFlow !== undefined ? capex : undefined, // only meaningful alongside a real operatingCashFlow
    });
  }

  return income.length > 0 ? { income, cashFlow } : null;
}
