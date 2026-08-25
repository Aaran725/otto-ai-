"use client";

import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

// A small categorical palette for the 4 loggable intents — distinct from
// the semantic bull/bear/gold tokens (which mean "good/bad/flagship"
// elsewhere in the app), since here the colors just need to be visually
// distinguishable from each other, not carry sentiment.
const INTENT_COLORS: Record<string, string> = {
  best: "#d4af37",
  undervalued: "#10b981",
  momentum: "#60a5fa",
  quality: "#a78bfa",
};
const FALLBACK_COLOR = "#636366";

export interface CompositionDatum {
  intent: string;
  value: number;
}

/**
 * Where the open capital actually sits right now, broken down by intent —
 * extends the existing "open positions" stat with a real breakdown instead
 * of just a single blended total. Dollar-weighted (allocatedAmount), not a
 * plain count, since a $1,200 quality pick and a $0 watch-only pick
 * shouldn't look the same size on the chart.
 */
export function PortfolioCompositionDonut({ data }: { data: CompositionDatum[] }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) {
    return <p className="otto-text-caption text-otto-text-faint">No open capital allocated yet.</p>;
  }

  return (
    <div className="w-full">
      <div className="relative h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="intent" innerRadius="62%" outerRadius="95%" paddingAngle={2} stroke="none">
              {data.map((d) => (
                <Cell key={d.intent} fill={INTENT_COLORS[d.intent] ?? FALLBACK_COLOR} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="tabular-nums text-lg font-semibold text-otto-text">${Math.round(total).toLocaleString("en-US")}</div>
          <div className="otto-text-caption text-otto-text-faint">deployed</div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
        {data.map((d) => (
          <div key={d.intent} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: INTENT_COLORS[d.intent] ?? FALLBACK_COLOR }} />
            <span className="otto-text-caption capitalize text-otto-text-muted">{d.intent}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
