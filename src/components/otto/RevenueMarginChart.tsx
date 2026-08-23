"use client";

import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FundamentalTrendPoint } from "@/lib/otto/schema";

function formatCompact(value: number) {
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value}`;
}

/** Revenue bars with a net-margin-% line overlay — margin computed
 * client-side from data already on hand (earnings/revenue), no new fetch. */
export function RevenueMarginChart({ data }: { data: FundamentalTrendPoint[] }) {
  const chartData = data.map((d) => ({
    ...d,
    marginPct: d.revenue !== 0 ? (d.earnings / d.revenue) * 100 : 0,
  }));

  if (chartData.length === 0) {
    return (
      <div className="flex h-64 w-full items-center justify-center rounded-lg border border-dashed border-otto-border-soft">
        <p className="text-xs text-otto-text-faint">Revenue trend unavailable for this ticker right now.</p>
      </div>
    );
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--otto-border-soft)" vertical={false} />
          <XAxis dataKey="period" tick={{ fill: "var(--otto-text-faint)", fontSize: 11 }} axisLine={{ stroke: "var(--otto-border)" }} tickLine={false} />
          <YAxis yAxisId="revenue" tickFormatter={formatCompact} tick={{ fill: "var(--otto-text-faint)", fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
          <YAxis
            yAxisId="margin"
            orientation="right"
            tickFormatter={(v) => `${v}%`}
            tick={{ fill: "var(--otto-text-faint)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip
            contentStyle={{ background: "var(--otto-bg-raised)", border: "1px solid var(--otto-border)", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "var(--otto-text-muted)" }}
            formatter={(value, name) => (name === "Net Margin" ? [`${Number(value).toFixed(1)}%`, name] : [formatCompact(Number(value)), name])}
          />
          <Bar yAxisId="revenue" dataKey="revenue" name="Revenue" fill="var(--otto-border)" radius={[3, 3, 0, 0]} />
          <Line yAxisId="margin" type="monotone" dataKey="marginPct" name="Net Margin" stroke="var(--otto-gold)" strokeWidth={2} dot={{ r: 3, fill: "var(--otto-gold)" }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
