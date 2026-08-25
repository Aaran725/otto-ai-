import { describe, it, expect } from "vitest";
import { computeDailyReturns, pearsonCorrelation, diversifySelection } from "../correlation";
import type { DailyPricePoint } from "../alpaca";

function series(prices: number[]): DailyPricePoint[] {
  return prices.map((price, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, price }));
}

describe("computeDailyReturns", () => {
  it("computes simple returns between consecutive points", () => {
    expect(computeDailyReturns(series([100, 110, 99]))).toEqual([0.1, -0.1]);
  });

  it("returns an empty array for fewer than 2 points", () => {
    expect(computeDailyReturns(series([100]))).toEqual([]);
    expect(computeDailyReturns([])).toEqual([]);
  });
});

describe("pearsonCorrelation", () => {
  it("returns null when overlap is below the minimum sample threshold", () => {
    const a = Array.from({ length: 10 }, (_, i) => i * 0.01);
    const b = Array.from({ length: 10 }, (_, i) => i * 0.01);
    expect(pearsonCorrelation(a, b)).toBeNull();
  });

  it("returns ~1 for two identical, sufficiently long return series", () => {
    const a = Array.from({ length: 30 }, (_, i) => Math.sin(i) * 0.02);
    expect(pearsonCorrelation(a, [...a])).toBeCloseTo(1, 5);
  });

  it("returns ~-1 for perfectly inverted series", () => {
    const a = Array.from({ length: 30 }, (_, i) => Math.sin(i) * 0.02);
    const b = a.map((v) => -v);
    expect(pearsonCorrelation(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns null for a flat (zero-variance) series — undefined correlation, not zero", () => {
    const a = Array.from({ length: 30 }, () => 0.01);
    const b = Array.from({ length: 30 }, (_, i) => Math.sin(i) * 0.02);
    expect(pearsonCorrelation(a, b)).toBeNull();
  });
});

describe("diversifySelection", () => {
  // 40 days of prices so returns clear the MIN_OVERLAP threshold (20).
  const days = 40;
  function trending(seed: number): DailyPricePoint[] {
    const prices: number[] = [100];
    for (let i = 1; i < days; i++) prices.push(prices[i - 1] * (1 + Math.sin(i / 3 + seed) * 0.01));
    return series(prices);
  }

  it("keeps all top picks when nothing is correlated above the threshold", () => {
    const ranked = [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }];
    const map = new Map<string, DailyPricePoint[]>([
      ["A", trending(0)],
      ["B", trending(2)],
      ["C", trending(4)],
    ]);
    const result = diversifySelection(ranked, map, 3, 0.99);
    expect(result.map((r) => r.symbol).sort()).toEqual(["A", "B", "C"]);
  });

  it("swaps out a highly-correlated lower-ranked pick for the next candidate", () => {
    const shared = trending(0);
    const ranked = [{ symbol: "A" }, { symbol: "B_CLONE" }, { symbol: "C" }];
    const map = new Map<string, DailyPricePoint[]>([
      ["A", shared],
      ["B_CLONE", shared], // identical series → correlation 1, must be swapped out
      ["C", trending(7)],
    ]);
    const result = diversifySelection(ranked, map, 2, 0.8);
    expect(result.map((r) => r.symbol)).toEqual(["A", "C"]);
  });

  it("admits a candidate with no price data rather than blocking on unknown correlation", () => {
    const ranked = [{ symbol: "A" }, { symbol: "NO_DATA" }];
    const map = new Map<string, DailyPricePoint[]>([["A", trending(0)]]);
    const result = diversifySelection(ranked, map, 2, 0.8);
    expect(result.map((r) => r.symbol)).toEqual(["A", "NO_DATA"]);
  });

  it("backfills by relaxing the threshold rather than returning fewer than targetCount", () => {
    const shared = trending(0);
    const ranked = [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }];
    // All three identical → nothing clears even a very high threshold.
    const map = new Map<string, DailyPricePoint[]>([
      ["A", shared],
      ["B", shared],
      ["C", shared],
    ]);
    const result = diversifySelection(ranked, map, 3, 0.5);
    expect(result.length).toBe(3);
  });
});
