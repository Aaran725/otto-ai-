"use client";

import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FundamentalTrendPoint } from "@/lib/otto/schema";

function formatCompact(value: number) {
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value}`;
}

export function FundamentalTrendChart({ data }: { data: FundamentalTrendPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 w-full items-center justify-center rounded-lg border border-dashed border-otto-border-soft">
        <p className="text-xs text-otto-text-faint">
          Financial statements unavailable for this ticker right now — data provider gap or rate limit.
        </p>
      </div>
    );
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--otto-border-soft)" vertical={false} />
          <XAxis
            dataKey="period"
            tick={{ fill: "var(--otto-text-faint)", fontSize: 11 }}
            axisLine={{ stroke: "var(--otto-border)" }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={formatCompact}
            tick={{ fill: "var(--otto-text-faint)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <Tooltip
            contentStyle={{
              background: "var(--otto-bg-raised)",
              border: "1px solid var(--otto-border)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--otto-text-muted)" }}
            formatter={(value) => formatCompact(Number(value))}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, color: "var(--otto-text-muted)" }}
            iconType="circle"
            iconSize={8}
          />
          <Bar dataKey="revenue" name="Revenue" fill="var(--otto-border)" radius={[3, 3, 0, 0]} />
          <Bar dataKey="freeCashFlow" name="Free Cash Flow" fill="var(--otto-gold)" radius={[3, 3, 0, 0]} />
          <Line
            type="monotone"
            dataKey="earnings"
            name="Earnings"
            stroke="var(--otto-bull)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--otto-bull)" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
