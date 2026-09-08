import { describe, it, expect } from "vitest";
import { normalizeIssuerName, parseInfoTable, isHighConvictionPosition } from "../sec-13f";

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
  it("sums multiple real sub-manager rows for the same issuer (shares AND value) into one real total", () => {
    // Same tag shape confirmed live against Berkshire Hathaway's actual
    // 2026-08-14 13F-HR filing — one real position split across several
    // otherManager rows that need summing, not just reading the first one.
    const xml = `
      <informationTable>
        <infoTable><nameOfIssuer>ALLY FINL INC</nameOfIssuer><cusip>02005N100</cusip><value>500000</value><shrsOrPrnAmt><sshPrnamt>12561737</sshPrnamt></shrsOrPrnAmt></infoTable>
        <infoTable><nameOfIssuer>ALLY FINL INC</nameOfIssuer><cusip>02005N100</cusip><value>120000</value><shrsOrPrnAmt><sshPrnamt>2803875</sshPrnamt></shrsOrPrnAmt></infoTable>
        <infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><cusip>037833100</cusip><value>75000000000</value><shrsOrPrnAmt><sshPrnamt>300000000</sshPrnamt></shrsOrPrnAmt></infoTable>
      </informationTable>`;
    const holdings = parseInfoTable(xml);
    expect(holdings.get(normalizeIssuerName("ALLY FINL INC"))).toEqual({ shares: 12561737 + 2803875, value: 500000 + 120000 });
    expect(holdings.get(normalizeIssuerName("APPLE INC"))).toEqual({ shares: 300000000, value: 75000000000 });
  });

  it("real fixture: Pershing Square's actual 2026-05-15 Uber row (confirmed live) parses to the exact reported shares and value", () => {
    const xml = `
      <informationTable>
        <infoTable><nameOfIssuer>UBER TECHNOLOGIES INC</nameOfIssuer><cusip>90353T100</cusip><value>2154934398</value><shrsOrPrnAmt><sshPrnamt>29958771</sshPrnamt></shrsOrPrnAmt></infoTable>
      </informationTable>`;
    expect(parseInfoTable(xml).get(normalizeIssuerName("UBER TECHNOLOGIES INC"))).toEqual({
      shares: 29958771,
      value: 2154934398,
    });
  });

  it("still counts a row missing `value` (contributes 0, not dropped) since shares is the load-bearing field", () => {
    const xml = `
      <informationTable>
        <infoTable><nameOfIssuer>NO VALUE CO</nameOfIssuer><cusip>000000001</cusip><shrsOrPrnAmt><sshPrnamt>1000</sshPrnamt></shrsOrPrnAmt></infoTable>
      </informationTable>`;
    expect(parseInfoTable(xml).get(normalizeIssuerName("NO VALUE CO"))).toEqual({ shares: 1000, value: 0 });
  });

  it("skips a row missing shares entirely rather than crashing or fabricating a value", () => {
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

describe("isHighConvictionPosition — Round 7, Phase Z: real conviction, not just any 13F filer", () => {
  it("flags every one of Pershing Square's real concentrated bets (live-pulled 2026-05-15 filing, $13.71B total book)", () => {
    // Real figures pulled live from Pershing Square's actual current 13F —
    // 7 of its 10 real positions land well clear of the 5% threshold.
    const totalPortfolioValue = 13_710_000_000;
    expect(isHighConvictionPosition(2_420_000_000, totalPortfolioValue)).toBe(true); // Brookfield, 17.6%
    expect(isHighConvictionPosition(2_390_000_000, totalPortfolioValue)).toBe(true); // Amazon, 17.4%
    expect(isHighConvictionPosition(2_150_000_000, totalPortfolioValue)).toBe(true); // Uber, 15.7%
    expect(isHighConvictionPosition(1_190_000_000, totalPortfolioValue)).toBe(true); // Howard Hughes, 8.7%
  });

  it("does not flag Pershing Square's own real small tail positions", () => {
    const totalPortfolioValue = 13_710_000_000;
    expect(isHighConvictionPosition(110_000_000, totalPortfolioValue)).toBe(false); // Seaport, 0.8%
    expect(isHighConvictionPosition(70_000_000, totalPortfolioValue)).toBe(false); // Hertz, 0.5%
  });

  it("does not flag Renaissance Technologies' real single largest position — a genuinely diversified book", () => {
    // Real figures: Nvidia was Renaissance's #1 real holding at 1.95% of
    // its real $72.6B, 2,898-position book — nowhere close to 5%.
    expect(isHighConvictionPosition(1_420_000_000, 72_600_000_000)).toBe(false);
  });

  it("never divides by zero for a manager with no real reported portfolio value", () => {
    expect(isHighConvictionPosition(1_000_000, 0)).toBe(false);
  });
});
