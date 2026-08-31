"use client";

import { clsx } from "clsx";
import type { SegmentAnalysis } from "@/lib/otto/segments";

// A single line of business over this share of revenue is a real
// concentration risk worth naming, not just a diversification footnote.
const CONCENTRATION_FLAG_PCT = 50;

/**
 * Real segment revenue, shown as concentration + growth — deliberately
 * not a dollar-valued "sum of the parts." See segments.ts for why: that
 * needs a different valuation multiple per segment, and applying the
 * company's own blended multiple to each piece and summing them would
 * just reproduce the market cap already known, not a real analysis.
 */
export function SegmentBreakdown({ segmentAnalysis }: { segmentAnalysis: SegmentAnalysis }) {
  const { segments, topSegmentConcentrationPct, fiscalYear } = segmentAnalysis;
  if (segments.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <p className="otto-text-label text-otto-text-faint">Revenue by Segment (FY{fiscalYear})</p>
      {topSegmentConcentrationPct >= CONCENTRATION_FLAG_PCT && (
        <div className="rounded-lg border border-otto-gold/25 bg-otto-gold-soft px-3 py-2 text-xs text-otto-text-muted">
          <span className="font-medium text-otto-gold">{topSegmentConcentrationPct}% of revenue</span> depends on{" "}
          {segments[0].label} alone — a real concentration risk, not just a diversification talking point.
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        {segments.map((s) => (
          <div key={s.label} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-otto-text">{s.label}</span>
              <span className="flex items-center gap-2 tabular-nums text-otto-text-muted">
                {s.pctOfTotal}%
                {s.yoyGrowthPct !== undefined && (
                  <span className={clsx("font-medium", s.yoyGrowthPct >= 0 ? "text-otto-bull" : "text-otto-bear")}>
                    {s.yoyGrowthPct >= 0 ? "+" : ""}
                    {s.yoyGrowthPct}% YoY
                  </span>
                )}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-otto-border-soft">
              <div className="h-full rounded-full bg-otto-gold" style={{ width: `${Math.min(s.pctOfTotal, 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
