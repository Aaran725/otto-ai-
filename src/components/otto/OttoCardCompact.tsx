"use client";

import { clsx } from "clsx";
import type { OttoAnalysis } from "@/lib/otto/schema";
import { VerdictTag } from "./VerdictTag";
import { MiniSparkline } from "./MiniSparkline";
import { Disclaimer } from "./Disclaimer";

function scoreColor(score: number) {
  if (score >= 75) return "var(--otto-gold)";
  if (score >= 55) return "var(--otto-bull)";
  if (score >= 40) return "var(--otto-text-muted)";
  return "var(--otto-bear)";
}

const BULLISH_VERDICTS = new Set(["Strong Buy", "Buy"]);
const BEARISH_VERDICTS = new Set(["Avoid", "Strong Avoid"]);

function glowClass(verdict: string) {
  if (BULLISH_VERDICTS.has(verdict)) return "otto-glow-bull";
  if (BEARISH_VERDICTS.has(verdict)) return "otto-glow-bear";
  return "otto-glow-neutral";
}

export function OttoCardCompact({
  analysis,
  onExpand,
  watched,
  onToggleWatch,
}: {
  analysis: OttoAnalysis;
  onExpand: () => void;
  watched?: boolean;
  onToggleWatch?: () => void;
}) {
  const positive = analysis.priceChangePercent1D >= 0;

  return (
    <div
      className={clsx(
        "otto-material otto-collapse otto-elevation-raised otto-lift group w-full max-w-md rounded-2xl border p-5 text-left transition-colors hover:border-otto-text-faint",
        analysis.dataQuality === "insufficient" ? "otto-glow-neutral" : glowClass(analysis.verdict)
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <button onClick={onExpand} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="otto-text-title text-otto-text">{analysis.ticker}</span>
            <VerdictTag verdict={analysis.verdict} dataQuality={analysis.dataQuality} />
          </div>
          <p className="otto-text-caption mt-0.5 truncate text-otto-text-muted">{analysis.companyName}</p>

          <div className="mt-3 flex items-baseline gap-2">
            <span className="tabular-nums text-xl font-semibold text-otto-text">
              ${analysis.price.toFixed(2)}
            </span>
            <span
              className={clsx(
                "tabular-nums text-xs font-medium",
                positive ? "text-otto-bull" : "text-otto-bear"
              )}
            >
              {positive ? "+" : ""}
              {analysis.priceChangePercent1D.toFixed(2)}%
            </span>
          </div>
        </button>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {onToggleWatch && (
              <button
                onClick={onToggleWatch}
                aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
                className={clsx("text-lg leading-none", watched ? "text-otto-gold" : "text-otto-text-faint hover:text-otto-text")}
              >
                {watched ? "★" : "☆"}
              </button>
            )}
            <span
              className="tabular-nums text-2xl font-semibold"
              style={{ color: analysis.dataQuality === "insufficient" ? "var(--otto-text-faint)" : scoreColor(analysis.convictionScore) }}
            >
              {analysis.dataQuality === "insufficient" ? "—" : Math.round(analysis.convictionScore)}
            </span>
          </div>
          <MiniSparkline data={analysis.historicalPrices} positive={positive} />
        </div>
      </div>

      <button onClick={onExpand} className="w-full text-left">
        <p className="otto-text-body mt-4 line-clamp-2 text-otto-text-muted">
          {analysis.oneLiner}
        </p>

        <span className="mt-3 inline-block text-xs font-medium text-otto-gold opacity-0 transition-opacity group-hover:opacity-100">
          View full research →
        </span>
      </button>
      <Disclaimer className="mt-2" />
    </div>
  );
}
