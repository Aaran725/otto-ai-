import { redis } from "./cache";
import { fetchFinnhubQuote } from "./finnhub";
import { fetchAlpacaHistoricalMonthly } from "./alpaca";
import { fetchYahooHistoricalMonthly } from "./yahoo";
import type { ScreenIntent } from "./screener";

/**
 * Permanent, append-only record of every real screener recommendation —
 * separate from the 4h screener result cache, which is about serving
 * repeated questions cheaply, not about keeping a record. Nothing here ever
 * expires. This is what a real, checkable track record is built on: what
 * Otto actually told people, unedited, checked against what really
 * happened later. See screener.ts's runScreener for the write hook.
 */

const NAMESPACE = "otto:track";
const COOLDOWN_DAYS = 30;
const MILESTONES = [30, 90, 180] as const;
type Milestone = (typeof MILESTONES)[number];

// "Being right" points in opposite directions depending on the intent. For
// every buy-side intent (best/undervalued/momentum/quality), success means
// the stock beat SPY. For "avoid", the recommendation was to steer clear —
// success means the stock LAGGED SPY, the opposite comparison. Scoring
// avoid the same direction as the others would silently mark every correct
// avoid call as a failure.
const INVERTED_INTENTS = new Set<ScreenIntent>(["avoid"]);

export interface ScreenerCallEvaluation {
  evaluatedAt: string;
  price: number;
  stockReturnPct: number;
  spyReturnPct: number;
  alphaPct: number; // direction-aware — see INVERTED_INTENTS
}

export interface ScreenerCallRecord {
  id: string;
  intent: ScreenIntent;
  symbol: string;
  companyName: string;
  priceAtCall: number;
  compositeScore: number;
  calledAt: string; // ISO timestamp
  peakPrice: number; // highest real daily price seen since calledAt (starts equal to priceAtCall)
  peakAt: string; // ISO timestamp of when peakPrice was set
  allocatedAmount: number; // simulated dollars staked at call time — see PORTFOLIO_* below
  closed: boolean; // true once its d180 milestone has been evaluated and capital returned to cash
  isFlagship: boolean; // true only for the #1-ranked pick of its scan — see logScreenerCall
  evaluations: Partial<Record<`d${Milestone}`, ScreenerCallEvaluation>>;
}

// How long the daily peak sweep keeps checking a call — a bit past the
// final 180-day milestone, then it stops: the track record's real judgment
// happens at the milestones, peak is a supplementary "how high did it get"
// figure, not something worth polling forever.
const PEAK_TRACKING_WINDOW_DAYS = 200;

const recordKey = (id: string) => `${NAMESPACE}:call:${id}`;
const cooldownKey = (intent: ScreenIntent, symbol: string) => `${NAMESPACE}:cooldown:${intent}:${symbol}`;
const intentCallsKey = (intent: ScreenIntent) => `${NAMESPACE}:calls:${intent}`;
const ALL_CALLS_KEY = `${NAMESPACE}:calls:all`;

/**
 * A real, dollar-denominated simulated portfolio layered on top of the
 * pick-by-pick track record — reports what a real $10,000 stake would
 * actually be worth today, not just an abstract average alpha percentage.
 * One combined pool across every logged intent (undervalued/momentum/
 * best/quality), not four separate pools — "the track record" is one
 * claim, not four.
 */
const PORTFOLIO_KEY = `${NAMESPACE}:portfolio`;
const STARTING_CASH = 10_000;

export interface PortfolioState {
  cashAvailable: number;
  startedAt: string;
}

async function getPortfolio(): Promise<PortfolioState> {
  const existing = await redis.get<PortfolioState>(PORTFOLIO_KEY);
  if (existing) return existing;
  const fresh: PortfolioState = { cashAvailable: STARTING_CASH, startedAt: new Date().toISOString() };
  await redis.set(PORTFOLIO_KEY, fresh);
  return fresh;
}

