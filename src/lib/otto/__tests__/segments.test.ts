import { describe, it, expect } from "vitest";
import { buildSegmentAnalysis, type FmpSegmentEntry } from "../segments";

// Real values confirmed live from FMP's /revenue-product-segmentation on
// AAPL — not synthetic, so the math is checked against a number that's
// actually correct in the real world, not just internally consistent.
const AAPL_FY2025: FmpSegmentEntry = {
  symbol: "AAPL",
  fiscalYear: 2025,
  period: "FY",
  reportedCurrency: "USD",
  date: "2025-09-27",
  data: {
    Mac: 33_708_000_000,
    Service: 109_158_000_000,
    "Wearables, Home and Accessories": 35_686_000_000,
    iPad: 28_023_000_000,
    iPhone: 209_586_000_000,
  },
};

const AAPL_FY2024: FmpSegmentEntry = {
  symbol: "AAPL",
  fiscalYear: 2024,
  period: "FY",
  reportedCurrency: "USD",
  date: "2024-09-28",
  data: {
    Mac: 29_984_000_000,
    Service: 96_169_000_000,
    "Wearables, Home and Accessories": 37_005_000_000,
    iPad: 26_694_000_000,
    iPhone: 201_183_000_000,
  },
};

describe("buildSegmentAnalysis", () => {
  it("returns null when FMP has no segment data for this ticker", () => {
    expect(buildSegmentAnalysis([])).toBeNull();
  });

  it("sorts segments descending by revenue, iPhone first for real Apple data", () => {
    const result = buildSegmentAnalysis([AAPL_FY2025]);
    expect(result?.segments.map((s) => s.label)).toEqual(["iPhone", "Service", "Wearables, Home and Accessories", "Mac", "iPad"]);
  });

  it("computes each segment's real % of total revenue, summing to ~100%", () => {
    const result = buildSegmentAnalysis([AAPL_FY2025]);
    const total = result!.segments.reduce((sum, s) => sum + s.pctOfTotal, 0);
    expect(total).toBeCloseTo(100, 0);
    // iPhone was ~$209.6B of ~$416.2B total — a real, checkable percentage.
    const iphone = result!.segments.find((s) => s.label === "iPhone");
    expect(iphone?.pctOfTotal).toBeCloseTo(50.4, 1);
  });

  it("flags real concentration risk when the top segment is a real majority", () => {
    const result = buildSegmentAnalysis([AAPL_FY2025]);
    expect(result?.topSegmentConcentrationPct).toBeGreaterThan(50);
  });

  it("computes real YoY growth per segment when the prior year has the same label", () => {
    const result = buildSegmentAnalysis([AAPL_FY2025, AAPL_FY2024]);
    const service = result!.segments.find((s) => s.label === "Service");
    // Real Services growth: (109.158B - 96.169B) / 96.169B ≈ +13.5%
    expect(service?.yoyGrowthPct).toBeCloseTo(13.5, 1);

    // Wearables actually SHRANK YoY — a real check that decline shows as negative, not clamped to zero.
    const wearables = result!.segments.find((s) => s.label === "Wearables, Home and Accessories");
    expect(wearables?.yoyGrowthPct).toBeLessThan(0);
  });

  it("omits yoyGrowthPct entirely when there's no prior year to compare against — never fabricates a growth number", () => {
    const result = buildSegmentAnalysis([AAPL_FY2025]); // no prior year supplied
    expect(result?.segments.every((s) => s.yoyGrowthPct === undefined)).toBe(true);
  });

  it("omits yoyGrowthPct for a segment that didn't exist under the same label the prior year", () => {
    const priorWithoutIpad: FmpSegmentEntry = { ...AAPL_FY2024, data: { ...AAPL_FY2024.data } };
    delete priorWithoutIpad.data.iPad;
    const result = buildSegmentAnalysis([AAPL_FY2025, priorWithoutIpad]);
    const ipad = result!.segments.find((s) => s.label === "iPad");
    expect(ipad?.yoyGrowthPct).toBeUndefined();
  });

  it("returns null rather than dividing by zero when total revenue is somehow zero", () => {
    const empty: FmpSegmentEntry = { ...AAPL_FY2025, data: {} };
    expect(buildSegmentAnalysis([empty])).toBeNull();
  });
});
