import type { StreetConsensus } from "@/lib/otto/schema";

const SEGMENT_COLORS: Record<string, string> = {
  strongBuy: "var(--otto-bull)",
  buy: "var(--otto-bull)",
  hold: "var(--otto-text-faint)",
  sell: "var(--otto-bear)",
  strongSell: "var(--otto-bear)",
};

const SEGMENT_LABELS: [key: keyof StreetConsensus["ratingCounts"], label: string][] = [
  ["strongBuy", "Strong Buy"],
  ["buy", "Buy"],
  ["hold", "Hold"],
  ["sell", "Sell"],
  ["strongSell", "Strong Sell"],
];

/** Replaces "22 analysts · Buy" text with a real buy/hold/sell ring built
 * from the actual rating counts (Street consensus data, not a guess). */
export function RatingDonut({ street }: { street: StreetConsensus }) {
  const total = street.analystCount;
  if (total === 0) {
    return <p className="text-sm text-otto-text-faint">No analyst ratings available.</p>;
  }

  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  let offsetAccum = 0;

  const segments = SEGMENT_LABELS.map(([key, label]) => {
    const count = street.ratingCounts[key];
    const fraction = count / total;
    const dash = fraction * circumference;
    const seg = { key, label, count, dash, offset: offsetAccum, color: SEGMENT_COLORS[key] };
    offsetAccum += dash;
    return seg;
  }).filter((s) => s.count > 0);

  return (
    <div className="flex items-center gap-6">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--otto-border)" strokeWidth="12" />
          {segments.map((s) => (
            <circle
              key={s.key}
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth="12"
              strokeDasharray={`${s.dash} ${circumference - s.dash}`}
              strokeDashoffset={-s.offset}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold text-otto-text">{total}</span>
          <span className="text-[9px] uppercase tracking-wide text-otto-text-faint">analysts</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {segments.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            <span className="text-otto-text-muted">{s.label}</span>
            <span className="tabular-nums font-medium text-otto-text">{s.count}</span>
          </div>
        ))}
        <p className="otto-text-label mt-1 text-otto-text-faint">Consensus: {street.rating}</p>
      </div>
    </div>
  );
}
