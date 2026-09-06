import { describe, it, expect } from "vitest";
import { normalizeIssuerName, parseInfoTable } from "../sec-13f";

describe("normalizeIssuerName — matching real 13F issuer names to Otto's own company names", () => {
  it("strips common corporate suffixes and punctuation", () => {
    expect(normalizeIssuerName("APPLE INC")).toBe("APPLE");
    expect(normalizeIssuerName("Apple Inc.")).toBe("APPLE");
    expect(normalizeIssuerName("BERKSHIRE HATHAWAY INC")).toBe("BERKSHIREHATHAWAY");
  });

  it("strips share-class suffixes real 13F filings actually use", () => {
    expect(normalizeIssuerName("ALPHABET INC-CL A")).toBe("ALPHABET");
    expect(normalizeIssuerName("ALPHABET INC-CL C")).toBe("ALPHABET");
  });

  it("normalizes case and whitespace so real-world naming variance still matches", () => {
    expect(normalizeIssuerName("ally finl inc")).toBe(normalizeIssuerName("ALLY FINL INC"));
  });

  it("returns empty string for empty input rather than throwing", () => {
    expect(normalizeIssuerName("")).toBe("");
  });
});

describe("parseInfoTable — real 13F information-table XML shape", () => {
  it("sums multiple real sub-manager rows for the same issuer into one real total", () => {
    // Same tag shape confirmed live against Berkshire Hathaway's actual
    // 2026-08-14 13F-HR filing — one real position split across several
    // otherManager rows that need summing, not just reading the first one.
    const xml = `
      <informationTable>
        <infoTable><nameOfIssuer>ALLY FINL INC</nameOfIssuer><cusip>02005N100</cusip><shrsOrPrnAmt><sshPrnamt>12561737</sshPrnamt></shrsOrPrnAmt></infoTable>
        <infoTable><nameOfIssuer>ALLY FINL INC</nameOfIssuer><cusip>02005N100</cusip><shrsOrPrnAmt><sshPrnamt>2803875</sshPrnamt></shrsOrPrnAmt></infoTable>
        <infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><cusip>037833100</cusip><shrsOrPrnAmt><sshPrnamt>300000000</sshPrnamt></shrsOrPrnAmt></infoTable>
      </informationTable>`;
    const holdings = parseInfoTable(xml);
    expect(holdings.get(normalizeIssuerName("ALLY FINL INC"))).toBe(12561737 + 2803875);
    expect(holdings.get(normalizeIssuerName("APPLE INC"))).toBe(300000000);
  });

  it("skips a row missing either real field rather than crashing or fabricating a value", () => {
    const xml = `
      <informationTable>
        <infoTable><nameOfIssuer>BROKEN CO</nameOfIssuer><cusip>000000000</cusip></infoTable>
      </informationTable>`;
    expect(parseInfoTable(xml).size).toBe(0);
  });

  it("returns an empty map for a real-shaped but empty information table", () => {
    expect(parseInfoTable("<informationTable></informationTable>").size).toBe(0);
  });
});
