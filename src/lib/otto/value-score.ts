import type { FmpRatios, FmpKeyMetrics } from "./fmp";

/**
 * A continuous 0-100 "how cheap is this, really" score — deliberately
 * separate from the Snowflake engine's discrete pass/fail valuation checks
 * (snowflake.ts), which stay untouched: those checks are the trusted,
 * explainable methodology shown on every single-stock card ("P/E under
 * 25x" pass/fail), and changing that display logic isn't the point here.
 *
 * The problem this solves: a binary check can't tell a P/E of 24.9 from a
 * P/E of 8 — both just "pass," so dozens of real stocks tie at a perfect
 * valuation score and the screener has no way to rank "barely acceptable"
 * below "genuinely cheap." This scores the same real ratios (already
 * fetched, zero extra API cost) on a smooth curve instead, specifically so
 * the "undervalued"/"best" screens can differentiate by actual magnitude,
 * not just clear-the-bar/don't.
 *
 * Each component is scored 0-100 on a linear ramp from "expensive" to a
 * "very cheap" ceiling chosen from typical real-market ranges, then
 * averaged across whichever ratios are actually available — same
 * "never score on missing data" discipline as the Snowflake engine.
 */
export function computeValueScore(ratios: FmpRatios | null, keyMetrics: FmpKeyMetrics | null): number | null {
  const components: number[] = [];

  const pe = ratios?.priceToEarningsRatio;
  if (pe !== undefined && pe > 0) {
    components.push(clamp01(1 - pe / 40) * 100);
  }

  const pfcf = ratios?.priceToFreeCashFlowRatio;
  if (pfcf !== undefined && pfcf > 0) {
    components.push(clamp01(1 - pfcf / 30) * 100);
  }

  const fcfYield = keyMetrics?.freeCashFlowYield;
  if (fcfYield !== undefined) {
    components.push(clamp01(fcfYield / 0.12) * 100); // 12%+ FCF yield = max score
  }

  const pb = ratios?.priceToBookRatio;
  if (pb !== undefined && pb > 0) {
    components.push(clamp01(1 - pb / 6) * 100);
  }

  const ps = ratios?.priceToSalesRatio;
  if (ps !== undefined && ps > 0) {
    components.push(clamp01(1 - ps / 8) * 100);
  }

  const peg = ratios?.priceToEarningsGrowthRatio;
  if (peg !== undefined && peg > 0) {
    components.push(clamp01(1 - peg / 2.5) * 100);
  }

  if (components.length === 0) return null;
  return Math.round(components.reduce((a, b) => a + b, 0) / components.length);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
