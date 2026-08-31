import { describe, it, expect } from "vitest";
import { computeSnowflake } from "../snowflake";
import type { StockBundle } from "../fmp";

/** Minimal valid bundle — every field a real caller could plausibly send
 * with nothing available, so tests only add exactly the fields a given
 * check needs. Mirrors buildFinnhubBundle's shape (the thinnest real
 * bundle in production), not a hypothetical. */
function emptyBundle(overrides: Partial<StockBundle> = {}): StockBundle {
  return {
    symbol: "TEST",
    quote: { symbol: "TEST", name: "Test Co", price: 100, changePercentage: 0, marketCap: 0, currency: "USD" },
    profile: null,
    ratios: null,
    keyMetrics: null,
    priceTargetConsensus: null,
    gradesConsensus: null,
    historicalMonthly: [],
    income: [],
    cashFlow: [],
    ...overrides,
  };
}

describe("computeSnowflake — the neutral-not-zero invariant", () => {
  it("scores every axis as a neutral 3/6 with zero checks when no data exists at all", () => {
    const sf = computeSnowflake(emptyBundle());
    for (const axis of [sf.valuation, sf.growth, sf.quality, sf.financialHealth] as const) {
      expect(axis.score).toBe(3);
      expect(axis.checks).toEqual([]);
    }
    // Momentum always has at least the 1-day-move check, from quote alone.
    expect(sf.momentum.checks.length).toBeGreaterThanOrEqual(1);
  });

  it("never lets a missing field resolve to a failed check — only checks with real data appear at all", () => {
    const sf = computeSnowflake(
      emptyBundle({ ratios: { symbol: "TEST", fiscalYear: "TTM", priceToEarningsRatio: 10 } })
    );
    // Only the one field that was actually provided produces a check.
    expect(sf.valuation.checks).toHaveLength(1);
    expect(sf.valuation.checks[0]).toEqual({ label: "P/E under 25x", passed: true });
  });
});

describe("computeSnowflake — valuation axis thresholds", () => {
  it("passes every check when all ratios clear their real thresholds", () => {
    const sf = computeSnowflake(
      emptyBundle({
        ratios: {
          symbol: "TEST",
          fiscalYear: "TTM",
          priceToEarningsRatio: 15,
          priceToFreeCashFlowRatio: 12,
          priceToBookRatio: 3,
          priceToSalesRatio: 2,
          priceToEarningsGrowthRatio: 1.2,
        },
        keyMetrics: { symbol: "TEST", fiscalYear: "TTM", freeCashFlowYield: 0.06 },
      })
    );
    expect(sf.valuation.score).toBe(6);
    expect(sf.valuation.checks.every((c) => c.passed)).toBe(true);
  });

  it("fails an expensive stock on every real threshold", () => {
    const sf = computeSnowflake(
      emptyBundle({
        ratios: {
          symbol: "TEST",
          fiscalYear: "TTM",
          priceToEarningsRatio: 80,
          priceToFreeCashFlowRatio: 60,
          priceToBookRatio: 20,
          priceToSalesRatio: 25,
        },
        keyMetrics: { symbol: "TEST", fiscalYear: "TTM", freeCashFlowYield: 0.01 },
      })
    );
    expect(sf.valuation.score).toBe(0);
  });

  it("treats a negative PEG as a fail, not a pass — a negative PEG means negative earnings growth, not cheap growth", () => {
    const sf = computeSnowflake(
      emptyBundle({ ratios: { symbol: "TEST", fiscalYear: "TTM", priceToEarningsGrowthRatio: -3 } })
    );
    expect(sf.valuation.checks[0]).toEqual({ label: "PEG under 2x", passed: false });
  });
});

