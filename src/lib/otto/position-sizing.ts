export interface PositionSizing {
  suggestedPct: number; // 0-15, suggested % of book for a single position
  annualizedVolatilityPct: number;
  rationale: string;
}

const MAX_POSITION_PCT = 15; // a single-name cap regardless of edge — real desks diversify

/**
 * A fractional-Kelly-style heuristic, not a rigorous Kelly calculation —
 * real Kelly needs an actual win probability and payoff ratio, which we
 * only have (roughly) from Otto's own track record once enough calls are
 * logged. Until then, this scales suggested size by two things we do have
 * for certain: conviction score as a proxy edge, and realized volatility
 * from actual price history as a real risk measure — not both from raw
 * feeling. Explicitly capped and floored so a single call never suggests
 * betting the book.
 */
export function computePositionSizing(convictionScore: number, monthlyCloses: number[]): PositionSizing | null {
  if (monthlyCloses.length < 4) return null; // not enough history for a real volatility read

  const returns: number[] = [];
  for (let i = 1; i < monthlyCloses.length; i++) {
    if (monthlyCloses[i - 1] > 0) returns.push(monthlyCloses[i] / monthlyCloses[i - 1] - 1);
  }
  if (returns.length < 3) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const monthlyStdev = Math.sqrt(variance);
  const annualizedVolatility = monthlyStdev * Math.sqrt(12);

  // edge: -1 (Strong Avoid) to +1 (Strong Buy), 0 at a neutral Hold (score 50)
  const edge = (convictionScore - 50) / 50;
  if (edge <= 0 || annualizedVolatility <= 0) {
    return {
      suggestedPct: 0,
      annualizedVolatilityPct: Math.round(annualizedVolatility * 1000) / 10,
      rationale:
        edge <= 0
          ? "Conviction isn't high enough above neutral to size a position — sit out."
          : "Not enough price history to size this responsibly.",
    };
  }

  // Fractional Kelly: divide the raw edge/volatility ratio down hard (÷4)
  // since convictionScore is a proxy for edge, not a measured probability —
  // sizing on the full theoretical Kelly fraction off a proxy would be
  // reckless. Still capped at MAX_POSITION_PCT regardless.
  const rawFraction = edge / (annualizedVolatility * 4);
  const suggestedPct = Math.round(Math.min(rawFraction * 100, MAX_POSITION_PCT) * 10) / 10;

  return {
    suggestedPct,
    annualizedVolatilityPct: Math.round(annualizedVolatility * 1000) / 10,
    rationale: `Fractional-Kelly heuristic: conviction edge scaled down by realized volatility (${(annualizedVolatility * 100).toFixed(0)}% annualized), capped at ${MAX_POSITION_PCT}% of book.`,
  };
}
