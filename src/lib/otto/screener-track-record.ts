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
 * Logs one real screener recommendation, permanently — unless the same
 * intent+symbol pair was already logged within the last 30 days. The
 * screener cache refreshes every 4h, so without this cooldown the same
 * pick would get logged dozens of times a month, inflating the record with
 * one bet counted repeatedly instead of distinct calls. Fire-and-forget
 * from the caller (runScreener) — a logging hiccup must never affect the
 * real screener response the user actually sees.
 */
export async function logScreenerCall(params: {
  intent: ScreenIntent;
  symbol: string;
  companyName: string;
  price: number;
  compositeScore: number;
}): Promise<void> {
  try {
    const onCooldown = await redis.get(cooldownKey(params.intent, params.symbol));
    if (onCooldown) return;

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
      evaluations: {},
    };
    await Promise.all([
      redis.set(recordKey(id), record),
      redis.zadd(ALL_CALLS_KEY, { score: now, member: id }),
      redis.zadd(intentCallsKey(params.intent), { score: now, member: id }),
      redis.set(cooldownKey(params.intent, params.symbol), true, { ex: COOLDOWN_DAYS * 24 * 60 * 60 }),
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

      await redis.set(recordKey(call.id), { ...call, evaluations: newEvaluations });
      evaluated += milestones.length;
    } catch {
      // one bad symbol shouldn't sink the whole sweep
    }
  }
  return { evaluated, checked: calls.length };
}
