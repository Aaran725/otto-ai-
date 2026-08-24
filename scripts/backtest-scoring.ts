/**
 * Free, honest sanity check on the screener's scoring weights — run
 * on-demand with `npx tsx scripts/backtest-scoring.ts`, not part of the
 * deployed app.
 *
 * WHAT THIS IS: a real diagnostic using the exact production scoring
 * functions (imported from screener.ts, not reimplemented — so this can
 * never silently drift from what's actually deployed) run against a broad,
 * randomly-sampled slice of the real market, correlated against real
 * trailing 26-week price returns (Finnhub, already fetched for every
 * candidate in production, zero extra cost).
 *
 * WHAT THIS IS NOT, and why: a true point-in-time backtest would score each
 * stock using the fundamentals AS THEY WERE months ago and check what
 * happened AFTER that date. FMP/Finnhub's free tiers only expose CURRENT
 * fundamentals — there is no free source of historical point-in-time
 * ratios/key-metrics. So this script can only correlate TODAY's score
 * against the TRAILING return leading up to today, not a genuine forward
 * prediction. That's a real, disclosed limitation, not a bug to fix later.
 *
 * Given that constraint, trailing-correlation still catches real
 * miscalibration:
 *   - "avoid" should correlate NEGATIVELY with trailing return (the
 *     weakest-scoring stocks should have actually been struggling).
 *   - "momentum"/"quality"/"best" should correlate POSITIVELY (they're
 *     built from axes — momentum explicitly, quality/financial-health
 *     implicitly — that track recent performance).
 *   - "undervalued" is NOT expected to correlate positively — a stock is
 *     often cheap BECAUSE it just underperformed (mean reversion). A near-
 *     zero or even negative correlation there is not a failure. What WOULD
 *     be a red flag: "undervalued" showing the same strong positive
 *     correlation as "momentum" — that would mean the value-score blend
 *     (see screener.ts's VALUE_SCORE_BLEND) is accidentally just
 *     re-detecting momentum instead of real cheapness.
 *
 * The real forward-looking validation (does a screener pick actually beat
 * SPY over the following months) can only come from letting time pass on
 * real, timestamped picks — that's what TrackRecordPanel already does for
 * single-stock analysis calls; extending that same logging to screener
 * picks is the honest next step once this diagnostic doesn't flag anything
 * structurally broken.
 */
import { fetchSecUniverse } from "../src/lib/otto/sec-universe";
import { computeSnowflake } from "../src/lib/otto/snowflake";
import { computeValueScore } from "../src/lib/otto/value-score";
import { mapWithConcurrency } from "../src/lib/otto/batch";
import {
  buildFinnhubBundle,
  scoreCandidate,
  applyValueScoreBlend,
  AXIS_WEIGHTS,
  ASCENDING_INTENTS,
  type ScreenIntent,
} from "../src/lib/otto/screener";

const SAMPLE_SIZE = 200;
const CONCURRENCY = 10; // stay well under Finnhub's 60/min-per-key budget alongside normal traffic
const INTENTS: ScreenIntent[] = ["undervalued", "momentum", "best", "quality", "avoid"];

function mulberry32(seed: number) {
  let state = seed | 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Evenly-spaced sample across the whole universe (not just the mega-cap
 * head) so the correlation check sees real losers as well as real winners —
 * a sample skewed toward prominent/successful companies couldn't ever show
 * a meaningful "avoid" correlation. */
function stratifiedSample<T>(pool: T[], n: number, seed: number): T[] {
  const random = mulberry32(seed);
  const step = pool.length / n;
  const picked: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(pool.length - 1, Math.floor(i * step + random() * step));
    picked.push(pool[idx]);
  }
  return picked;
}

function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 5) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
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
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

/** Splits into 5 buckets by score and reports mean trailing return per
 * bucket — more interpretable than a bare correlation coefficient, and
 * catches non-monotonic miscalibration a linear correlation can miss. */
