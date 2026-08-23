"use client";

import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoricalPoint, OttoForecast, StreetConsensus } from "@/lib/otto/schema";

const FORECAST_LABEL = "+12mo";

interface ChartPoint {
  date: string;
  close?: number;
  bear?: number;
  base?: number;
  bull?: number;
  street?: number;
  bandBase?: number; // invisible stack base = bear
  bandRange?: number; // stacked on top = bull - bear
}

function buildChartData(
  data: HistoricalPoint[],
  forecast?: OttoForecast,
  street?: StreetConsensus | null
): ChartPoint[] {
  const points: ChartPoint[] = data.map((p) => ({ date: p.date, close: p.close }));
  if (!forecast || points.length === 0) return points;

  const last = points[points.length - 1];
  const anchor = last.close ?? 0;
  last.bear = anchor;
  last.base = anchor;
  last.bull = anchor;
  last.bandBase = anchor;
  last.bandRange = 0;
  const hasStreetTarget = street?.targetConsensus !== undefined;
  if (hasStreetTarget) last.street = anchor;

  points.push({
    date: FORECAST_LABEL,
    bear: forecast.bearTarget,
    base: forecast.baseTarget,
    bull: forecast.bullTarget,
    bandBase: forecast.bearTarget,
    bandRange: Math.max(forecast.bullTarget - forecast.bearTarget, 0),
    ...(hasStreetTarget ? { street: street!.targetConsensus } : {}),
  });

  return points;
}

export function PriceChart({
  data,
  positive,
  forecast,
  street,
}: {
  data: HistoricalPoint[];
  positive: boolean;
  forecast?: OttoForecast;
  street?: StreetConsensus | null;
}) {
  const color = positive ? "var(--otto-bull)" : "var(--otto-bear)";
  const chartData = buildChartData(data, forecast, street);

  if (data.length === 0) {
    return (
      <div className="flex h-56 w-full items-center justify-center rounded-lg border border-dashed border-otto-border-soft">
        <p className="text-xs text-otto-text-faint">
          Price history unavailable for this ticker right now — data provider gap or rate limit.
        </p>
      </div>
    );
  }

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tickFormatter={(d: string) => (d === FORECAST_LABEL ? d : d.slice(5, 7) + "/" + d.slice(2, 4))}
            tick={{ fill: "var(--otto-text-faint)", fontSize: 11 }}
            axisLine={{ stroke: "var(--otto-border)" }}
            tickLine={false}
            minTickGap={20}
          />
          <YAxis hide domain={["dataMin - 2", "dataMax + 2"]} />
          <Tooltip
            contentStyle={{
              background: "var(--otto-bg-raised)",
              border: "1px solid var(--otto-border)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--otto-text-muted)" }}
            itemStyle={{ color: "var(--otto-text)" }}
            formatter={(value, name) => {
              if (name === "bandBase" || name === "bandRange") return [null, null];
              return [`$${Number(value).toFixed(2)}`, typeof name === "string" ? name : ""];
            }}
          />
          <Area type="monotone" dataKey="close" name="Close" stroke={color} strokeWidth={2} fill="url(#priceFill)" />

          {forecast && (
            <>
              <Area
                dataKey="bandBase"
                stackId="band"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
                legendType="none"
                name="bandBase"
              />
              <Area
                dataKey="bandRange"
                stackId="band"
                stroke="none"
                fill="var(--otto-gold)"
                fillOpacity={0.12}
                isAnimationActive={false}
                legendType="none"
                name="bandRange"
              />
              <Line type="monotone" dataKey="bull" name="Bull" stroke="var(--otto-bull)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} connectNulls />
              <Line type="monotone" dataKey="base" name="Base" stroke="var(--otto-gold)" strokeDasharray="4 3" strokeWidth={1.75} dot={false} connectNulls />
              <Line type="monotone" dataKey="bear" name="Bear" stroke="var(--otto-bear)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} connectNulls />
              {street?.targetConsensus !== undefined && (
                <Line
                  type="monotone"
                  dataKey="street"
                  name="Street"
                  stroke="var(--otto-text)"
                  strokeDasharray="2 2"
                  strokeWidth={1.5}
                  dot={{ r: 3, fill: "var(--otto-text)" }}
                  connectNulls
                />
              )}
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