// Sizing is a percentage of the ORIGINAL $10,000 stake, not shrinking
// remaining cash — position sizes stay stable and comparable across the
// portfolio's life instead of shrinking as capital deploys. Scaled by
// conviction (the final composite score): a 100-score pick gets the full
// 12%, a 0-score pick (which would never actually reach a finalist slot,
// given Phase C's floors) would get the 4% minimum.
const MIN_ALLOCATION_PCT = 4;
const MAX_ALLOCATION_PCT = 12;
function targetAllocation(compositeScore: number): number {
  const clamped = Math.max(0, Math.min(100, compositeScore));
  const pct = MIN_ALLOCATION_PCT + (clamped / 100) * (MAX_ALLOCATION_PCT - MIN_ALLOCATION_PCT);
  return Math.round((pct / 100) * STARTING_CASH);
}

/**
 * Logs one real screener recommendation, permanently — unless the same
 * intent+symbol pair was already logged within the last 30 days. The
 * screener cache refreshes every 4h, so without this cooldown the same
 * pick would get logged dozens of times a month, inflating the record with
 * one bet counted repeatedly instead of distinct calls.
 *
 * isFlagship marks only the #1-ranked pick of its scan — a real,
 * pre-committed rule (the caller passes rank position, not a retroactive
 * "which one did best" call), so a headline "flagship" stat isn't diluted
 * by picks 2-5. All 5 stay in the full record and the $10k simulation
 * either way; flagship is a reporting lens on top, not a second, smaller
 * log. Awaited sequentially by the caller (see runScreener), not fire-
 * and-forget — a logging hiccup still can't affect the real screener
 * response, since errors are caught internally below.
 */
export async function logScreenerCall(params: {
  intent: ScreenIntent;
  symbol: string;
  companyName: string;
  price: number;
  compositeScore: number;
  isFlagship: boolean;
}): Promise<void> {
  // "avoid" isn't a recommendation to buy — a track record is fundamentally
  // about "here's what we told people to consider, did it work out," and an
  // avoid call inverts that (success = the stock underperforming). Keeping
  // it out of the permanent log avoids mixing two different claims under
  // one "track record" umbrella, especially while avoid's calibration is
  // the newest and least-proven of the intents (see Phase 0).
  //
  // "contrarian" is excluded for a different reason: unlike every other
  // intent, its "success" direction varies PER PICK (Otto more bullish
  // than the Street on one stock, more bearish on another) — the current
  // alpha model (INVERTED_INTENTS below) only supports one fixed direction
  // per intent. Logging these correctly would need storing each pick's
  // disagreement direction individually, not just its intent — real scope
  // beyond building the screen itself, not done here.
  if (params.intent === "avoid" || params.intent === "contrarian") return;
  try {
    const onCooldown = await redis.get(cooldownKey(params.intent, params.symbol));
    if (onCooldown) return;

    // Cash allocation: this function is called sequentially (awaited, not
    // fire-and-forget — see runScreener) in rank order for each scan's
    // finalists, so the highest-conviction pick of the batch claims cash
    // first. A pick is never skipped or left unlogged just because the sim
    // is low on funds — that would quietly bias the record toward only
    // well-funded days. When cash is scarce it just gets a smaller (or
    // $0, "watch only") stake instead; the call itself is always tracked.
    const portfolio = await getPortfolio();
    const target = targetAllocation(params.compositeScore);
    const allocatedAmount = Math.max(0, Math.min(target, portfolio.cashAvailable));

    const now = Date.now();
    const id = `${params.intent}:${params.symbol}:${now}`;
    const nowIso = new Date(now).toISOString();
    const record: ScreenerCallRecord = {
      id,
      intent: params.intent,
      symbol: params.symbol,
      companyName: params.companyName,
      priceAtCall: params.price,
      compositeScore: params.compositeScore,
      calledAt: nowIso,
      peakPrice: params.price,
      peakAt: nowIso,
      allocatedAmount,
      closed: false,
      isFlagship: params.isFlagship,
      evaluations: {},
    };
    await Promise.all([
      redis.set(recordKey(id), record),
      redis.zadd(ALL_CALLS_KEY, { score: now, member: id }),
      redis.zadd(intentCallsKey(params.intent), { score: now, member: id }),
      redis.set(cooldownKey(params.intent, params.symbol), true, { ex: COOLDOWN_DAYS * 24 * 60 * 60 }),
      redis.set(PORTFOLIO_KEY, { ...portfolio, cashAvailable: portfolio.cashAvailable - allocatedAmount }),
    ]);
  } catch {
    // Best-effort — losing a track-record entry is a completeness gap for
    // later, never a reason to fail the request that triggered it.
  }
}

