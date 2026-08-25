"use client";

import { RadialBar, RadialBarChart, PolarAngleAxis, ResponsiveContainer } from "recharts";

/**
 * Radial "how's the $10k doing" gauge — same RadialBarChart pattern used by
 * most dashboard chart kits (Bklit UI's ARR dial among them), rebuilt here
 * in recharts (already a dependency, see SnowflakeChart/PriceChart) rather
 * than pulling in a shadcn-based component library, since this app doesn't
 * use shadcn/Radix anywhere and one gauge isn't worth that dependency chain.
 *
 * Scale is 0-200% of the ORIGINAL starting cash, not an arbitrary return-%
 * range — breakeven (ratio = 1.0) sits at the gauge's midpoint by
 * construction, profit pushes past it, loss pulls short of it. The visual
 * caps at 200% of starting cash so one outlier position can't blow out the
 * arc, but the center label always shows the real, uncapped dollar total
 * and return % — the cap only affects how far the arc is drawn, never what
 * number is displayed.
 */
export function ReturnGauge({
  totalValue,
  startingCash,
  totalReturnPct,
}: {
  totalValue: number;
  startingCash: number;
  totalReturnPct: number;
}) {
  const ratio = totalValue / startingCash;
  const cappedRatio = Math.max(0, Math.min(2, ratio));
  const gaugeValue = (cappedRatio / 2) * 100;
  const color = ratio >= 1 ? "var(--otto-bull)" : "var(--otto-bear)";

  return (
    <div className="relative h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          data={[{ value: gaugeValue }]}
          innerRadius="72%"
          outerRadius="100%"
          startAngle={90}
          endAngle={-270}
          barSize={10}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
          <RadialBar dataKey="value" cornerRadius={6} fill={color} background={{ fill: "var(--otto-border-soft)" }} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <div className="tabular-nums text-xl font-semibold text-otto-text">
          ${totalValue.toLocaleString("en-US")}
        </div>
        <div className={`tabular-nums text-sm font-medium ${totalReturnPct >= 0 ? "text-otto-bull" : "text-otto-bear"}`}>
          {totalReturnPct >= 0 ? "+" : ""}
          {totalReturnPct.toFixed(1)}%
        </div>
      </div>
    </div>
  );
}
