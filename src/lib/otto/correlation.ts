import type { DailyPricePoint } from "./alpaca";

/**
 * Daily simple returns from a chronologically-ordered price series. Assumes
 * `points` is already sorted oldest-to-newest (Alpaca's bars endpoint
 * returns them that way) — no sort here, since sorting cheaply-wrong
 * (e.g. by string date) is worse than trusting the known-good input order.
 */
export function computeDailyReturns(points: DailyPricePoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].price;
    const curr = points[i].price;
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  return returns;
}

// Fewer than this many overlapping daily returns isn't enough to trust a
// correlation figure — it would swing wildly on a couple of shared moves
// rather than reflecting real co-movement.
const MIN_OVERLAP = 20;

/**
 * Pearson correlation between two return series, aligned by trailing index
 * (both series' most recent N days, not by explicit date-matching — daily
 * bars from the same lookback window line up in practice). Returns null,
 * not 0, when there isn't enough overlapping data — null means "unknown,"
 * 0 means "measured and genuinely uncorrelated," and callers must not
 * conflate the two (see diversifySelection).
 */
export function pearsonCorrelation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < MIN_OVERLAP) return null;
  const xs = a.slice(-n);
  const ys = b.slice(-n);
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  // Effectively-zero variance (a flat series, or one that rounds to flat
  // after floating-point summation) has no defined correlation — an epsilon
  // guard rather than exact `=== 0`, since summing many identical floats can
  // land a hair off zero from rounding alone.
  if (varX < 1e-12 || varY < 1e-12) return null;
  return cov / Math.sqrt(varX * varY);
}

/**
 * Greedily walks `ranked` (already sorted best-first) and accepts a
 * candidate unless it's highly correlated with an already-accepted pick —
 * in which case it's skipped, not dropped from the pool, and the walk
 * continues for a replacement. This is what turns "top 5 by score" into
 * "top 5 by score that aren't secretly one concentrated bet."
 *
 * If the ranked list is exhausted before reaching targetCount (a real risk
 * with a short list or a market-wide single-factor move correlating
 * everything), backfills by relaxing the threshold rather than silently
 * shipping fewer than targetCount picks — a partial list is a worse outcome
 * than a slightly-more-correlated one, since the caller committed to
 * returning exactly targetCount finalists.
 */
export function diversifySelection<T extends { symbol: string }>(
  ranked: T[],
  priceSeriesBySymbol: Map<string, DailyPricePoint[]>,
  targetCount: number,
  maxPairwiseCorrelation = 0.8
): T[] {
  const returnsBySymbol = new Map<string, number[]>();
  for (const [symbol, points] of priceSeriesBySymbol) {
    returnsBySymbol.set(symbol, computeDailyReturns(points));
  }

  function isTooCorrelated(candidate: T, accepted: T[], threshold: number): boolean {
    const candidateReturns = returnsBySymbol.get(candidate.symbol);
    if (!candidateReturns) return false; // no data — fail open, never block on an unknown
    for (const a of accepted) {
      const acceptedReturns = returnsBySymbol.get(a.symbol);
      if (!acceptedReturns) continue;
      const corr = pearsonCorrelation(candidateReturns, acceptedReturns);
      if (corr !== null && corr > threshold) return true;
    }
    return false;
  }

  function walk(threshold: number): T[] {
    const accepted: T[] = [];
    for (const candidate of ranked) {
      if (accepted.length >= targetCount) break;
      if (!isTooCorrelated(candidate, accepted, threshold)) accepted.push(candidate);
    }
    return accepted;
  }

  const primary = walk(maxPairwiseCorrelation);
  if (primary.length >= targetCount) return primary;

  // Backfill: relax the threshold in steps rather than an all-or-nothing
  // fallback to the raw ranked list — this still prefers less-correlated
  // combinations when any exist, and only fully gives up diversification
  // (threshold 1.0, i.e. accept everything) if the pool is truly too thin.
  for (const threshold of [0.9, 0.95, 1.01]) {
    const relaxed = walk(threshold);
    if (relaxed.length >= targetCount) return relaxed;
  }
  return ranked.slice(0, targetCount);
}