export async function getAllScreenerCalls(): Promise<ScreenerCallRecord[]> {
  const ids = await redis.zrange<string[]>(ALL_CALLS_KEY, 0, -1);
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => redis.get<ScreenerCallRecord>(recordKey(id))));
  return records.filter((r): r is ScreenerCallRecord => r !== null);
}

/**
 * Wipes every logged call and every intent+symbol cooldown, and
 * reinitializes the $10,000 portfolio fresh as of right now. A real,
 * one-time operational reset — not something the app calls on its own —
 * used when the record-keeping model itself changes enough (e.g. adding
 * real dollar allocation) that mixing old, un-allocated calls with new
 * ones would misrepresent the portfolio's actual history.
 */
export async function resetTrackRecord(): Promise<{ purgedCalls: number }> {
  const calls = await getAllScreenerCalls();
  await Promise.all([
    ...calls.map((c) => redis.del(recordKey(c.id))),
    ...calls.map((c) => redis.del(cooldownKey(c.intent, c.symbol))),
    redis.del(ALL_CALLS_KEY),
    ...(["undervalued", "momentum", "best", "quality"] as ScreenIntent[]).map((intent) => redis.del(intentCallsKey(intent))),
  ]);
  const fresh: PortfolioState = { cashAvailable: STARTING_CASH, startedAt: new Date().toISOString() };
  await redis.set(PORTFOLIO_KEY, fresh);
  return { purgedCalls: calls.length };
}

interface PricePoint {
  date: string;
  price: number;
}

/** Nearest SPY monthly point to a target date — monthly resolution means
 * this is an approximation, not an exact same-day price, but it's real
 * market data. Mirrors TrackRecordPanel's client-side helper of the same
 * name; kept as a small separate copy here since this runs server-side in
 * a cron sweep, not in the browser. */
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Shared direction logic between the permanent milestone evaluator and the
 * live on-demand viewer below — see INVERTED_INTENTS for why "avoid"
 * flips the comparison. */
function computeAlpha(intent: ScreenIntent, stockReturnPct: number, spyReturnPct: number): number {
  return INVERTED_INTENTS.has(intent) ? spyReturnPct - stockReturnPct : stockReturnPct - spyReturnPct;
}

export interface ScreenerCallWithLive extends ScreenerCallRecord {
  live: {
    price: number;
    stockReturnPct: number;
    spyReturnPct: number;
    alphaPct: number;
  } | null; // null when a live quote couldn't be fetched
}

/**
 * On-demand mark-to-market for every logged call, computed fresh on each
 * request and never written to Redis — the permanent record only ever gets
 * written by evaluateDueScreenerCalls() at real 30/90/180-day milestones.
 * This exists purely so a human can ask "what's this worth right now"
 * without waiting for a milestone to land; it's not part of the official
 * track record math.
 */
