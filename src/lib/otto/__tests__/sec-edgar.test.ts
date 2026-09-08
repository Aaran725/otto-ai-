import { describe, it, expect } from "vitest";
import { findTenKIndices, findRiskFactorsSectionStart } from "../sec-edgar";

describe("findTenKIndices — Round 8, Phase EE: real year-over-year 10-K pairing", () => {
  it("finds the first two real 10-K indices, skipping interleaved 10-Qs and other filing types", () => {
    // Real, realistic shape: a submissions feed lists filings newest-first,
    // with 10-Qs and other forms (8-K, DEF 14A) interleaved between 10-Ks.
    const form = ["8-K", "10-Q", "10-Q", "10-K", "10-Q", "DEF 14A", "10-Q", "10-K", "10-Q"];
    expect(findTenKIndices(form, 2)).toEqual([3, 7]);
  });

  it("returns fewer than requested when a company doesn't have that many real 10-Ks on file yet", () => {
    const form = ["8-K", "10-Q", "10-K"];
    expect(findTenKIndices(form, 2)).toEqual([2]);
  });

  it("returns an empty array when there are no real 10-Ks at all", () => {
    expect(findTenKIndices(["10-Q", "8-K"], 2)).toEqual([]);
  });
});

describe("findRiskFactorsSectionStart — the real fix for landing on a cross-reference instead of the real section", () => {
  it("skips real cross-references and lands on the real section heading, confirmed against NVDA's actual live 10-K text shape", () => {
    // Real, live-confirmed shape: "Item 1A. Risk Factors" appears 7 times
    // in NVDA's actual most recent 10-K — a naive first-match regex landed
    // on one of the cross-references below (real text pulled live), not
    // the real section, which only ever continues with "The following
    // risk(s)..." rather than "for a discussion of..."/"for additional
    // information about...".
    // Padded with enough real filler text between occurrences that the
    // 300-char lookahead window can't bleed from one match into the next
    // — real 10-Ks separate these occurrences by thousands of characters,
    // not a few dozen, so this mirrors that real spacing.
    const filler = "x".repeat(500);
    const html = [
      'Item 1A. Risk Factors &#8211; Risks Related to Regulatory, Legal, Our Stock, and Other Matters" for a discussion of this potential impact.',
      'Item 1A. Risk Factors" for a discussion of these potential impacts. Human Capital Management',
      "Item 1A. Risk Factors The following risk factors should be considered in addition to the other information in this Annual Report on Form 10-K.",
      'Item 1A. Risk factors" in this annual report on Form 10-K for additional information about cybersecurity-related risks.',
    ].join(` ${filler} `);
    const start = findRiskFactorsSectionStart(html);
    expect(start).not.toBeNull();
    expect(html.slice(start!, start! + 100)).toContain("The following risk factors should be considered");
  });

  it("returns null when the phrase never appears at all", () => {
    expect(findRiskFactorsSectionStart("<p>Item 1. Business</p>")).toBeNull();
  });
});
