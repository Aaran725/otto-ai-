"use client";

import { clsx } from "clsx";
import type { GovernmentContractSignal } from "@/lib/otto/usaspending";

function fmtDollars(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${n.toLocaleString("en-US")}`;
}

/**
 * Real federal contract award history from USASpending.gov's official
 * API — a revenue-durability signal for the subset of companies with real
 * government business, not a component every company gets (most have
 * none at all, which is why the caller only renders this when non-null).
 */
export function GovernmentContractPanel({ signal }: { signal: GovernmentContractSignal }) {
  const growing = signal.growthPct !== null && signal.growthPct >= 0;
  return (
    <div className="flex flex-col gap-2">
      <p className="otto-text-label text-otto-text-faint">Federal Contract Awards (USASpending.gov)</p>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-otto-text-muted">FY{signal.recentFiscalYear} awards</span>
        <span className="tabular-nums font-medium text-otto-text">{fmtDollars(signal.recentFiscalYearTotal)}</span>
      </div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-otto-text-muted">FY{signal.priorFiscalYear} awards</span>
        <span className="tabular-nums text-otto-text-muted">{fmtDollars(signal.priorFiscalYearTotal)}</span>
      </div>
      {signal.growthPct !== null && (
        <p className="text-xs text-otto-text-muted">
          <span className={clsx("font-medium", growing ? "text-otto-bull" : "text-otto-bear")}>
            {growing ? "+" : ""}
            {signal.growthPct.toFixed(0)}% YoY
          </span>{" "}
          in real federal contract awards — a genuine revenue-durability signal, not projected or estimated.
        </p>
      )}
    </div>
  );
}
