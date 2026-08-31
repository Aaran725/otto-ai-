import { describe, it, expect } from "vitest";
import { buildReconciliationNoteFromSnapshot } from "../groq";
import type { OttoSnowflakeScores } from "../snowflake";

function sf(overrides: Partial<Record<keyof OttoSnowflakeScores, number>> = {}): OttoSnowflakeScores {
  const base = { valuation: 3, growth: 3, quality: 3, financialHealth: 3, momentum: 3, ...overrides };
  const axis = (score: number) => ({ score, checks: [] });
  return {
    valuation: axis(base.valuation),
    growth: axis(base.growth),
    quality: axis(base.quality),
    financialHealth: axis(base.financialHealth),
    momentum: axis(base.momentum),
  };
}

describe("buildReconciliationNoteFromSnapshot", () => {
  it("returns null when there's no cached screener result to compare against", () => {
    expect(buildReconciliationNoteFromSnapshot(null, 80, sf())).toBeNull();
  });

  it("returns null when the gap is below the threshold — the generic disclaimer already covers it", () => {
    const note = buildReconciliationNoteFromSnapshot({ compositeScore: 75, sf: sf() }, 84, sf()); // delta = 9
    expect(note).toBeNull();
  });

  it("fires right at the threshold boundary, not just strictly above it", () => {
    const note = buildReconciliationNoteFromSnapshot({ compositeScore: 75, sf: sf() }, 85, sf()); // delta = 10
    expect(note).not.toBeNull();
  });

  it("names the single axis that actually drove the gap, with its real from/to scores", () => {
    const screenerSf = sf({ growth: 1 });
    const analysisSf = sf({ growth: 6 }); // the only axis that moved, and by a lot
    const note = buildReconciliationNoteFromSnapshot({ compositeScore: 60, sf: screenerSf }, 85, analysisSf);
    expect(note).toContain("growth");
    expect(note).toContain("1/6");
    expect(note).toContain("6/6");
    expect(note).toContain("moved up to 85");
  });

  it("says 'down' when the full analysis landed below the screener score", () => {
    const screenerSf = sf({ quality: 6 });
    const analysisSf = sf({ quality: 1 });
    const note = buildReconciliationNoteFromSnapshot({ compositeScore: 90, sf: screenerSf }, 65, analysisSf);
    expect(note).toContain("moved down to 65");
    expect(note).toContain("quality");
  });

  it("falls back to the generic message when the gap is real but spread thinly across axes, no single driver", () => {
    // Every axis moved by exactly 1 (below the >=2 "worth naming" bar),
    // but they add up to a real double-digit composite gap.
    const screenerSf = sf({ valuation: 3, growth: 3, quality: 3, financialHealth: 3, momentum: 3 });
    const analysisSf = sf({ valuation: 4, growth: 4, quality: 2, financialHealth: 2, momentum: 4 });
    const note = buildReconciliationNoteFromSnapshot({ compositeScore: 60, sf: screenerSf }, 72, analysisSf);
    expect(note).toMatch(/quicker, thinner scan/);
    expect(note).not.toMatch(/mainly driven by/);
  });

  it("picks the single LARGEST axis delta when more than one axis moved enough to qualify", () => {
    const screenerSf = sf({ valuation: 3, growth: 3 });
    const analysisSf = sf({ valuation: 5, growth: 6 }); // valuation +2, growth +3 — growth is bigger
    const note = buildReconciliationNoteFromSnapshot({ compositeScore: 60, sf: screenerSf }, 85, analysisSf);
    expect(note).toContain("growth");
    expect(note).not.toContain("mainly driven by valuation");
  });
});
