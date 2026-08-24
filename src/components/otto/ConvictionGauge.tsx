import type { DataQuality } from "@/lib/otto/schema";

function scoreColor(score: number) {
  if (score >= 75) return "var(--otto-gold)";
  if (score >= 55) return "var(--otto-bull)";
  if (score >= 40) return "var(--otto-text-muted)";
  return "var(--otto-bear)";
}

export function ConvictionGauge({ score, dataQuality }: { score: number; dataQuality?: DataQuality }) {
  const insufficient = dataQuality === "insufficient";
  const clamped = Math.max(0, Math.min(100, score));
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  // A near-empty ring reads as "no real signal" rather than a number that
  // looks confident but was computed from almost no real data.
  const offset = insufficient ? circumference * 0.94 : circumference * (1 - clamped / 100);
  const color = insufficient ? "var(--otto-text-faint)" : scoreColor(clamped);

  return (
    <div className="relative flex h-32 w-32 shrink-0 items-center justify-center">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="var(--otto-border)"
          strokeWidth="6"
        />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="tabular-nums text-3xl font-semibold" style={{ color }}>
          {insufficient ? "—" : Math.round(clamped)}
        </span>
        <span className="otto-text-label text-otto-text-faint">
          {insufficient ? "No Rating" : "Conviction"}
        </span>
      </div>
    </div>
  );
}
