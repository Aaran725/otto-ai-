"use client";

import type { CSSProperties } from "react";
import { clsx } from "clsx";
import type { OttoAnalysis } from "@/lib/otto/schema";
import type { ComparisonResult } from "@/lib/otto/chat-types";
import { VerdictTag } from "./VerdictTag";
import { SnowflakeChart } from "./SnowflakeChart";
import { Disclaimer } from "./Disclaimer";
import { CountUp } from "./CountUp";
import { useGlassPointer } from "./useGlassPointer";

function scoreColor(score: number) {
  if (score >= 75) return "var(--otto-gold)";
  if (score >= 55) return "var(--otto-bull)";
  if (score >= 40) return "var(--otto-text-muted)";
  return "var(--otto-bear)";
}

const SIGNAL_COLOR: Record<"bull" | "bear" | "neutral", string> = {
  bull: "text-otto-bull",
  bear: "text-otto-bear",
  neutral: "text-otto-text-muted",
};

/** One column of the comparison grid — its own component so each instance
 * gets its own useGlassPointer hook call (each column's cursor spotlight
 * tracks independently; hooks can't be called inside .map()). */
function ComparisonColumn({
  analysis,
  index,
  onSelect,
}: {
  analysis: OttoAnalysis;
  index: number;
  onSelect?: (symbol: string) => void;
}) {
  const glass = useGlassPointer<HTMLButtonElement>();

  return (
    <button
      ref={glass.ref}
      onMouseMove={glass.onMouseMove}
      onClick={() => onSelect?.(analysis.ticker)}
      style={{ animationDelay: `${index * 80}ms` }}
      className="otto-arrive otto-glass min-w-0 rounded-xl border border-otto-border-soft p-3 text-left transition-colors hover:border-otto-text-faint"
    >
      <div className="relative z-10 flex items-center justify-between gap-2">
        <span className="otto-text-title text-otto-text">{analysis.ticker}</span>
        <span
          className={clsx(analysis.dataQuality !== "insufficient" && "otto-score-halo")}
          style={
            analysis.dataQuality === "insufficient"
              ? undefined
              : ({ "--halo-color": scoreColor(analysis.convictionScore) } as CSSProperties)
          }
        >
          <span
            className="tabular-nums text-lg font-semibold"
            style={{ color: analysis.dataQuality === "insufficient" ? "var(--otto-text-faint)" : scoreColor(analysis.convictionScore) }}
          >
            {analysis.dataQuality === "insufficient" ? "—" : <CountUp value={Math.round(analysis.convictionScore)} />}
          </span>
        </span>
      </div>
      <p className="otto-text-caption relative z-10 truncate text-otto-text-muted">{analysis.companyName}</p>
      <div className="relative z-10 mt-1.5">
        <VerdictTag verdict={analysis.verdict} dataQuality={analysis.dataQuality} />
      </div>
      <div className="relative z-10 mt-2 flex items-baseline gap-1.5">
        <span className="tabular-nums text-sm font-medium text-otto-text">${analysis.price.toFixed(2)}</span>
        <span className={clsx("tabular-nums text-xs", analysis.priceChangePercent1D >= 0 ? "text-otto-bull" : "text-otto-bear")}>
          {analysis.priceChangePercent1D >= 0 ? "+" : ""}
          {analysis.priceChangePercent1D.toFixed(2)}%
        </span>
      </div>
      <p className="otto-text-caption relative z-10 mt-2 line-clamp-3 text-otto-text-muted">{analysis.oneLiner}</p>
      <div className="relative z-10 mt-2">
        <SnowflakeChart snowflake={analysis.snowflake} />
      </div>
    </button>
  );
}

/** N-way side-by-side view (2-3 stocks) from one comparison request — each
 * column is the exact same real OttoAnalysis a single search would produce,
 * just laid out for a direct read instead of 2-3 separate messages. Metrics
 * are aligned by label across columns (Otto's own pipeline always produces
 * the same fixed set — Valuation, FCF Yield, ROIC, Debt-to-Equity, Revenue
 * Growth, Net Margin — so the first analysis's label order is a safe key). */
export function ComparisonCard({
  comparison,
  onSelect,
}: {
  comparison: ComparisonResult;
  onSelect?: (symbol: string) => void;
}) {
  const { tickers: analyses } = comparison;
  const metricLabels = analyses[0]?.metrics.map((m) => m.label) ?? [];

  return (
    <div className="otto-material otto-elevation-raised w-full rounded-2xl border border-otto-border p-5">
      <div
        className={clsx(
          "grid gap-4",
          analyses.length >= 3 ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"
        )}
      >
        {analyses.map((analysis, i) => (
          <ComparisonColumn key={analysis.ticker} analysis={analysis} index={i} onSelect={onSelect} />
        ))}
      </div>

      {metricLabels.length > 0 && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-xs">
            <thead>
              <tr className="border-b border-otto-border-soft text-otto-text-faint">
                <th className="py-1.5 pr-3 font-medium">Metric</th>
                {analyses.map((a) => (
                  <th key={a.ticker} className="py-1.5 pr-3 text-right font-medium">
                    {a.ticker}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metricLabels.map((label, i) => (
                <tr key={label} className="border-b border-otto-border-soft/50 last:border-0">
                  <td className="py-1.5 pr-3 text-otto-text-muted">{label}</td>
                  {analyses.map((a) => {
                    const cell = a.metrics[i];
                    return (
                      <td key={a.ticker} className={clsx("py-1.5 pr-3 text-right tabular-nums", cell ? SIGNAL_COLOR[cell.signal] : "text-otto-text-faint")}>
                        {cell?.value ?? "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Disclaimer className="mt-3" />
    </div>
  );
}
