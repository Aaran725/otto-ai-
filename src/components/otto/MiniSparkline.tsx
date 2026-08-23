"use client";

import { Line, LineChart, ResponsiveContainer } from "recharts";
import type { HistoricalPoint } from "@/lib/otto/schema";

export function MiniSparkline({
  data,
  positive,
}: {
  data: HistoricalPoint[];
  positive: boolean;
}) {
  const color = positive ? "var(--otto-bull)" : "var(--otto-bear)";

  return (
    <div className="h-10 w-24 shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="close"
            stroke={color}
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
