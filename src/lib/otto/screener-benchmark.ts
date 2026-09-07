import { redis } from "./cache";
import { fetchFinnhubQuote } from "./finnhub";
import { fetchAlpacaHistoricalMonthly } from "./alpaca";
import { fetchYahooHistoricalMonthly } from "./yahoo";
import { computeAlpha, getAllScreenerCalls } from "./screener-track-record";
import type { ScreenIntent } from "./screener";

/**
 * The "dumb-money arena" (Phase L) — real, notional (zero-capital) tracking
 * of a random 5-stock draw and an equal-weight basket of all 14
 * semifinalists, logged at the exact same moment (same request, same pool)
 * a real scan narrows to its finalists, and evaluated through the same
 * real SPY-relative alpha math as every real pick. This is what makes
 * "our picks aren't random" a real, running, checkable number instead of
 * an assurance — the entire reason this phase exists.
 *
 * Deliberately its own fully separate module and Redis namespace, NOT
 * layered into ScreenerCallRecord/PORTFOLIO_KEY (screener-track-record.ts):
 * that system's every closing/early-exit branch moves real simulated
 * dollars between cash pools, and a benchmark call has — and must always
 * have — zero capital behind it. Duplicating the compact evaluation loop
 * here (rather than adding a "skip cash movement" branch to the real one)
 * means a benchmark record can never accidentally touch the real $10k
 * portfolio, at the cost of a small amount of parallel structure.
 *
 * Equal-weight basket math: rather than tracking one synthetic "basket"
 * position, each of the 14 semifinalists is logged as its own record
 * (benchmark: "equalWeight") and evaluated individually. Because alpha is
 * linear (alpha_i = stockReturn_i - spyReturn, same spyReturn for every
 * symbol drawn the same day), the AVERAGE of 14 individually-evaluated
 * alphas is exactly equal to the real alpha of an equal-weighted basket of
 * those same 14 — no separate basket-return calculation needed, and it
 * reuses the exact same per-symbol evaluation path as "random" and every
 * real pick.
 */

const NAMESPACE = "otto:benchmark";
const COOLDOWN_DAYS = 30;
const MILESTONES = [30, 90, 180] as const;
type Milestone = (typeof MILESTONES)[number];

export type BenchmarkType = "random" | "equalWeight";

export interface BenchmarkCallEvaluation {
  evaluatedAt: string;
  price: number;
  stockReturnPct: number;
  spyReturnPct: number;
  alphaPct: number; // direction-aware — see computeAlpha in screener-track-record.ts
}

export interface BenchmarkCallRecord {
  id: string;
  benchmark: BenchmarkType;
  intent: ScreenIntent;
  symbol: string;
  companyName: string;
  priceAtCall: number;
  calledAt: string;
  evaluations: Partial<Record<`d${Milestone}`, BenchmarkCallEvaluation>>;
  closed: boolean;
}

const recordKey = (id: string) => `${NAMESPACE}:call:${id}`;
const cooldownKey = (benchmark: BenchmarkType, intent: ScreenIntent, symbol: string) =>
  `${NAMESPACE}:cooldown:${benchmark}:${intent}:${symbol}`;
const ALL_CALLS_KEY = `${NAMESPACE}:calls:all`;

/**
 * Logs one notional benchmark pick — zero simulated capital, real
 * evaluation. Same 30-day per-(benchmark, intent, symbol) cooldown
 * discipline as logScreenerCall, for the same reason: without it, the same
 * symbol re-appearing across many 4h cache-refresh cycles within a month
 * would flood the sample with one repeated draw instead of distinct ones.
 * Best-effort, same as logScreenerCall — never allowed to affect the real
 * screener response.
 */
