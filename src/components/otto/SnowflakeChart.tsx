"use client";

import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";
import type { OttoSnowflake } from "@/lib/otto/schema";

const AXIS_LABELS: Record<keyof OttoSnowflake, string> = {
  valuation: "Valuation",
  growth: "Growth",
  quality: "Quality",
  financialHealth: "Fin. Health",
  momentum: "Momentum",
};

function scoreColor(score: number) {
  if (score >= 5) return "var(--otto-bull)";
  if (score >= 3) return "var(--otto-gold)";
  return "var(--otto-bear)";
}

export function SnowflakeChart({ snowflake }: { snowflake: OttoSnowflake }) {
  const axes = Object.keys(AXIS_LABELS) as (keyof OttoSnowflake)[];
  const data = axes.map((key) => ({
    axis: AXIS_LABELS[key],
    score: snowflake[key].score,
  }));
  const avgScore = data.reduce((sum, d) => sum + d.score, 0) / data.length;
  const color = scoreColor(avgScore);

  return (
    <div>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="72%">
            <PolarGrid stroke="var(--otto-border)" />
            <PolarAngleAxis
              dataKey="axis"
              tick={{ fill: "var(--otto-text-muted)", fontSize: 11 }}
            />
            <PolarRadiusAxis domain={[0, 6]} tick={false} axisLine={false} />
            <Radar
              dataKey="score"
              stroke={color}
              fill={color}
              fillOpacity={0.25}
              strokeWidth={2}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {axes.map((key) => (
          <div key={key} className="flex items-start gap-2.5">
            <span
              className="mt-1 h-2 w-2 shrink-0 rounded-full"
              style={{ background: scoreColor(snowflake[key].score) }}
            />
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-xs font-medium text-otto-text">
                  {AXIS_LABELS[key]}
                </span>
                <span className="tabular-nums text-xs text-otto-text-faint">
                  {snowflake[key].score}/6
                </span>
                {snowflake[key].checksRun < 3 && (
                  <span className="text-[10px] text-otto-gold">low data</span>
                )}
              </div>
              <p className="text-xs leading-relaxed text-otto-text-muted">
                {snowflake[key].note}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
