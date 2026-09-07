import { describe, it, expect } from "vitest";
import { summarizeAlphaByBenchmark } from "../screener-benchmark";

describe("summarizeAlphaByBenchmark — the dumb-money arena's real comparison math", () => {
  it("averages real d30 alphas per benchmark type", () => {
    const result = summarizeAlphaByBenchmark(
      [
        { benchmark: "random", alphaPct: 10 },
        { benchmark: "random", alphaPct: -4 },
        { benchmark: "equalWeight", alphaPct: 2 },
        { benchmark: "equalWeight", alphaPct: 6 },
        { benchmark: "equalWeight", alphaPct: 4 },
      ],
      ["random", "equalWeight"]
    );
    expect(result).toEqual([
      { benchmark: "random", sampleSize: 2, avgAlphaPct: 3 },
      { benchmark: "equalWeight", sampleSize: 3, avgAlphaPct: 4 },
    ]);
  });

  it("returns a zero-sample row (never omits or fabricates) for a benchmark type with no real entries yet", () => {
    const result = summarizeAlphaByBenchmark([{ benchmark: "random", alphaPct: 5 }], ["random", "equalWeight"]);
    expect(result).toEqual([
      { benchmark: "random", sampleSize: 1, avgAlphaPct: 5 },
      { benchmark: "equalWeight", sampleSize: 0, avgAlphaPct: 0 },
    ]);
  });

  it("preserves the requested benchmarkTypes order regardless of input order", () => {
    const result = summarizeAlphaByBenchmark(
      [
        { benchmark: "equalWeight", alphaPct: 1 },
        { benchmark: "random", alphaPct: 2 },
      ],
      ["random", "equalWeight"]
    );
    expect(result.map((r) => r.benchmark)).toEqual(["random", "equalWeight"]);
  });
});
