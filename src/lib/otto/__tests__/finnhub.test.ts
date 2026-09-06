import { describe, it, expect } from "vitest";
import { findRevenueConcept } from "../finnhub";

describe("findRevenueConcept — the real fix for banks silently breaking financials-trend", () => {
  it("uses the standard commercial-company revenue tag when it exists", () => {
    const ic = [
      { concept: "us-gaap_Revenues", value: 1000 },
      { concept: "us-gaap_NetIncomeLoss", value: 100 },
    ];
    expect(findRevenueConcept(ic)).toBe(1000);
  });

  it("falls back to net interest income + noninterest income for a real bank with no standard revenue tag", () => {
    // Real concept values pulled live from Finnhub's actual /stock/financials-reported
    // response for UMBF (UMB Financial Corp) — confirmed zero standard revenue tags
    // present at all, which silently broke fetchFinnhubFinancialsTrend (and,
    // downstream, Phase A's sector-relative scoring) for every bank candidate.
    const ic = [
      { concept: "us-gaap_InterestAndDividendIncomeOperating", value: 3354280000 },
      { concept: "us-gaap_InterestIncomeExpenseNet", value: 1862205000 },
      { concept: "us-gaap_NoninterestIncome", value: 790050000 },
      { concept: "us-gaap_NetIncomeLoss", value: 702398000 },
    ];
    expect(findRevenueConcept(ic)).toBe(1862205000 + 790050000);
  });

  it("still returns undefined when neither the standard tags nor the bank fallback tags exist", () => {
    const ic = [{ concept: "us-gaap_SomeUnrelatedConcept", value: 42 }];
    expect(findRevenueConcept(ic)).toBeUndefined();
  });

  it("handles a bank fallback with no noninterest income reported, treating it as zero rather than failing", () => {
    const ic = [{ concept: "us-gaap_InterestIncomeExpenseNet", value: 500 }];
    expect(findRevenueConcept(ic)).toBe(500);
  });

  it("returns undefined for undefined input rather than throwing", () => {
    expect(findRevenueConcept(undefined)).toBeUndefined();
  });
});
