import { describe, it, expect } from "vitest";
import { usFiscalYear } from "../usaspending";

describe("usFiscalYear — the real fix for a live-confirmed fairness bug", () => {
  it("September still belongs to the fiscal year that started the previous October", () => {
    // Confirmed live: querying "most recent 2 results" naively compared a
    // complete FY2025 against an 11-months-in FY2026 and reported a
    // misleading "-40% YoY" that was really just "this year isn't over."
    expect(usFiscalYear(new Date(Date.UTC(2026, 8, 6)))).toBe(2026); // Sep 6, 2026
  });

  it("October 1st rolls over into the NEXT fiscal year, even though the calendar year hasn't turned", () => {
    expect(usFiscalYear(new Date(Date.UTC(2026, 9, 1)))).toBe(2027); // Oct 1, 2026
  });

  it("late December is still the same fiscal year as the following January", () => {
    expect(usFiscalYear(new Date(Date.UTC(2025, 11, 31)))).toBe(2026); // Dec 31, 2025
    expect(usFiscalYear(new Date(Date.UTC(2026, 0, 1)))).toBe(2026); // Jan 1, 2026
  });
});