export async function getScreenerCallsWithLiveMarks(): Promise<ScreenerCallWithLive[]> {
  const calls = await getAllScreenerCalls();
  if (calls.length === 0) return [];

  const [spyHistoryAlpaca, spyQuote] = await Promise.all([
    fetchAlpacaHistoricalMonthly("SPY").catch(() => []),
    fetchFinnhubQuote("SPY").catch(() => null),
  ]);
  const spyHistory = spyHistoryAlpaca.length > 0 ? spyHistoryAlpaca : await fetchYahooHistoricalMonthly("SPY").catch(() => []);
  const spyCurrent = spyQuote?.price ?? null;

  return Promise.all(
    calls.map(async (call): Promise<ScreenerCallWithLive> => {
      const quote = await fetchFinnhubQuote(call.symbol).catch(() => null);
      const currentPrice = quote?.price ?? null;
      const spyAtCall = nearestPrice(spyHistory, call.calledAt);
      if (currentPrice === null || spyAtCall === null || spyCurrent === null) {
        return { ...call, live: null };
      }
      const stockReturnPct = ((currentPrice - call.priceAtCall) / call.priceAtCall) * 100;
      const spyReturnPct = ((spyCurrent - spyAtCall) / spyAtCall) * 100;
      return {
        ...call,
        live: { price: currentPrice, stockReturnPct, spyReturnPct, alphaPct: computeAlpha(call.intent, stockReturnPct, spyReturnPct) },
      };
    })
  );
}

export interface PortfolioSummary {
  startedAt: string;
  startingCash: number;
  cashAvailable: number;
  openPositionsValue: number;
  totalValue: number;
  totalReturnPct: number;
  openPositionCount: number;
  closedPositionCount: number;
}

/**
 * The real dollar-denominated headline: what a $10,000 stake, sized by
 * real conviction and allocated in the real order picks were made, is
 * actually worth today — cash on hand plus the live mark-to-market value
 * of every still-open position. Open positions use the same live quote as
 * getScreenerCallsWithLiveMarks; closed ones (past their 180-day horizon)
 * already had their value folded back into cashAvailable at close time, so
 * they don't get double-counted here.
 */
export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const [portfolio, callsWithLive] = await Promise.all([getPortfolio(), getScreenerCallsWithLiveMarks()]);
  const open = callsWithLive.filter((c) => !c.closed);
  const openPositionsValue = open.reduce((sum, c) => {
    const liveReturnPct = c.live?.stockReturnPct ?? 0;
    return sum + c.allocatedAmount * (1 + liveReturnPct / 100);
  }, 0);
  const totalValue = portfolio.cashAvailable + openPositionsValue;
  return {
    startedAt: portfolio.startedAt,
    startingCash: STARTING_CASH,
    cashAvailable: Math.round(portfolio.cashAvailable),
    openPositionsValue: Math.round(openPositionsValue),
    totalValue: Math.round(totalValue),
    totalReturnPct: ((totalValue - STARTING_CASH) / STARTING_CASH) * 100,
    openPositionCount: open.length,
    closedPositionCount: callsWithLive.length - open.length,
  };
}

