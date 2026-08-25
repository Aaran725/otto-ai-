import { describe, it, expect } from "vitest";
import { freshnessMultiplier } from "../freshness";

describe("freshnessMultiplier", () => {
  it("returns full weight for an event today", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(freshnessMultiplier(today)).toBeCloseTo(1, 1);
  });

  it("returns exactly half weight at the half-life boundary", () => {
    // Precision 1 (±0.05), not 2 — the date is truncated to day granularity
    // (slice(0, 10) drops time-of-day), so depending on what time "now" is
    // when this runs, up to ~24h of rounding error is expected, not a bug.
    const date = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(freshnessMultiplier(date, 45)).toBeCloseTo(0.5, 1);
  });

  it("decays further for an older event, using a custom half-life", () => {
    const date = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(freshnessMultiplier(date, 45)).toBeCloseTo(0.25, 2);
  });

  it("fails open (full weight) when the date is unknown", () => {
    expect(freshnessMultiplier(undefined)).toBe(1);
  });

  it("fails open on an unparseable date rather than throwing", () => {
    expect(freshnessMultiplier("not-a-date")).toBe(1);
  });

  it("fails open on a future date (clock skew guard)", () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(freshnessMultiplier(future)).toBe(1);
  });
});