describe("computeSnowflake — growth axis", () => {
  it("computes real YoY growth from consecutive income statements", () => {
    const sf = computeSnowflake(
      emptyBundle({
        income: [
          { date: "2024-12-31", fiscalYear: "2024", revenue: 100, netIncome: 10 },
          { date: "2025-12-31", fiscalYear: "2025", revenue: 120, netIncome: 15 },
        ],
      })
    );
    const revenueCheck = sf.growth.checks.find((c) => c.label === "Revenue grew YoY");
    const incomeCheck = sf.growth.checks.find((c) => c.label === "Net income grew YoY");
    expect(revenueCheck?.passed).toBe(true);
    expect(incomeCheck?.passed).toBe(true);
  });

  it("falls back to Finnhub's revenueGrowthYoY ratio when the income statement is blocked", () => {
    const sf = computeSnowflake(emptyBundle({ ratios: { symbol: "TEST", fiscalYear: "TTM", revenueGrowthYoY: 0.15 } }));
    expect(sf.growth.checks).toEqual([{ label: "Revenue grew YoY", passed: true }]);
  });

  it("prefers real income-statement YoY over the Finnhub fallback when both exist", () => {
    const sf = computeSnowflake(
      emptyBundle({
        ratios: { symbol: "TEST", fiscalYear: "TTM", revenueGrowthYoY: 0.99 }, // would pass if used
        income: [
          { date: "2024-12-31", fiscalYear: "2024", revenue: 100, netIncome: 10 },
          { date: "2025-12-31", fiscalYear: "2025", revenue: 90, netIncome: 10 }, // real decline
        ],
      })
    );
    expect(sf.growth.checks.find((c) => c.label === "Revenue grew YoY")?.passed).toBe(false);
  });

  it("flags margin expansion only when net margin actually widened between periods", () => {
    const sf = computeSnowflake(
      emptyBundle({
        income: [
          { date: "2024-12-31", fiscalYear: "2024", revenue: 100, netIncome: 5 }, // 5% margin
          { date: "2025-12-31", fiscalYear: "2025", revenue: 100, netIncome: 10 }, // 10% margin
        ],
      })
    );
    expect(sf.growth.checks.find((c) => c.label === "Net margin expanding")?.passed).toBe(true);
  });
});

describe("computeSnowflake — momentum axis technicals fallback", () => {
  // FMP's priceAvg50/200/yearHigh are absent (blocked-ticker scenario) —
  // this is the exact fallback path a screener/Finnhub-only bundle relies
  // on for every candidate.
  function monthlyUptrend(): { date: string; price: number; symbol: string; volume: number }[] {
    // 7 points, strictly increasing — clears MIN_POINTS(7) and should read
    // as a real uptrend under computeTechnicals' own trend logic.
    return Array.from({ length: 7 }, (_, i) => ({
      symbol: "TEST",
      date: `2026-0${i + 1}-01`,
      price: 100 + i * 5,
      volume: 0,
    }));
  }

  it("falls back to SMA-proxy checks when priceAvg50/200 are both missing", () => {
    const sf = computeSnowflake(
      emptyBundle({
        quote: { symbol: "TEST", name: "Test Co", price: 130, changePercentage: 1, marketCap: 0, currency: "USD" },
        historicalMonthly: monthlyUptrend(),
      })
    );
    const labels = sf.momentum.checks.map((c) => c.label);
    expect(labels).toContain("Price above 3-month average (SMA proxy)");
    expect(labels).toContain("Price above 6-month average (SMA proxy)");
    expect(labels).toContain("Short-term trend above medium-term (uptrend)");
    // The real FMP-native labels must NOT appear when their source data doesn't exist.
    expect(labels).not.toContain("Price above 50-day average");
  });

  it("uses the real FMP fields instead of the fallback when they're actually present", () => {
    const sf = computeSnowflake(
      emptyBundle({
        quote: {
          symbol: "TEST",
          name: "Test Co",
          price: 130,
          changePercentage: 1,
          marketCap: 0,
          currency: "USD",
          priceAvg50: 120,
          priceAvg200: 110,
          yearHigh: 140,
        },
        historicalMonthly: monthlyUptrend(), // present but should be ignored in favor of real fields
      })
    );
    const labels = sf.momentum.checks.map((c) => c.label);
    expect(labels).toContain("Price above 50-day average");
    expect(labels).toContain("Price above 200-day average");
    expect(labels).toContain("50-day average above 200-day (uptrend)");
    expect(labels).not.toContain("Price above 3-month average (SMA proxy)");
  });

  it("computes the 12mo trend check off just 2 points, but withholds SMA/RSI-derived checks below computeTechnicals' own 7-point minimum", () => {
    const sf = computeSnowflake(emptyBundle({ historicalMonthly: monthlyUptrend().slice(0, 3) }));
    const labels = sf.momentum.checks.map((c) => c.label);
    // ytdTrend only needs 2 points, so this one is present even this early.
    expect(labels).toContain("Positive trailing 12mo trend");
    // But nothing that needs computeTechnicals (7-point minimum) appears yet.
    expect(labels).not.toContain("Price above 3-month average (SMA proxy)");
    expect(labels).not.toContain("Within 25% of trailing 12mo high");
  });
});