function quintileReport(pairs: { score: number; trailingReturn: number }[]): string {
  const sorted = [...pairs].sort((a, b) => a.score - b.score);
  const bucketSize = Math.ceil(sorted.length / 5);
  const lines: string[] = [];
  for (let q = 0; q < 5; q++) {
    const bucket = sorted.slice(q * bucketSize, (q + 1) * bucketSize);
    if (bucket.length === 0) continue;
    const avgReturn = bucket.reduce((a, b) => a + b.trailingReturn, 0) / bucket.length;
    const scoreRange = `${bucket[0].score.toFixed(0)}-${bucket.at(-1)!.score.toFixed(0)}`;
    lines.push(`    Q${q + 1} (score ${scoreRange}, n=${bucket.length}): avg trailing 26wk return ${avgReturn >= 0 ? "+" : ""}${avgReturn.toFixed(1)}%`);
  }
  return lines.join("\n");
}

async function main() {
  console.log(`Sampling ${SAMPLE_SIZE} real tickers from the SEC universe...`);
  const universe = await fetchSecUniverse(2000);
  const sample = stratifiedSample(universe, SAMPLE_SIZE, 20260824);

  console.log(`Fetching real fundamentals + scoring ${sample.length} candidates via production functions...`);
  const results = await mapWithConcurrency(sample, CONCURRENCY, async (entry) => {
    try {
      const bundle = await buildFinnhubBundle(entry.symbol);
      if (!bundle) return null;
      const trailingReturn = bundle.keyMetrics?.twentySixWeekReturn;
      if (trailingReturn === undefined) return null; // can't validate without real trailing-return data
      const sf = computeSnowflake(bundle);
      const valueScore = computeValueScore(bundle.ratios, bundle.keyMetrics);
      const scoresByIntent: Partial<Record<ScreenIntent, number>> = {};
      for (const intent of INTENTS) {
        scoresByIntent[intent] = applyValueScoreBlend(intent, scoreCandidate(intent, sf, AXIS_WEIGHTS[intent]), valueScore);
      }
      return { symbol: entry.symbol, trailingReturn: trailingReturn * 100, scoresByIntent };
    } catch {
      return null;
    }
  });

  const valid = results.filter((r): r is NonNullable<typeof r> => r !== null);
  console.log(`\n${valid.length}/${sample.length} candidates had usable data (real fundamentals + trailing return).\n`);
  console.log("=".repeat(72));
  console.log("SCORING WEIGHT SANITY CHECK — trailing 26-week return correlation");
  console.log("=".repeat(72));

  for (const intent of INTENTS) {
    const pairs = valid.map((v) => ({ score: v.scoresByIntent[intent]!, trailingReturn: v.trailingReturn }));
    const correlation = pearsonCorrelation(
      pairs.map((p) => p.score),
      pairs.map((p) => p.trailingReturn)
    );
    const expected = ASCENDING_INTENTS.has(intent)
      ? "expect NEGATIVE (weakest scores should be real laggards)"
      : intent === "undervalued"
        ? "no strong expectation either way (mean reversion) — a strong POSITIVE match to momentum's number would be the red flag"
        : "expect weak-to-moderate POSITIVE";
    console.log(`\n${intent.toUpperCase()} (n=${pairs.length}) — ${expected}`);
    console.log(`  Pearson r = ${correlation !== null ? correlation.toFixed(3) : "n/a (insufficient variance)"}`);
    console.log(quintileReport(pairs));
  }
  console.log(`\n${"=".repeat(72)}`);
  console.log(
    "Reminder: this is a trailing-correlation sanity check, not a forward\n" +
      "predictive backtest — free data tiers don't expose point-in-time\n" +
      "historical fundamentals. Treat a wildly wrong-signed correlation as a\n" +
      "real red flag; treat a clean signal here as 'not obviously broken,'\n" +
      "not as proof of forward alpha."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
