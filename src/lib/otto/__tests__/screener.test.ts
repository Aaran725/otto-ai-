import { describe, it, expect } from "vitest";
import { applyRegimeTilt } from "../screener";

const BASE_WEIGHTS = { valuation: 1, growth: 1, quality: 1, financialHealth: 1, momentum: 1 };

describe("applyRegimeTilt — fed-funds regime tilt (existing behavior)", () => {
  it("tilts toward quality/financialHealth and away from growth/momentum when rates are elevated", () => {
    const tilted = applyRegimeTilt(BASE_WEIGHTS, { fedFundsRate: 5 });
    expect(tilted.quality).toBeGreaterThan(1);
    expect(tilted.financialHealth).toBeGreaterThan(1);
    expect(tilted.growth).toBeLessThan(1);
    expect(tilted.momentum).toBeLessThan(1);
  });

  it("tilts toward growth/momentum and away from quality when rates are low", () => {
    const tilted = applyRegimeTilt(BASE_WEIGHTS, { fedFundsRate: 2 });
    expect(tilted.growth).toBeGreaterThan(1);
    expect(tilted.momentum).toBeGreaterThan(1);
    expect(tilted.quality).toBeLessThan(1);
  });

  it("leaves weights untouched in the neutral 3-4.5% band, and when macro is null", () => {
    expect(applyRegimeTilt(BASE_WEIGHTS, { fedFundsRate: 3.75 })).toEqual(BASE_WEIGHTS);
    expect(applyRegimeTilt(BASE_WEIGHTS, null)).toEqual(BASE_WEIGHTS);
  });
});

describe("applyRegimeTilt — real yield-curve inversion (Round 5, Phase O)", () => {
  it("tilts toward quality/financialHealth and away from growth/momentum when the 2s10s spread is negative (inverted)", () => {
    const tilted = applyRegimeTilt(BASE_WEIGHTS, { fedFundsRate: 3.75, yieldCurveSpread: -0.5 });
    expect(tilted.quality).toBeGreaterThan(1);
    expect(tilted.financialHealth).toBeGreaterThan(1);
    expect(tilted.growth).toBeLessThan(1);
    expect(tilted.momentum).toBeLessThan(1);
  });

  it("does not fire when the spread is positive (a normal, non-inverted curve)", () => {
    const tilted = applyRegimeTilt(BASE_WEIGHTS, { fedFundsRate: 3.75, yieldCurveSpread: 0.8 });
    expect(tilted).toEqual(BASE_WEIGHTS);
  });

  it("does not fire when yieldCurveSpread is absent — never fabricates a signal from missing data", () => {
    const tilted = applyRegimeTilt(BASE_WEIGHTS, { fedFundsRate: 3.75 });
    expect(tilted).toEqual(BASE_WEIGHTS);
  });

  it("layers on TOP of an active fed-funds tilt rather than replacing it — both real signals compound", () => {
    const fedFundsOnly = applyRegimeTilt(BASE_WEIGHTS, { fedFundsRate: 5 });
    const both = applyRegimeTilt(BASE_WEIGHTS, { fedFundsRate: 5, yieldCurveSpread: -0.2 });
    expect(both.quality!).toBeGreaterThan(fedFundsOnly.quality!);
    expect(both.growth!).toBeLessThan(fedFundsOnly.growth!);
  });
});
