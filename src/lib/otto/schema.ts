import type { EarningsRecord } from "./earnings";
import type { ShortInterestData } from "./short-interest";
import type { PositionSizing } from "./position-sizing";
import type { PeerValuation } from "./peers";
import type { InsiderActivity } from "./insider";
import type { NewsResult } from "./web-search";
import type { CatalystEvent } from "./catalyst-bus";
import type { SegmentAnalysis } from "./segments";

export type Verdict = "Strong Buy" | "Buy" | "Hold" | "Avoid" | "Strong Avoid";

/**
 * Computed deterministically from real checks-run counts (never from the
 * LLM) — a confident-looking "Hold, 55" card is meaningless when every
 * fundamentals axis defaulted to a neutral 3/6 because no real data was
 * available, and that must never look identical to a genuinely-scored
 * mediocre stock. "insufficient" means most axes had zero real checks run.
 */
export type DataQuality = "full" | "partial" | "insufficient";

export interface HistoricalPoint {
  /** ISO date, e.g. "2025-08-01" */
  date: string;
  close: number;
  /** Only present when the source bar carried real OHLC (Alpaca/Yahoo
   * fallback paths) — FMP's primary "light" endpoint is close-only, so
   * these are absent for most tickers. Never synthesized from close alone. */
  open?: number;
  high?: number;
  low?: number;
}

export interface FundamentalTrendPoint {
  /** Fiscal year label, e.g. "FY2021" */
  period: string;
  revenue: number;
  earnings: number;
  freeCashFlow: number;
  operatingCashFlow?: number;
  capex?: number;
}

export interface MetricComparison {
  label: string;
  value: string;
  benchmark: string;
  /** How this metric should read visually: bullish, bearish, or neutral */
  signal: "bull" | "bear" | "neutral";
}

export interface SnowflakeAxisResult {
  score: number; // 0-6, computed deterministically — never set by the LLM
  checksRun: number; // out of 6 possible — fewer means less data was available for this axis
  note: string; // one-sentence explanation, written by the LLM from the score + checks
}

export interface OttoSnowflake {
  valuation: SnowflakeAxisResult;
  growth: SnowflakeAxisResult;
  quality: SnowflakeAxisResult;
  financialHealth: SnowflakeAxisResult;
  momentum: SnowflakeAxisResult;
}

export interface OttoForecast {
  bearTarget: number;
  baseTarget: number;
  bullTarget: number;
  horizonMonths: number; // 12
  rationale: string; // <=200 chars, written by the LLM from the computed targets
}

/** Fed funds rate, 10Y Treasury yield, CPI YoY — from FRED, ticker-agnostic. */
export interface MacroSnapshot {
  fedFundsRate: number;
  treasury10Y: number;
  cpiYoyPct: number;
  asOf: string;
}

/**
 * Real Wall Street analyst data — never LLM-generated. Price targets come
 * from FMP only; when FMP's /price-target-consensus is blocked for a
 * ticker (same whitelist gate as ratios/key-metrics), the target fields are
 * omitted but the rating counts can still come from Finnhub's free
 * recommendation-trends endpoint — a ratings-only consensus is still more
 * honest than hiding the whole panel.
 */
export interface StreetConsensus {
  targetHigh?: number;
  targetLow?: number;
  targetConsensus?: number;
  targetMedian?: number;
  analystCount: number;
  rating: string; // e.g. "Buy"
  ratingCounts: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number };
  /** Direction analyst ratings have actually moved recently — a snapshot
   * consensus looks identical whether it's been climbing or sliding into
   * that number, and those are very different signals. Null when the
   * trend endpoint had nothing to report (e.g. too few analysts). */
  ratingTrend?: { direction: "improving" | "worsening" | "flat"; delta: number };
  /** How much analysts actually disagree, computed from the real spread
   * already in targetHigh/targetLow — (high - low) / consensus, as a
   * percent of the consensus target. Tight consensus and wide
   * disagreement can sit behind the exact same headline target number.
   * Null when high/low/consensus aren't all available. */
  targetDispersionPct?: number;
}

