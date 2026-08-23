"use client";

import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import type { InsiderActivity, InsiderTransaction } from "@/lib/otto/insider";

function formatCompact(value: number) {
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function toPoint(t: InsiderTransaction) {
  return {
    x: new Date(t.date).getTime(),
    y: t.value ?? t.shares,
    shares: t.shares,
    date: t.date,
    hasValue: t.value !== undefined,
  };
}

/** Real Form 4 open-market transactions plotted over time — a scatter
 * instead of a single "buying/selling" badge, so the size and cadence of
 * insider activity is visible, not just its net direction. Bubble size
 * scales with dollar value when a transaction price was reported; falls
 * back to share count when it wasn't (SEC's XML doesn't always carry a
 * price, e.g. for certain gift/gift-adjacent open-market codes). */
export function InsiderTimeline({ insiderActivity }: { insiderActivity: InsiderActivity }) {
  const { buys, sells, netShares, direction, transactions } = insiderActivity;

  if (transactions.length === 0) {
    return (
      <div className="flex h-48 w-full items-center justify-center rounded-lg border border-dashed border-otto-border-soft">
        <p className="otto-text-caption text-otto-text-faint">No open-market insider transactions in the last 180 days.</p>
      </div>
    );
  }

  const buyPoints = transactions.filter((t) => t.code === "P").map(toPoint);
  const sellPoints = transactions.filter((t) => t.code === "S").map(toPoint);
  const directionColor = direction === "buying" ? "var(--otto-bull)" : direction === "selling" ? "var(--otto-bear)" : "var(--otto-text-muted)";

  return (
    <div className="flex flex-col gap-3">
      <p className="otto-text-caption text-otto-text-muted">
        <span className="font-medium" style={{ color: directionColor }}>
          Net {direction}
        </span>{" "}
        over the last 180 days — {buys} buy{buys === 1 ? "" : "s"}, {sells} sell{sells === 1 ? "" : "s"}, net{" "}
        {Math.abs(netShares).toLocaleString()} shares {netShares >= 0 ? "bought" : "sold"}.
      </p>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--otto-border-soft)" vertical={false} />
            <XAxis
              dataKey="x"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              tick={{ fill: "var(--otto-text-faint)", fontSize: 11 }}
              axisLine={{ stroke: "var(--otto-border)" }}
              tickLine={false}
            />
            <YAxis
              dataKey="y"
              tickFormatter={(v) => formatCompact(Number(v))}
              tick={{ fill: "var(--otto-text-faint)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <ZAxis dataKey="y" range={[40, 260]} />
            <Tooltip
              cursor={{ stroke: "var(--otto-border)" }}
              contentStyle={{ background: "var(--otto-bg-raised)", border: "1px solid var(--otto-border)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "var(--otto-text-muted)" }}
              formatter={(value, name, props) => {
                const p = props.payload as ReturnType<typeof toPoint>;
                const label = p.hasValue ? formatCompact(Number(value)) : `${p.shares.toLocaleString()} sh`;
                return [label, name];
              }}
              labelFormatter={(v) => new Date(Number(v)).toLocaleDateString()}
            />
            <Scatter name="Buy" data={buyPoints} fill="var(--otto-bull)" fillOpacity={0.75} />
            <Scatter name="Sell" data={sellPoints} fill="var(--otto-bear)" fillOpacity={0.75} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <p className="otto-text-caption flex items-center gap-3 text-otto-text-faint">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-otto-bull" /> Buy
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-otto-bear" /> Sell
        </span>
        <span>· bubble size = transaction size</span>
      </p>
    </div>
  );
}
