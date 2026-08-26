"use client";

import { Bar, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoricalPoint } from "@/lib/otto/schema";

interface Candle extends HistoricalPoint {
  open: number;
  high: number;
  low: number;
}

function isCandle(p: HistoricalPoint): p is Candle {
  return p.open !== undefined && p.high !== undefined && p.low !== undefined;
}

/** Single custom Bar shape drawing both the wick and the body from the raw
 * OHLC payload — reads low/high straight off payload rather than relying on
 * Recharts' own range-bar pixel math, so wick and body always agree. */
function CandleShape(props: unknown) {
  const { x, y, width, height, payload } = props as {
    x: number;
    y: number;
    width: number;
    height: number;
    payload: Candle;
  };
  const { open, close, high, low } = payload;
  const up = close >= open;
  const color = up ? "var(--otto-bull)" : "var(--otto-bear)";
  const range = high - low || 1;
  const priceToY = (price: number) => y + height * (1 - (price - low) / range);
  const bodyTop = priceToY(Math.max(open, close));
  const bodyBottom = priceToY(Math.min(open, close));
  const cx = x + width / 2;
  const bodyWidth = Math.max(width * 0.55, 2);

  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1.25} />
      <rect
        x={cx - bodyWidth / 2}
        y={bodyTop}
        width={bodyWidth}
        height={Math.max(bodyBottom - bodyTop, 1.5)}
        fill={color}
        rx={1}
      />
    </g>
  );
}

function CandleTooltip({ active, payload, label }: { active?: boolean; payload?: { payload: Candle }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div
      style={{
        background: "var(--otto-bg-raised)",
        border: "1px solid var(--otto-border)",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 12,
      }}
    >
      <p style={{ color: "var(--otto-text-muted)", marginBottom: 4 }}>{label}</p>
      <p style={{ color: "var(--otto-text)" }}>
        O ${d.open.toFixed(2)} · H ${d.high.toFixed(2)}
      </p>
      <p style={{ color: "var(--otto-text)" }}>
        L ${d.low.toFixed(2)} · C ${d.close.toFixed(2)}
      </p>
    </div>
  );
}

/**
 * Real OHLC candles — only renders when the underlying source actually
 * carried open/high/low (the Alpaca/Yahoo fallback paths). FMP's primary
 * "light" endpoint is close-only, so for most tickers this component has
 * nothing to show and the caller should skip it rather than fabricate a
 * candle body from a single close price.
 */
export function CandlestickChart({ data }: { data: HistoricalPoint[] }) {
  const points = data.filter(isCandle);
  if (points.length === 0) return null;

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="date"
            tickFormatter={(d: string) => d.slice(5, 7) + "/" + d.slice(2, 4)}
            tick={{ fill: "var(--otto-text-faint)", fontSize: 11 }}
            axisLine={{ stroke: "var(--otto-border)" }}
            tickLine={false}
            minTickGap={20}
          />
          <YAxis hide domain={["dataMin - 2", "dataMax + 2"]} />
          <Tooltip content={<CandleTooltip />} cursor={{ fill: "var(--otto-material-border)" }} />
          <Bar dataKey={(d: Candle) => [d.low, d.high]} shape={CandleShape} isAnimationActive={false} maxBarSize={22} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
