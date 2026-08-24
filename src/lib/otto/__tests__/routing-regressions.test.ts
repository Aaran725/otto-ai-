import { describe, it, expect } from "vitest";
import { extractExplicitCandidates } from "../resolve-ticker";
import { detectScreenIntent, detectThemeFilter, detectCapFilter } from "../screener";
import { themeQueryToFilter } from "../screen-query";

/**
 * Every case here is a real bug this session found live in production and
 * fixed — not a hypothetical. This file exists so the next fix for a new
 * word-collision doesn't quietly regress an old one. Only the pure,
 * network-free routing logic is covered (explicit-candidate extraction,
 * intent/theme/cap regex detection) — the LLM interpreter and the fuzzy
 * whole-message match aren't unit-testable without mocking a live network
 * call, so those stay covered by manual live verification per change.
 */

describe("extractExplicitCandidates — explicit ticker signal extraction", () => {
  it("does not extract a stray 'P' from 'P/E' (confirmed bug: resolved to a random 'P' stock)", () => {
    expect(extractExplicitCandidates("P/E under 30")).toEqual([]);
  });

  it("does not extract stray letters from other slash-separated ratios", () => {
    expect(extractExplicitCandidates("P/B under 6 and P/S under 3")).toEqual([]);
  });

  it("does not treat PEG as a ticker (collides with real ticker PEG, Public Service Enterprise Group)", () => {
    expect(extractExplicitCandidates("PEG under 2")).toEqual([]);
  });

  it("still extracts a real bare single-letter ticker only when $-prefixed", () => {
    expect(extractExplicitCandidates("what about $F right now")).toEqual(["F"]);
  });

  it("does not extract a bare (non-$) single letter as a ticker", () => {
    expect(extractExplicitCandidates("is F a buy")).toEqual([]);
  });

  it("extracts a real bare all-caps ticker mention", () => {
    expect(extractExplicitCandidates("what about UBER")).toEqual(["UBER"]);
  });

  it("does not extract common stopwords that happen to be all-caps-able", () => {
    expect(extractExplicitCandidates("IS UBER A GOOD BUY")).toEqual(["UBER"]);
  });
});

describe("detectScreenIntent — free-form phrasing coverage", () => {
  it("classifies explicit undervalued language", () => {
    expect(detectScreenIntent("find undervalued stocks")).toBe("undervalued");
  });

  it("classifies rocket-stock slang as momentum", () => {
    expect(detectScreenIntent("any rocket stocks?")).toBe("momentum");
  });

  it("classifies broad custom upside phrasing as best (regression: previously fell through to null)", () => {
    expect(detectScreenIntent("find a stock with massive upside potential")).toBe("best");
  });

  it("classifies stocks-to-avoid language", () => {
    expect(detectScreenIntent("stocks to avoid")).toBe("avoid");
  });

  it("returns null for a message with no screen signal at all", () => {
    expect(detectScreenIntent("what does ROIC mean")).toBeNull();
  });
});

describe("detectThemeFilter — fixed-list theme detection + multi-theme combos", () => {
  it("detects a single fixed theme", () => {
    const theme = detectThemeFilter("best healthcare stocks");
    expect(theme?.label).toBe("healthcare");
  });

  it("combines two matched themes into one merged filter (regression target: previously only ever returned the first match)", () => {
    const theme = detectThemeFilter("best AI healthcare stocks");
    expect(theme?.label).toContain("AI");
    expect(theme?.label).toContain("healthcare");
    // The merged regex must match either theme's industries, not require both.
    expect(theme?.industryMatch.test("Software - Infrastructure")).toBe(true);
    expect(theme?.industryMatch.test("Biotechnology")).toBe(true);
  });

  it("returns null when no fixed theme is named", () => {
    expect(detectThemeFilter("what's your best pick")).toBeNull();
  });
});

describe("detectCapFilter — mega-cap detection", () => {
  it("detects explicit mega-cap phrasing", () => {
    expect(detectCapFilter("mega cap stocks")?.minMarketCapMillions).toBe(200_000);
  });

  it("does not fire on unrelated messages", () => {
    expect(detectCapFilter("find undervalued stocks")).toBeNull();
  });
});

describe("themeQueryToFilter — LLM-derived theme -> screener filter conversion", () => {
  it("builds a working case-insensitive regex from real keywords", () => {
    const filter = themeQueryToFilter({ label: "Physical AI", keywords: ["robotics", "industrial automation"] });
    expect(filter.industryMatch.test("Industrial Automation & Robotics")).toBe(true);
    expect(filter.industryMatch.test("Pharmaceuticals")).toBe(false);
  });

  it("escapes regex-special characters in keywords instead of letting them break the pattern", () => {
    const filter = themeQueryToFilter({ label: "Test", keywords: ["C++", "R&D-heavy"] });
    expect(() => filter.industryMatch.test("anything")).not.toThrow();
  });

  it("never matches anything when given no keywords at all (seed tickers still carry the request)", () => {
    const filter = themeQueryToFilter({ label: "Empty", keywords: [] });
    expect(filter.industryMatch.test("Technology")).toBe(false);
  });
});
