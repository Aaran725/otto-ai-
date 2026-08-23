import type { PeerValuation } from "@/lib/otto/peers";

interface Gauge {
  label: string;
  value: number | undefined;
  median: number | undefined;
  format: (n: number) => string;
  /** For most multiples, below median = cheap = bullish. ROIC inverts: above median = bullish. */
  higherIsBetter: boolean;
}

function GaugeBar({ gauge }: { gauge: Gauge }) {
  if (gauge.value === undefined || gauge.median === undefined || gauge.median <= 0) {
    return (
      <div className="flex items-center justify-between text-xs text-otto-text-faint">
        <span>{gauge.label}</span>
        <span>n/a</span>
      </div>
    );
  }

  // Scale both bars relative to whichever is larger, so the comparison
  // reads visually even when the stock is 2-3x its peer median.
  const maxVal = Math.max(gauge.value, gauge.median) * 1.15;
  const valuePct = Math.min((gauge.value / maxVal) * 100, 100);
  const medianPct = Math.min((gauge.median / maxVal) * 100, 100);
  const isCheaperOrBetter = gauge.higherIsBetter ? gauge.value > gauge.median : gauge.value < gauge.median;
  const color = isCheaperOrBetter ? "var(--otto-bull)" : "var(--otto-bear)";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-otto-text-muted">{gauge.label}</span>
        <span className="tabular-nums font-medium" style={{ color }}>
          {gauge.format(gauge.value)} <span className="text-otto-text-faint">vs {gauge.format(gauge.median)} median</span>
        </span>
      </div>
      <div className="relative h-2 w-full overflow-visible rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full" style={{ width: `${valuePct}%`, background: color }} />
        <div
          className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-otto-text"
          style={{ left: `${medianPct}%` }}
          title="Sector median"
        />
      </div>
    </div>
  );
}

/**
 * Visual instead of "P/E: 24x" — three real gauges (P/E, P/FCF, ROIC), each
 * bar showing this stock against its actual SEC-classified sector median
 * (the vertical tick mark), colored by whether that comparison is
 * favorable. EV/EBITDA was in the original ask but dropped rather than
 * faked — none of the free data sources this app uses carry it.
 */
export function ValuationGaugeCluster({
  peerValuation,
  currentPE,
  currentPFCF,
  currentROIC,
}: {
  peerValuation: PeerValuation;
  currentPE?: number;
  currentPFCF?: number;
  currentROIC?: number;
}) {
  const gauges: Gauge[] = [
    { label: "P/E", value: currentPE, median: peerValuation.medianPE, format: (n) => `${n.toFixed(1)}x`, higherIsBetter: false },
    {
      label: "P/FCF",
      value: currentPFCF,
      median: peerValuation.medianPFCF ?? undefined,
      format: (n) => `${n.toFixed(1)}x`,
      higherIsBetter: false,
    },
    {
      label: "ROIC",
      value: currentROIC,
      median: peerValuation.medianROIC ?? undefined,
      format: (n) => `${(n * 100).toFixed(1)}%`,
      higherIsBetter: true,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="otto-text-label text-otto-text-faint">
        Vs. {peerValuation.sicDescription} peers ({peerValuation.peers.length} found)
      </p>
      {gauges.map((g) => (
        <GaugeBar key={g.label} gauge={g} />
      ))}
    </div>
  );
}
