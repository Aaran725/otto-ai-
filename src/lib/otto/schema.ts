import type { EarningsRecord } from "./earnings";
import type { ShortInterestData } from "./short-interest";
import type { PositionSizing } from "./position-sizing";
import type { PeerValuation } from "./peers";
import type { InsiderActivity } from "./insider";

export type Verdict = "Strong Buy" | "Buy" | "Hold" | "Avoid" | "Strong Avoid";

export interface HistoricalPoint {
  /** ISO date, e.g. "2025-08-01" */
  date: string;
  close: number;
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
  generatedAt: string; // ISO timestamp
}
