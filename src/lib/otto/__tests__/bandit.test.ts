import { describe, it, expect } from "vitest";
import { sampleBeta } from "../bandit";

function meanOf(samples: number[]): number {
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

// Statistical tests on a real random sampler — generous tolerances on
// purpose (this is genuinely random, not deterministic), but tight enough
// to catch a real implementation bug: the sampler silently ignoring one
// of its two parameters, always returning a fixed value, or landing
// outside [0,1] would all still pass a single-sample smoke test and would
// all fail here.
describe("sampleBeta — the real math the bandit's decisions are built on", () => {
  it("every sample lands in [0, 1] — a hard invariant regardless of parameters", () => {
    for (let i = 0; i < 500; i++) {
      const s = sampleBeta(1 + Math.random() * 50, 1 + Math.random() * 50);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("Beta(1,1) is uniform — mean converges to ~0.5 over many samples", () => {
    const samples = Array.from({ length: 5000 }, () => sampleBeta(1, 1));
    expect(meanOf(samples)).toBeCloseTo(0.5, 1);
  });

  it("a variant with strong real winning evidence samples high on average — the actual exploitation behavior", () => {
    // Beta(50, 5): 50 real wins, 5 real losses — a variant the bandit
    // should now trust a lot. True mean = 50/55 ≈ 0.909.
    const samples = Array.from({ length: 3000 }, () => sampleBeta(50, 5));
    expect(meanOf(samples)).toBeGreaterThan(0.8);
  });

  it("a variant with strong real losing evidence samples low on average", () => {
    // Beta(5, 50): the mirror case, true mean = 5/55 ≈ 0.091.
    const samples = Array.from({ length: 3000 }, () => sampleBeta(5, 50));
    expect(meanOf(samples)).toBeLessThan(0.2);
  });

  it("an untested variant (wide posterior) sometimes samples HIGHER than a proven winner — real exploration, not pure exploitation", () => {
    // This is the actual mechanism that keeps the bandit from permanently
    // locking onto an early leader: Beta(1,1)'s wide spread means it can
    // beat even a strongly-winning Beta(30,3) by chance often enough to
    // keep getting picked occasionally.
    let untestedWinsCount = 0;
    const trials = 4000;
    for (let i = 0; i < trials; i++) {
      const provenWinner = sampleBeta(30, 3);
      const untested = sampleBeta(1, 1);
      if (untested > provenWinner) untestedWinsCount++;
    }
    // Not "wins often" — just "wins sometimes," which is the whole point.
    // A broken sampler that always returns the theoretical mean (no real
    // randomness) would make this exactly 0.
    expect(untestedWinsCount).toBeGreaterThan(0);
    expect(untestedWinsCount / trials).toBeLessThan(0.5); // but still loses more than it wins, as it should
  });

  it("more real evidence narrows the distribution — Beta(500,50) is far more consistent than Beta(5,1) at the same ~90% implied rate", () => {
    const wellTested = Array.from({ length: 2000 }, () => sampleBeta(500, 50));
    const barelyTested = Array.from({ length: 2000 }, () => sampleBeta(5, 1));
    const variance = (samples: number[]) => {
      const m = meanOf(samples);
      return meanOf(samples.map((s) => (s - m) ** 2));
    };
    expect(variance(wellTested)).toBeLessThan(variance(barelyTested));
  });
});
