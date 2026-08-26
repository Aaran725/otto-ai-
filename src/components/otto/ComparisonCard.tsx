"use client";

import { clsx } from "clsx";
import type { OttoAnalysis } from "@/lib/otto/schema";
import type { ComparisonResult } from "@/lib/otto/chat-types";
import { VerdictTag } from "./VerdictTag";
import { SnowflakeChart } from "./SnowflakeChart";
import { Disclaimer } from "./Disclaimer";

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
        {analyses.map((analysis) => (
          <button
            key={analysis.ticker}
            onClick={() => onSelect?.(analysis.ticker)}
            className="min-w-0 rounded-xl border border-otto-border-soft p-3 text-left transition-colors hover:border-otto-text-faint"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="otto-text-title text-otto-text">{analysis.ticker}</span>
              <span
                className="tabular-nums text-lg font-semibold"
                style={{ color: analysis.dataQuality === "insufficient" ? "var(--otto-text-faint)" : scoreColor(analysis.convictionScore) }}
              >
                {analysis.dataQuality === "insufficient" ? "—" : Math.round(analysis.convictionScore)}
              </span>
            </div>
            <p className="otto-text-caption truncate text-otto-text-muted">{analysis.companyName}</p>
            <div className="mt-1.5">
              <VerdictTag verdict={analysis.verdict} dataQuality={analysis.dataQuality} />
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="tabular-nums text-sm font-medium text-otto-text">${analysis.price.toFixed(2)}</span>
              <span className={clsx("tabular-nums text-xs", analysis.priceChangePercent1D >= 0 ? "text-otto-bull" : "text-otto-bear")}>
                {analysis.priceChangePercent1D >= 0 ? "+" : ""}
                {analysis.priceChangePercent1D.toFixed(2)}%
              </span>
            </div>
            <p className="otto-text-caption mt-2 line-clamp-3 text-otto-text-muted">{analysis.oneLiner}</p>
            <div className="mt-2">
              <SnowflakeChart snowflake={analysis.snowflake} />
            </div>
          </button>
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