export interface FlagshipSummary {
  count: number;
  avgLiveAlphaPct: number | null; // across flagship calls with a resolvable live quote
  avgD30AlphaPct: number | null;
  avgD90AlphaPct: number | null;
  avgD180AlphaPct: number | null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The flagship-only lens on the same data — Otto's single highest-
 * conviction pick per scan (isFlagship), not diluted by picks 2-5. This is
 * the number worth leading with once the record is public: a smaller,
 * cleaner, higher-bar sample rather than the full portfolio's blended
 * average.
 */
export async function getFlagshipSummary(): Promise<FlagshipSummary> {
  const calls = await getScreenerCallsWithLiveMarks();
  const flagship = calls.filter((c) => c.isFlagship);
  return {
    count: flagship.length,
    avgLiveAlphaPct: average(flagship.map((c) => c.live?.alphaPct).filter((v): v is number => v !== undefined)),
    avgD30AlphaPct: average(flagship.map((c) => c.evaluations.d30?.alphaPct).filter((v): v is number => v !== undefined)),
    avgD90AlphaPct: average(flagship.map((c) => c.evaluations.d90?.alphaPct).filter((v): v is number => v !== undefined)),
    avgD180AlphaPct: average(flagship.map((c) => c.evaluations.d180?.alphaPct).filter((v): v is number => v !== undefined)),
  };
}

/**
 * Daily peak update — checks today's real price for every call still
 * within the tracking window and raises peakPrice/peakAt if today's price
 * is a new high since the call was made. This is a real, daily-granularity
 * high-water mark (not a continuous intraday peak — the cron only runs
 * once a day), so it can miss an intraday spike that fully reverted before
 * the next sweep, but it correctly captures any peak that held through at
 * least one daily check. Never lowers peakPrice — a peak, once real, stays
 * on the record even after the price comes back down.
 */
export async function updateDailyPeaks(): Promise<{ updated: number; checked: number }> {
  const calls = await getAllScreenerCalls();
  const now = Date.now();
  const active = calls.filter((c) => (now - new Date(c.calledAt).getTime()) / MS_PER_DAY <= PEAK_TRACKING_WINDOW_DAYS);
  if (active.length === 0) return { updated: 0, checked: calls.length };

  let updated = 0;
  for (const call of active) {
    try {
      const quote = await fetchFinnhubQuote(call.symbol).catch(() => null);
      const currentPrice = quote?.price ?? null;
      if (currentPrice === null || currentPrice <= call.peakPrice) continue;
      await redis.set(recordKey(call.id), {
        ...call,
        peakPrice: currentPrice,
        peakAt: new Date(now).toISOString(),
      });
      updated += 1;
    } catch {
      // one bad symbol shouldn't sink the whole sweep
    }
  }
  return { updated, checked: active.length };
}

/**
 * Sweeps every logged call for milestones (30/90/180 days) that have been
 * crossed but not yet evaluated, computes real realized alpha vs SPY, and
 * writes the result back permanently. Idempotent — safe to run daily via
 * cron without double-processing anything already evaluated. If a sweep is
 * ever missed for a stretch, multiple milestones can come due for the same
 * call at once; each due call gets exactly one write with every newly-due
 * milestone folded in together, using today's real price for all of them —
 * there's no fabricated backdating of what we didn't check in time.
 */
export async function evaluateDueScreenerCalls(): Promise<{ evaluated: number; checked: number }> {
  const calls = await getAllScreenerCalls();
  const now = Date.now();

  const due = new Map<string, { call: ScreenerCallRecord; milestones: Milestone[] }>();
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

      const evaluation: ScreenerCallEvaluation = {
        evaluatedAt: new Date().toISOString(),
        price: currentPrice,
        stockReturnPct,
        spyReturnPct,
        alphaPct,
      };
      const newEvaluations = { ...call.evaluations };
      for (const m of milestones) newEvaluations[`d${m}`] = evaluation;

      // 180 days is the position's full horizon — closing it returns its
      // real, realized simulated value (stake × (1 + actual stock return))
      // back to the cash pool, freeing capital for new picks instead of
      // leaving it locked in a position the record has already fully
      // judged. This is the portfolio's only turnover mechanic, anchored
      // on data already collected here, not a separate exit rule.
      const closing = milestones.includes(180);
      if (closing) {
        const portfolio = await getPortfolio();
        const closingValue = call.allocatedAmount * (1 + stockReturnPct / 100);
        await redis.set(PORTFOLIO_KEY, { ...portfolio, cashAvailable: portfolio.cashAvailable + closingValue });
      }

      await redis.set(recordKey(call.id), { ...call, evaluations: newEvaluations, closed: closing || call.closed });
      evaluated += milestones.length;
    } catch {
      // one bad symbol shouldn't sink the whole sweep
    }
  }
  return { evaluated, checked: calls.length };
}