/**
 * What Groq actually returns: everything in OttoAnalysis except the
 * deterministically-computed snowflake scores and forecast targets, which
 * are merged in server-side. Groq only supplies the narrative around them.
 */
export interface GroqOttoResponse {
  ticker: string;
  companyName: string;
  price: number;
  currency: string;
  priceChangePercent1D: number;
  convictionScore: number;
  verdict: Verdict;
  oneLiner: string;
  synthesis: string;
  catalysts: [string, string, string];
  risks: [string, string];
  snowflakeNotes: {
    valuation: string;
    growth: string;
    quality: string;
    financialHealth: string;
    momentum: string;
  };
  forecastRationale: string;
}

export interface OttoAnalysis {
  ticker: string;
  companyName: string;
  price: number;
  currency: string;
  priceChangePercent1D: number;
  convictionScore: number; // 0-100
  verdict: Verdict;
  oneLiner: string; // <= 120 chars, the single-sentence thesis
  synthesis: string; // 2-4 sentence "why now" paragraph tying thesis + snowflake together
  historicalPrices: HistoricalPoint[]; // ~12 months, monthly or weekly
  catalysts: [string, string, string]; // exactly 3
  risks: [string, string]; // exactly 2
  metrics: MetricComparison[]; // Valuation, FCF Yield, ROIC, Debt-to-Equity, Revenue Growth, Net Margin
  fundamentalTrend: FundamentalTrendPoint[]; // 5 fiscal years
  snowflake: OttoSnowflake;
  forecast: OttoForecast;
  streetConsensus: StreetConsensus | null;
  macro: MacroSnapshot | null;
  /** Real equity-risk-premium read: FCF yield vs the 10-year Treasury —
   * "high" means the stock earns less on its own cash than a risk-free
   * bond, so its valuation leans on rates staying low. Null when macro or
   * FCF yield data isn't available. */
  rateSensitivity: "high" | "moderate" | "low" | null;
  earnings: EarningsRecord | null;
  shortInterest: ShortInterestData | null;
  positionSizing: PositionSizing | null;
  peerValuation: PeerValuation | null;
  insiderActivity: InsiderActivity | null;
  /** Real, dated web results from the last 7 days (Tavily) — deliberately
   * never fed into the LLM prompt or the score. Unstructured/unverified
   * web content sits outside this app's "every number traceable to a
   * primary source" design; shown as its own linked-out panel instead so
   * it's a real catalyst check, not a silent influence on Otto's own
   * reasoning. Null when no API key is configured or nothing recent came
   * back — not the same as "checked, no news." */
  recentNews: NewsResult[] | null;
  /** Real, dated catalyst events (insider clusters, structured 8-K item
   * codes) published to catalyst-bus.ts within the last 14 days — the
   * same detection that already triggers early cache invalidation for
   * this symbol, surfaced back to the user instead of only ever firing
   * silently in the background. Empty array, not null, when none exist —
   * this is always "checked," unlike recentNews which depends on an
   * external API key being configured. */
  recentCatalysts: CatalystEvent[];
  /** Real per-segment revenue breakdown, when the company reports one —
   * see segments.ts for why this is concentration/growth analysis, not a
   * dollar-valued sum-of-the-parts. Null when FMP has no segment data for
   * this ticker (most small/mid-caps don't break out product segments). */
  segmentAnalysis: SegmentAnalysis | null;
  generatedAt: string; // ISO timestamp
  dataQuality: DataQuality;
  /** Explains a real screener-vs-conviction divergence when one exists,
   * grounded in the actual axis-by-axis numbers — null when there's no
   * cached screener result to compare against, or when the two scores
   * agree closely enough that the generic disclaimer already covers it. */
  reconciliationNote: string | null;
  /** The strongest real case against Otto's own verdict — generated by a
   * genuinely separate LLM call run in parallel against the same real data
   * (never told what the verdict is, so it can't just soften/agree with
   * it), not the same softer catalysts/risks bullets written by the pass
   * that also decided the verdict. Null only if that call itself failed;
   * a weak bear case still comes back as real text saying so. */
  counterArgument: string | null;
}
