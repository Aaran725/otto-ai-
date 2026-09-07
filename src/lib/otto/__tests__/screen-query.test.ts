import { describe, it, expect } from "vitest";
import { sanitizeRequirements } from "../screen-query";

describe("sanitizeRequirements — the real fix for the LLM's explicit-null fields", () => {
  it("strips explicit nulls the model writes for fields it means to leave unset", () => {
    // Real, live-confirmed shape: the model fills in every declared schema
    // key rather than omitting unset ones. "cheap stocks with no insider
    // selling" returned exactly this — maxPE/minRevenueGrowthPct/etc all
    // null, only noInsiderSelling actually set — and untreated, req.maxPE
    // !== undefined (null !== undefined is true) coerced to a `pe > 0`
    // check that rejected every real candidate.
    const raw = {
      maxPE: null,
      minRevenueGrowthPct: null,
      minROICPct: null,
      minFCFYieldPct: null,
      noEarningsManipulationRisk: null,
      noBankruptcyRisk: null,
      stableMargins: null,
      noInsiderSelling: true,
      requiresRealConvergence: null,
    } as never;
    expect(sanitizeRequirements(raw)).toEqual({ noInsiderSelling: true });
  });

  it("returns null when every field is null (no real requirement stated at all)", () => {
    const raw = { maxPE: null, noInsiderSelling: null } as never;
    expect(sanitizeRequirements(raw)).toBeNull();
  });

  it("returns null unchanged, and passes through a clean object unchanged", () => {
    expect(sanitizeRequirements(null)).toBeNull();
    expect(sanitizeRequirements(undefined)).toBeNull();
    expect(sanitizeRequirements({ maxPE: 25, noBankruptcyRisk: true })).toEqual({ maxPE: 25, noBankruptcyRisk: true });
  });
});
