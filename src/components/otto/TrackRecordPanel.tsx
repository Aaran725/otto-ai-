"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";
import type { LoggedCall } from "@/lib/otto/persistence";
import { Disclaimer } from "./Disclaimer";

const BULLISH_VERDICTS = new Set(["Strong Buy", "Buy"]);
const BEARISH_VERDICTS = new Set(["Avoid", "Strong Avoid"]);

interface SpyPoint {
  date: string;
  price: number;
}

interface CallWithPrice extends LoggedCall {
  currentPrice: number | null;
  spyReturnPct: number | null; // SPY's return over the same window as this call, null if no benchmark data
}

/** Nearest SPY monthly point to a call's date — monthly resolution means
 * this is an approximation, not an exact same-day price, but it's real
 * market data, not a fabricated baseline. */
function nearestSpyPrice(history: SpyPoint[], targetDate: string): number | null {
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
 * The single most important credibility surface in the app: every call
 * Otto has actually made (not a curated subset), checked against real
 * current prices. "Correct" only applies to directional verdicts (Buy-side
 * calls that went up, Avoid-side calls that went down) — a Hold has no
 * correct/incorrect reading, so it's excluded from the win-rate math
 * entirely rather than counted either way.
 */
export function TrackRecordPanel({ calls }: { calls: LoggedCall[] }) {
  const [withPrices, setWithPrices] = useState<CallWithPrice[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (calls.length === 0) {
      setWithPrices([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch("/api/track-record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: calls.map((c) => c.symbol) }),
    })
      .then((res) => res.json())
      .then((data: { prices: Record<string, number | null>; spy: { history: SpyPoint[]; current: number | null } }) => {
        setWithPrices(
          calls.map((c) => {
            const spyAtCall = nearestSpyPrice(data.spy.history, c.calledAt);
            const spyReturnPct =
              spyAtCall !== null && data.spy.current !== null ? (data.spy.current - spyAtCall) / spyAtCall : null;
            return { ...c, currentPrice: data.prices[c.symbol] ?? null, spyReturnPct };
          })
        );
      })
      .catch(() => setWithPrices(calls.map((c) => ({ ...c, currentPrice: null, spyReturnPct: null }))))
      .finally(() => setLoading(false));
  }, [calls]);

  if (loading || !withPrices) {
    return <p className="text-sm text-otto-text-muted">Checking current prices…</p>;
  }

  if (withPrices.length === 0) {
    return (
      <p className="text-sm text-otto-text-muted">
        No calls logged yet — every fresh stock lookup gets recorded here automatically.
      </p>
    );
  }

  const judged = withPrices.filter((c) => c.currentPrice !== null && (BULLISH_VERDICTS.has(c.verdict) || BEARISH_VERDICTS.has(c.verdict)));
  const correct = judged.filter((c) => {
    const returnPct = (c.currentPrice! - c.calledPrice) / c.calledPrice;
    return BULLISH_VERDICTS.has(c.verdict) ? returnPct > 0 : returnPct < 0;
  });
  const winRate = judged.length > 0 ? Math.round((correct.length / judged.length) * 100) : null;

  // A raw "went up" win rate doesn't mean much if the whole market went up
  // over the same stretch — alpha compares each call's own return to what
  // SPY actually did over that same window (real data, matched by date, not
  // a single blanket "the market returns ~10%/year" assumption). For a
  // bearish call, "beating the market" means the stock underperforming SPY
  // — that's the point of an Avoid call.
  const judgedWithSpy = judged.filter((c) => c.spyReturnPct !== null);
  const avgAlphaPct =
    judgedWithSpy.length > 0
      ? (judgedWithSpy.reduce((sum, c) => {
          const stockReturn = (c.currentPrice! - c.calledPrice) / c.calledPrice;
          const alpha = BULLISH_VERDICTS.has(c.verdict) ? stockReturn - c.spyReturnPct! : c.spyReturnPct! - stockReturn;
          return sum + alpha;
        }, 0) /
          judgedWithSpy.length) *
        100
      : null;

  return (
    <div>
      <h2 className="otto-text-title text-otto-text">Otto's Track Record</h2>
      <p className="mt-1 text-sm text-otto-text-muted">
        Every call logged automatically, unfiltered — {withPrices.length} total.
        {winRate !== null && (
          <>
            {" "}
            <span className="font-medium text-otto-text">{winRate}% directional win rate</span> on {judged.length}{" "}
            Buy/Avoid calls with enough time elapsed to judge.
          </>
        )}
        {avgAlphaPct !== null && (
          <>
            {" "}
            <span className={clsx("font-medium", avgAlphaPct >= 0 ? "text-otto-bull" : "text-otto-bear")}>
              {avgAlphaPct >= 0 ? "+" : ""}
              {avgAlphaPct.toFixed(1)}% avg alpha vs SPY
            </span>{" "}
            over each call's own window.
          </>
        )}
      </p>

      <div className="otto-list-group mt-4">
        {withPrices.map((c) => {
          const returnPct = c.currentPrice !== null ? (c.currentPrice - c.calledPrice) / c.calledPrice : null;
          const isJudged = BULLISH_VERDICTS.has(c.verdict) || BEARISH_VERDICTS.has(c.verdict);
          const wasCorrect =
            isJudged && returnPct !== null ? (BULLISH_VERDICTS.has(c.verdict) ? returnPct > 0 : returnPct < 0) : null;

          return (
            <div key={c.id} className="otto-list-row flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-otto-text">{c.symbol}</span>
                  <span className="text-xs text-otto-text-faint">{c.verdict}</span>
                  <span className="text-xs text-otto-text-faint">· {c.calledAt.slice(0, 10)}</span>
                </div>
                <p className="text-xs text-otto-text-muted">
                  Called at ${c.calledPrice.toFixed(2)}, conviction {Math.round(c.convictionScore)}
                </p>
              </div>
              <div className="shrink-0 text-right">
                {c.currentPrice !== null ? (
                  <>
                    <div className="tabular-nums text-sm text-otto-text">${c.currentPrice.toFixed(2)}</div>
                    <div
                      className={clsx(
                        "tabular-nums text-xs font-medium",
                        returnPct! > 0 ? "text-otto-bull" : returnPct! < 0 ? "text-otto-bear" : "text-otto-text-muted"
                      )}
                    >
                      {returnPct! > 0 ? "+" : ""}
                      {(returnPct! * 100).toFixed(1)}%
                    </div>
                  </>
                ) : (
                  <span className="text-xs text-otto-text-faint">price unavailable</span>
                )}
                {wasCorrect !== null && (
                  <div className={clsx("text-[9px] uppercase tracking-wide", wasCorrect ? "text-otto-bull" : "text-otto-bear")}>
                    {wasCorrect ? "correct" : "wrong"}
                  </div>
                )}
                {c.spyReturnPct !== null && (
                  <div className="text-[9px] text-otto-text-faint">SPY {c.spyReturnPct >= 0 ? "+" : ""}{(c.spyReturnPct * 100).toFixed(1)}%</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Disclaimer className="mt-4" />
    </div>
  );
}
