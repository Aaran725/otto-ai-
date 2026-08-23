import type { FundamentalTrendPoint } from "@/lib/otto/schema";

function formatCompact(value: number) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  return `${sign}$${abs}`;
}

/** Operating cash flow → capex → free cash flow, for the most recent fiscal
 * year that has real operatingCashFlow/capex data (not every ticker's
 * cash-flow statement carries both — a whitelist-restricted or Finnhub-
 * fallback year sometimes only has freeCashFlow itself, in which case this
 * falls back honestly instead of drawing a fake bridge). */
export function CashFlowWaterfall({ data }: { data: FundamentalTrendPoint[] }) {
  const latest = [...data].reverse().find((d) => d.operatingCashFlow !== undefined && d.capex !== undefined);

  if (!latest || latest.operatingCashFlow === undefined || latest.capex === undefined) {
    return (
      <p className="text-xs text-otto-text-faint">
        Operating cash flow / capex breakdown unavailable for this ticker — only net free cash flow is available.
      </p>
    );
  }

  const operating = latest.operatingCashFlow;
  const capex = -Math.abs(latest.capex);
  const fcf = operating + capex;

  const maxAbs = Math.max(Math.abs(operating), Math.abs(fcf), Math.abs(capex));
  const barPct = (n: number) => `${Math.max((Math.abs(n) / maxAbs) * 100, 3)}%`;

  const bars = [
    { label: "Operating CF", value: operating, color: "var(--otto-bull)" },
    { label: "Capex", value: capex, color: "var(--otto-bear)" },
    { label: "Free Cash Flow", value: fcf, color: "var(--otto-gold)" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="otto-text-label text-otto-text-faint">{latest.period} bridge</p>
      {bars.map((b) => (
        <div key={b.label}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-otto-text-muted">{b.label}</span>
            <span className="tabular-nums font-medium" style={{ color: b.color }}>
              {formatCompact(b.value)}
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full" style={{ width: barPct(b.value), background: b.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}
