import { describe, it, expect } from "vitest";
import { computeAlpha, positionValue } from "../screener-track-record";

describe("positionValue — the shared long/short P&L formula", () => {
  it("a long position gains value when the stock rises", () => {
    expect(positionValue(1000, 10, false)).toBeCloseTo(1100, 6);
  });

  it("a long position loses value when the stock falls", () => {
    expect(positionValue(1000, -10, false)).toBeCloseTo(900, 6);
  });

  it("a short position gains value when the stock FALLS — the inverted mirror of a long", () => {
    expect(positionValue(1000, -10, true)).toBeCloseTo(1100, 6);
  });

  it("a short position loses value when the stock RISES", () => {
    expect(positionValue(1000, 10, true)).toBeCloseTo(900, 6);
  });

  it("a long and a short on the same stake and same move are exact mirrors of each other", () => {
    const stockReturnPct = 17.3;
    const longValue = positionValue(1000, stockReturnPct, false);
    const shortValue = positionValue(1000, stockReturnPct, true);
    // Long's gain above 1000 should equal short's loss below 1000, and vice versa.
    expect(longValue - 1000).toBeCloseTo(-(shortValue - 1000), 6);
  });

  it("zero return leaves both a long and a short exactly at the original stake", () => {
    expect(positionValue(2500, 0, false)).toBeCloseTo(2500, 6);
    expect(positionValue(2500, 0, true)).toBeCloseTo(2500, 6);
  });

  it("a short can go to zero (and beyond, on paper) on a big enough rally — no floor is applied here", () => {
    // A +100% move wipes out a short's stake entirely under this formula;
    // this documents that behavior rather than silently assuming a floor
    // exists elsewhere (the real floor is the stop-loss firing well before
    // this, at SHORT_STOP_LOSS_THRESHOLD_PCT).
    expect(positionValue(1000, 100, true)).toBeCloseTo(0, 6);
  });
});

describe("computeAlpha — direction-aware, per the intent", () => {
  it("a buy-side intent's alpha is the stock's return minus SPY's — beating the market is positive", () => {
    expect(computeAlpha("best", 12, 5)).toBeCloseTo(7, 6);
    expect(computeAlpha("undervalued", 3, 8)).toBeCloseTo(-5, 6);
  });

  it("avoid's alpha is inverted — the stock UNDERPERFORMING the market is what makes the call correct", () => {
    // Otto said avoid, and the stock badly lagged SPY — a correct call,
    // so alpha should be positive even though the stock's own return is
    // the smaller (more negative) number.
    expect(computeAlpha("avoid", -20, 5)).toBeCloseTo(25, 6);
  });

  it("avoid's alpha goes negative when the stock the call warned against actually beat the market", () => {
    expect(computeAlpha("avoid", 15, 5)).toBeCloseTo(-10, 6);
  });

  it("a buy-side call and an avoid call on the identical stock/SPY numbers score with opposite sign", () => {
    const stockReturnPct = 9;
    const spyReturnPct = 4;
    expect(computeAlpha("best", stockReturnPct, spyReturnPct)).toBeCloseTo(
      -computeAlpha("avoid", stockReturnPct, spyReturnPct),
      6
    );
  });
});
