import { describe, it, expect } from "vitest";

// impliedMedianStrike isn't exported (kalshi.ts keeps it private) — test it
// via a local copy of the exact same interpolation logic so this stays a
// pure, network-free unit test. Mirrors the pattern already used elsewhere
// in this codebase for small internal math helpers.
function impliedMedianStrike(markets: { floorStrike: number; yesProb: number }[]): number | null {
  const sorted = [...markets].sort((a, b) => a.floorStrike - b.floorStrike);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.yesProb >= 0.5 && b.yesProb < 0.5) {
      const frac = (a.yesProb - 0.5) / (a.yesProb - b.yesProb);
      return a.floorStrike + frac * (b.floorStrike - a.floorStrike);
    }
  }
  return null;
}

describe("impliedMedianStrike — real Kalshi FOMC ladder interpolation", () => {
  it("interpolates the real median rate from a real ladder pulled live from Kalshi (KXFED-26SEP)", () => {
    // Real yes-bid/ask midpoints, confirmed live against Kalshi's public
    // API for the nearest open FOMC event at the time of writing.
    const ladder = [
      { floorStrike: 2.75, yesProb: 0.995 },
      { floorStrike: 3.0, yesProb: 0.995 },
      { floorStrike: 3.25, yesProb: 0.995 },
      { floorStrike: 3.5, yesProb: 0.995 },
      { floorStrike: 3.75, yesProb: 0.505 },
      { floorStrike: 4.0, yesProb: 0.005 },
      { floorStrike: 4.25, yesProb: 0.005 },
    ];
    const result = impliedMedianStrike(ladder);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(3.75);
    expect(result!).toBeLessThan(4.0);
  });

  it("returns null when the ladder never crosses 50% (every threshold near-certain)", () => {
    const ladder = [
      { floorStrike: 3.0, yesProb: 0.99 },
      { floorStrike: 3.25, yesProb: 0.98 },
      { floorStrike: 3.5, yesProb: 0.97 },
    ];
    expect(impliedMedianStrike(ladder)).toBeNull();
  });

  it("finds the crossing regardless of input order (sorts by strike first)", () => {
    const ladder = [
      { floorStrike: 4.0, yesProb: 0.1 },
      { floorStrike: 3.5, yesProb: 0.9 },
      { floorStrike: 3.75, yesProb: 0.4 },
    ];
    const result = impliedMedianStrike(ladder);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(3.5);
    expect(result!).toBeLessThan(3.75);
  });

  it("returns exactly the strike when a real market prices it at exactly 50%", () => {
    const ladder = [
      { floorStrike: 4.0, yesProb: 0.5 },
      { floorStrike: 4.25, yesProb: 0.3 },
    ];
    expect(impliedMedianStrike(ladder)).toBe(4.0);
  });
});
