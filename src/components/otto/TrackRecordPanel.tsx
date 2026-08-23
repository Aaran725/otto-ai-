"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";
import type { LoggedCall } from "@/lib/otto/persistence";
import { Disclaimer } from "./Disclaimer";

const BULLISH_VERDICTS = new Set(["Strong Buy", "Buy"]);
const BEARISH_VERDICTS = new Set(["Avoid", "Strong Avoid"]);

interface CallWithPrice extends LoggedCall {
  currentPrice: number | null;
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
      .then((data: { prices: Record<string, number | null> }) => {
        setWithPrices(calls.map((c) => ({ ...c, currentPrice: data.prices[c.symbol] ?? null })));
      })
      .catch(() => setWithPrices(calls.map((c) => ({ ...c, currentPrice: null }))))
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
              </div>
            </div>
          );
        })}
      </div>

      <Disclaimer className="mt-4" />
    </div>
  );
}