export async function logBenchmarkCall(params: {
  benchmark: BenchmarkType;
  intent: ScreenIntent;
  symbol: string;
  companyName: string;
  price: number;
}): Promise<void> {
  // Same real reason as logScreenerCall's own exclusion: "contrarian"'s
  // success direction varies per-pick, not per-intent, so there's no
  // single fixed direction to compare a random draw against.
  if (params.intent === "contrarian") return;
  try {
    const key = cooldownKey(params.benchmark, params.intent, params.symbol);
    const onCooldown = await redis.get(key);
    if (onCooldown) return;

    const now = Date.now();
    const id = `${params.benchmark}:${params.intent}:${params.symbol}:${now}`;
    const record: BenchmarkCallRecord = {
      id,
      benchmark: params.benchmark,
      intent: params.intent,
      symbol: params.symbol,
      companyName: params.companyName,
      priceAtCall: params.price,
      calledAt: new Date(now).toISOString(),
      evaluations: {},
      closed: false,
    };
    await Promise.all([
      redis.set(recordKey(id), record),
      redis.zadd(ALL_CALLS_KEY, { score: now, member: id }),
      redis.set(key, true, { ex: COOLDOWN_DAYS * 24 * 60 * 60 }),
    ]);
  } catch {
    // Best-effort — losing a benchmark sample is never a reason to fail
    // the real screener request that triggered it.
  }
}

export async function getAllBenchmarkCalls(): Promise<BenchmarkCallRecord[]> {
  const ids = await redis.zrange<string[]>(ALL_CALLS_KEY, 0, -1);
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => redis.get<BenchmarkCallRecord>(recordKey(id))));
  return records.filter((r): r is BenchmarkCallRecord => r !== null);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface PricePoint {
  date: string;
  price: number;
}

/** Same real approximation as screener-track-record.ts's own copy — kept
 * separate rather than exported/shared since this module is deliberately
 * self-contained (see the file-level comment on why). */
function nearestPrice(history: PricePoint[], targetDate: string): number | null {
  if (history.length === 0) return null;
  const target = new Date(targetDate).getTime();
  let best = history[0];
  let bestDiff = Math.abs(new Date(best.date).getTime() - target);
  for (const point of history) {
    const diff = Math.abs(new Date(point.date).getTime() - target);
    if (diff < bestDiff) {
      best = point;
      bestDiff = diff;
    }
  }
  return best.price;
}

/**
 * Same 30/90/180-day milestone sweep as evaluateDueScreenerCalls, minus
 * every bit of PORTFOLIO_KEY cash-movement logic — there's nothing to
 * credit or debit here. Idempotent, same as the real sweep: safe to run
 * daily via cron without double-processing anything already evaluated.
 */
export async function evaluateDueBenchmarkCalls(): Promise<{ evaluated: number; checked: number }> {
  const calls = await getAllBenchmarkCalls();
  const now = Date.now();

  const due = new Map<string, { call: BenchmarkCallRecord; milestones: Milestone[] }>();
  for (const call of calls) {
    const ageDays = (now - new Date(call.calledAt).getTime()) / MS_PER_DAY;
    const milestones = MILESTONES.filter((m) => ageDays >= m && !call.evaluations[`d${m}`]);
    if (milestones.length > 0) due.set(call.id, { call, milestones });
  }
  if (due.size === 0) return { evaluated: 0, checked: calls.length };

  const [spyHistoryAlpaca, spyQuote] = await Promise.all([
    fetchAlpacaHistoricalMonthly("SPY").catch(() => []),
    fetchFinnhubQuote("SPY").catch(() => null),
  ]);
  const spyHistory = spyHistoryAlpaca.length > 0 ? spyHistoryAlpaca : await fetchYahooHistoricalMonthly("SPY").catch(() => []);
  const spyCurrent = spyQuote?.price ?? null;

  let evaluated = 0;
  for (const { call, milestones } of due.values()) {
    try {
      const quote = await fetchFinnhubQuote(call.symbol).catch(() => null);
      const currentPrice = quote?.price ?? null;
      const spyAtCall = nearestPrice(spyHistory, call.calledAt);
      if (currentPrice === null || spyAtCall === null || spyCurrent === null) continue;

      const stockReturnPct = ((currentPrice - call.priceAtCall) / call.priceAtCall) * 100;
      const spyReturnPct = ((spyCurrent - spyAtCall) / spyAtCall) * 100;
      const alphaPct = computeAlpha(call.intent, stockReturnPct, spyReturnPct);

      const evaluation: BenchmarkCallEvaluation = {
        evaluatedAt: new Date().toISOString(),
        price: currentPrice,
        stockReturnPct,
        spyReturnPct,
        alphaPct,
      };
      const newEvaluations = { ...call.evaluations };
      for (const m of milestones) newEvaluations[`d${m}`] = evaluation;

      await redis.set(recordKey(call.id), {
        ...call,
        evaluations: newEvaluations,
        closed: milestones.includes(180) || call.closed,
      });
      evaluated += milestones.length;
    } catch {
      // one bad symbol shouldn't sink the whole sweep
    }
  }
  return { evaluated, checked: calls.length };
}

