import { describe, it, expect } from "vitest";
import { applyRegimeTilt, passesExplicitChecks, type ScreenerCandidate } from "../screener";
import type { OttoSnowflakeScores, SnowflakeAxisScore } from "../snowflake";
import type { InsiderActivity } from "../insider";

function emptyAxis(): SnowflakeAxisScore {
  return { score: 3, checks: [] };
}

function baseCandidate(overrides: Partial<ScreenerCandidate> = {}): ScreenerCandidate {
  return {
    symbol: "TEST",
    companyName: "Test Co",
    price: 100,
    compositeScore: 50,
    keyStat: "",
    thinCoverage: false,
    ...overrides,
  };
}

function sfWith(overrides: Partial<OttoSnowflakeScores>): OttoSnowflakeScores {
  return {
    valuation: emptyAxis(),
    growth: emptyAxis(),
    quality: emptyAxis(),
    financialHealth: emptyAxis(),
    momentum: emptyAxis(),
    ...overrides,
  };
}

function insiderDirection(direction: InsiderActivity["direction"]): InsiderActivity {
  return { buys: 0, sells: 0, netShares: 0, direction, transactions: [], officerNetShares: 0, hasCSuiteBuying: false, topOfficerTitle: null };
}

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

describe("passesExplicitChecks — Round 6, Phase V: real search criteria drawn from Otto's own checks", () => {
  const noMaps = [new Map<string, boolean>(), new Map<string, boolean>()] as const;

  it("passes any candidate when no requirements are given", () => {
    expect(passesExplicitChecks(baseCandidate(), null, ...noMaps)).toBe(true);
  });

  it("noEarningsManipulationRisk: excludes only a candidate whose real Beneish check actually failed", () => {
    const failed = baseCandidate({ sf: sfWith({ quality: { score: 0, checks: [{ id: "beneishMScore", label: "Beneish M-Score (0.50) shows no signs of earnings manipulation", passed: false }] } } ) });
    const passed = baseCandidate({ sf: sfWith({ quality: { score: 6, checks: [{ id: "beneishMScore", label: "Beneish M-Score (-3.00) shows no signs of earnings manipulation", passed: true }] } } ) });
    const unverified = baseCandidate({ sf: sfWith({ quality: emptyAxis() }) }); // check never ran (thin coverage) — must not be treated as a failure
    const req = { noEarningsManipulationRisk: true };
    expect(passesExplicitChecks(failed, req, ...noMaps)).toBe(false);
    expect(passesExplicitChecks(passed, req, ...noMaps)).toBe(true);
    expect(passesExplicitChecks(unverified, req, ...noMaps)).toBe(true);
  });

  it("noBankruptcyRisk: excludes only a candidate whose real Altman Z check actually failed", () => {
    const failed = baseCandidate({ sf: sfWith({ financialHealth: { score: 0, checks: [{ id: "altmanZ", label: "Altman Z-Score (0.90) signals low bankruptcy risk", passed: false }] } }) });
    const passed = baseCandidate({ sf: sfWith({ financialHealth: { score: 6, checks: [{ id: "altmanZ", label: "Altman Z-Score (5.00) signals low bankruptcy risk", passed: true }] } }) });
    const req = { noBankruptcyRisk: true };
    expect(passesExplicitChecks(failed, req, ...noMaps)).toBe(false);
    expect(passesExplicitChecks(passed, req, ...noMaps)).toBe(true);
  });

  it("stableMargins: excludes only a candidate whose real margin-stability check actually failed", () => {
    const failed = baseCandidate({ sf: sfWith({ quality: { score: 0, checks: [{ id: "marginStability", label: "Stable gross margins (12.0% variation) — low cyclicality", passed: false }] } }) });
    const passed = baseCandidate({ sf: sfWith({ quality: { score: 6, checks: [{ id: "marginStability", label: "Stable gross margins (2.0% variation) — low cyclicality", passed: true }] } }) });
    const req = { stableMargins: true };
    expect(passesExplicitChecks(failed, req, ...noMaps)).toBe(false);
    expect(passesExplicitChecks(passed, req, ...noMaps)).toBe(true);
  });

  it("noInsiderSelling: excludes only confirmed selling — no data or buying both pass (a negative-exclusion criterion, not a positive-clearance one)", () => {
    const req = { noInsiderSelling: true };
    expect(passesExplicitChecks(baseCandidate({ insiderActivity: insiderDirection("selling") }), req, ...noMaps)).toBe(false);
    expect(passesExplicitChecks(baseCandidate({ insiderActivity: insiderDirection("buying") }), req, ...noMaps)).toBe(true);
    expect(passesExplicitChecks(baseCandidate({ insiderActivity: insiderDirection("mixed") }), req, ...noMaps)).toBe(true);
    expect(passesExplicitChecks(baseCandidate(), req, ...noMaps)).toBe(true); // no insider data at all
  });

  it("requiresRealConvergence: excludes unless 2+ independent real sources actually agree", () => {
    const req = { requiresRealConvergence: true };
    const institutional = new Map([["TEST", true]]);
    const congressional = new Map([["TEST", true]]);
    const none = new Map<string, boolean>();
    // Only insider buying — 1 source, not real convergence.
    expect(passesExplicitChecks(baseCandidate({ insiderActivity: insiderDirection("buying") }), req, none, none)).toBe(false);
    // Insider buying + real institutional increase — 2 independent sources.
    expect(passesExplicitChecks(baseCandidate({ insiderActivity: insiderDirection("buying") }), req, institutional, none)).toBe(true);
    // Institutional + congressional, no insider activity at all — still 2 real sources.
    expect(passesExplicitChecks(baseCandidate(), req, institutional, congressional)).toBe(true);
    // Nothing agrees.
    expect(passesExplicitChecks(baseCandidate(), req, none, none)).toBe(false);
  });
});
