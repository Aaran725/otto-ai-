"use client";

import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";

export interface FactorAlphaBarDatum {
  type: string;
  label: string;
  avgAlphaPct: number;
  sampleSize: number;
}

/**
 * At-a-glance comparison across factors that actually have real data —
 * deliberately excludes zero-sample factors rather than drawing a 0%
 * bar for them, since a 0% bar reads as "measured, no effect" when the
 * real state is "not measured at all yet." The existing card grid below
 * this (screener-log page) keeps the honest "not enough data yet" /
 * "disabled" text for those; this chart is purely a faster comparison of
 * whatever factors do have a real sample size, not a replacement for that
 * detail.
 */
export function FactorAlphaBars({ data }: { data: FactorAlphaBarDatum[] }) {
  if (data.length === 0) return null;
  const sorted = [...data].sort((a, b) => b.avgAlphaPct - a.avgAlphaPct);
  const height = Math.max(sorted.length * 34, 60);

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={sorted} layout="vertical" margin={{ top: 4, right: 36, bottom: 4, left: 4 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="label"
            width={150}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--otto-text-muted)", fontSize: 11 }}
          />
          <ReferenceLine x={0} stroke="var(--otto-border)" />
          <Bar dataKey="avgAlphaPct" radius={3} barSize={12}>
            {sorted.map((d) => (
              <Cell key={d.type} fill={d.avgAlphaPct >= 0 ? "var(--otto-bull)" : "var(--otto-bear)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