export interface BenchmarkComparisonRow {
  benchmark: BenchmarkType;
  sampleSize: number; // number of real, evaluated d30 alphas behind this average
  avgAlphaPct: number;
}

export interface BenchmarkSummary {
  realPicks: { sampleSize: number; avgAlphaPct: number };
  benchmarks: BenchmarkComparisonRow[];
}

/**
 * The actual headline number Phase L exists to produce: real logged picks'
 * average real d30 alpha vs. each benchmark's average real d30 alpha,
 * blended across every tracked intent (each already direction-normalized
 * by computeAlpha, so blending "undervalued" alongside "avoid" is
 * apples-to-apples). d30 chosen deliberately — the milestone most likely
 * to have real sample size early, same one the factor kill-switch and the
 * bandit both lean on first. Returns sampleSize 0 / avgAlphaPct 0 for any
 * side with no real evaluated data yet — never a fabricated placeholder
 * number.
 */
function avg(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Pure grouping/averaging core of getBenchmarkSummary, pulled out so it's
 * directly testable without a real Redis round-trip — mirrors how
 * computeAlpha/positionValue in screener-track-record.ts stay pure and
 * exported while the I/O around them doesn't. Returns sampleSize 0 /
 * avgAlphaPct 0 for a benchmark type with no d30 entries yet, in the same
 * order as `benchmarkTypes`, rather than omitting the row — the caller
 * always gets one entry per type, even at zero real samples.
 */
export function summarizeAlphaByBenchmark(
  d30Alphas: { benchmark: BenchmarkType; alphaPct: number }[],
  benchmarkTypes: BenchmarkType[]
): BenchmarkComparisonRow[] {
  const byBenchmark = new Map<BenchmarkType, number[]>();
  for (const { benchmark, alphaPct } of d30Alphas) {
    const arr = byBenchmark.get(benchmark) ?? [];
    arr.push(alphaPct);
    byBenchmark.set(benchmark, arr);
  }
  return benchmarkTypes.map((benchmark) => {
    const values = byBenchmark.get(benchmark) ?? [];
    return { benchmark, sampleSize: values.length, avgAlphaPct: values.length > 0 ? avg(values) : 0 };
  });
}

export async function getBenchmarkSummary(): Promise<BenchmarkSummary> {
  const [benchmarkCalls, realCalls] = await Promise.all([getAllBenchmarkCalls(), getAllScreenerCalls()]);

  const d30Alphas = benchmarkCalls
    .filter((c) => c.evaluations.d30)
    .map((c) => ({ benchmark: c.benchmark, alphaPct: c.evaluations.d30!.alphaPct }));
  const benchmarks = summarizeAlphaByBenchmark(d30Alphas, ["random", "equalWeight"]);

  const realAlphas = realCalls.map((c) => c.evaluations.d30?.alphaPct).filter((a): a is number => a !== undefined);
  return {
    realPicks: { sampleSize: realAlphas.length, avgAlphaPct: realAlphas.length > 0 ? avg(realAlphas) : 0 },
    benchmarks,
  };
}
