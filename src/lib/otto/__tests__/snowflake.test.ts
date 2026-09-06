import { describe, it, expect } from "vitest";
import { computeSnowflake, computeAltmanZScore } from "../snowflake";
import type { StockBundle } from "../fmp";
import type { PeerValuation, PeerPercentiles } from "../peers";

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
    balanceSheet: [],
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

/** Minimal real-shaped peer fixture — only `percentiles` varies per test,
 * matching how snowflake.ts actually reads this object (everything else on
 * PeerValuation is display-only, irrelevant to scoring). */
function peerFixture(percentiles: Partial<PeerPercentiles>): PeerValuation {
  const base: PeerPercentiles = { pe: null, pfcf: null, pb: null, ps: null, grossMargin: null, roic: null, roe: null };
  return {
    sicDescription: "Test Sector",
    peerCount: 10,
    medianPE: 20,
    percentile: percentiles.pe ?? 50,
    medianPFCF: null,
    medianROIC: null,
    peers: [],
    percentiles: { ...base, ...percentiles },
  };
}

describe("computeSnowflake — sector-relative scoring (real hedge-fund-style percentile ranking)", () => {
  it("a P/E that fails the flat 25x threshold still passes when it's genuinely cheap vs real sector peers", () => {
    const bundle = emptyBundle({ ratios: { symbol: "TEST", fiscalYear: "TTM", priceToEarningsRatio: 30 } });
    // 30x fails the absolute check on its own.
    const flat = computeSnowflake(bundle);
    expect(flat.valuation.checks[0]).toEqual({ label: "P/E under 25x", passed: false });
    // But peer percentile 20 means "better than 80% of real sector peers" —
    // cheaper than the peer median (<50) should flip the check to pass,
    // and the label should say so instead of citing the flat 25x rule.
    const sf = computeSnowflake(bundle, peerFixture({ pe: 20 }));
    expect(sf.valuation.checks[0].passed).toBe(true);
    expect(sf.valuation.checks[0].label).toBe("P/E — better than 80% of real sector peers");
  });

  it("a cheap-looking P/E still fails when it's actually expensive vs real sector peers", () => {
    const bundle = emptyBundle({ ratios: { symbol: "TEST", fiscalYear: "TTM", priceToEarningsRatio: 10 } });
    // 10x clears the flat threshold easily on its own.
    expect(computeSnowflake(bundle).valuation.checks[0].passed).toBe(true);
    // But a peer percentile of 80 means 80% of real peers are cheaper —
    // this sector just runs at very low multiples (e.g. banks), so 10x is
    // actually expensive relative to them.
    const sf = computeSnowflake(bundle, peerFixture({ pe: 80 }));
    expect(sf.valuation.checks[0].passed).toBe(false);
  });

  it("falls back to the absolute threshold for a metric peers didn't cover, even when other metrics have real percentiles", () => {
    const sf = computeSnowflake(
      emptyBundle({ ratios: { symbol: "TEST", fiscalYear: "TTM", priceToEarningsRatio: 15, priceToBookRatio: 3 } }),
      peerFixture({ pe: 30, pb: null }) // pe has a real percentile, pb doesn't (too few peers reported it)
    );
    expect(sf.valuation.checks.find((c) => c.label.startsWith("P/E"))?.label).toBe("P/E — better than 70% of real sector peers");
    // P/B under 6x is the untouched absolute fallback, unaffected by pe's percentile existing.
    expect(sf.valuation.checks.find((c) => c.label.startsWith("P/B"))).toEqual({ label: "P/B under 6x", passed: true });
  });

  it("behaves exactly as the no-peer-data path when peerValuation is omitted entirely — no regression", () => {
    const bundle = emptyBundle({ ratios: { symbol: "TEST", fiscalYear: "TTM", priceToEarningsRatio: 30 } });
    expect(computeSnowflake(bundle)).toEqual(computeSnowflake(bundle, undefined));
    expect(computeSnowflake(bundle, null)).toEqual(computeSnowflake(bundle));
  });

  it("applies the same sector-relative treatment to quality axis metrics (gross margin, ROIC, ROE)", () => {
    const bundle = emptyBundle({
      ratios: { symbol: "TEST", fiscalYear: "TTM", grossProfitMargin: 0.2 }, // fails the flat "above 35%" check
    });
    expect(computeSnowflake(bundle).quality.checks[0]).toEqual({ label: "Gross margin above 35%", passed: false });
    // But a real peer percentile of 10 means this stock beats 90% of real
    // sector peers on gross margin — genuinely excellent for this industry
    // even though 20% looks weak against a universal 35% bar.
    const sf = computeSnowflake(bundle, peerFixture({ grossMargin: 10 }));
    expect(sf.quality.checks[0]).toEqual({ label: "Gross margin — better than 90% of real sector peers", passed: true });
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

  it("Piotroski accrual check: fails when reported profit outruns real cash from operations", () => {
    const sf = computeSnowflake(
      emptyBundle({
        income: [{ date: "2025-12-31", fiscalYear: "2025", revenue: 100, netIncome: 20 }],
        cashFlow: [{ date: "2025-12-31", fiscalYear: "2025", netIncome: 20, freeCashFlow: 5, operatingCashFlow: 8 }],
      })
    );
    expect(sf.growth.checks.find((c) => c.label === "Cash flow backs up reported profit (CFO > net income)")?.passed).toBe(
      false
    );
  });

  it("Piotroski accrual check: passes when real cash from operations exceeds reported profit", () => {
    const sf = computeSnowflake(
      emptyBundle({
        income: [{ date: "2025-12-31", fiscalYear: "2025", revenue: 100, netIncome: 20 }],
        cashFlow: [{ date: "2025-12-31", fiscalYear: "2025", netIncome: 20, freeCashFlow: 25, operatingCashFlow: 30 }],
      })
    );
    expect(sf.growth.checks.find((c) => c.label === "Cash flow backs up reported profit (CFO > net income)")?.passed).toBe(
      true
    );
  });

  it("Piotroski no-dilution check: fails on real meaningful share growth YoY", () => {
    const sf = computeSnowflake(
      emptyBundle({
        income: [
          { date: "2024-12-31", fiscalYear: "2024", revenue: 100, netIncome: 10, sharesOutstanding: 1_000_000 },
          { date: "2025-12-31", fiscalYear: "2025", revenue: 110, netIncome: 11, sharesOutstanding: 1_150_000 }, // +15%
        ],
      })
    );
    expect(sf.growth.checks.find((c) => c.label === "No meaningful share dilution YoY")?.passed).toBe(false);
  });

  it("Piotroski no-dilution check: passes on flat share count, and tolerates routine RSU vesting within 2%", () => {
    const sf = computeSnowflake(
      emptyBundle({
        income: [
          { date: "2024-12-31", fiscalYear: "2024", revenue: 100, netIncome: 10, sharesOutstanding: 1_000_000 },
          { date: "2025-12-31", fiscalYear: "2025", revenue: 110, netIncome: 11, sharesOutstanding: 1_015_000 }, // +1.5%
        ],
      })
    );
    expect(sf.growth.checks.find((c) => c.label === "No meaningful share dilution YoY")?.passed).toBe(true);
  });

  it("neither Piotroski check appears when the underlying data (operatingCashFlow/sharesOutstanding) isn't there", () => {
    const sf = computeSnowflake(
      emptyBundle({
        income: [
          { date: "2024-12-31", fiscalYear: "2024", revenue: 100, netIncome: 10 },
          { date: "2025-12-31", fiscalYear: "2025", revenue: 120, netIncome: 15 },
        ],
        cashFlow: [{ date: "2025-12-31", fiscalYear: "2025", netIncome: 15, freeCashFlow: 12 }], // no operatingCashFlow
      })
    );
    expect(sf.growth.checks.find((c) => c.label.includes("Cash flow backs up"))).toBeUndefined();
    expect(sf.growth.checks.find((c) => c.label.includes("dilution"))).toBeUndefined();
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

describe("computeAltmanZScore — the real, standard 1968 formula", () => {
  it("scores a real large-cap's real balance sheet as deep in the safe zone", () => {
    // Real figures pulled live from FMP's actual /balance-sheet-statement
    // and /income-statement for AAPL (FY2025) — market cap is a reasonable
    // current approximation, not tied to the filing date, since Z is
    // always computed against today's real market cap in practice.
    const z = computeAltmanZScore({
      totalAssets: 359_241_000_000,
      workingCapital: 147_957_000_000 - 165_631_000_000,
      retainedEarnings: -14_264_000_000,
      ebit: 132_729_000_000,
      marketCap: 3_500_000_000_000,
      totalLiabilities: 285_508_000_000,
      revenue: 416_161_000_000,
    });
    expect(z).not.toBeNull();
    expect(z!).toBeGreaterThan(2.99); // real safe-zone threshold
  });

  it("scores a real distress profile (negative working capital and retained earnings, thin EBIT, market cap barely above liabilities) as real distress risk", () => {
    const z = computeAltmanZScore({
      totalAssets: 1_000_000_000,
      workingCapital: -150_000_000, // current liabilities exceed current assets
      retainedEarnings: -400_000_000, // accumulated losses
      ebit: 20_000_000,
      marketCap: 300_000_000, // market values it well below its own liabilities
      totalLiabilities: 900_000_000,
      revenue: 500_000_000,
    });
    expect(z).not.toBeNull();
    expect(z!).toBeLessThan(1.81); // real distress-zone threshold
  });

  it("returns null rather than a divide-by-zero result when total assets or total liabilities are zero", () => {
    expect(
      computeAltmanZScore({ totalAssets: 0, workingCapital: 0, retainedEarnings: 0, ebit: 0, marketCap: 100, totalLiabilities: 50, revenue: 0 })
    ).toBeNull();
    expect(
      computeAltmanZScore({ totalAssets: 100, workingCapital: 0, retainedEarnings: 0, ebit: 0, marketCap: 100, totalLiabilities: 0, revenue: 0 })
    ).toBeNull();
  });

  it("wires into computeSnowflake's financialHealth axis only when real balance-sheet data exists", () => {
    const withBalanceSheet = computeSnowflake(
      emptyBundle({
        quote: { symbol: "TEST", name: "Test Co", price: 100, changePercentage: 0, marketCap: 3_500_000_000_000, currency: "USD" },
        income: [{ date: "2025-12-31", fiscalYear: "2025", revenue: 416_161_000_000, netIncome: 112_010_000_000, ebit: 132_729_000_000 }],
        balanceSheet: [
          {
            date: "2025-12-31",
            fiscalYear: "2025",
            totalAssets: 359_241_000_000,
            totalCurrentAssets: 147_957_000_000,
            totalCurrentLiabilities: 165_631_000_000,
            totalLiabilities: 285_508_000_000,
            retainedEarnings: -14_264_000_000,
          },
        ],
      })
    );
    expect(withBalanceSheet.financialHealth.checks.some((c) => c.label.includes("Altman Z-Score"))).toBe(true);

    const withoutBalanceSheet = computeSnowflake(emptyBundle());
    expect(withoutBalanceSheet.financialHealth.checks.some((c) => c.label.includes("Altman Z-Score"))).toBe(false);
  });
});
